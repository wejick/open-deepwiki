import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { runClaude } from "./claudeRun.ts";
import { bundleDir } from "./verify.ts";
import {
  CLAUDE_PROBES,
  WRITE_PAGE,
  claudePipelineHappy,
  claudePooledPages,
  claudeRateLimitedPool,
  claudeSessions,
  claudeStallsOnOnePage,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { testConfig } from "../../test/helpers/config.ts";

import {
  checkout,
  cleanupTmps,
  pageEntry,
  peakInFlight,
} from "../../test/helpers/claudeHarness.ts";

afterEach(cleanupTmps);

describe("Non-interactive Claude Code producer invocation \u203a orchestration", () => {
  const PAGES = ["a.md", "b.md", "c.md"];

  test("One session per planned page", async () => {
    const { dir, checkout: c } = await checkout();
    const seen = join(dir, "pages.txt");
    const shim = await claudePipelineHappy(PAGES);

    const run = await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(shim), ODW_PAGES_OUT: seen },
    });

    expect(run.outcome).toBe("ok");
    const order = (await readFile(seen, "utf8")).trim().split("\n");
    // Exactly one session per page, no page twice...
    expect(new Set(order).size).toBe(order.length);
    expect(order).toEqual(["a.md", "b.md", "c.md", "overview.md"]);
  });

  test("Overview is produced last with the finished page list", async () => {
    const { dir, checkout: c } = await checkout();
    const argv = join(dir, "argv.txt");
    // Records the prompt of every session, so the overview's can be read back.
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        'printf "%s\\n=====\\n" "$PROMPT" >> "$ODW_ARGV_OUT"',
        `PLAN_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
        `PAGE_PATH=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
        "mkdir -p ./openwiki",
        'if [ -n "$PLAN_FILE" ]; then',
        `  printf '%s' '${JSON.stringify({
          pages: ["a.md", "b.md"].map((path) => ({
            path,
            type: "concept",
            title: path,
            brief: "b",
            sourcePaths: [],
            relatedPages: [],
          })),
          deletePages: [],
        })}' > "$PLAN_FILE"`,
        'elif [ -n "$PAGE_PATH" ]; then',
        '  printf -- "---\\ntype: concept\\ntitle: P\\n---\\n\\nBody.\\n" > "./openwiki/$PAGE_PATH"',
        "fi",
        `cat <<'JSON'\n${JSON.stringify({
          is_error: false,
          terminal_reason: "completed",
          result: "done",
        })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );

    await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: argv },
    });
    const prompts = (await readFile(argv, "utf8")).split("\n=====\n").filter((p) => p.trim());

    // The overview session is the last one...
    const last = prompts.at(-1) ?? "";
    expect(last.startsWith("PAGE_PATH: overview.md")).toBe(true);
    // ...and it names the pages that actually shipped, not the plan's intentions.
    expect(last).toContain("a.md");
    expect(last).toContain("b.md");
  });

  test("Per-session timeout bounds one page, not the run", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeStallsOnOnePage(PAGES, "b.md");
    const cfg = testConfig(dir, { ODW_CLAUDE_STEP_TIMEOUT_SEC: "1" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    // The stuck page costs one page...
    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    const written = await readdir(bundleDir(c));
    expect(written).not.toContain("b.md");
    // ...and every later page is still attempted.
    expect(written).toContain("c.md");
    expect(written).toContain("overview.md");
  });
});

describe("Concurrent page workers", () => {
  const PAGES = ["a.md", "b.md", "c.md", "d.md"];

  test("Page workers cap concurrency", async () => {
    const { dir, checkout: c } = await checkout();
    const log = join(dir, "inflight.log");
    const shim = await claudePooledPages(PAGES, log, 0.3);
    const cfg = testConfig(dir, { ODW_CLAUDE_PAGE_WORKERS: "2" });

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });
    expect(run.outcome).toBe("ok");
    // The pool reached its cap and never exceeded it...
    expect(await peakInFlight(log)).toBe(2);
    // ...and every page still shipped.
    for (const p of [...PAGES, "overview.md"]) {
      expect(await readFile(join(bundleDir(c), p), "utf8")).not.toBe("");
    }
  });

  test("Page workers default to one", async () => {
    const { dir, checkout: c } = await checkout();
    const log = join(dir, "inflight.log");
    const shim = await claudePooledPages(PAGES, log, 0.3);

    const run = await runClaude(testConfig(dir), "init", c, { env: { PATH: pathWith(shim) } });
    expect(run.outcome).toBe("ok");
    // Unset = sequential: no two sessions ever overlap.
    expect(await peakInFlight(log)).toBe(1);
    for (const p of [...PAGES, "overview.md"]) {
      expect(await readFile(join(bundleDir(c), p), "utf8")).not.toBe("");
    }
  });

  test("The overview never joins the pool", async () => {
    const { dir, checkout: c } = await checkout();
    const log = join(dir, "inflight.log");
    const argv = join(dir, "argv.txt");
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
        `PAGE_PATH=$(printf '%s\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
        "mkdir -p ./openwiki",
        'if [ -n "$PLAN_FILE" ]; then',
        `  printf '%s' '${JSON.stringify({
          pages: ["a.md", "b.md", "c.md"].map(pageEntry),
          deletePages: [],
        })}' > "$PLAN_FILE"`,
        'elif [ -n "$PAGE_PATH" ]; then',
        `  echo "start:$PAGE_PATH" >> '${log}'`,
        "  sleep 0.3",
        `  if [ "$PAGE_PATH" = "overview.md" ]; then printf "%s\\n" "$PROMPT" >> '${argv}'; fi`,
        '  printf -- "---\\ntype: concept\\ntitle: P\\n---\\n\\nBody.\\n" > "./openwiki/$PAGE_PATH"',
        `  echo "end:$PAGE_PATH" >> '${log}'`,
        "fi",
        `cat <<'JSON'\n${JSON.stringify({
          is_error: false,
          terminal_reason: "completed",
          result: "done",
        })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );

    const run = await runClaude(testConfig(dir, { ODW_CLAUDE_PAGE_WORKERS: "3" }), "init", c, {
      env: { PATH: pathWith(shim) },
    });
    expect(run.outcome).toBe("ok");

    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l !== "");
    const lastPoolEnd = lines.findLastIndex((l) => l.startsWith("end:") && !l.includes("overview"));
    const overviewStart = lines.findIndex((l) => l === "start:overview.md");
    expect(overviewStart).toBeGreaterThan(lastPoolEnd);
    // The overview session names the pages that shipped.
    const overviewPrompt = await readFile(argv, "utf8");
    expect(overviewPrompt).toContain("a.md");
    expect(overviewPrompt).toContain("b.md");
    expect(overviewPrompt).toContain("c.md");
  });

  test("Concurrent page sessions share one whole-run deadline", async () => {
    const { dir, checkout: c } = await checkout();
    const started = join(dir, "started.log");
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
        `PAGE_PATH=$(printf '%s\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
        "mkdir -p ./openwiki",
        'if [ -n "$PLAN_FILE" ]; then',
        `  printf '%s' '${JSON.stringify({
          pages: ["a.md", "b.md", "c.md", "d.md", "e.md"].map(pageEntry),
          deletePages: [],
        })}' > "$PLAN_FILE"`,
        'elif [ -n "$PAGE_PATH" ]; then',
        `  echo "$PAGE_PATH" >> '${started}'`,
        "  sleep 10",
        '  printf -- "---\\ntype: concept\\ntitle: P\\n---\\n\\nBody.\\n" > "./openwiki/$PAGE_PATH"',
        "fi",
        `cat <<'JSON'\n${JSON.stringify({
          is_error: false,
          terminal_reason: "completed",
          result: "done",
        })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );
    // 4s still lands far inside the 10s page sleep: the point is one shared
    // wall clock (two sessions start, the rest never launch), and the slack
    // keeps setup + planner + spawn noise from firing the deadline early on a
    // loaded machine.
    const cfg = testConfig(dir, { ODW_CLAUDE_PAGE_WORKERS: "2", ODW_CLAUDE_TIMEOUT_SEC: "4" });
    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    // The deadline is one wall clock: two sessions start in the window, the
    // rest are never launched, and the run reports the lost pages.
    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    expect(run.timedOut).toBe(true);
    const launched = (await readFile(started, "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l !== "");
    expect(launched).toEqual(["a.md", "b.md"]);
    expect(run.stderr).toContain("out of budget with c.md and later pages unproduced");
  });

  test("The first failing page leads the failure report", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
        `PAGE_PATH=$(printf '%s\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
        "mkdir -p ./openwiki",
        'if [ -n "$PLAN_FILE" ]; then',
        `  printf '%s' '${JSON.stringify({
          pages: ["a.md", "b.md"].map(pageEntry),
          deletePages: [],
        })}' > "$PLAN_FILE"`,
        'elif [ -n "$PAGE_PATH" ]; then',
        '  if [ "$PAGE_PATH" = "a.md" ]; then sleep 1; exit 2; fi',
        '  if [ "$PAGE_PATH" = "b.md" ]; then exit 3; fi',
        '  printf -- "---\\ntype: concept\\ntitle: P\\n---\\n\\nBody.\\n" > "./openwiki/$PAGE_PATH"',
        "fi",
        `cat <<'JSON'\n${JSON.stringify({
          is_error: false,
          terminal_reason: "completed",
          result: "done",
        })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );
    const cfg = testConfig(dir, { ODW_CLAUDE_PAGE_WORKERS: "2" });
    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("failed");
    expect(run.partial).toBe(true);
    // a.md is launched first but fails slowest — completion order must not
    // decide the report; launch order does.
    expect(run.exitCode).toBe(2);
    const aPos = run.stderr.indexOf("a.md: not produced");
    const bPos = run.stderr.indexOf("b.md: not produced");
    expect(aPos).toBeGreaterThan(-1);
    expect(bPos).toBeGreaterThan(aPos);
  });
});

describe("Rate-limited page pool", () => {
  test("A rate-limited page session aborts in-flight peers", async () => {
    const { dir, checkout: c } = await checkout();
    const shim = await claudeRateLimitedPool({
      pages: ["a.md", "b.md", "c.md"],
      onPath: "c.md",
      partialPrefix: "no frontmatter\n",
      holdSec: 30,
      resetAt: "2026-09-02T03:00:00Z",
    });
    const cfg = testConfig(dir, { ODW_CLAUDE_PAGE_WORKERS: "3", ODW_CLAUDE_STEP_TIMEOUT_SEC: "2" });
    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("rate_limited");
    expect(run.partial).toBe(true);
    // The reset time comes from the rate-limited session, not a cancelled peer.
    expect(run.resetAt).toBe("2026-09-02T03:00:00Z");
    const written = await readdir(bundleDir(c));
    // No overview session ran after the pool was cancelled.
    expect(written).not.toContain("overview.md");
    expect(written).not.toContain("c.md");
    // The cancelled peers were killed mid-write: only their prefix remains.
    expect(await readFile(join(bundleDir(c), "a.md"), "utf8")).toBe("no frontmatter\n");
    expect(await readFile(join(bundleDir(c), "b.md"), "utf8")).toBe("no frontmatter\n");
  });

  test("A rate-limited abort resumes cleanly", async () => {
    const { dir, checkout: c } = await checkout();
    const limited = await claudeRateLimitedPool({
      pages: ["a.md", "b.md", "c.md"],
      onPath: "c.md",
      partialPrefix: "no frontmatter\n",
      holdSec: 30,
    });
    const first = await runClaude(
      testConfig(dir, { ODW_CLAUDE_PAGE_WORKERS: "3", ODW_CLAUDE_STEP_TIMEOUT_SEC: "2" }),
      "init",
      c,
      { env: { PATH: pathWith(limited) } },
    );
    expect(first.outcome).toBe("rate_limited");

    // A fresh run resumes the stamped plan: only the pages that are neither
    // present nor conformant are produced again — the peers' half-written
    // files are rewritten, not trusted.
    const secondShim = await claudePipelineHappy(["a.md", "b.md", "c.md"]);
    const second = await runClaude(testConfig(dir), "init", c, {
      env: { PATH: pathWith(secondShim) },
    });
    expect(second.outcome).toBe("ok");
    for (const p of ["a.md", "b.md", "c.md", "overview.md"]) {
      const body = await readFile(join(bundleDir(c), p), "utf8");
      expect(body).not.toBe("no frontmatter\n");
      expect(body.startsWith("---\ntype:")).toBe(true);
    }
  });
});

describe("Guaranteed overview page", () => {
  test("Update cannot delete the overview page", async () => {
    const { dir, checkout: c } = await checkout();
    const bundle = bundleDir(c);
    await mkdir(bundle, { recursive: true });
    await Bun.write(join(bundle, "gone.md"), "---\ntype: concept\n---\n\nBody.\n");
    await Bun.write(join(bundle, "overview.md"), "---\ntype: overview\n---\n\nMap.\n");
    // A plan that asks for both deletions; only the justified one is honoured.
    // The structure changed, so the overview is planned — meaning deleted and
    // produced again like any planned page.
    const shim = await claudeSessions({
      plan: [],
      deletePages: ["gone.md", "overview.md"],
      page: [WRITE_PAGE],
    });

    const run = await runClaude(testConfig(dir), "update", c, { env: { PATH: pathWith(shim) } });

    expect(run.outcome).toBe("ok");
    await expect(stat(join(bundle, "overview.md"))).resolves.toBeTruthy();
    await expect(stat(join(bundle, "gone.md"))).rejects.toThrow();
  });

  test("A run missing its overview page is not successful", async () => {
    const { dir, checkout: c } = await checkout();
    const cfg = testConfig(dir, { ODW_CLAUDE_STEP_TIMEOUT_SEC: "1" });
    const shim = await claudeStallsOnOnePage(["a.md", "overview.md"], "overview.md");

    const run = await runClaude(cfg, "init", c, { env: { PATH: pathWith(shim) } });

    expect(run.ok).toBe(false);
    expect(run.partial).toBe(true);
    expect(await readdir(bundleDir(c))).not.toContain("overview.md");
  });
});
