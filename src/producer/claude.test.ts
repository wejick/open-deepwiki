import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ALLOWED_TOOLS,
  DENIED_TOOLS,
  SETTING_SOURCES,
  authoringPrompt,
  checkClaude,
  classifyResult,
  describeSession,
  pageDirectives,
  areaDirectives,
  phasePrompt,
  plannerDirectives,
  runSession,
  supportsSettingSources,
  whyNotProduced,
} from "./claude.ts";
import { runClaude } from "./claudeRun.ts";
import { runIsolatedProducer } from "./run.ts";
import { bundleDir } from "./verify.ts";
import {
  CLAUDE_PROBES,
  CLAUDE_PROBES_LEGACY,
  claudeGarbageOutput,
  claudeHang,
  claudeHappy,
  claudeAlwaysUnacceptable,
  claudeFailsOnePage,
  claudeMalformedBundle,
  claudeStallsOnOnePage,
  claudeNotLoggedIn,
  claudeRateLimited,
  claudeRateLimitedNoReset,
  claudeSuccessButEmpty,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { bundleFixture, makeTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

import {
  checkout,
  cleanupTmps,
  sessionRecord,
  trackTmp,
} from "../../test/helpers/claudeHarness.ts";

afterEach(cleanupTmps);

describe("Non-interactive Claude Code producer invocation", () => {
  test("Init run produces a bundle", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeHappy(bundleFixture("valid"));
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("ok");
    expect(run.ok).toBe(true);
    expect(run.exitCode).toBe(0);
    await expect(stat(join(bundleDir(c), "index.md"))).resolves.toBeTruthy();
  });

  test("argv carries the measured flags — prompt file, model, effort, tool policy", async () => {
    const { dir, checkout: c } = await checkout();
    // Record argv instead of running: this asserts the invocation contract.
    const shim = await writeShim(
      "claude",
      [...CLAUDE_PROBES, 'printf "%s\\n" "$@" > "$ODW_ARGV_OUT"', "exit 0"].join("\n"),
    );
    const cfg = testConfig(dir, {
      ODW_CLAUDE_MODEL: "claude-sonnet-5",
      ODW_CLAUDE_EFFORT: "medium",
    });
    const argvOut = join(dir, "argv.txt");

    await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim), ODW_ARGV_OUT: argvOut } });
    const argv = (await readFile(argvOut, "utf8")).split("\n");

    expect(argv).toContain("-p");
    // D4: the contract is injected as system-prompt text, never --plugin-dir.
    expect(argv).toContain("--append-system-prompt-file");
    expect(argv).not.toContain("--plugin-dir");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-sonnet-5");
    expect(argv).toContain("--effort");
    expect(argv).toContain("medium");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain(ALLOWED_TOOLS);
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain(DENIED_TOOLS);
    expect(argv).toContain("--setting-sources");
    expect(argv).toContain(SETTING_SOURCES);
  });

  test("a CLI without --setting-sources is not handed it — an unknown option kills every session", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await writeShim(
      "claude",
      [...CLAUDE_PROBES_LEGACY, 'printf "%s\\n" "$@" > "$ODW_ARGV_OUT"', "exit 0"].join("\n"),
    );
    const argvOut = join(dir, "argv.txt");

    const run = await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: argvOut },
    });
    const argv = (await readFile(argvOut, "utf8")).split("\n");

    expect(argv).not.toContain("--setting-sources");
    expect(run.stderr).toContain("--setting-sources");
  });

  test("supportsSettingSources reads the CLI's own help, and a missing CLI is a no", async () => {
    const modern = await writeShim("claude", CLAUDE_PROBES.join("\n"));
    const legacy = await writeShim("claude", CLAUDE_PROBES_LEGACY.join("\n"));
    const dir = await makeTmp();
    trackTmp(dir);
    const empty = join(dir, "no-claude-here");

    expect(await supportsSettingSources({ PATH: pathWith(modern) }, dir)).toBe(true);
    expect(await supportsSettingSources({ PATH: pathWith(legacy) }, dir)).toBe(false);
    expect(await supportsSettingSources({ PATH: empty }, dir)).toBe(false);
  });

  test("Bash is denied and the allowlist is read-plus-bundle-write only", () => {
    expect(DENIED_TOOLS).toBe("Bash");
    for (const tool of ["Read", "Grep", "Glob", "Write", "Edit"]) {
      expect(ALLOWED_TOOLS.split(",")).toContain(tool);
    }
    // No shell, no network, no arbitrary execution.
    for (const forbidden of ["Bash", "WebFetch", "WebSearch", "Task"]) {
      if (forbidden === "Bash") continue;
      expect(ALLOWED_TOOLS).not.toContain(forbidden);
    }
    expect(SETTING_SOURCES.split(",")).toEqual(["user"]);
  });

  test("Timeout kills the run", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeHang();
    const cfg = testConfig(dir);

    const run = await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim) },
      timeoutMs: 400,
    });

    expect(run.timedOut).toBe(true);
    expect(run.outcome).toBe("failed");
    expect(run.signal).toBe("SIGKILL");
  });

  test("Timeout kills the run — even when the budget kills the last session", async () => {
    const { dir, checkout: c } = await checkout();
    // The overview is the last job, so no later pre-session deadline check
    // runs: the kill must still be reported as a timeout. The budget only has
    // to outlast setup + the a.md session (the shim then stalls 30s) — it is
    // generous because sharded runs inflate spawn times, not because the
    // semantics depend on it.
    const shim = await claudeStallsOnOnePage(["a.md"], "overview.md");
    const cfg = testConfig(dir);

    const run = await runClaude(cfg, "init", c, {
      env: { PATH: pathWith(shim) },
      timeoutMs: 2000,
    });

    expect(run.timedOut).toBe(true);
    expect(run.partial).toBe(true);
    expect(run.outcome).toBe("failed");
  });

  test("a missing CLI is reported as such, not as a mysterious failure", async () => {
    const { dir, checkout: c } = await checkout();
    const empty = join(dir, "empty-bin");
    await mkdir(empty, { recursive: true });
    const cfg = testConfig(dir);

    const run = await runClaude(cfg, "init", c, { env: { PATH: empty } });
    expect(run.outcome).toBe("failed");
    expect(run.spawnError ?? "").toContain("claude");

    const check = await checkClaude({ env: { PATH: empty } });
    expect(check.missing).toBe(true);
  });

  test("no config dir is set unless the operator provisioned one (D5)", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await writeShim(
      "claude",
      [...CLAUDE_PROBES, 'echo "${CLAUDE_CONFIG_DIR:-UNSET}" > "$ODW_ARGV_OUT"', "exit 0"].join(
        "\n",
      ),
    );
    const out = join(dir, "cfgdir.txt");

    // Default: inherit ambient config — isolation would break auth.
    await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: out, CLAUDE_CONFIG_DIR: "" },
    });
    expect((await readFile(out, "utf8")).trim()).toBe("UNSET");

    // Explicitly provisioned: honored.
    await runClaude(testConfig(dir, { ODW_CLAUDE_CONFIG_DIR: "/tmp/provisioned" }), "init", c, {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: out },
    });
    expect((await readFile(out, "utf8")).trim()).toBe("/tmp/provisioned");
  });
});

