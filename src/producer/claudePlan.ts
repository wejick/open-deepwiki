import { z } from "zod";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESERVED_NAMES, pageConformance } from "./verify.ts";
import { protectionReason } from "./claudeDigest.ts";

/**
 * The page plan, which is also the run's checkpoint — the contract lives in
 * CONTRACT.md; this file holds its mechanics. The planning session writes
 * `.odw-plan.json` into the bundle: a dot-file, so `walkMd` and everything
 * downstream of it never sees it, and the work-in-progress area's wholesale
 * copies preserve and restore it for free. A page's completion is its
 * presence in the bundle with conformant frontmatter — no per-page state is
 * persisted anywhere, which is why the stamp write below is deliberately not
 * atomic: a kill mid-write corrupts the file, and the next run reads that as
 * a replan — one lost planning session, no lost page work.
 */

/** The synthesized entry point, distinct from the mechanical `index.md`. */
export const OVERVIEW_PAGE = "overview.md";

/** A dot-file, so nothing that walks the bundle's pages ever sees it. */
export const PLAN_FILE_NAME = ".odw-plan.json";

const PlanPage = z.object({
  /** Bundle-relative, e.g. `architecture/producer-pipeline.md`. */
  path: z.string().min(1),
  // Everything below is authoring cargo handed to the page session's prompt;
  // the orchestrator never interprets it, so none of it is validated.
  type: z.string().default(""),
  title: z.string().default(""),
  brief: z.string().default(""),
  /** Starting points, not research boundaries. */
  sourcePaths: z.array(z.string()).default([]),
  /** Curated by the planner — only it sees the whole tree. */
  relatedPages: z.array(z.string()).default([]),
});
export type PlanPage = z.infer<typeof PlanPage>;

const Plan = z.object({
  pages: z.array(PlanPage),
  /** Update runs only: pages the change set justifies removing. */
  deletePages: z.array(z.string()).default([]),
  /** Stamped by the orchestrator once the plan's deletions have run —
   *  never written by the planning session. */
  appliedAtSha: z.string().optional(),
});
export type Plan = z.infer<typeof Plan>;

export type PlanParse = { ok: true; plan: Plan } | { ok: false; error: string };

/** The file the planning session was told to write its plan to. */
export function parsePlan(fileContents: string | null): PlanParse {
  if (fileContents === null || fileContents.trim() === "") {
    return { ok: false, error: "the planning session produced no plan" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fileContents);
  } catch {
    return { ok: false, error: "the planning session's plan was not valid JSON" };
  }
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `the planning session's plan did not match the expected shape: ${
        issue === undefined ? "unknown field error" : `${issue.path.join(".")}: ${issue.message}`
      }`,
    };
  }
  // An empty plan is legal on an update; `normalizePlan` rejects it for init.
  return { ok: true, plan: parsed.data };
}

/** Bundle-relative, no escape, no reserved name — mirrors `citedPath`. */
function normalizePagePath(raw: string): string | null {
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  const path = parts.join("/");
  if (path === "" || !path.endsWith(".md")) return null;
  if (RESERVED_NAMES.has(parts.at(-1) ?? "")) return null;
  return path;
}

export type NormalizedPlan = { pages: PlanPage[]; deletePages: string[] };

export type Normalized = { ok: true; plan: NormalizedPlan } | { ok: false; error: string };

/** Guarantees the model isn't trusted with: no duplicate/reserved paths, an
 *  overview page always present and always last. */
