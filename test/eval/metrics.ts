import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RESERVED_NAMES, verifyBundle, walkMd } from "../../src/producer/verify.ts";
import {
  PLAN_FILE_NAME,
  foldPages,
  hasCrossCuttingStem,
  parsePlan,
} from "../../src/producer/claudePlan.ts";
import { scoreGrounding, citedPaths, type GroundingResult } from "../../src/producer/grounding.ts";
import { crawlSources } from "../../src/index/crawl.ts";
import { ingestBundle } from "../../src/index/ingest.ts";
import { openDb } from "../../src/index/db.ts";
import { loadConfig, type Config } from "../../src/config/config.ts";

/** gray-matter caches by content string, and a throw leaves a poisoned `{}`
 *  entry that later returns empty frontmatter. An options object skips it. */
const NO_MATTER_CACHE = {} as const;

/**
 * Bundle comparison metrics for the parity harness — dev tooling, not runtime.
 * Deterministic and offline. Reuses the real modules (`verifyBundle`,
 * `ingestBundle`, `scoreGrounding`, `crawlSources`) rather than reimplementing
 * them, so a harness number and a runtime number cannot drift apart.
 */

export type CoverageResult = {
  /** Source directories with at least one file cited by some page. */
  dirsCovered: number;
  dirsTotal: number;
  dirRatio: number;
  /** Source files cited by some page. */
  filesCited: number;
  filesTotal: number;
  fileRatio: number;
  /** Exported identifiers named in a page body. TS/JS only — other languages
   *  contribute 0 to the denominator rather than counting as covered. */
  exportsMentioned: number;
  exportsTotal: number;
  exportRatio: number;
};

export type BundleMetrics = {
  conformant: boolean;
  concepts: number;
  conformanceErrors: number;
  linkResolved: number;
  linkTotal: number;
  linkRatio: number;
  grounding: GroundingResult;
  coverage: CoverageResult;
  planQuality: PlanQuality;
};

/** Plan-shape indicators, reported never gated: how bloated the plan behind
 *  this bundle was, and how much of it the merge fold accounts for. Both plan
 *  fields are null when the bundle carries no plan dot-file (a published
 *  bundle normally does not — point the harness at a WIP area to measure one). */
export type PlanQuality = {
  plannedPages: number | null;
  foldedAtMerge: number | null;
  /** Concept pages whose filename stem names a cross-cutting subject — the
   *  per-area-boilerplate indicator the fold cannot see post-merge. */
  boilerplateStems: number;
  /** Planned pages (or, with no plan dot-file, shipped pages) per
   *  documentable file — the plan-granularity indicator the page budget
   *  targets. Reported, never gated. */
  pagesPerDocFile: number | null;
};

const EXPORT_DECL =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const TS_JS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Exported identifiers declared in a TS/JS source file. */
export function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(EXPORT_DECL)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  for (const m of source.matchAll(EXPORT_LIST)) {
    for (const part of (m[1] ?? "").split(",")) {
      // `a as b` exports the name `b`; bare `a` exports `a`.
      const alias = part.split(/\bas\b/);
      const name = (alias.at(-1) ?? "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") names.add(name);
    }
  }
  return [...names].toSorted();
}

/** Directory of a repo-relative path, or "." for a root-level file. */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "." : rel.slice(0, i);
}

