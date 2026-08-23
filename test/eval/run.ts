#!/usr/bin/env bun
/**
 * Bundle parity harness (`bun run eval`) — dev tooling, not runtime (design D11).
 *
 * Compares two OKF bundles produced for the SAME repo at the SAME commit, so
 * the only variable is which producer wrote them. Every metric is deterministic
 * and offline; the report carries no timestamps so two runs over unchanged
 * inputs are byte-identical and diffable.
 *
 * Usage:
 *   bun run eval --checkout <repo> --a <bundleA> --b <bundleB> [--out report.json]
 *   bun run eval --checkout <repo> --a <bundleA>            # single bundle
 *
 * Deliberately lives outside `bun test`: it is a measurement tool, not an
 * assertion suite, and 1.5 runs it against real repos.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { measureBundle, type BundleMetrics } from "./metrics.ts";
import { loadQuestions, scoreRetrieval, type RetrievalResult } from "./retrieval.ts";

type Args = { checkout?: string; a?: string; b?: string; out?: string; questions?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === "--checkout") args.checkout = value;
    else if (key === "--a") args.a = value;
    else if (key === "--b") args.b = value;
    else if (key === "--out") args.out = value;
    else if (key === "--questions") args.questions = value;
  }
  return args;
}

/** Deep key-sorted clone so JSON.stringify output is order-stable. */
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  // Round floats so a last-bit difference never shows up as a diff.
  if (typeof value === "number" && !Number.isInteger(value)) return Number(value.toFixed(6));
  return value;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** One report line per label; `b` renders the comparison column. */
export function row(label: string, a: BundleMetrics, b: BundleMetrics | null): string {
  const get = (m: BundleMetrics): string => {
    switch (label) {
      case "conformant":
        return String(m.conformant);
      case "concepts":
        return String(m.concepts);
      case "plan quality": {
        const q = m.planQuality;
        if (q.plannedPages === null || q.foldedAtMerge === null) {
          return `${q.boilerplateStems} boilerplate stems (no plan file)`;
        }
        return `planned ${q.plannedPages}, fold -${q.foldedAtMerge}, ${q.boilerplateStems} boilerplate stems`;
      }
      case "pages/doc-file": {
        const g = m.planQuality.pagesPerDocFile;
        return g === null ? "n/a" : g.toFixed(3);
      }
      case "link resolution":
        return `${pct(m.linkRatio)} (${m.linkResolved}/${m.linkTotal})`;
      case "grounding score":
        return `${pct(m.grounding.score)} (${m.grounding.resolved}/${m.grounding.cited})`;
      case "grounding density":
        return m.grounding.density.toFixed(2);
      case "uncited pages":
        return `${m.grounding.uncitedPages}/${m.grounding.pages}`;
      case "dir coverage":
        return `${pct(m.coverage.dirRatio)} (${m.coverage.dirsCovered}/${m.coverage.dirsTotal})`;
      case "file coverage":
        return `${pct(m.coverage.fileRatio)} (${m.coverage.filesCited}/${m.coverage.filesTotal})`;
      case "export coverage":
        return `${pct(m.coverage.exportRatio)} (${m.coverage.exportsMentioned}/${m.coverage.exportsTotal})`;
      default:
        return "";
    }
  };
  return b === null
    ? `  ${label.padEnd(18)} ${get(a)}`
    : `  ${label.padEnd(18)} ${get(a).padEnd(22)} ${get(b)}`;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.checkout === undefined || args.a === undefined) {
    console.error(
      "usage: bun run eval --checkout <repo> --a <bundleA> [--b <bundleB>] [--out report.json]",
    );
    return 1;
  }

  // Retrieval scoring embeds queries, so it uses the ambient (real) config;
  // the offline metrics do not care which endpoint is configured.
  const cfg =
    args.questions === undefined
      ? loadConfig({ ODW_LLM_MODEL: "eval", OPENROUTER_API_KEY: "eval" })
      : loadConfig();
  const checkout = resolve(args.checkout);
  const a = await measureBundle(resolve(args.a), checkout, cfg);
  const b = args.b === undefined ? null : await measureBundle(resolve(args.b), checkout, cfg);

  let ra: RetrievalResult | null = null;
  let rb: RetrievalResult | null = null;
  if (args.questions !== undefined) {
    const questions = await loadQuestions(resolve(args.questions));
    console.log(`\nretrieval: ${questions.length} questions (embeds — not offline)`);
    ra = await scoreRetrieval(resolve(args.a), checkout, cfg, questions);
    if (args.b !== undefined) rb = await scoreRetrieval(resolve(args.b), checkout, cfg, questions);
  }

  const report = stable({
    checkout: args.checkout,
    a: { bundle: args.a, ...a, ...(ra === null ? {} : { retrieval: ra }) },
    ...(b === null
      ? {}
      : { b: { bundle: args.b, ...b, ...(rb === null ? {} : { retrieval: rb }) } }),
  });

  const labels = [
    "conformant",
    "concepts",
    "plan quality",
    "pages/doc-file",
    "link resolution",
    "grounding score",
    "grounding density",
    "uncited pages",
    "dir coverage",
    "file coverage",
    "export coverage",
  ];
  console.log(b === null ? `\n${args.a}\n` : `\n  ${"".padEnd(18)} ${"A".padEnd(22)} B\n`);
  for (const label of labels) console.log(row(label, a, b));
  if (ra !== null) {
    const fmt = (r: RetrievalResult): string =>
      `${pct(r.recallAt5)} recall@5 · ${r.mrr.toFixed(3)} MRR (${r.questions}q, ${r.misses.length} missed)`;
    console.log(
      rb === null
        ? `  ${"retrieval".padEnd(18)} ${fmt(ra)}`
        : `  ${"retrieval".padEnd(18)} ${fmt(ra)}\n  ${"".padEnd(18)} ${fmt(rb)}`,
    );
  }
  console.log("");

  if (args.out !== undefined) {
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report → ${args.out}\n`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