export function normalizePlan(
  plan: NormalizedPlan,
  opts: { mode: "init" | "update"; existingPages?: string[] },
): Normalized {
  // An init run has no previous bundle to delete from.
  if (opts.mode === "init" && plan.deletePages.length > 0) {
    return { ok: false, error: "an init plan cannot delete pages" };
  }

  const seen = new Set<string>();
  const pages: PlanPage[] = [];
  for (const page of plan.pages) {
    const path = normalizePagePath(page.path);
    if (path === null) {
      return {
        ok: false,
        error: `the plan named an unusable page path: ${page.path}`,
      };
    }
    // One shot, unlike openwiki's retryable tool call — drop, don't fail.
    if (seen.has(path)) continue;
    seen.add(path);
    pages.push({
      ...page,
      path,
      relatedPages: page.relatedPages
        .map(normalizePagePath)
        .filter((p): p is string => p !== null && p !== path),
    });
  }

  // Before the overview is inserted below, or an empty init plan would pass.
  if (opts.mode === "init" && pages.length === 0) {
    return { ok: false, error: "the plan contained no pages" };
  }

  // Not the model's call — an unprovoked rewrite reads as a scope violation.
  const existing = new Set(opts.existingPages ?? []);
  const structureChanged = pages.some((p) => !existing.has(p.path)) || plan.deletePages.length > 0;
  const needsOverview = opts.mode === "init" || !existing.has(OVERVIEW_PAGE) || structureChanged;
  if (needsOverview && !seen.has(OVERVIEW_PAGE)) {
    pages.push({
      path: OVERVIEW_PAGE,
      type: "overview",
      title: "Overview",
      brief:
        "A compact map of what this repository is: its major domains, each linked to the page that covers it.",
      sourcePaths: [],
      relatedPages: [], // filled in at generation time, once pages exist
    });
    seen.add(OVERVIEW_PAGE);
  }

  const deletePages = plan.deletePages
    .map(normalizePagePath)
    // Never the overview, never a page this run is about to write.
    .filter((p): p is string => p !== null && p !== OVERVIEW_PAGE && !seen.has(p));

  // Stable, so a resumed run walks the same sequence a fresh one would.
  pages.sort((a, b) => {
    if ((a.path === OVERVIEW_PAGE) !== (b.path === OVERVIEW_PAGE)) {
      return a.path === OVERVIEW_PAGE ? 1 : -1;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return { ok: true, plan: { pages, deletePages } };
}

export type PlanFile =
  | { kind: "absent" }
  | { kind: "invalid"; error: string }
  | { kind: "stale"; appliedAtSha: string }
  | { kind: "unapplied"; plan: Plan }
  | { kind: "resumable"; plan: Plan };

/** The bundle's plan file, classified against the commit this run builds. */
export async function loadPlan(bundleDir: string, targetSha: string): Promise<PlanFile> {
  const raw = await readFile(join(bundleDir, PLAN_FILE_NAME), "utf8").catch(() => null);
  if (raw === null) return { kind: "absent" };
  const parsed = parsePlan(raw);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error };
  const stamp = parsed.plan.appliedAtSha;
  if (stamp === undefined) return { kind: "unapplied", plan: parsed.plan };
  if (stamp !== targetSha) return { kind: "stale", appliedAtSha: stamp };
  return { kind: "resumable", plan: parsed.plan };
}

/** Record that the plan's deletions have run: the normalized plan plus the
 *  commit being built. */
export async function stampPlan(
  bundleDir: string,
  plan: NormalizedPlan,
  targetSha: string,
): Promise<void> {
  await writeFile(
    join(bundleDir, PLAN_FILE_NAME),
    `${JSON.stringify({ ...plan, appliedAtSha: targetSha }, null, 2)}\n`,
  );
}

/* ── split planning: map and parts ──────────────────────────────────────────
 * Planning units below the session exit: the map names the areas, one part
 * per area carries its pages, and the map's stamp carries the drift check
 * for both — a part can only be stale through a stale map, because parts
 * are only read under the map that names them.
 */

/** A dot-file, like the plan — invisible to everything that walks pages. */
export const MAP_FILE_NAME = ".odw-map.json";

/** The part file for one area, also a dot-file. */
export const partFileName = (areaId: string): string => `.odw-plan.part-${areaId}.json`;

const AREA_ID = /^[a-z0-9][a-z0-9._-]*$/;

const Area = z.object({
  /** Filename-safe, so it can name the part file. */
  id: z.string().regex(AREA_ID),
  title: z.string().min(1),
  /** What the area is, in the mapper's words — authoring cargo for its sessions. */
  scope: z.string().default(""),
  /** Repo-relative dirs/files the area owns; the sizing check counts these. */
  paths: z.array(z.string().min(1)).min(1),
});
export type Area = z.infer<typeof Area>;

/** One exclusion proposal: a whole directory the mapper judges data payload,
 *  plus one line of evidence. The gate decides — never the prose. */
const ExcludeProposal = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});
export type ExcludeProposal = z.infer<typeof ExcludeProposal>;

export type AreaMap = {
  areas: Area[];
  /** The mapper's exclusion proposals, gated before any takes effect. Kept on
   *  the saved map so a resumed run re-runs the same pure gate. */
  exclude?: ExcludeProposal[];
  /** Stamped by the orchestrator once validated — never by the session. */
  targetSha?: string;
};

export type MapParse = { ok: true; map: AreaMap } | { ok: false; error: string };

export function parseMap(fileContents: string | null): MapParse {
  if (fileContents === null || fileContents.trim() === "") {
    return { ok: false, error: "the map session produced no map" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fileContents);
  } catch {
    return { ok: false, error: "the map session's map was not valid JSON" };
  }
  const parsed = z
    .object({ areas: z.array(Area).min(1), exclude: z.array(ExcludeProposal).optional() })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `the map session's map did not match the expected shape: ${
        issue === undefined ? "unknown field error" : `${issue.path.join(".")}: ${issue.message}`
      }`,
    };
  }
  return { ok: true, map: parsed.data as AreaMap };
}

/** Per-area file budget: min(5% of the tree, 1000) — the sizing rule's cap. */
export function areaFileBudget(totalFiles: number): number {
  return Math.max(1, Math.min(Math.ceil(totalFiles * 0.05), 1000));
}

/** The area count the sizing rule implies: ceil(N / budget), at least 1. */
export function expectedAreaCount(totalFiles: number): number {
  return Math.max(1, Math.ceil(totalFiles / areaFileBudget(totalFiles)));
}

