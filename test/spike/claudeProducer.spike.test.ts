import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { runClaude } from "../../src/producer/claudeRun.ts";
import { OVERVIEW_PAGE } from "../../src/producer/claudePlan.ts";
import { RESERVED_NAMES, verifyBundle, walkMd } from "../../src/producer/verify.ts";
import { scoreGrounding } from "../../src/producer/grounding.ts";
import { measureBundle } from "../eval/metrics.ts";
import { loadQuestions, scoreRetrieval } from "../eval/retrieval.ts";
import { stubFakeVecEmbeddings } from "../helpers/fetchStub.ts";
import { testConfig } from "../helpers/config.ts";

/** gray-matter caches by content string, and a throw leaves a poisoned `{}`
 *  entry that later returns empty frontmatter. An options object skips it. */
const NO_MATTER_CACHE = {} as const;

/**
 * The one test that runs the real `claude` CLI. Skipped unless ODW_SPIKE=1, so
 * the default suite stays offline while the spike remains code that runs and
 * asserts rather than a runbook nobody follows.
 *
 *   ODW_SPIKE=1 bun test test/spike/
 *
 * Answers what the producer is built on: whether the authoring contract reaches
 * the child, whether pages populate `sources[].resource` usably, and what the
 * JSON result shape is — plus the two sandboxing claims (no repo script run, no
 * source file modified). Costs real quota; the fixture is deliberately tiny.
 */

const ENABLED = process.env.ODW_SPIKE === "1";
const SPIKE = fileURLToPath(
  new URL(
    "../../openspec/changes/archive/2026-08-28-add-claude-code-producer/spike",
    import.meta.url,
  ),
);
const TIMEOUT_MS = Number(process.env.ODW_SPIKE_TIMEOUT_MS ?? 8 * 60 * 1000);

/** Pinned, not left to the CLI default: an unpinned run is not comparable
 *  across machines or over time, and comparing numbers is the point. */
const MODEL = process.env.ODW_CLAUDE_MODEL ?? "claude-sonnet-5";
const EFFORT = process.env.ODW_CLAUDE_EFFORT ?? "medium";

type Run = {
  outcome: "ok" | "failed" | "rate_limited";
  exitCode: number | null;
  json: Record<string, unknown> | null;
  checkout: string;
  workdir: string;
  executedScript: boolean;
  modified: string[];
};

/** Memoized so the first test pays for the run and the rest reuse it — a
 *  `beforeAll` cannot carry a timeout long enough for a live agent run. */
let pending: Promise<Run> | null = null;
function theRun(): Promise<Run> {
  pending ??= doRun();
  return pending;
}

async function fingerprint(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(d: string, base: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === "openwiki" || e.name === ".git") continue;
      const abs = join(d, e.name);
      const rel = base === "" ? e.name : `${base}/${e.name}`;
      if (e.isDirectory()) await walk(abs, rel);
      else out.set(rel, Bun.hash(await readFile(abs, "utf8")).toString());
    }
  }
  await walk(dir, "");
  return out;
}