describe("A page that was not produced says why", () => {
  test("the note carries the failing session's own account", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeFailsOnePage(["a.md", "b.md"], "b.md", {
      stderr: "Error: the model refused to write b.md",
    });

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    expect(run.stderr).toContain("b.md: not produced");
    expect(run.stderr).toContain("exit 2");
    expect(run.stderr).toContain("the model refused to write b.md");
    expect(run.stderr).not.toContain("a.md: not produced");
  });

  test("the failing session is reported, not whichever session happened to be last", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeFailsOnePage(["a.md", "b.md"], "b.md");

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("session exploded");
  });

  test("a session's incidental warnings never crowd the notes out of the tail", async () => {
    const { dir, checkout: c } = await checkout();
    const noise =
      "Ignoring 18 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.";
    const shim = await claudeFailsOnePage(["a.md", "b.md"], "b.md", { noise });

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    const tail = run.stderr.trim().split("\n").slice(-3).join(" ");
    expect(tail).toContain("b.md: not produced");
    expect(tail).not.toContain("has not been trusted");
  });

  test("whyNotProduced separates writing nothing from writing something malformed", () => {
    const claimedSuccess = sessionRecord();
    expect(whyNotProduced(claimedSuccess, null)).toContain("wrote no page");
    expect(whyNotProduced(claimedSuccess, "no frontmatter at all\n")).toContain(
      "missing frontmatter",
    );
    expect(whyNotProduced(sessionRecord({ outcome: "failed", exitCode: 2 }), null)).toContain(
      "exit 2",
    );
  });

  test("describeSession stays one bounded line whatever the child said", () => {
    expect(
      describeSession(sessionRecord({ outcome: "failed", spawnError: "ENOENT: claude not found" })),
    ).toBe("ENOENT: claude not found");
    expect(describeSession(sessionRecord({ outcome: "failed", timedOut: true }))).toBe(
      "session timed out",
    );

    const said = describeSession(
      sessionRecord({
        outcome: "failed",
        exitCode: 1,
        stdout: JSON.stringify({
          is_error: true,
          terminal_reason: "api_error",
          result: `Overloaded. ${"detail ".repeat(80)}`,
        }),
      }),
    );
    expect(said).toContain("exit 1");
    expect(said).toContain("api_error");
    expect(said).toContain("Overloaded");
    expect(said.split("\n")).toHaveLength(1);
    expect(said.length).toBeLessThan(300);

    expect(describeSession(sessionRecord({ outcome: "failed", exitCode: null }))).not.toBe("");
  });
});