/** The init plan's page budget: max(12, ceil(N/100)) — one page per hundred
 *  documentable files, floored so a small tree still affords the core pages.
 *  A ratio rather than a count, so it scales from small repos to monorepos
 *  the way the area budget's min(5%, 1000) does. */
export function pageBudget(totalFiles: number): number {
  return Math.max(12, Math.ceil(totalFiles / 100));
}

/** The scope path naming the repo root itself (`.` or `./`); its area owns
 *  only the root's own files, never the whole tree — the budget forbids that. */
const isRootScope = (raw: string): boolean =>
  raw
    .split("/")
    .filter((part) => part !== "")
    .join("/") === ".";

/** A directory scope without the trailing slash the prompt's example writes —
 *  the ownership helpers and the split match on the canonical (no-slash) form. */
const untrail = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/** Tracked files an area's paths own: prefix match, the exact file, or — for
 *  the root path `.` — the files sitting directly in the repo root. */
function filesUnder(paths: string[], trackedFiles: string[]): number {
  return trackedFiles.filter((f) =>
    paths.some(
      (p) =>
        (isRootScope(p) && !f.includes("/")) ||
        f === p ||
        f.startsWith(p.endsWith("/") ? p : `${p}/`),
    ),
  ).length;
}

/** The files one scope path owns: `.` names the root's own files, a directory
 *  owns its whole subtree, a file owns itself. */
function ownedFiles(scope: string, trackedFiles: string[]): string[] {
  if (isRootScope(scope)) return trackedFiles.filter((f) => !f.includes("/"));
  return trackedFiles.filter((f) => f === scope || f.startsWith(`${scope}/`));
}

/** The count `validateMap` charges an area: its non-root scopes' owned files,
 *  a file claimed by several paths counted once. The root's own files are
 *  exempt here, exactly as they are from the budget. */
function areaOwned(paths: string[], trackedFiles: string[]): number {
  return filesUnder(
    paths.filter((p) => !isRootScope(p)),
    trackedFiles,
  );
}

/** A repo-relative, non-escaping path an area may own. Empty segments are
 *  tolerated, as in `citedPath`: the map prompt's example writes directories
 *  with a trailing slash, and `filesUnder` matches both forms. `.` names the
 *  root's own files — the form the model reaches for from the digest's
 *  `(root)` group. */
function usableScopePath(raw: string): boolean {
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return false;
  const parts = raw.split("/").filter((part) => part !== "");
  if (parts.length === 1 && parts[0] === ".") return true;
  return parts.length > 0 && parts.every((part) => part !== "." && part !== "..");
}

export type MapValidation = { ok: true; map: AreaMap } | { ok: false; error: string };

/** Canonical scope-path form: `(root)` from the digest, backslashes, `//`,
 *  `./` prefixes and trailing slashes all name what the prompt already
 *  teaches. Null when the path stays unusable. */
function canonicalScopePath(raw: string): string | null {
  let p = raw.trim().replace(/\\+/g, "/").replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "(root)") p = ".";
  while (p.startsWith("./")) p = p.slice(2);
  return usableScopePath(p) ? p : null;
}

export type RepairedMap = { map: AreaMap; repairs: string[] };

/** Deterministic map cleanup before validation, so a synonymous-but-odd path
 *  form or a duplicate id costs a normalization instead of a dead run and a
 *  re-run of the map session. Form changes are summarized in one note; drops
 *  and merges — the semantics-touching repairs — are noted individually.
 *  Sizing is never touched: an off-sizing or over-budget map still fails
 *  validation and re-plans, because re-partitioning needs the model. */
export function repairMap(map: AreaMap): RepairedMap {
  const repairs: string[] = [];
  const areas: Area[] = [];
  const byId = new Map<string, Area>();
  let forms = 0;
  for (const source of map.areas) {
    const paths: string[] = [];
    for (const raw of source.paths) {
      const canon = canonicalScopePath(raw);
      if (canon === null) {
        repairs.push(`dropped unusable path ${raw} (area ${source.id})`);
        continue;
      }
      if (canon !== raw) forms++;
      if (!paths.includes(canon)) paths.push(canon);
    }
    const seen = byId.get(source.id);
    if (seen !== undefined) {
      for (const p of paths) if (!seen.paths.includes(p)) seen.paths.push(p);
      repairs.push(`merged duplicate area id ${source.id}`);
      continue;
    }
    const area: Area = { ...source, paths };
    byId.set(area.id, area);
    areas.push(area);
  }
  const kept = areas.filter((a) => {
    if (a.paths.length > 0) return true;
    repairs.push(`dropped area ${a.id} (no usable paths left)`);
    return false;
  });
  if (forms > 0) repairs.unshift(`normalized ${forms} path form(s)`);
  return { map: { ...map, areas: kept }, repairs };
}

/** Everything the model is not trusted with: safe unique ids, owned paths,
 *  per-area file budget, and an area count within half–double the sizing
 *  rule's expectation. */