async function doRun(): Promise<Run> {
  const workdir = await mkdtemp(join(tmpdir(), "odw-spike-"));
  const checkout = join(workdir, "checkout");
  await cp(join(SPIKE, "init"), checkout, { recursive: true });

  // A script the producer must never execute; running it leaves a marker.
  const marker = join(workdir, "EXECUTED");
  await Bun.write(join(checkout, "build.sh"), `#!/bin/sh\necho executed > '${marker}'\n`);
  await Bun.write(
    join(checkout, "package.json"),
    JSON.stringify({ name: "spike", scripts: { build: "sh build.sh" } }, null, 2),
  );

  const before = await fingerprint(checkout);
  const started = Date.now();

  // Drives the producer itself, not a hand-assembled argv. Flag-level findings
  // live in the archived `add-claude-code-producer` change.
  const cfg = testConfig(join(workdir, "run-config"), {
    ODW_CLAUDE_MODEL: MODEL,
    ODW_CLAUDE_EFFORT: EFFORT,
    ODW_CLAUDE_TIMEOUT_SEC: String(Math.ceil(TIMEOUT_MS / 1000)),
    ODW_CLAUDE_STEP_TIMEOUT_SEC: String(Math.ceil(TIMEOUT_MS / 1000)),
  });
  const run = await runClaude(cfg, "init", checkout, {}, { targetSha: "spike" });

  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }

  const after = await fingerprint(checkout);
  const modified = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
  const executedScript = await stat(marker).then(
    () => true,
    () => false,
  );

  console.log(
    [
      "",
      "── spike findings (1.7) ────────────────────────",
      `model / effort   ${MODEL} / ${EFFORT}`,
      `outcome          ${run.outcome}${run.partial === true ? " (partial)" : ""}`,
      `exit code        ${run.exitCode}`,
      `duration         ${((Date.now() - started) / 1000).toFixed(1)}s`,
      `timed out        ${run.timedOut}`,
      `stdout is JSON   ${json !== null}`,
      `is_error         ${String(json?.is_error)}`,
      `terminal_reason  ${String(json?.terminal_reason)}`,
      `num_turns        ${String(json?.num_turns)}`,
      `total_cost_usd   ${String(json?.total_cost_usd)}`,
      `json keys        ${json === null ? "-" : Object.keys(json).toSorted().join(", ")}`,
      `result           ${String(json?.result).slice(0, 200)}`,
      `bash executed    ${executedScript}`,
      `files modified   ${modified.length === 0 ? "none" : modified.join(", ")}`,
      "────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );

  return {
    outcome: run.outcome,
    exitCode: run.exitCode,
    json,
    checkout,
    workdir,
    executedScript,
    modified,
  };
}

afterAll(async () => {
  if (pending === null) return;
  const r = await pending.catch(() => null);
  if (r === null) return;
  // ODW_SPIKE_KEEP=1 retains the bundle — quality is unjudgeable once deleted.
  if (process.env.ODW_SPIKE_KEEP === "1") {
    console.log(`\n  bundle kept: ${join(r.checkout, "openwiki")}\n`);
    return;
  }
  await rm(r.workdir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("LIVE: claude producer spike (1.7)", () => {
  test(
    "the orchestrated run completes and its sessions return parseable JSON (question c)",
    async () => {
      const r = await theRun();
      expect(r.outcome).toBe("ok");
      expect(r.json).not.toBeNull();
      // terminal_reason is more stable than the free-text `result`.
      expect(r.json?.terminal_reason).toBe("completed");
      expect(r.json?.is_error).toBe(false);
      expect(r.exitCode).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "the run was planned and produced page by page, ending in the overview",
    async () => {
      const r = await theRun();
      const bundle = join(r.checkout, "openwiki");
      const pages = (await walkMd(bundle)).filter(
        (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
      );
      // The overview is the job the orchestrator always inserts and runs last.
      expect(pages.length).toBeGreaterThan(1);
      expect(pages).toContain(OVERVIEW_PAGE);
      // A completed run leaves no plan file in the published bundle.
      expect(await readdir(bundle)).not.toContain(".odw-plan.json");
    },
    TIMEOUT_MS,
  );

  test(
    "a bundle is produced at ./openwiki/ and conforms",
    async () => {
      const r = await theRun();
      const res = await verifyBundle(join(r.checkout, "openwiki"));
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.concepts).toBeGreaterThan(0);
      expect(res.indexPresent).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "the authoring contract reached every page session (question a)",
    async () => {
      // `sources[]` with repo:// entries is a convention only the skill
      // supplies, so its presence is the signal the contract arrived.
      const r = await theRun();
      const bundle = join(r.checkout, "openwiki");
      const pages = (await walkMd(bundle)).filter(
        (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
      );
      expect(pages.length).toBeGreaterThan(0);
      const canaried: string[] = [];
      for (const rel of pages) {
        const fm = matter(await readFile(join(bundle, rel), "utf8"), NO_MATTER_CACHE).data;
        const sources = Array.isArray(fm.sources) ? fm.sources : [];
        if (
          sources.some((e) =>
            String((e as { resource?: unknown })?.resource ?? "").startsWith("repo://"),
          )
        )
          canaried.push(rel);
      }
      console.log(`  contract applied on ${canaried.length}/${pages.length} pages`);
      expect(canaried).toEqual(pages);
    },
    TIMEOUT_MS,
  );

  test(
    "pages populate sources[].resource and they resolve (question b)",
    async () => {
      const r = await theRun();
      const g = await scoreGrounding(join(r.checkout, "openwiki"), r.checkout);
      console.log(`  grounding: ${JSON.stringify(g)}`);
      expect(g.cited).toBeGreaterThan(0);
      expect(g.score).toBe(1); // a fabricated path across 5 files is inexcusable
      expect(g.uncitedPages).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "quality: the full parity metric set, not just grounding",
    async () => {
      const r = await theRun();
      const cfg = testConfig(join(r.workdir, "data"));
      const m = await measureBundle(join(r.checkout, "openwiki"), r.checkout, cfg);

      console.log(
        [
          "",
          "── quality (offline, via the 1.2 harness) ──────",
          `conformant       ${m.conformant} (${m.concepts} concepts, ${m.conformanceErrors} errors)`,
          `link resolution  ${m.linkResolved}/${m.linkTotal}`,
          `grounding        score ${m.grounding.score.toFixed(3)} · density ${m.grounding.density.toFixed(2)} · ${m.grounding.uncitedPages}/${m.grounding.pages} uncited`,
          `dir coverage     ${m.coverage.dirsCovered}/${m.coverage.dirsTotal}`,
          `file coverage    ${m.coverage.filesCited}/${m.coverage.filesTotal}`,
          `export coverage  ${m.coverage.exportsMentioned}/${m.coverage.exportsTotal}`,
          "────────────────────────────────────────────────",
          "",
        ].join("\n"),
      );

      expect(m.conformant).toBe(true);
      // At five source files, skipping one is a real miss rather than a
      // judgement call — a check only a tiny fixture can make.
      expect(m.coverage.fileRatio).toBe(1);
      expect(m.coverage.dirRatio).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "quality: the wiki makes the code findable (retrieval)",
    async () => {
      const r = await theRun();
      const cfg = testConfig(join(r.workdir, "data2"));
      // Deterministic embeddings: this scores the bundle, not the model.
      const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
      try {
        const questions = await loadQuestions(join(SPIKE, "questions.json"));
        const res = await scoreRetrieval(join(r.checkout, "openwiki"), r.checkout, cfg, questions);
        console.log(
          `  retrieval: recall@5 ${res.recallAt5.toFixed(3)} · MRR ${res.mrr.toFixed(3)} · ${res.misses.length}/${res.questions} missed`,
        );
        if (res.misses.length > 0) console.log(`  missed: ${res.misses.join(" | ")}`);
        expect(res.questions).toBeGreaterThan(0);
        expect(res.recallAt5).toBeGreaterThan(0);
      } finally {
        stub.restore();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "quality: any Mermaid diagram authored uses a documented form and isn't empty",
    async () => {
      // Diagrams are conditional guidance (SKILL.md's "Diagrams" section), not
      // a hard rule — and this fixture's tiny cache -> store -> index chain is
      // exactly the "single linear path" case that section says is fine to
      // skip, so presence is not asserted here (would be flaky: a fully
      // compliant run may legitimately draw none). What's checked is that any
      // fence the model does write names one of the two documented diagram
      // types and isn't left dangling.
      const r = await theRun();
      const bundle = join(r.checkout, "openwiki");
      const pages = (await walkMd(bundle)).filter(
        (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
      );
      const fences: string[] = [];
      for (const rel of pages) {
        const { content } = matter(await readFile(join(bundle, rel), "utf8"), NO_MATTER_CACHE);
        for (const m of content.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
          fences.push((m[1] ?? "").trim());
        }
      }
      console.log(`  mermaid fences authored: ${fences.length}/${pages.length} pages`);
      for (const fence of fences) {
        expect(fence.length).toBeGreaterThan(0);
        expect(/^(flowchart\s+TD|sequenceDiagram)\b/.test(fence)).toBe(true);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "no repository script was executed and no source file modified",
    async () => {
      const r = await theRun();
      expect(r.executedScript).toBe(false);
      expect(r.modified).toEqual([]);
      for (const rel of ["src/cache.ts", "src/store.ts", "src/index.ts", "src/format.ts"]) {
        expect(await readFile(join(r.checkout, rel), "utf8")).toBe(
          await readFile(join(SPIKE, "init", rel), "utf8"),
        );
      }
    },
    TIMEOUT_MS,
  );
});