describe("In-flight session abort", () => {
  test("an abort kills the child early and is not reported as a timeout", async () => {
    const { dir, checkout: c } = await checkout();
    const marker = join(dir, "started");
    const shimDir = await writeShim("claude", `touch '${marker}'; sleep 30; exit 0`);
    const cfg = testConfig(dir);
    const controller = new AbortController();
    const session = runSession(cfg, {
      systemPromptFile: join(dir, "contract.md"),
      prompt: "PAGE_PATH: a.md",
      cwd: c,
      env: { PATH: pathWith(shimDir), HOME: dir },
      // Far beyond the test's abort: only the signal can end this session.
      timeoutMs: 60_000,
      extraArgs: [],
      signal: controller.signal,
    });
    // Wait for the child to be up before aborting, so the kill lands
    // mid-flight rather than before the spawn.
    for (
      let i = 0;
      i < 200 &&
      !(await stat(marker)
        .then(() => true)
        .catch(() => false));
      i++
    ) {
      await Bun.sleep(10);
    }
    controller.abort();
    const s = await session;
    expect(s.aborted).toBe(true);
    expect(s.timedOut).toBe(false);
    expect(s.signal).toBe("SIGKILL");
    expect(s.outcome).toBe("failed");
    expect(s.spawnError).toBeNull();
  });
});