export function validateMap(map: AreaMap, trackedFiles: string[]): MapValidation {
  const budget = areaFileBudget(trackedFiles.length);
  const expected = expectedAreaCount(trackedFiles.length);
  const ids = new Set<string>();
  for (const area of map.areas) {
    if (ids.has(area.id))
      return { ok: false, error: `the map named a duplicate area id: ${area.id}` };
    ids.add(area.id);
    for (const p of area.paths) {
      if (!usableScopePath(p)) {
        return { ok: false, error: `area ${area.id} names an unusable scope path: ${p}` };
      }
    }
    /* The budget exempts the root's own files: a flat pile of configs no
     * coherent boundary splits, and the digest shows it as one group. */
    const owned = areaOwned(area.paths, trackedFiles);
    if (owned > budget) {
      return {
        ok: false,
        error: `area ${area.id} covers ${owned} documentable files, over the ${budget}-file area budget`,
      };
    }
  }
  const min = Math.ceil(expected / 2);
  const max = expected * 2;
  if (map.areas.length < min || map.areas.length > max) {
    return {
      ok: false,
      error: `the map named ${map.areas.length} areas; the sizing rule implies ${expected} (accepted ${min}–${max})`,
    };
  }
  return { ok: true, map };
}

/* ── overflow split ────────────────────────────────────────────────────────
 * An area the mapper drew bigger than the budget is not the run's failure —
 * the mapper sizes from a digest that hides subtree totals, so overflow is
 * expected — and discarding its map would just re-run the same blind session.
 * The area is instead split deterministically into `-part-N` siblings that
 * inherit its id prefix, title and scope, so the sessions that plan each part
 * still recognize one origin area. The split partitions the area's owned
 * files exactly: no file gained, no file lost.
 */

/** One claimable piece of an over-budget area: scope paths whose owned files
 *  stay at or under the budget. */
type ScopeUnit = { paths: string[]; count: number };

/** Break one over-budget directory scope into at-most-budget units: its child
 *  directories (each recursed when it too is over budget) plus its own files,
 *  which have no name to claim as a scope other than the files themselves. */
function decomposeScope(scope: string, trackedFiles: string[], budget: number): ScopeUnit[] {
  const prefix = `${scope}/`;
  const children = new Map<string, string[]>();
  const direct: string[] = [];
  for (const f of trackedFiles) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) direct.push(f);
    else {
      const child = `${scope}/${rest.slice(0, slash)}`;
      const list = children.get(child);
      if (list === undefined) children.set(child, [f]);
      else list.push(f);
    }
  }
  const units: ScopeUnit[] = [];
  for (const [dir, files] of [...children.entries()].toSorted((a, b) => {
    return b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  })) {
    if (files.length <= budget) units.push({ paths: [dir], count: files.length });
    else units.push(...decomposeScope(dir, trackedFiles, budget));
  }
  for (let i = 0; i < direct.length; i += budget) {
    const chunk = direct.slice(i, i + budget);
    units.push({ paths: chunk, count: chunk.length });
  }
  return units;
}

/** One over-budget area's replacement: consecutive at-most-budget parts built
 *  greedily from the units in order, so siblings of one subtree stay together.
 *  The root's own files are exempt from the budget and ride on part 1. */
function splitArea(area: Area, trackedFiles: string[], budget: number): Area[] {
  const rootPaths = area.paths.filter((p) => isRootScope(p));
  const below = area.paths.filter((p) => !isRootScope(p)).map(untrail);
  // A narrower claim under a wider one adds no ownership — drop it, so the
  // split partitions the owned set instead of double-listing it.
  const maximal = below.filter((p) => !below.some((q) => q !== p && p.startsWith(`${q}/`)));
  const units: ScopeUnit[] = [];
  for (const p of maximal) {
    const files = ownedFiles(p, trackedFiles);
    if (files.length <= budget) units.push({ paths: [p], count: files.length });
    else units.push(...decomposeScope(p, trackedFiles, budget));
  }
  const parts: string[][] = [];
  let open: string[] = [];
  let openCount = 0;
  for (const unit of units) {
    if (open.length > 0 && openCount + unit.count > budget) {
      parts.push(open);
      open = [];
      openCount = 0;
    }
    open.push(...unit.paths);
    openCount += unit.count;
  }
  if (open.length > 0) parts.push(open);
  if (rootPaths.length > 0 && parts.length > 0) parts[0] = [...rootPaths, ...(parts[0] ?? [])];
  return parts.map((paths, i) => ({
    id: `${area.id}-part-${i + 1}`,
    title: area.title,
    scope: area.scope,
    paths,
  }));
}

/** Deterministic repair of an over-budget map, run before `validateMap`: any
 *  area owning more files than the budget is replaced by `-part-N` siblings.
 *  Sizing-touching like `repairMap`'s path work is not — the map still fails
 *  validation (off-count, unusable scope) when the split cannot save it. */
