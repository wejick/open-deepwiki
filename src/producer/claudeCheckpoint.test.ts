import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ALLOWED_TOOLS } from "./claude.ts";
import { runClaude } from "./claudeRun.ts";
import { runIsolatedProducer } from "./run.ts";
import { PLAN_FILE_NAME } from "./claudePlan.ts";
import { readEvents } from "../monitor/events.ts";
import { wipDir } from "./wip.ts";
import { bundleDir } from "./verify.ts";
import {
  CLAUDE_PROBES,
  WRITE_PAGE,
  claudePipelineHappy,
  claudeSessions,
  claudeSplit,
  claudeStallsOnOnePage,
  claudeSuccessButEmpty,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { testConfig } from "../../test/helpers/config.ts";

import {
  SPLIT_AREAS,
  checkout,
  cleanupTmps,
  claudeRecordingShim,
  gitCheckout,
  promptBlocks,
  sessionLog,
} from "../../test/helpers/claudeHarness.ts";

afterEach(cleanupTmps);

describe("Plan-file checkpoint", () => {
  const PAGES = ["a.md", "b.md", "c.md"];
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  test("Completed pages survive an interrupted run", async () => {
    const { dir, checkout: c } = await checkout();
    const cfg = testConfig(dir, { ODW_CLAUDE_STEP_TIMEOUT_SEC: "1" });

    // A run stalled on b.md keeps the pages it produced — and the plan file.
    const first = await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(await claudeStallsOnOnePage(PAGES, "b.md")) } },
      { targetSha: SHA_A },
    );

    expect(first.partial).toBe(true);
    const bundle = await readdir(bundleDir(c));
    expect(bundle).toContain(".odw-plan.json");
    expect(bundle).toContain("a.md");
    expect(bundle).not.toContain("b.md");
  });

  test("A resumed run produces only what is missing", async () => {
    const { dir, checkout: c } = await checkout();
    const cfg = testConfig(dir, { ODW_CLAUDE_STEP_TIMEOUT_SEC: "1" });

    await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(await claudeStallsOnOnePage(PAGES, "b.md")) } },
      { targetSha: SHA_A },
    );

    // Second run, same commit: no planning session, and only the page that
    // never landed gets one.
    const sessions = join(dir, "sessions.txt");
    const shim = await claudeSessions({
      plan: PAGES,
      first: sessionLog(sessions),
      page: [WRITE_PAGE],
    });
    const second = await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(shim), ODW_SESSIONS_OUT: sessions } },
      { targetSha: SHA_A },
    );

    expect(second.outcome).toBe("ok");
    expect((await readFile(sessions, "utf8")).trim().split("\n")).toEqual(["page:b.md"]);
  });

  test("A successful run leaves no plan file behind", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudePipelineHappy(PAGES);

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("ok");
    expect(await readdir(bundleDir(c))).not.toContain(".odw-plan.json");
  });

  test("Plan application is recorded before any page is produced", async () => {
    const { dir, checkout: c } = await checkout();
    const cfg = testConfig(dir, { ODW_CLAUDE_STEP_TIMEOUT_SEC: "1" });
    const bundle = bundleDir(c);
    await mkdir(bundle, { recursive: true });
    // A kill landed right after planning: the plan was never applied, and a
    // stale page from a previous bundle still sits where a.md will go.
    await Bun.write(
      join(bundle, ".odw-plan.json"),
      JSON.stringify({ pages: [{ path: "a.md" }], deletePages: [] }),
    );
    await Bun.write(join(bundle, "a.md"), "---\ntype: concept\n---\n\nSTALE\n");

    const sessions = join(dir, "sessions.txt");
    const shim = await claudeSessions({
      plan: ["never-planned.md"],
      first: sessionLog(sessions),
      page: [
        // The overview never lands, so the plan file survives to be read.
        'if [ "$PAGE_PATH" = "overview.md" ]; then sleep 30; exit 0; fi',
        WRITE_PAGE,
      ],
    });
    const run = await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(shim), ODW_SESSIONS_OUT: sessions } },
      { targetSha: SHA_A },
    );

    expect(run.partial).toBe(true);
    // The existing plan was applied, not replanned: a page session ran for
    // a.md because application deleted the stale file first...
    expect((await readFile(sessions, "utf8")).trim().split("\n")).toEqual([
      "page:a.md",
      "page:overview.md",
    ]);
    const page = await readFile(join(bundle, "a.md"), "utf8");
    expect(page).toContain("Assigned page");
    expect(page).not.toContain("STALE");
    // ...and the plan file records that application happened, and for which commit.
    const stamped = JSON.parse(await readFile(join(bundle, ".odw-plan.json"), "utf8")) as {
      appliedAtSha?: string;
    };
    expect(stamped.appliedAtSha).toBe(SHA_A);
  });

  test("A moved target commit discards the plan", async () => {
    const { dir, checkout: c } = await checkout();
    const bundle = bundleDir(c);
    await mkdir(bundle, { recursive: true });
    // A fully-applied plan from an earlier commit, plus its finished page.
    await Bun.write(
      join(bundle, ".odw-plan.json"),
      JSON.stringify({ pages: [{ path: "a.md" }], deletePages: [], appliedAtSha: SHA_A }),
    );
    await Bun.write(join(bundle, "a.md"), "---\ntype: concept\n---\n\nold build\n");

    const sessions = join(dir, "sessions.txt");
    const shim = await claudeSessions({
      plan: ["fresh.md"],
      first: sessionLog(sessions),
      page: [WRITE_PAGE],
    });
    const run = await runClaude(
      testConfig(dir),
      "init",
      c,
      { env: { PATH: pathWith(shim), ODW_SESSIONS_OUT: sessions } },
      { targetSha: SHA_B },
    );

    expect(run.outcome).toBe("ok");
    // The stale plan was replanned, and the new plan's pages were produced.
    expect((await readFile(sessions, "utf8")).trim().split("\n")).toEqual([
      "plan",
      "page:fresh.md",
      "page:overview.md",
    ]);
  });
});