async function pageBodies(bundle: string): Promise<string[]> {
  const files = (await walkMd(bundle)).filter(
    (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
  );
  const bodies: string[] = [];
  for (const rel of files) {
    try {
      bodies.push(matter(await readFile(join(bundle, rel), "utf8"), NO_MATTER_CACHE).content);
    } catch {
      continue; // malformed page — verifyBundle reports it
    }
  }
  return bodies;
}

async function citedFileSet(bundle: string): Promise<Set<string>> {
  const files = (await walkMd(bundle)).filter(
    (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
  );
  const cited = new Set<string>();
  for (const rel of files) {
    try {
      const parsed = matter(await readFile(join(bundle, rel), "utf8"), NO_MATTER_CACHE);
      for (const p of citedPaths(parsed.data)) cited.add(p);
    } catch {
      continue;
    }
  }
  return cited;
}

export async function scoreCoverage(
  bundle: string,
  checkout: string,
  cfg: Config,
): Promise<CoverageResult> {
  const chunks = await crawlSources(checkout, cfg);
  // crawlSources chunks large files, so one path can appear several times.
  const sourceFiles = [...new Set(chunks.map((c) => c.path))].toSorted();
  const cited = await citedFileSet(bundle);
  const bodies = await pageBodies(bundle);
  const haystack = bodies.join("\n");

  const sourceSet = new Set(sourceFiles);
  // A fabricated path must not cover the directory it pretends to live in.
  const citedReal = [...cited].filter((p) => sourceSet.has(p));
  const dirsTotal = new Set(sourceFiles.map(dirOf));
  const dirsCovered = new Set(citedReal.map(dirOf));

  let exportsTotal = 0;
  let exportsMentioned = 0;
  for (const rel of sourceFiles) {
    if (!TS_JS.test(rel)) continue;
    let text: string;
    try {
      text = await readFile(join(checkout, rel), "utf8");
    } catch {
      continue;
    }
    for (const name of exportedNames(text)) {
      exportsTotal++;
      // Word-boundary match so `Store` does not count as covering `StoreEntry`.
      if (new RegExp(`\\b${name.replaceAll(/[$]/g, "\\$")}\\b`).test(haystack)) exportsMentioned++;
    }
  }

  return {
    dirsCovered: dirsCovered.size,
    dirsTotal: dirsTotal.size,
    dirRatio: dirsTotal.size === 0 ? 0 : dirsCovered.size / dirsTotal.size,
    filesCited: citedReal.length,
    filesTotal: sourceFiles.length,
    fileRatio: sourceFiles.length === 0 ? 0 : citedReal.length / sourceFiles.length,
    exportsMentioned,
    exportsTotal,
    exportRatio: exportsTotal === 0 ? 0 : exportsMentioned / exportsTotal,
  };
}

/** Plan-shape indicators for the bundle's own dot-file, best-effort: a
 *  missing or malformed plan reports nulls, never an error. */
export async function scorePlanQuality(
  bundle: string,
  conceptPaths: string[],
): Promise<PlanQuality> {
  const raw = await readFile(join(bundle, PLAN_FILE_NAME), "utf8").catch(() => null);
  const parsed = raw === null ? null : parsePlan(raw);
  const planned = parsed !== null && parsed.ok ? parsed.plan.pages : null;
  return {
    plannedPages: planned === null ? null : planned.length,
    foldedAtMerge: planned === null ? null : planned.length - foldPages(planned).length,
    boilerplateStems: conceptPaths.filter(hasCrossCuttingStem).length,
    pagesPerDocFile: null,
  };
}

/** Link resolution via the real ingester, in a throwaway DB (no embedding). */
export async function scoreLinks(
  bundle: string,
  cfg: Config,
): Promise<{ resolved: number; total: number; ratio: number }> {
  const dir = await mkdtemp(join(tmpdir(), "odw-eval-"));
  try {
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    const res = await ingestBundle(db, "eval", bundle);
    return {
      resolved: res.linkResolved,
      total: res.linkTotal,
      ratio: res.linkTotal === 0 ? 0 : res.linkResolved / res.linkTotal,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function measureBundle(
  bundle: string,
  checkout: string,
  cfg: Config = loadConfig({ ODW_LLM_MODEL: "eval", OPENROUTER_API_KEY: "eval" }),
): Promise<BundleMetrics> {
  const conformance = await verifyBundle(bundle);
  const links = await scoreLinks(bundle, cfg);
  const grounding = await scoreGrounding(bundle, checkout);
  const coverage = await scoreCoverage(bundle, checkout, cfg);
  const conceptPaths = (await walkMd(bundle)).filter(
    (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
  );
  const planQuality = await scorePlanQuality(bundle, conceptPaths);
  // Granularity falls back to shipped pages when no plan dot-file exists —
  // a published bundle normally does not carry one.
  const granularityPages = planQuality.plannedPages ?? conceptPaths.length;
  planQuality.pagesPerDocFile =
    coverage.filesTotal === 0 ? null : granularityPages / coverage.filesTotal;

  return {
    conformant: conformance.ok,
    concepts: conformance.concepts,
    conformanceErrors: conformance.errors.length,
    linkResolved: links.resolved,
    linkTotal: links.total,
    linkRatio: links.ratio,
    grounding,
    coverage,
    planQuality,
  };
}