export function splitOverBudgetAreas(map: AreaMap, trackedFiles: string[]): RepairedMap {
  const budget = areaFileBudget(trackedFiles.length);
  const repairs: string[] = [];
  const areas: Area[] = [];
  for (const area of map.areas) {
    if (areaOwned(area.paths, trackedFiles) <= budget) {
      areas.push(area);
      continue;
    }
    const parts = splitArea(area, trackedFiles, budget);
    repairs.push(`split ${area.id} into ${parts.length} parts`);
    areas.push(...parts);
  }
  return { map: { ...map, areas }, repairs };
}

/* ── exclusion gate ────────────────────────────────────────────────────────
 * A proposal is all-or-nothing for the map: the mapper covered nothing it
 * excluded, so a rejection means the tree needs an owner the map never drew.
 * Safety is derived from the tree via `protectionReason`, never from the
 * proposal's prose; usefulness is "still owns something documentable", so a
 * no-op rule cannot be persisted.
 */
export type ExcludeGate =
  | { ok: true; globs: string[]; documentable: string[] }
  | { ok: false; error: string };

const rejectProposal = (
  proposal: ExcludeProposal,
  reason: string,
): { ok: false; error: string } => ({
  ok: false,
  error: `exclude proposal "${proposal.path}" ${reason}`,
});

/** Gate the map's exclusion proposals. Pure in the checkout's tracked files
 *  and the current documentable set (kinds and merged globs already applied),
 *  so a reused map re-derives the same verdict. */
export function gateExcludeProposals(
  proposals: ExcludeProposal[],
  args: { tracked: string[]; documentable: string[] },
): ExcludeGate {
  const dirs: string[] = [];
  for (const proposal of proposals) {
    const p = canonicalScopePath(proposal.path);
    if (p === null) return rejectProposal(proposal, "is not a usable repo-relative path");
    if (isRootScope(p)) return rejectProposal(proposal, "names the repository root");
    if (!args.tracked.some((f) => f.startsWith(`${p}/`)))
      return rejectProposal(proposal, "names no tracked directory");
    for (const f of args.tracked) {
      if (!f.startsWith(`${p}/`)) continue;
      const why = protectionReason(f);
      if (why !== null) return rejectProposal(proposal, `contains a ${why} file: ${f}`);
    }
    if (!args.documentable.some((f) => f.startsWith(`${p}/`)))
      return rejectProposal(proposal, "excludes nothing documentable (no-op)");
    if (!dirs.includes(p)) dirs.push(p);
  }
  // A proposal nested inside another accepted one adds nothing — keep the
  // outer directory and drop the inner, rather than persisting a dead rule.
  const outer = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(`${o}/`)));
  const documentable = args.documentable.filter((f) => !outer.some((d) => f.startsWith(`${d}/`)));
  return { ok: true, globs: outer.map((d) => `${d}/**`), documentable };
}

export type StrippedMap = { map: AreaMap; notes: string[] };

/** Remove what accepted exclusions took from a repaired map: an area `path`
 *  owning no documentable file is dropped, and an area left owning nothing
 *  goes with it. Root scopes keep their claim — a directory proposal can
 *  never empty the root's own files. */
export function stripMap(map: AreaMap, narrowed: string[]): StrippedMap {
  const notes: string[] = [];
  const areas: Area[] = [];
  for (const area of map.areas) {
    const paths = area.paths.filter(
      (p) => isRootScope(p) || ownedFiles(untrail(p), narrowed).length > 0,
    );
    for (const dropped of area.paths.filter((p) => !paths.includes(p)))
      notes.push(`pruned ${dropped} (area ${area.id})`);
    if (paths.length === 0) {
      notes.push(`dropped area ${area.id} (owned only excluded files)`);
      continue;
    }
    areas.push({ ...area, paths });
  }
  return { map: { ...map, areas }, notes };
}

export type MapFile =
  | { kind: "absent" }
  | { kind: "invalid"; error: string }
  | { kind: "stale"; targetSha: string }
  | { kind: "unvalidated"; map: AreaMap }
  | { kind: "current"; map: AreaMap };

/** The bundle's map file, classified against the commit this run builds. */
export async function loadMap(bundleDir: string, targetSha: string): Promise<MapFile> {
  const raw = await readFile(join(bundleDir, MAP_FILE_NAME), "utf8").catch(() => null);
  if (raw === null) return { kind: "absent" };
  const parsed = parseMap(raw);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error };
  const stamp = parsed.map.targetSha;
  if (stamp === undefined) return { kind: "unvalidated", map: parsed.map };
  if (stamp !== targetSha) return { kind: "stale", targetSha: stamp };
  return { kind: "current", map: parsed.map };
}

/** Persist a validated map, stamped with the commit being built, areas in a
 *  stable order so a resumed run walks the same sequence a fresh one would.
 *  The proposals ride along unstamped: they are re-gated on reuse, not
 *  trusted from the stamp. */
export async function saveMap(bundleDir: string, map: AreaMap, targetSha: string): Promise<void> {
  const areas = map.areas.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(
    join(bundleDir, MAP_FILE_NAME),
    `${JSON.stringify(
      {
        areas,
        ...(map.exclude === undefined || map.exclude.length === 0 ? {} : { exclude: map.exclude }),
        targetSha,
      },
      null,
      2,
    )}\n`,
  );
}

