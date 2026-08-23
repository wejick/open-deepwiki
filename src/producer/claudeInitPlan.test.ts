import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { phasePrompt, plannerDirectives } from "./claude.ts";
import { runClaude } from "./claudeRun.ts";
import { runIsolatedProducer } from "./run.ts";
import { readEvents } from "../monitor/events.ts";
import { readWipMeta, wipDir } from "./wip.ts";
import { bundleDir } from "./verify.ts";
import { createGitRepo } from "../../test/helpers/gitFixture.ts";
import {
  CLAUDE_PROBES,
  WRITE_PAGE,
  claudeSessions,
  claudeSplit,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { testConfig } from "../../test/helpers/config.ts";

import {
  AREA_PAGE_JOBS,
  SPLIT_AREAS,
  checkout,
  cleanupTmps,
  claudeRecordingShim,
  gitCheckout,
  mapGuidance,
  promptBlocks,
  sessionLog,
} from "../../test/helpers/claudeHarness.ts";

afterEach(cleanupTmps);

describe("Checkpointed planning for large initial bundles › orchestration", () => {
  test("Large init splits planning: map, one session per area, then pages", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const log = join(dir, "sessions.txt");
    const shim = await claudeSplit(SPLIT_AREAS, { log });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) }, repoId: "r" });

    expect(run.outcome).toBe("ok");
    // Map first, every area before any page, pages sorted with overview last.
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "map",
      "area:a0",
      "area:a1",
      "area:a2",
      "area:a3",
      ...AREA_PAGE_JOBS.map((p) => `page:${p}`),
    ]);
    // Progress events mirror the same unit order with done/total counts,
    // each session's spawn beat preceding its completion beat.
    const progress = (await readEvents(cfg)).filter((e) => e.type === "producer_progress");
    expect(progress.map((e) => `${e.stage} ${e.note}`)).toEqual([
      "planning init, 4 documentable files",
      "session map",
      "map 4 areas",
      "session area a0",
      "area a0: 1/4",
      "session area a1",
      "area a1: 2/4",
      "session area a2",
      "area a2: 3/4",
      "session area a3",
      "area a3: 4/4",
      "plan 4 pages",
      ...AREA_PAGE_JOBS.flatMap((p, i) => [`session page ${p}`, `page ${p}: ${i + 1}/5`]),
    ]);
    for (const e of progress) expect(e.producer).toBe("claude");
    // A successful bundle carries no planning artifacts.
    const bundle = await readdir(bundleDir(c));
    expect(bundle).not.toContain(".odw-plan.json");
    expect(bundle).not.toContain(".odw-map.json");
    expect(bundle.filter((f) => f.startsWith(".odw-plan.part-"))).toEqual([]);
    for (const p of AREA_PAGE_JOBS) await expect(stat(join(bundleDir(c), p))).resolves.toBeTruthy();
  });

  test("A repairable map is normalized instead of failing the run", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const log = join(dir, "sessions.txt");
    // Odd-but-synonymous forms plus real junk: a duplicate id, an escaping
    // path — every one repairable without model judgment.
    const shim = await claudeSplit(
      [
        { id: "a0", paths: ["./f0.ts/"], pages: ["area0.md"] },
        { id: "a1", paths: ["f1.ts", "../escape"], pages: ["area1.md"] },
        { id: "a2", paths: ["f2.ts"], pages: ["area2.md"] },
        { id: "a3", paths: ["f3.ts"], pages: ["area3.md"] },
        { id: "a3", paths: ["junk\\dir"], pages: ["dup.md"] },
      ],
      { log },
    );
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) }, repoId: "r" });

    expect(run.outcome).toBe("ok");
    // The duplicate id merged before any area session spawned.
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "map",
      "area:a0",
      "area:a1",
      "area:a2",
      "area:a3",
      ...AREA_PAGE_JOBS.map((p) => `page:${p}`),
    ]);
    expect(run.stderr).toContain("map repaired:");
    expect(run.stderr).toContain("dropped unusable path ../escape (area a1)");
    expect(run.stderr).toContain("merged duplicate area id a3");
    const progress = (await readEvents(cfg)).filter((e) => e.type === "producer_progress");
    expect(progress.map((e) => `${e.stage} ${e.note}`)).toContain("map 4 areas");
  });

  test("An over-budget area is split into part areas instead of failing the run", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const log = join(dir, "sessions.txt");
    // One area claims all four files: over the 1-file budget (expected 4
    // areas, accepted 2–8). The run splits it rather than dying on the map.
    const shim = await claudeSplit(
      [{ id: "a0", paths: ["f0.ts", "f1.ts", "f2.ts", "f3.ts"], pages: ["a0.md"] }],
      { log, wildcard: true },
    );
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) }, repoId: "r" });

    expect(run.outcome).toBe("ok");
    expect(run.stderr).toContain("map repaired: split a0 into 4 parts");
    // The parts are planned as their own areas — recognizable siblings of a0.
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "map",
      "area:a0-part-1",
      "area:a0-part-2",
      "area:a0-part-3",
      "area:a0-part-4",
      "page:a0-part-1.md",
      "page:a0-part-2.md",
      "page:a0-part-3.md",
      "page:a0-part-4.md",
      "page:overview.md",
    ]);
    const progress = (await readEvents(cfg)).filter((e) => e.type === "producer_progress");
    expect(progress.map((e) => `${e.stage} ${e.note}`)).toContain("map 4 areas");
  });

  test("Small init keeps single-session planning", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const log = join(dir, "sessions.txt");
    const shim = await claudeSessions({
      plan: ["a.md"],
      first: sessionLog(log),
      page: [WRITE_PAGE],
    });
    // Default threshold 2000: 4 files never split.
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) }, repoId: "r" });

    expect(run.outcome).toBe("ok");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "plan",
      "page:a.md",
      "page:overview.md",
    ]);
    expect(await readdir(bundleDir(c))).not.toContain(".odw-map.json");
    // Undecomposed planning gets its plan beat too, counted before
    // normalization adds the overview.
    const progress = (await readEvents(cfg)).filter((e) => e.type === "producer_progress");
    expect(progress.map((e) => `${e.stage} ${e.note}`)).toEqual([
      "planning init, 4 documentable files",
      "session plan",
      "plan 1 pages",
      "session page a.md",
      "page a.md: 1/2",
      "session page overview.md",
      "page overview.md: 2/2",
    ]);
  });

  test("Non-documentable files do not push a checkout into split planning", async () => {
    const { dir, checkout: c } = await checkout();
    // 3 documentable source files plus inert noise: raw tracked count (5)
    // exceeds the threshold, documentable count (3) does not.
    await createGitRepo(c, {
      "f0.ts": "a",
      "f1.ts": "b",
      "f2.ts": "c",
      "assets/i1.png": "x",
      "package-lock.json": "{}",
    });
    const log = join(dir, "sessions.txt");
    const shim = await claudeSessions({
      plan: ["a.md"],
      first: sessionLog(log),
      page: [WRITE_PAGE],
    });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "3" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) }, repoId: "r" });

    expect(run.outcome).toBe("ok");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "plan",
      "page:a.md",
      "page:overview.md",
    ]);
    expect(await readdir(bundleDir(c))).not.toContain(".odw-map.json");
    const progress = (await readEvents(cfg)).filter((e) => e.type === "producer_progress");
    expect(progress.map((e) => `${e.stage} ${e.note}`)[0]).toBe(
      "planning init, 3 documentable files",
    );
  });

  test("The map session is told the documentable count, excluding inert files", async () => {
    const { dir, checkout: c } = await checkout();
    // 4 documentable files plus tracked noise that must not reach sizing.
    await createGitRepo(c, {
      "f0.ts": "a",
      "f1.ts": "b",
      "f2.ts": "c",
      "f3.ts": "d",
      "assets/i1.png": "x",
      "assets/i2.png": "x",
      "assets/i3.png": "x",
      "assets/i4.png": "x",
      "assets/i5.png": "x",
      "package-lock.json": "{}",
    });
    const argv = join(dir, "argv.txt");
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `printf "%s\\n=====\\n" "$PROMPT" >> "$ODW_ARGV_OUT"`,
        `MAP_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^MAP_FILE: //p' | head -1)`,
        `printf '%s' '{"areas":[{"id":"a0","title":"a0","paths":["f0.ts"]}]}' > "$MAP_FILE"`,
        `cat <<'JSON'\n${JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: argv },
    });
    const prompts = (await readFile(argv, "utf8")).split("\n=====\n");
    const mapPrompt = prompts.find((p) => p.trim()) ?? "";

    expect(mapPrompt).toContain("Cover the 4 documentable files the digest lists");
    expect(mapPrompt).toContain("at most 1 documentable files"); // budget: ceil(4 * 5%)
    expect(mapPrompt).not.toContain("10 documentable");
    expect(mapPrompt).not.toContain("tracked files");
  });

  test("Claude producer planning honors the merged exclude set › Glob-excluded tracked files are not planned", async () => {
    const { dir, checkout: c } = await checkout();
    // 5 files documentable by kind; dist/** removes one before sizing.
    await createGitRepo(c, {
      "f0.ts": "a",
      "f1.ts": "b",
      "f2.ts": "c",
      "f3.ts": "d",
      "dist/bundle.js": "minified",
      "assets/i1.png": "x",
    });
    const argv = join(dir, "argv.txt");
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `printf "%s\\n=====\\n" "$PROMPT" >> "$ODW_ARGV_OUT"`,
        `MAP_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^MAP_FILE: //p' | head -1)`,
        `printf '%s' '{"areas":[{"id":"a0","title":"a0","paths":["f0.ts"]}]}' > "$MAP_FILE"`,
        `cat <<'JSON'\n${JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );
    const cfg = testConfig(dir, {
      ODW_PRODUCER: "claude",
      ODW_CLAUDE_SPLIT_PLAN_FILES: "2",
      ODW_EXCLUDE_GLOBS: "dist/**",
    });

    await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: argv },
    });
    const prompts = (await readFile(argv, "utf8")).split("\n=====\n");
    const mapPrompt = prompts.find((p) => p.trim()) ?? "";

    // The digest the mapper is told to cover never names the glob-excluded
    // build output — 4 documentable, not 5.
    expect(mapPrompt).toContain("Cover the 4 documentable files the digest lists");
    expect(mapPrompt).not.toContain("5 documentable");
    expect(mapPrompt).not.toContain("bundle.js");
  });

  test("A separately configured model applies to the map session only", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const models = join(dir, "models.txt");
    const shim = await claudeSplit(SPLIT_AREAS, { modelLog: models });
    const cfg = testConfig(dir, {
      ODW_PRODUCER: "claude",
      ODW_CLAUDE_SPLIT_PLAN_FILES: "2",
      ODW_CLAUDE_MAP_MODEL: "claude-haiku-4",
    });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("ok");
    const lines = (await readFile(models, "utf8")).trim().split("\n");
    expect(lines[0]).toBe("map claude-haiku-4 medium");
    expect(lines.filter((l) => l.startsWith("area "))).toHaveLength(4);
    // Every session after the map keeps the run's model and effort.
    for (const line of lines.slice(1)) expect(line.endsWith("claude-sonnet-5 medium")).toBe(true);
  });

  test("Per-step model and effort apply to that step only", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const models = join(dir, "models.txt");
    const shim = await claudeSplit(SPLIT_AREAS, { modelLog: models });
    const cfg = testConfig(dir, {
      ODW_PRODUCER: "claude",
      ODW_CLAUDE_SPLIT_PLAN_FILES: "2",
      ODW_CLAUDE_MAP_MODEL: "claude-haiku-4-5-20251001",
      ODW_CLAUDE_MAP_EFFORT: "medium",
      ODW_CLAUDE_PLAN_MODEL: "claude-haiku-4-5-20251001",
      ODW_CLAUDE_PLAN_EFFORT: "high",
      ODW_CLAUDE_PAGE_MODEL: "claude-sonnet-5",
      ODW_CLAUDE_PAGE_EFFORT: "high",
    });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("ok");
    const lines = (await readFile(models, "utf8")).trim().split("\n");
    expect(lines[0]).toBe("map claude-haiku-4-5-20251001 medium");
    expect(lines.filter((l) => l === "area claude-haiku-4-5-20251001 high")).toHaveLength(4);
    expect(lines.filter((l) => l === "page claude-sonnet-5 high")).toHaveLength(5);
  });

  test("The map session is told the digest, the sizing, and where to write", async () => {
    const { dir, checkout: c } = await gitCheckout();
    // Records the map session's prompt.
    const argv = join(dir, "argv.txt");
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `printf "%s\\n=====\\n" "$PROMPT" >> "$ODW_ARGV_OUT"`,
        `MAP_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^MAP_FILE: //p' | head -1)`,
        `printf '%s' '{"areas":[{"id":"a0","title":"a0","paths":["f0.ts"]},{"id":"a1","title":"a1","paths":["f1.ts"]},{"id":"a2","title":"a2","paths":["f2.ts"]},{"id":"a3","title":"a3","paths":["f3.ts"]}]}' > "$MAP_FILE"`,
        `cat <<'JSON'\n${JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: argv },
    });
    const prompts = (await readFile(argv, "utf8")).split("\n=====\n");
    const mapPrompt = prompts.find((p) => p.trim()) ?? "";

    expect(mapPrompt.startsWith("MAP_FILE: ")).toBe(true);
    expect(mapPrompt).toContain("digest.txt");
    expect(mapPrompt).toContain("4 areas"); // sizing: ceil(4 / 1)
    expect(mapPrompt).toContain("at most 1 documentable files"); // budget: ceil(4 * 5%)
  });

  test("A rate-limited area session ends the run, preserving the map and parts", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const shim = await claudeSplit(SPLIT_AREAS, { rateLimitArea: "a2" });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("rate_limited");
    expect(run.partial).toBe(true);
    expect(run.resetAt).toBe("2026-09-01T12:00:00Z");
    // Forward progress: map + two parts completed before the limit hit.
    expect(run.unitsCompleted).toBeGreaterThanOrEqual(3);
    const bundle = await readdir(bundleDir(c));
    expect(bundle).toContain(".odw-map.json");
    expect(bundle).toContain(".odw-plan.part-a0.json");
    expect(bundle).toContain(".odw-plan.part-a1.json");
    expect(bundle).not.toContain(".odw-plan.part-a3.json");
  });

  test("A rate-limited split run resets the resume counter via its completed units", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const shim = await claudeSplit(SPLIT_AREAS, { rateLimitArea: "a2" });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      c,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
      { targetSha: "a".repeat(40) },
      "repo-split",
    );

    const meta = await readWipMeta(cfg, "repo-split");
    expect(meta?.attempts).toBe(1); // progressed, not advanced
    expect(await readdir(wipDir(cfg, "repo-split"))).toContain(".odw-plan.part-a0.json");
  });

  test("A failed map session preserves the map it wrote", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const shim = await claudeSplit(SPLIT_AREAS, { stallMap: true });
    const cfg = testConfig(dir, {
      ODW_PRODUCER: "claude",
      ODW_CLAUDE_SPLIT_PLAN_FILES: "2",
      ODW_CLAUDE_STEP_TIMEOUT_SEC: "1",
    });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    // Killed past the step budget after writing a valid map: resumable work.
    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    expect(run.stderr).toContain("map: not mapped (session timed out)");
    expect(run.stderr).toContain("usable map kept, next run resumes from it");
    // Direct run (no repoId): no progress events even on failure paths.
    expect(await readEvents(cfg)).toEqual([]);
    expect(await readdir(bundleDir(c))).toContain(".odw-map.json");
  });

  test("A failing area session is not fatal: later areas still run, the run is partial", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const shim = await claudeSplit(SPLIT_AREAS, { failArea: "a1" });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    expect(run.stderr).toContain("area a1: not planned");
    expect(run.stderr).toContain("area exploded");
    const bundle = await readdir(bundleDir(c));
    expect(bundle).not.toContain(".odw-plan.part-a1.json");
    expect(bundle).toContain(".odw-plan.part-a2.json"); // the run continued
  });

  test("A stalled area session is bounded by the step timeout; later areas still run", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const shim = await claudeSplit(SPLIT_AREAS, { stallArea: "a1" });
    const cfg = testConfig(dir, {
      ODW_PRODUCER: "claude",
      ODW_CLAUDE_SPLIT_PLAN_FILES: "2",
      ODW_CLAUDE_STEP_TIMEOUT_SEC: "1",
    });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    const bundle = await readdir(bundleDir(c));
    expect(bundle).not.toContain(".odw-plan.part-a1.json");
    expect(bundle).toContain(".odw-plan.part-a3.json");
  });

  test("A part that validates is done even when its session exits ugly", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const shim = await claudeSplit(SPLIT_AREAS, { failAfterPartArea: "a1" });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    // Presence of a validated part decides the unit, so the merge completes
    // and no "not planned" note contradicts the outcome.
    expect(run.outcome).toBe("ok");
    expect(run.stderr).not.toContain("area a1: not planned");
    await expect(stat(join(bundleDir(c), "area1.md"))).resolves.toBeTruthy();
  });

  test("An unusable part is discarded and no page session runs before a valid merge", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const log = join(dir, "sessions.txt");
    const shim = await claudeSplit(SPLIT_AREAS, { escapingPartArea: "a1", log });
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    expect(run.stderr).toContain("area a1");
    // Validation gates generation: a1 never merged, so no page was asked for.
    expect((await readFile(log, "utf8")).trim().split("\n")).not.toContain("page:area0.md");
    expect(await readdir(bundleDir(c))).not.toContain(".odw-plan.part-a1.json");
  });

  test("A resumed split run plans only the missing area", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });
    const SHA = "a".repeat(40);

    // First run loses one area: its parts stay, the plan never merges.
    const first = await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(await claudeSplit(SPLIT_AREAS, { failArea: "a3" })) } },
      { targetSha: SHA },
    );
    expect(first.partial).toBe(true);

    // Second run, same commit: no map session, only a3 replans, then pages.
    const log = join(dir, "sessions2.txt");
    const second = await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(await claudeSplit(SPLIT_AREAS, { log })) } },
      { targetSha: SHA },
    );

    expect(second.outcome).toBe("ok");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "area:a3",
      ...AREA_PAGE_JOBS.map((p) => `page:${p}`),
    ]);
  });

  test("A moved target commit discards the map and replans every area", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" });
    const SHA_A = "a".repeat(40);
    const SHA_B = "b".repeat(40);

    await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(await claudeSplit(SPLIT_AREAS, { failArea: "a3" })) } },
      { targetSha: SHA_A },
    );

    const log = join(dir, "sessions2.txt");
    const second = await runClaude(
      cfg,
      "init",
      c,
      { env: { PATH: pathWith(await claudeSplit(SPLIT_AREAS, { log })) } },
      { targetSha: SHA_B },
    );

    expect(second.outcome).toBe("ok");
    // The stale map was discarded: the map session ran again, for every area.
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "map",
      "area:a0",
      "area:a1",
      "area:a2",
      "area:a3",
      ...AREA_PAGE_JOBS.map((p) => `page:${p}`),
    ]);
  });
});

describe("Claude producer map ownership guidance", () => {
  test("permits overlapping areas", async () => {
    const g = await mapGuidance();
    expect(g).toContain("A file may belong to more than one area");
    expect(g).toContain("explored from each context that uses it");
    expect(g).not.toContain("documented from each context that uses it");
  });

  test("assigns cross-cutting subjects to one area", async () => {
    const g = await mapGuidance();
    expect(g).toContain("Cross-cutting subjects");
    expect(g).toContain("at most one page in the whole bundle");
    expect(g).toContain("owned by the area whose paths host that code");
    expect(g).toContain("state management");
    expect(g).toContain("error handling");
    expect(g).toContain("Record that ownership in the owning area's `scope`");
  });

  test("does not demand a strict partition", async () => {
    const g = await mapGuidance();
    expect(g).toContain("Areas are scopes, not a partition");
    // The old partition contract is gone: no file "belongs to exactly one
    // area" demand and no "must cover the tree" requirement.
    expect(g).not.toMatch(/belongs to exactly one area/);
    expect(g).not.toMatch(/must cover the tree/);
    // The phrase itself survives only as a negation of the requirement.
    expect(g).toMatch(/Nothing requires a file to sit in exactly one area/);
  });

  test("refuses areas for omitted files", async () => {
    const g = await mapGuidance();
    expect(g).toContain("never write a `path` that reaches into one");
    expect(g).toMatch(/need no area and must not get one/);
    expect(g).toContain("non-documentable");
  });

  test("names flows over file-kind directories", async () => {
    const g = await mapGuidance();
    expect(g).toContain("never for a file-kind directory");
    expect(g).toContain("Do not peel a feature into");
    expect(g).toContain("-constants");
    expect(g).toContain("-utils");
  });

  test("requires a pre-write budget check", async () => {
    const g = await mapGuidance();
    expect(g).toContain("split any area whose total exceeds the budget");
    // The run repairs an over-budget area now — the map is no longer discarded.
    expect(g).not.toContain("discards the whole map");
    expect(g).toContain("splits it into `-part-1`, `-part-2` siblings");
    expect(g).toContain("split before you write");
  });

  test("requires code-group reach", async () => {
    const g = await mapGuidance();
    expect(g).toContain("Reach");
    expect(g).toContain("every group's code is under at least one area's paths");
  });

  test("forbids coverage claims in the summary", async () => {
    const g = await mapGuidance();
    expect(g).toContain("does not assert that the map covers the repository");
  });
});

describe("Structure-seeded planning on init", () => {
  test("the undecomposed init planner is seeded with the whole structure handout", async () => {
    const { dir, checkout: c } = await gitCheckout();
    const tools = join(dir, "tools.txt");
    const prompts = join(dir, "prompts.txt");
    const structs = join(dir, "structs.txt");
    const shim = await claudeRecordingShim({ planPages: ["a.md"], tools, prompts, structs });

    const run = await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(shim), ODW_TOOLS_OUT: tools },
    });

    expect(run.outcome).toBe("ok");
    const plan = promptBlocks(await readFile(prompts, "utf8"))["plan"] ?? "";
    expect(plan.startsWith("PLAN_FILE: ")).toBe(true);
    expect(plan).toContain("The repository structure is at");
    expect(plan).toContain("digest.txt");
    expect(plan).toContain("authoritative for what exists");
  });

  test("the map and every area session plan from the structure handout", async () => {
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
    const blocks = promptBlocks(await readFile(prompts, "utf8"));
    const map = blocks["map"] ?? "";
    expect(map.startsWith("MAP_FILE: ")).toBe(true);
    expect(map).toContain("digest.txt");
    expect(map).toContain("Cover the 4 documentable files the digest lists");
    const area = blocks["a0"] ?? "";
    expect(area.startsWith("AREA_ID: a0")).toBe(true);
    expect(area).toContain("Structure handout for the paths this area owns:");
    expect(area).toContain("digest-a0.txt");
    // The slice it points at lists only the area's own file.
    const handout = promptBlocks(await readFile(structs, "utf8"))["a0"] ?? "";
    expect(handout).toContain("f0.ts");
    expect(handout).not.toContain("f1.ts");
  });

  test("planning guidance reads files only when the handout cannot answer", async () => {
    const planner = (await phasePrompt("planner")).toLowerCase().replace(/\s+/g, " ");
    for (const phrase of [
      "authoritative for what exists",
      "understand what a directory",
      "ground a page's scope or brief",
      "trace a flow",
      "rather than mirroring the source tree",
    ]) {
      expect(planner).toContain(phrase.toLowerCase());
    }
    const map = await mapGuidance();
    expect(map).toContain("authoritative for what exists");
  });

  test("an update planner is not seeded with the structure", () => {
    const seeded = plannerDirectives("init", {}, "/tmp/plan.json", {
      handoutFile: "/tmp/digest.txt",
    });
    expect(seeded).toContain("The repository structure is at");

    const update = plannerDirectives(
      "update",
      { changedPaths: ["src/cache.ts"] },
      "/tmp/plan.json",
    );
    expect(update).not.toContain("The repository structure is at");
    expect(update).not.toContain("digest");
  });
});