describe("Rate-limit outcome distinct from failure", () => {
  test("a usage limit is rate_limited, not failed, and records the reset time", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeRateLimited("2026-09-01T12:00:00Z");
    const cfg = testConfig(dir);

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("rate_limited");
    expect(run.outcome).not.toBe("failed");
    expect(run.resetAt).toBe("2026-09-01T12:00:00Z");
  });

  test("rate limited without a reset time still classifies as rate_limited", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeRateLimitedNoReset();

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });
    expect(run.outcome).toBe("rate_limited");
    expect(run.resetAt).toBeNull();
  });

  test("not-logged-in is a failure, not a rate limit", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeNotLoggedIn();

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });
    expect(run.outcome).toBe("failed");
  });

  test("classifyResult reads terminal_reason, not the free-text result", () => {
    expect(classifyResult({ terminal_reason: "completed", is_error: false }).outcome).toBe("ok");
    expect(classifyResult({ terminal_reason: "api_error", is_error: true }).outcome).toBe("failed");
    // 429 on its own is enough.
    expect(classifyResult({ api_error_status: 429 }).outcome).toBe("rate_limited");
    // Unparseable payload is a failure, never a success.
    expect(classifyResult(null).outcome).toBe("failed");
    // is_error true wins over a "completed" reason.
    expect(classifyResult({ terminal_reason: "completed", is_error: true }).outcome).toBe("failed");
  });

  test("a completed run is not a usage limit just because it says so in prose", () => {
    // `result` is the model's own summary of the work it did, so a wiki for a
    // throttling library mentions rate limiting. Matching the wording ahead of
    // the completion check turned every successful run of such a repo into a
    // fake limit: never indexed, lastIndexedSha frozen, repo deprioritized.
    for (const result of [
      "Wrote 12 pages covering auth, caching and the rate limiter.",
      "Documented the quota exceeded error path and the retry budget.",
      "Added a page on how the gateway handles too many requests.",
    ]) {
      expect(
        classifyResult({ terminal_reason: "completed", is_error: false, result }).outcome,
      ).toBe("ok");
    }
    // A 429 is a fact, so it still outranks a completion claim...
    expect(
      classifyResult({ terminal_reason: "completed", is_error: false, api_error_status: 429 })
        .outcome,
    ).toBe("rate_limited");
    // ...and for a run that did NOT complete, the wording still classifies why.
    expect(
      classifyResult({
        terminal_reason: "api_error",
        is_error: true,
        result: "usage limit reached",
      }).outcome,
    ).toBe("rate_limited");
  });

  test("the authoring-contract staging directory does not outlive the run", async () => {
    const { dir, checkout: c } = await checkout();
    // Pin TMPDIR to a directory only this test sees: the shared OS tmpdir also
    // holds staging from OTHER test files running in parallel, which reads as
    // a false leak. `os.tmpdir()` re-reads the env per call, so both the
    // producer's staging and the shim writer land here.
    const sandbox = join(dir, "tmp");
    await mkdir(sandbox, { recursive: true });
    // The shim goes to the default tmpdir: `writeShim("claude", …)` stages into
    // `odw-claude-*` too, and only the producer's own staging must be in the
    // sandbox the leak check reads.
    const shim = await claudeRateLimited(); // a non-happy path still cleans up
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = sandbox;
    try {
      await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    }

    const leaked = (await readdir(sandbox)).filter((e) => e.startsWith("odw-claude-"));
    // One directory per repo per night, forever, on a long-lived `serve`.
    expect(leaked).toEqual([]);
  });

  test("garbage stdout is a failure rather than a crash", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeGarbageOutput();

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });
    expect(run.outcome).toBe("failed");
  });
});

describe("A producer's own success signal is not acceptance (D8b)", () => {
  test("a session reporting success while the bundle stays unusable is still rejected", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeAlwaysUnacceptable();

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "init",
      c,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
    );

    // Every session said success and every planned page was written...
    expect(res.run.outcome).toBe("ok");
    // ...and acceptance still rejects the bundle they add up to.
    expect(res.ok).toBe(false);
    expect(res.verification?.ok).toBe(false);
  });

  test("Unparseable plan fails the run without writing pages", async () => {
    const { dir, checkout: c } = await checkout();
    // Claims completion having produced nothing — measured in the live spike.
    const shim = await claudeSuccessButEmpty();

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("failed");
    expect(run.spawnError ?? "").toContain("plan");
    await expect(readdir(bundleDir(c))).rejects.toThrow();
  });

  test("a page session reporting success without writing its page leaves nothing behind", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeMalformedBundle();

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });

    // The page is not produced, so the run is incomplete and resumable.
    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    // The failed session's file is deleted, so a half-written page can never
    // be mistaken for a produced one (or fail conformance for the bundle).
    expect(await readdir(bundleDir(c))).not.toContain("broken.md");
  });
});