export type PartFile =
  | { kind: "absent" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; pages: PlanPage[] };

/** One area's part: present and valid means its unit is done. */
export async function readPart(bundleDir: string, areaId: string): Promise<PartFile> {
  const raw = await readFile(join(bundleDir, partFileName(areaId)), "utf8").catch(() => null);
  if (raw === null) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: "the area session's part was not valid JSON" };
  }
  const shape = z.object({ pages: z.array(PlanPage) }).safeParse(parsed);
  if (!shape.success) {
    return { kind: "invalid", error: "the area session's part did not match the expected shape" };
  }
  const seen = new Set<string>();
  for (const page of shape.data.pages) {
    const path = normalizePagePath(page.path);
    if (path === null) {
      return { kind: "invalid", error: `the part named an unusable page path: ${page.path}` };
    }
    if (seen.has(path))
      return { kind: "invalid", error: `the part named a duplicate page path: ${path}` };
    seen.add(path);
  }
  return { kind: "ok", pages: shape.data.pages };
}

/** Every area's pages, collapsed to one entry per cross-cutting subject, in
 *  the map's stable order — the raw plan the ordinary APPLY path then
 *  normalizes, stamps and applies. */
/**
 * A merged plan names each cross-cutting subject once: the area sessions
 * cannot see one another's parts, so the same subject arrives once per area —
 * as an identical title or as each area's own `<subject>.md`. Both shapes
 * fold into the first entry in map order, which keeps the unioned source
 * paths and related pages; a stem naming no cross-cutting subject never
 * folds, so per-stream `overview.md` pages and per-stream API pages survive.
 */
const CROSS_CUTTING_TERMS = [
  "state management",
  "constants",
  "configuration",
  "utilities",
  "helpers",
  "navigation",
  "routing",
  "analytics",
  "logging",
  "error handling",
];

function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function pathStem(path: string): string {
  const base = path.split("/").at(-1) ?? "";
  return base.replace(/\.md$/, "").replace(/[-_]+/g, " ").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Whether a page's filename stem names a cross-cutting subject — the same
 *  predicate the merge fold folds on, exported for the eval harness's
 *  boilerplate indicator. */
export function hasCrossCuttingStem(path: string): boolean {
  const stem = pathStem(path);
  return CROSS_CUTTING_TERMS.some((term) => stem.includes(term));
}

function unionInto(target: PlanPage, source: PlanPage): void {
  for (const p of source.sourcePaths) {
    if (!target.sourcePaths.includes(p)) target.sourcePaths.push(p);
  }
  for (const p of source.relatedPages) {
    if (!target.relatedPages.includes(p)) target.relatedPages.push(p);
  }
}

export function foldPages(pages: PlanPage[]): PlanPage[] {
  const kept: PlanPage[] = [];
  const byTitle = new Map<string, number>();
  const byStem = new Map<string, number>();
  for (const page of pages) {
    const title = titleKey(page.title);
    const stem = pathStem(page.path);
    const crossCutting = CROSS_CUTTING_TERMS.some((term) => stem.includes(term));
    const at = byTitle.get(title) ?? (crossCutting ? byStem.get(stem) : undefined);
    const target = at === undefined ? undefined : kept[at];
    if (target !== undefined) {
      unionInto(target, page);
      continue;
    }
    byTitle.set(title, kept.length);
    if (crossCutting) byStem.set(stem, kept.length);
    kept.push({
      ...page,
      sourcePaths: [...page.sourcePaths],
      relatedPages: [...page.relatedPages],
    });
  }
  return kept;
}

/** Longest directory prefix shared by every path — `"."` when they share
 *  none. The seam along which over-budget pages merge. */
function commonParent(paths: string[]): string {
  const dirs = paths.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "."));
  if (dirs.length === 0) return ".";
  let prefix = dirs[0]!;
  for (const d of dirs) {
    while (prefix !== "." && d !== prefix && !d.startsWith(`${prefix}/`)) {
      const cut = prefix.lastIndexOf("/");
      prefix = cut === -1 ? "." : prefix.slice(0, cut);
    }
  }
  return prefix;
}

/** A human title from a directory name: its last segment, hyphens and
 *  underscores spelled out, first letter capitalized. */
function titleFromParent(dir: string): string {
  const words = (dir === "." ? "root" : (dir.split("/").at(-1) ?? "root"))
    .replace(/[-_]+/g, " ")
    .trim();
  return words === "" ? "Root" : words[0]!.toUpperCase() + words.slice(1);
}