describe("A failed planning session preserves the plan it wrote", () => {
  const PAGES = ["a.md", "b.md"];

  /** Writes a valid plan, then hangs — killed by the step timeout after
   *  the write, the exact window the preserve rule exists for. */
  function planThenHang(): Promise<string> {
    return writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `PLAN_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
        "mkdir -p ./openwiki",
        'if [ -n "$PLAN_FILE" ]; then',
        `  printf '%s' '${JSON.stringify({
          pages: PAGES.map((path) => ({
            path,
            type: "concept",
            title: path,
            brief: "b",
            sourcePaths: [],
            relatedPages: [],
          })),
          deletePages: [],
        })}' > "$PLAN_FILE"`,
        "  sleep 30",
        "  exit 0",
        "fi",
        'if [ -n "$PAGE_PATH" ]; then',
        '  mkdir -p "$(dirname "./openwiki/$PAGE_PATH")"',
        WRITE_PAGE,
        "fi",
        `cat <<'JSON'\n${JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );
  }

  test("a timeout after writing the plan ends the run partial, plan intact", async () => {
    const { dir, checkout: c } = await checkout();
    const cfg = testConfig(dir, {
      ODW_PRODUCER: "claude",
      ODW_CLAUDE_STEP_TIMEOUT_SEC: "1",
    });

    const run = await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(await planThenHang()) },
    });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    expect(await readdir(bundleDir(c))).toContain(".odw-plan.json");
  });

  test("a usage limit after writing the plan keeps rate_limited and adds partial", async () => {
    const { dir, checkout: c } = await checkout();
    // Plan first, then the 429 payload — the session did its work, then died.
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `PLAN_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
        "mkdir -p ./openwiki",
        'if [ -n "$PLAN_FILE" ]; then',
        `  printf '%s' '${JSON.stringify({
          pages: PAGES.map((path) => ({
            path,
            type: "concept",
            title: path,
            brief: "b",
            sourcePaths: [],
            relatedPages: [],
          })),
          deletePages: [],
        })}' > "$PLAN_FILE"`,
        `  cat <<'JSON'\n${JSON.stringify({
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 429,
          result: "Usage limit reached",
        })}\nJSON`,
        "  exit 1",
        "fi",
        'if [ -n "$PAGE_PATH" ]; then',
        '  mkdir -p "$(dirname "./openwiki/$PAGE_PATH")"',
        WRITE_PAGE,
        "fi",
        "exit 0",
      ].join("\n"),
    );

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("rate_limited");
    expect(run.partial).toBe(true);
  });

  test("a planner that dies before writing preserves nothing (unchanged)", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeSuccessButEmpty();

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBeUndefined();
    expect(run.unitsCompleted).toBeUndefined();
  });

  test("the preserved plan reaches the WIP area for the next run", async () => {
    const { dir, checkout: c } = await checkout();
    const cfg = testConfig(dir, {
      ODW_PRODUCER: "claude",
      ODW_CLAUDE_STEP_TIMEOUT_SEC: "1",
    });

    const res = await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      c,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(await planThenHang()) } },
      { targetSha: "a".repeat(40) },
      "repo-preserve",
    );

    expect(res.run.partial).toBe(true);
    expect(res.wip.preserved).not.toBeNull();
    expect(await readdir(wipDir(cfg, "repo-preserve"))).toContain(".odw-plan.json");
  });
});

