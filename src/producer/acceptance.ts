import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NO_MATTER_CACHE,
  RESERVED_NAMES,
  walkMd,
  verifyBundle,
  type VerifyResult,
} from "./verify.ts";
import { scoreGrounding, citedPaths, type GroundingResult } from "./grounding.ts";
import { crawlSourcePaths } from "../index/crawl.ts";
import { resolveLink, LINK_RE } from "../index/ingest.ts";
import type { Config } from "../config/config.ts";

/**
 * Bundle acceptance — the one gate every producer's bundle passes before it
 * is indexed. `acceptBundle` runs the checks in order and reports which
 * failed first, so the repair retry can act on it: conformance, grounding and
 * citation density, cross-page link resolution, init coverage, and the
 * update-only scope checks (no type reassignment, no edits outside the change
 * set, churn proportionate to the source change).
 *
 * Every floor ships at 0 — measure, do not gate, until an operator
 * calibrates — and the scores are recorded either way.
 *
 * Producer-blind by construction: nothing here knows which producer wrote
 * the bundle, and `contract.test.ts` enforces that by grep. A producer's own
 * success signal is deliberately not an input — a measured run exited 0
 * claiming completion having written nothing.
 */

export type LinkScoreResult = { resolved: number; total: number; ratio: number };

export type AcceptanceResult = {
  ok: boolean;
  errors: string[];
  verification: VerifyResult;
  grounding: GroundingResult;
  linkScore: LinkScoreResult;
  /** Fraction of source directories some page cites. Init runs only. */
  coverage: number | null;
  /** Bundle churn / source churn. Update runs only. */
  churnRatio: number | null;
  /** Which check failed first, so the repair retry can respond to it. */
  failure: "conformance" | "grounding" | "link" | "coverage" | "scope" | null;
};

export type AcceptanceInput = {
  mode: "init" | "update";
  /** Source paths changed since the anchor — required to judge an update. */
  changedPaths?: string[] | undefined;
  /** Concept page bytes captured BEFORE the run. */
  pagesBefore?: Map<string, string> | undefined;
  /** `type` values in use before the run. */
  typesBefore?: string[] | undefined;
};

/** Directory of a repo-relative path, or "." for a root-level file. */
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
}