export async function mergeParts(
  bundleDir: string,
  areas: Area[],
  totalFiles: number,
): Promise<{ ok: true; plan: Plan } | { ok: false; error: string }> {
  const pages: PlanPage[] = [];
  const areaByPath = new Map<string, string>();
  for (const area of areas) {
    const part = await readPart(bundleDir, area.id);
    if (part.kind !== "ok") {
      return { ok: false, error: `area ${area.id} has no valid part (${part.kind})` };
    }
    for (const page of part.pages) {
      if (!areaByPath.has(page.path)) areaByPath.set(page.path, area.id);
      pages.push(page);
    }
  }
  const folded = foldPages(pages);
  const budgeted = enforcePageBudget(
    { pages: folded, deletePages: [] },
    totalFiles,
    folded.map((p) => areaByPath.get(p.path) ?? null),
  );
  if (!budgeted.ok) return budgeted;
  return { ok: true, plan: budgeted.plan };
}

/** Deterministic budget repair on an init plan, run at merge time before the
 *  plan is validated: while the plan exceeds the page budget, the largest
 *  group of entries sharing `type` and a common source-path parent merges —
 *  earliest in map order surviving, titled after the parent, source paths and
 *  related pages unioned — the same survivor rules the cross-cutting fold
 *  uses. Entries differing in `type`, living in different map areas, carrying
 *  a cross-cutting stem, or citing nothing are never merged: those seams are
 *  ownership, not sloppiness. A plan no eligible group can bring under the
 *  budget is reported with its numbers, not butchered. `pageAreas` attributes
 *  each page to its map area (parallel to `plan.pages`); null for a
 *  single-session plan, where no area seam exists. */
export function enforcePageBudget(
  plan: Plan,
  totalFiles: number,
  pageAreas: readonly (string | null)[] | null,
): { ok: true; plan: Plan; merged: number } | { ok: false; error: string } {
  const budget = pageBudget(totalFiles);
  type Item = { page: PlanPage; area: string | null; order: number };
  const live: Item[] = plan.pages.map((page, order) => ({
    page,
    area: pageAreas?.[order] ?? null,
    order,
  }));
  let merged = 0;
  while (live.length > budget) {
    const groups = new Map<string, Item[]>();
    for (const it of live) {
      if (it.page.sourcePaths.length === 0 || hasCrossCuttingStem(it.page.path)) continue;
      const parent = commonParent(it.page.sourcePaths);
      const key = `${it.page.type}\u0000${it.area ?? ""}\u0000${parent}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [it]);
      else group.push(it);
    }
    let best: Item[] | null = null;
    let bestParent = "";
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      if (
        best === null ||
        group.length > best.length ||
        (group.length === best.length && group[0]!.order < best[0]!.order)
      ) {
        best = group;
        bestParent = key.split("\u0000")[2] ?? ".";
      }
    }
    if (best === null) break;
    best.sort((a, b) => a.order - b.order);
    const survivor = best[0]!;
    for (const rest of best.slice(1)) unionInto(survivor.page, rest.page);
    survivor.page.title = titleFromParent(bestParent);
    merged += best.length - 1;
    const spent = new Set(best.slice(1).map((it) => it.order));
    for (let i = live.length - 1; i >= 0; i--) {
      if (spent.has(live[i]!.order)) live.splice(i, 1);
    }
  }
  if (live.length > budget) {
    const areas = [...new Set(live.map((it) => it.area).filter((a): a is string => a !== null))];
    return {
      ok: false,
      error:
        `plan exceeds the page budget: ${live.length} pages over ${budget} after merging ${merged}` +
        (areas.length > 0
          ? ` (could not merge in: ${areas.join(", ")})`
          : " (single-session plan: no area seams to merge along)"),
    };
  }
  if (merged === 0) return { ok: true, plan, merged: 0 };
  return {
    ok: true,
    plan: { pages: live.map((it) => it.page), deletePages: plan.deletePages },
    merged,
  };
}

/** Remove the map and every part — the merged, stamped plan is the
 *  checkpoint from here on, and a published bundle carries neither. Part
 *  files are found by prefix, so a stale map's parts go too even when no
 *  validated map names them. */
export async function clearPlanningArtifacts(bundleDir: string): Promise<void> {
  const files = await readdir(bundleDir).catch(() => [] as string[]);
  await Promise.all(
    [
      MAP_FILE_NAME,
      SESSIONS_FILE_NAME,
      SESSIONS_TMP,
      ...files.filter((f) => f.startsWith(".odw-plan.part-")),
    ].map((f) => rm(join(bundleDir, f), { force: true })),
  );
}

/* ── page-session identities ───────────────────────────────────────────────
 * A page session killed mid-flight — usage limit, timeout, peer abort —
 * emits no result payload, so its session id can never be scraped after the
 * fact. It is instead assigned before the child spawns and persisted here,
 * so a later run can continue that exact session with `claude -p --resume`.
 * A sidecar rather than a plan field: a corrupt record costs one resume,
 * never the plan parse (an invalid plan replans, which deletes pages).
 */

/** A dot-file, like the plan — invisible to everything that walks pages. */
export const SESSIONS_FILE_NAME = ".odw-sessions.json";

const SESSIONS_TMP = `${SESSIONS_FILE_NAME}.tmp`;

async function readSessionRecords(bundleDir: string): Promise<Record<string, string>> {
  const raw = await readFile(join(bundleDir, SESSIONS_FILE_NAME), "utf8").catch(() => null);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const records: Record<string, string> = {};
    for (const [page, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === "string") records[page] = id;
    }
    return records;
  } catch {
    return {};
  }
}

/** The identity recorded for a page, or null. */
export async function recordedSession(bundleDir: string, pagePath: string): Promise<string | null> {
  return (await readSessionRecords(bundleDir))[pagePath] ?? null;
}

/* Up to `pageWorkers` update the sidecar concurrently; a bare
 * read-modify-write from two workers would lose records, so every update
 * rides one promise chain. The write itself is temp+rename atomic, so a kill
 * mid-write leaves the previous records intact. */
let sidecarChain = Promise.resolve();
function updateSessionRecords(
  bundleDir: string,
  update: (records: Record<string, string>) => Record<string, string>,
): Promise<void> {
  const next = sidecarChain.then(async () => {
    const updated = update(await readSessionRecords(bundleDir));
    const tmp = join(bundleDir, SESSIONS_TMP);
    await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`);
    await rename(tmp, join(bundleDir, SESSIONS_FILE_NAME));
  });
  sidecarChain = next.catch(() => {});
  return next;
}