describe("Authoring contract and producer input", () => {
  test("the injected prompt is the SKILL.md body, frontmatter stripped", async () => {
    const prompt = await authoringPrompt();
    expect(prompt.startsWith("---")).toBe(false);
    expect(prompt).not.toContain("allowed-tools:");
    // The load-bearing rules must survive into the injected text.
    expect(prompt).toContain("./openwiki/");
    expect(prompt).toContain("sources");
    expect(prompt).toContain("repo://");
  });

  test("the injected prompt instructs Mermaid diagram authoring", async () => {
    const prompt = await authoringPrompt();
    // Component/module relationships and branching decisions.
    expect(prompt).toContain("flowchart TD");
    // Interactions over time.
    expect(prompt).toContain("sequenceDiagram");
    // Every diagram gets a caption sentence, never left to speak for itself.
    expect(prompt.toLowerCase()).toContain("one sentence");
    // Pure-reference / single-linear-path pages skip diagrams entirely.
    expect(prompt.toLowerCase()).toContain("skip diagrams");
  });

  test("the injected prompt instructs a closing related-pages section and bold-on-first-mention", async () => {
    const prompt = await authoringPrompt();
    expect(prompt.toLowerCase()).toContain("related pages");
    expect(prompt.toLowerCase()).toContain("first time you formally introduce");
  });

  test("the injected prompt instructs a tags field and quoted Mermaid node labels", async () => {
    const prompt = await authoringPrompt();
    expect(prompt).toContain("tags");
    expect(prompt.toLowerCase()).toContain("quote every node label");
  });

  test("the injected prompt instructs preferring line-range citations", async () => {
    const prompt = await authoringPrompt();
    expect(prompt.toLowerCase()).toContain("prefer the line-range form");
  });

  test("the injected prompt instructs plain, direct prose", async () => {
    const prompt = await authoringPrompt();
    expect(prompt.toLowerCase()).toContain("contrastive-redefinition");
    expect(prompt.toLowerCase()).toContain("hedging and filler");
  });

  test("update planner directives carry the change set and the type vocabulary", () => {
    const d = plannerDirectives(
      "update",
      {
        fromSha: "a".repeat(40),
        changedPaths: ["src/cache.ts", "src/store.ts"],
        typeVocabulary: ["concept", "module"],
      },
      "/tmp/plan.json",
    );
    expect(d).toContain("update");
    expect(d).toContain("a".repeat(40));
    expect(d).toContain("src/cache.ts");
    expect(d).toContain("concept");
  });

  test("init planner directives ask for whole-repository coverage", () => {
    const d = plannerDirectives("init", {}, "/tmp/plan.json");
    expect(d).toContain("init");
    expect(d.toLowerCase()).toContain("whole repository");
  });

  test("the planner is told, on its own line, where to write the plan", () => {
    // On its own line, so a shim can `sed` it out of argv.
    const d = plannerDirectives("init", {}, "/tmp/x/plan.json");
    expect(d.split("\n")[0]).toBe("PLAN_FILE: /tmp/x/plan.json");
  });

  test("An area session sees the titles already planned", () => {
    const d = areaDirectives(
      { id: "alpha", title: "Alpha", scope: "The alpha flow", paths: ["src/alpha/"] },
      "/tmp/wip/.odw-plan.part-alpha.json",
      [],
      ["State management", "Auth module overview"],
    );
    expect(d).toContain("- State management");
    expect(d).toContain("- Auth module overview");
    expect(d).toContain("plan no page for these subjects");
  });

  test("Area-session guidance forbids boilerplate mirrors", () => {
    const d = areaDirectives(
      { id: "alpha", title: "Alpha", scope: "", paths: ["src/alpha/"] },
      "/tmp/wip/.odw-plan.part-alpha.json",
      [],
      [],
    );
    expect(d).toContain("Plan only pages specific to this area's own paths");
    expect(d).toContain("Cross-cutting subjects");
    expect(d).toContain("state management");
    expect(d).toContain("error handling");
  });

  test("init planning guidance carries the page ratio and the screen anti-pattern", () => {
    const init = plannerDirectives("init", {}, "/tmp/plan.json");
    expect(init).toContain("one page per hundred documentable files");
    expect(init).toContain("one page per screen, dialog, or directory leaf");
    // Update planning is change-set scoped — no ratio there.
    const update = plannerDirectives("update", {}, "/tmp/plan.json");
    expect(update).not.toContain("one page per hundred");
    const area = areaDirectives(
      { id: "alpha", title: "Alpha", scope: "", paths: ["src/alpha/"] },
      "/tmp/wip/.odw-plan.part-alpha.json",
      [],
      [],
    );
    expect(area).toContain("one page per hundred documentable files the area owns");
    expect(area).toContain("one page per screen, dialog, or directory leaf");
    // Page sessions write, they do not plan.
    const page = pageDirectives(
      {
        path: "services/auth.md",
        type: "service",
        title: "Auth",
        brief: "b",
        sourcePaths: ["src/auth.ts"],
        relatedPages: [],
      },
      [],
      {},
    );
    expect(page).not.toContain("one page per hundred");
  });

  test("a page session is told exactly one page and the pages it may link to", () => {
    const d = pageDirectives(
      {
        path: "services/auth.md",
        type: "service",
        title: "Auth",
        brief: "How tokens are minted.",
        sourcePaths: ["src/auth.ts"],
        relatedPages: [],
      },
      ["services/cache.md", "overview.md"],
      {},
    );

    expect(d.split("\n")[0]).toBe("PAGE_PATH: services/auth.md");
    expect(d.split("\n").filter((l) => l.startsWith("PAGE_PATH: "))).toHaveLength(1);
    expect(d).toContain("How tokens are minted.");
    expect(d).toContain("src/auth.ts");
    expect(d).toContain("services/cache.md");
  });

  test("each phase inherits the shared contract and only its own protocol", async () => {
    const planner = await phasePrompt("planner");
    const page = await phasePrompt("page");
    const shared = await authoringPrompt();

    for (const prompt of [planner, page]) expect(prompt).toContain(shared.split("\n")[0] ?? "");
    expect(planner).toContain("PLAN_FILE");
    expect(page).not.toContain("PLAN_FILE");
    expect(page).toContain("PAGE_PATH");
  });

  test("Planning guidance pins a closed, singular type vocabulary", async () => {
    const planner = await phasePrompt("planner");
    expect(planner).toContain("closed set, singular");
    expect(planner).toContain("Never pluralize");
  });
});