/** Concept pages (excluding reserved structural files) and their bytes. */
export async function conceptPages(bundle: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await walkMd(bundle)) {
    if (RESERVED_NAMES.has(rel.split("/").at(-1) ?? "")) continue;
    try {
      out.set(rel, await readFile(join(bundle, rel), "utf8"));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Score of in-body cross-page link resolution, reusing the indexer's own
 * `resolveLink` (and its `LINK_RE` pattern) so this can never drift from what
 * `ingestBundle` actually resolves. Unlike `ingestBundle`'s own `linkTotal`
 * (which counts every link match for a coarse density stat), a target that
 * cannot possibly be a cross-page link — an external URL, a `repo://`
 * citation — is not a candidate at all and is excluded from `total`, not
 * counted as unresolved; conflating the two would make an ordinary external
 * reference drag this score down for no reason. Producer-independent:
 * filesystem only, no DB. A bundle with no cross-page link candidates scores
 * 1 — vacuously perfect, not vacuously broken — since a page having none is
 * unremarkable on its own.
 */
export async function scoreLinks(bundle: string): Promise<LinkScoreResult> {
  const pages = await conceptPages(bundle);
  const conceptIds = new Set([...pages.keys()].map((rel) => rel.replace(/\.md$/, "")));
  let resolved = 0;
  let total = 0;
  for (const [rel, raw] of pages) {
    const fromDir = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
    let body: string;
    try {
      body = matter(raw, NO_MATTER_CACHE).content;
    } catch {
      continue; // malformed page — verifyBundle reports it
    }
    for (const m of body.matchAll(LINK_RE)) {
      const target = m[1] ?? "";
      if (!target) continue;
      const clean = target.split("#")[0] ?? "";
      if (!clean.endsWith(".md")) continue; // not a cross-page link candidate
      total++;
      if (resolveLink(target, fromDir, conceptIds) !== null) resolved++;
    }
  }
  return { resolved, total, ratio: total === 0 ? 1 : resolved / total };
}

/** `type` per concept page. */
async function typesByPage(bundle: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [rel, raw] of await conceptPages(bundle)) {
    try {
      const t = matter(raw, NO_MATTER_CACHE).data.type;
      if (typeof t === "string") out.set(rel, t);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The fraction of source directories some page cites a file in. Init runs have
 * no previous bundle to compare against, so conformance and grounding both pass
 * on a bundle truncated by an exhausted context; this is what catches that.
 */
export async function initCoverage(bundle: string, sourcePaths: string[]): Promise<number> {
  if (sourcePaths.length === 0) return 1;
  const sourceSet = new Set(sourcePaths);
  const cited = new Set<string>();
  for (const [, raw] of await conceptPages(bundle)) {
    try {
      for (const p of citedPaths(matter(raw, NO_MATTER_CACHE).data)) {
        if (sourceSet.has(p)) cited.add(dirOf(p));
      }
    } catch {
      continue;
    }
  }
  const total = new Set(sourcePaths.map(dirOf));
  return total.size === 0 ? 1 : cited.size / total.size;
}

/** Cited paths per page, from raw page bytes. */
function citationsOf(pages: Map<string, string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [rel, raw] of pages) {
    try {
      out.set(rel, new Set(citedPaths(matter(raw, NO_MATTER_CACHE).data)));
    } catch {
      out.set(rel, new Set()); // malformed page — verifyBundle reports it
    }
  }
  return out;
}

/**
 * Pages a change set could legitimately touch: those citing a changed path,
 * plus those that did not exist before.
 *
 * Citations are read from BOTH sides of the run. A page deleted because the
 * file it documented was deleted has no post-run citations at all, and a page
 * that swapped one citation for another would otherwise look untouchable — in
 * both cases the pre-run citations are the ones that justify the edit.
 */
function pagesAffectedBy(
  changed: string[],
  citationsNow: Map<string, Set<string>>,
  citationsBefore: Map<string, Set<string>>,
  before: Map<string, string>,
): Set<string> {
  const changedSet = new Set(changed);
  const affected = new Set<string>();
  const citesChanged = (cites: Set<string> | undefined): boolean => {
    for (const c of cites ?? []) if (changedSet.has(c)) return true;
    return false;
  };
  for (const rel of new Set([...citationsNow.keys(), ...citationsBefore.keys()])) {
    if (!before.has(rel)) {
      affected.add(rel); // new page
      continue;
    }
    if (citesChanged(citationsNow.get(rel)) || citesChanged(citationsBefore.get(rel))) {
      affected.add(rel);
    }
  }
  return affected;
}

export async function acceptBundle(
  cfg: Config,
  bundle: string,
  checkout: string,
  input: AcceptanceInput,
): Promise<AcceptanceResult> {
  const errors: string[] = [];
  const verification = await verifyBundle(bundle);
  const grounding = await scoreGrounding(bundle, checkout);
  const linkScore = await scoreLinks(bundle);
  let coverage: number | null = null;
  let churnRatio: number | null = null;

  const fail = (
    kind: NonNullable<AcceptanceResult["failure"]>,
    message: string,
  ): AcceptanceResult => {
    errors.push(message);
    return {
      ok: false,
      errors,
      verification,
      grounding,
      linkScore,
      coverage,
      churnRatio,
      failure: kind,
    };
  };

  // 1. Structural conformance.
  if (!verification.ok) {
    return fail(
      "conformance",
      `bundle is not conformant: ${verification.errors
        .slice(0, 5)
        .map((e) => `${e.file} (${e.reason})`)
        .join("; ")}`,
    );
  }

  // 2. Grounding. A bundle citing nothing resolves 100% of nothing, so the
  //    density floor is not optional.
  if (grounding.score < cfg.grounding.min) {
    return fail(
      "grounding",
      `grounding score ${grounding.score.toFixed(3)} below floor ${cfg.grounding.min}` +
        (grounding.unresolved.length > 0
          ? ` — unresolved: ${grounding.unresolved.slice(0, 5).join(", ")}`
          : ""),
    );
  }
  if (grounding.density < cfg.grounding.minDensity) {
    return fail(
      "grounding",
      `citation density ${grounding.density.toFixed(2)} below floor ${cfg.grounding.minDensity} — ${grounding.uncitedPages}/${grounding.pages} pages cite nothing`,
    );
  }

  // 2b. Link resolution — same "measure, don't gate by default" shape as
  //     grounding, and for the same reason: an uncalibrated floor rejects
  //     bundles that legitimately cite a page outside the current scope.
  if (linkScore.ratio < cfg.linkMin) {
    return fail(
      "link",
      `link score ${linkScore.ratio.toFixed(3)} below floor ${cfg.linkMin} — ${linkScore.total - linkScore.resolved}/${linkScore.total} links unresolved`,
    );
  }

  // 3. Init only: does the bundle actually cover the repository?
  if (input.mode === "init") {
    coverage = await initCoverage(bundle, await crawlSourcePaths(checkout, cfg));
    if (coverage < cfg.initCoverageMin) {
      return fail(
        "coverage",
        `initial bundle covers ${(coverage * 100).toFixed(0)}% of source directories, below floor ${(cfg.initCoverageMin * 100).toFixed(0)}%`,
      );
    }
  }

  // 4. Update only: scoped-update checks.
  if (input.mode === "update" && input.pagesBefore !== undefined) {
    const before = input.pagesBefore;
    const now = await conceptPages(bundle);
    const citationsNow = citationsOf(now);
    const citationsBefore = citationsOf(before);

    // 4a. An existing page keeps its `type`.
    if (input.typesBefore !== undefined) {
      const typesNow = await typesByPage(bundle);
      const allowed = new Set(input.typesBefore);
      for (const [rel, t] of typesNow) {
        if (before.has(rel) && !allowed.has(t)) {
          return fail("scope", `page ${rel} was reassigned to type "${t}", which is not in use`);
        }
      }
    }

    // 4b. Pages outside the change set stay byte-identical. Reserved files
    //     legitimately track others, and conceptPages already excludes them.
    const changed = input.changedPaths ?? [];
    const affected = pagesAffectedBy(changed, citationsNow, citationsBefore, before);
    const touched = [...before.keys()].filter((k) => before.get(k) !== now.get(k));
    const illegal = touched.filter((k) => !affected.has(k));
    if (illegal.length > 0) {
      return fail(
        "scope",
        `pages outside the change set were modified: ${illegal.slice(0, 5).join(", ")}`,
      );
    }

    // 4c. Bundle churn must be proportionate to source churn. Measured on every
    //     update; gated only once an operator sets a ceiling, like the other
    //     floors — and note the scale before setting one: a bundle has far fewer
    //     pages than a repo has files, so one page revised for one changed file
    //     out of 500 already reads as ~25x.
    if (before.size > 0 && changed.length > 0) {
      const sourceCount = (await crawlSourcePaths(checkout, cfg)).length;
      if (sourceCount > 0) {
        const bundleChurn = (touched.length + Math.max(0, now.size - before.size)) / before.size;
        churnRatio = bundleChurn / (changed.length / sourceCount);
        if (cfg.updateMaxChurnRatio > 0 && churnRatio > cfg.updateMaxChurnRatio) {
          return fail(
            "scope",
            `bundle churn is disproportionate: ${churnRatio.toFixed(1)}x the source churn (ceiling ${cfg.updateMaxChurnRatio}x)`,
          );
        }
      }
    }
  }

  return {
    ok: true,
    errors: [],
    verification,
    grounding,
    linkScore,
    coverage,
    churnRatio,
    failure: null,
  };
}