/** Record a page's session identity — always called before that session
 *  spawns, so a kill cannot cost the record. */
export function recordSessionIdentity(
  bundleDir: string,
  pagePath: string,
  id: string,
): Promise<void> {
  return updateSessionRecords(bundleDir, (records) => ({ ...records, [pagePath]: id }));
}

/** Drop a page's record: the page was produced, or its session ended in a
 *  terminal failure — either way the next attempt starts fresh. */
export function clearSessionIdentity(bundleDir: string, pagePath: string): Promise<void> {
  return updateSessionRecords(bundleDir, (records) => {
    if (!(pagePath in records)) return records;
    const { [pagePath]: _dropped, ...rest } = records;
    return rest;
  });
}

/* ── progress: the read-time count of the durable planning/page units ────── */

export type PlanProgress = {
  phase: "planning" | "pages";
  /** False marks in-flight planning that is not decomposed (no map, no plan). */
  split: boolean;
  done: number;
  total: number;
  /** Newest contributing artifact's mtime — the last progress beat. */
  lastUnitAt: string | null;
};

async function newestMtime(dir: string, files: string[]): Promise<string | null> {
  let newest: number | null = null;
  for (const f of files) {
    const s = await stat(join(dir, f)).catch(() => null);
    if (s !== null && (newest === null || s.mtimeMs > newest)) newest = s.mtimeMs;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

/** What one bundle-shaped directory can legibly report, or null. */
async function legibleProgress(dir: string): Promise<PlanProgress | null> {
  const planRaw = await readFile(join(dir, PLAN_FILE_NAME), "utf8").catch(() => null);
  const plan = planRaw === null ? null : parsePlan(planRaw);
  if (plan !== null && plan.ok) {
    const present: string[] = [];
    for (const page of plan.plan.pages) {
      const raw = await readFile(join(dir, page.path), "utf8").catch(() => null);
      if (raw !== null && pageConformance(raw) === null) present.push(page.path);
    }
    return {
      phase: "pages",
      split: true,
      done: present.length,
      total: plan.plan.pages.length,
      lastUnitAt: await newestMtime(dir, [PLAN_FILE_NAME, ...present]),
    };
  }
  const mapRaw = await readFile(join(dir, MAP_FILE_NAME), "utf8").catch(() => null);
  const map = mapRaw === null ? null : parseMap(mapRaw);
  if (map !== null && map.ok) {
    const done: string[] = [];
    for (const area of map.map.areas) {
      const part = await readPart(dir, area.id);
      if (part.kind === "ok") done.push(partFileName(area.id));
    }
    return {
      phase: "planning",
      split: true,
      done: done.length,
      total: map.map.areas.length,
      lastUnitAt: await newestMtime(dir, [MAP_FILE_NAME, ...done]),
    };
  }
  return null;
}

/**
 * Production progress, computed at read time from the durable artifacts —
 * never stored. Prefers the staged bundle, falls back to the work-in-progress
 * area so a multi-night build stays legible between runs. In-flight planning
 * with no map and no plan yet reports the undecomposed marker; everything
 * else illegible is null. Every read is best-effort: racing the producer's
 * writes yields null, never an error.
 */
export async function readPlanProgress(
  bundleDir: string,
  wipDir: string | null,
  inFlight: boolean,
): Promise<PlanProgress | null> {
  try {
    const fromBundle = await legibleProgress(bundleDir);
    if (fromBundle !== null) return fromBundle;
    if (wipDir !== null) {
      const fromWip = await legibleProgress(wipDir);
      if (fromWip !== null) return fromWip;
    }
  } catch {
    // a read raced a write — nothing legible, not an error
  }
  return inFlight ? { phase: "planning", split: false, done: 0, total: 0, lastUnitAt: null } : null;
}