/** Prompts are hard-wrapped prose, so an instruction can straddle a newline. */
async function flat(phase: "planner" | "page"): Promise<string> {
  return (await phasePrompt(phase)).toLowerCase().replace(/\s+/g, " ");
}

const containsAll = async (phase: "planner" | "page", phrases: string[]): Promise<void> => {
  const prompt = await flat(phase);
  for (const phrase of phrases) expect(prompt).toContain(phrase.toLowerCase());
};

describe("Claude producer page plan", () => {
  test("Planner prompt instructs staged, system-oriented planning", async () => {
    await containsAll("planner", [
      // Three passes: surface, then flow, then boundaries.
      "manifests",
      "entry points",
      "public surfaces",
      "end-to-end",
      "tests",
      "rather than mirroring the source tree",
      "architecture/",
      "concepts/",
      "workflows/",
      "operations/",
      "integrations/",
      "testing/",
    ]);
  });
});

describe("Claude producer page-depth guidance", () => {
  test("Page prompt instructs a depth checklist and dense prose", async () => {
    await containsAll("page", [
      "responsibilities",
      "entry points",
      "control flow",
      "invariants",
      "failure modes",
      "extension points",
      "configuration",
      "focused tests",
      // The two failure modes the checklist exists to prevent.
      "source-file inventory",
      "dense and non-redundant, not short",
      "page length",
    ]);
  });

  test("Page prompt instructs relationship modeling and retrieval-oriented descriptions", async () => {
    await containsAll("page", [
      "the sentence that explains the relationship",
      "dispatches to",
      "depends on",
      "shares infrastructure with",
      "at least two",
      "standalone",
      // Density is not the goal, so neither padding nor reflexive inverses.
      "increase graph density",
      "reciprocal link",
      "write it for search",
      // Descriptions read as the page's one-line summary, not wiki navigation.
      "one-line summary",
      "never the page's own role in this wiki",
      "start here to find",
    ]);
  });
});

describe("Claude producer bundle finalization", () => {
  test("a stale index and an invalid Mermaid fence are corrected before the run reports ok", async () => {
    const { dir, checkout: c } = await checkout();
    // What "the model wrote": a wrong index.md and one broken diagram.
    const raw = await makeTmp();
    trackTmp(raw);
    await Bun.write(join(raw, "index.md"), "stale, does not match reality\n");
    await Bun.write(
      join(raw, "overview.md"),
      "---\ntype: overview\ntitle: Overview\ndescription: Top-level map\n---\n\n# Overview\n\n```mermaid\nthis <<< is ; not valid mermaid\n```\n",
    );
    const shim = await claudeHappy(raw);
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });
    expect(run.outcome).toBe("ok");

    const index = await readFile(join(bundleDir(c), "index.md"), "utf8");
    expect(index).toContain("[Overview](overview.md) - Top-level map");
    expect(index.startsWith('---\nokf_version: "0.2"\n---')).toBe(true);

    const overview = await readFile(join(bundleDir(c), "overview.md"), "utf8");
    expect(overview).not.toContain("```mermaid");
    expect(overview).toContain("mermaid parse failed");
  });

  test("a rate-limited run is never finalized — the outcome stays rate_limited", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeRateLimited();
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    // Finalization only runs on an "ok" outcome.
    expect(run.outcome).toBe("rate_limited");
  });
});