describe("Planning sessions on init do not enumerate", () => {
  test("the map and area sessions spawn without the enumeration tool", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const tools = join(dir, "tools.txt");
    const prompts = join(dir, "prompts.txt");
    const structs = join(dir, "structs.txt");
    const shim = await claudeRecordingShim({ areaCount: 4, tools, prompts, structs });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim), ODW_TOOLS_OUT: tools },
    });

    expect(run.outcome).toBe("ok");
    const lines = (await readFile(tools, "utf8")).trim().split("\n");
    expect(lines[0]).toBe("map Read,Grep,Write");
    const areas = lines.filter((l) => l.startsWith("area "));
    expect(areas).toHaveLength(4);
    for (const l of areas) expect(l.endsWith("Read,Grep,Write")).toBe(true);
    // Only the planning sessions lose the enumeration tool; pages keep it.
    const planning = lines.filter((l) => !l.startsWith("page:"));
    expect(planning.join("\n")).not.toContain("Glob");
    for (const l of planning) expect(l.endsWith("Read,Grep,Write")).toBe(true);
  });

  test("the undecomposed init planner spawns without enumeration; pages keep the full toolset", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const tools = join(dir, "tools.txt");
    const prompts = join(dir, "prompts.txt");
    const structs = join(dir, "structs.txt");
    const shim = await claudeRecordingShim({ planPages: ["a.md"], tools, prompts, structs });

    const run = await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(shim), ODW_TOOLS_OUT: tools },
    });

    expect(run.outcome).toBe("ok");
    const lines = (await readFile(tools, "utf8")).trim().split("\n");
    expect(lines[0]).toBe("plan Read,Grep,Write");
    for (const l of lines.slice(1)) {
      expect(l).toContain("page:");
      expect(l).toContain(ALLOWED_TOOLS);
    }
  });

  test("an update planner keeps the full toolset", async () => {
    const { dir, checkout: c } = await checkout();
    const bundle = bundleDir(c);
    await mkdir(bundle, { recursive: true });
    await Bun.write(
      join(bundle, "overview.md"),
      "---\ntype: overview\ntitle: Overview\ndescription: Entry.\n---\n\nMap.\n",
    );
    const tools = join(dir, "tools.txt");
    const prompts = join(dir, "prompts.txt");
    const structs = join(dir, "structs.txt");
    const shim = await claudeRecordingShim({ planPages: [], tools, prompts, structs });

    const run = await runClaude(testConfig(dir), "update", c, {
      env: { PATH: pathWith(shim), ODW_TOOLS_OUT: tools },
    });

    expect(run.outcome).toBe("ok");
    const lines = (await readFile(tools, "utf8")).trim().split("\n");
    expect(lines).toEqual([`plan ${ALLOWED_TOOLS}`]);
    const plan = promptBlocks(await readFile(prompts, "utf8"))["plan"] ?? "";
    expect(plan).not.toContain("repository structure is at");
  });
});

describe("Init plan page budget › orchestration", () => {
  test("An irreducible plan fails the run with its numbers", async () => {
    const { dir, checkout: c } = await gitCheckout();
    // Thirteen root-level pages, each citing nothing: no seam to merge along,
    // and budget 12 (the floor) leaves one page over.
    const plan = Array.from({ length: 13 }, (_, i) => `p${i}.md`);
    const shim = await claudeSessions({ plan });

    const run = await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(shim) },
      repoId: "r",
    });

    expect(run.outcome).toBe("failed");
    expect(run.spawnError ?? "").toContain("plan exceeds the page budget: 13 pages over 12");
    expect(run.spawnError ?? "").toContain("no area seams");
    // No page was ever written from the rejected plan; the unstamped plan
    // dot-file stays for the next run's deterministic re-repair.
    expect(await readdir(bundleDir(c))).toEqual([PLAN_FILE_NAME]);
  });

  test("An over-budget merged plan is repaired at the merge and the run proceeds", async () => {
    const { dir, checkout: c } = await gitCheckout();
    // a0's part names 14 pages citing one shared source parent — the merge
    // folds them to one entry before the plan is validated.
    const areas = [
      {
        ...SPLIT_AREAS[0]!,
        pages: Array.from({ length: 14 }, (_, i) => `a0/p${i}.md`),
        sources: ["src/shared.ts"],
      },
      ...SPLIT_AREAS.slice(1),
    ];
    const shim = await claudeSplit(areas);
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim) },
      repoId: "r",
    });

    expect(run.outcome).toBe("ok");
    const progress = (await readEvents(cfg)).filter((e) => e.type === "producer_progress");
    const planBeat = progress.find((e) => e.stage === "plan");
    expect(planBeat?.note).toBe("4 pages");
  });

  test("An irreducible merged plan fails the run, planning dot-files intact", async () => {
    const { dir, checkout: c } = await gitCheckout();
    // a0's part names 13 unmergeable pages (no source paths): 16 pages over
    // budget 12 with no eligible group.
    const areas = [
      { ...SPLIT_AREAS[0]!, pages: Array.from({ length: 13 }, (_, i) => `a0/p${i}.md`) },
      ...SPLIT_AREAS.slice(1),
    ];
    const shim = await claudeSplit(areas);
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim) },
      repoId: "r",
    });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    expect(run.spawnError ?? "").toContain("plan exceeds the page budget: 16 pages over 12");
    expect(run.spawnError ?? "").toContain("could not merge in: a0, a1, a2, a3");
    // The checkpoint the next run resumes from is untouched.
    const bundle = await readdir(bundleDir(c));
    expect(bundle).toContain(".odw-map.json");
    expect(bundle).toContain(".odw-plan.part-a0.json");
  });
});
