import matter from "gray-matter";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NO_MATTER_CACHE, RESERVED_NAMES, walkMd } from "./verify.ts";

/**
 * Do the source paths a page cites actually exist in the checkout?
 * `scoreGrounding` is the bundle-level scorer acceptance gates on; the
 * `citedPath` / `citedPaths` / `lineRangeOf` parsers are shared with the
 * coverage and scope checks in `acceptance.ts`.
 *
 * The citation signal is `sources[].resource` frontmatter, not body prose —
 * the one surface both producers write into, which keeps this check
 * producer-independent. Non-`repo://` resources are legitimate OKF and are
 * ignored, not counted as unresolved. Filesystem only: no model, no network.
 */

/** A `repo://` resource, optionally with a `#L10-L20` fragment. */
const REPO_RESOURCE = /^repo:\/\/([^#]+)(?:#.*)?$/;

export type GroundingResult = {
  cited: number;
  resolved: number;
  /** `resolved / cited`, and 0 — never 1 — when nothing is cited. */
  score: number;
  /** Citations per 1000 body words. */
  density: number;
  unresolved: string[];
  /** Density's raw inputs, so alternative formulas need no change here. */
  pages: number;
  bodyWords: number;
  uniqueFiles: number;
  /** Pages citing nothing — a bundle-wide density can hide these. */
  uncitedPages: number;
};

/** The repo-relative path in a `sources[].resource`, or null if it isn't one. */
export function citedPath(resource: unknown): string | null {
  if (typeof resource !== "string") return null;
  const m = REPO_RESOURCE.exec(resource.trim());
  const raw = m?.[1];
  if (raw === undefined || raw === "") return null;

  // Refuse anything rooted outside the checkout.
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null; // escapes the checkout
      parts.pop();
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/** One page's cited paths, deduplicated — repeating a citation must not clear
 *  the density floor. The same file cited by another page still counts again. */
export function citedPaths(frontmatter: Record<string, unknown>): string[] {
  return [...citedEntriesByPath(frontmatter).keys()];
}

/** Cited paths grouped with every raw `resource` string that named them, so a
 *  bad line-range can't hide behind a good one citing the same file. */
export function citedEntriesByPath(frontmatter: Record<string, unknown>): Map<string, string[]> {
  const sources = frontmatter.sources;
  const out = new Map<string, string[]>();
  if (!Array.isArray(sources)) return out;
  for (const entry of sources) {
    if (entry === null || typeof entry !== "object") continue;
    const resource = (entry as { resource?: unknown }).resource;
    const path = citedPath(resource);
    if (path === null) continue;
    const list = out.get(path);
    if (list === undefined) out.set(path, [String(resource)]);
    else list.push(String(resource));
  }
  return out;
}

/** A `#Lstart-Lend` or single-line `#Lstart` fragment, or null if absent. */
const LINE_RANGE_RE = /#L(\d+)(?:-L(\d+))?\s*$/;

export function lineRangeOf(resource: unknown): { start: number; end: number } | null {
  if (typeof resource !== "string") return null;
  const m = LINE_RANGE_RE.exec(resource.trim());
  if (m === null) return null;
  const startRaw = m[1];
  if (startRaw === undefined) return null;
  const start = Number(startRaw);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  return { start, end };
}

function countLines(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Score a bundle's citations against the checkout it describes. */
export async function scoreGrounding(bundle: string, checkout: string): Promise<GroundingResult> {
  const mdFiles = (await walkMd(bundle)).filter(
    (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
  );

  // macOS temp dirs are themselves reached through a symlink.
  const realRoot = await realpath(checkout).catch(() => null);

  let cited = 0;
  let resolved = 0;
  let bodyWords = 0;
  let uncitedPages = 0;
  const unresolvedSet = new Set<string>();
  const uniquePaths = new Set<string>();
  const resolvedCache = new Map<string, boolean>();
  const lineCountCache = new Map<string, number>();

  const lineCountOf = async (path: string): Promise<number> => {
    const cached = lineCountCache.get(path);
    if (cached !== undefined) return cached;
    let count: number;
    try {
      count = countLines(await readFile(join(checkout, path), "utf8"));
    } catch {
      count = 0;
    }
    lineCountCache.set(path, count);
    return count;
  };

  for (const rel of mdFiles) {
    let raw: string;
    try {
      raw = await readFile(join(bundle, rel), "utf8");
    } catch {
      continue; // verifyBundle reports unreadable files
    }
    // Malformed YAML is verifyBundle's error to report, not ours to throw on.
    let parsed;
    try {
      parsed = matter(raw, NO_MATTER_CACHE);
    } catch {
      continue;
    }
    bodyWords += countWords(parsed.content);

    const entriesByPath = citedEntriesByPath(parsed.data);
    if (entriesByPath.size === 0) uncitedPages++;
    for (const [path, resources] of entriesByPath) {
      cited++;
      uniquePaths.add(path);
      let ok = resolvedCache.get(path);
      if (ok === undefined) {
        ok = realRoot === null ? false : await isCitableFile(realRoot, checkout, path);
        resolvedCache.set(path, ok);
      }
      // A hallucinated range must not hide behind an otherwise-real path.
      if (ok) {
        for (const resource of resources) {
          const range = lineRangeOf(resource);
          if (range === null) continue;
          const lines = await lineCountOf(path);
          if (range.start < 1 || range.end > lines || range.start > range.end) {
            ok = false;
            break;
          }
        }
      }
      if (ok) resolved++;
      else unresolvedSet.add(path);
    }
  }

  return {
    cited,
    resolved,
    score: cited === 0 ? 0 : resolved / cited,
    density: bodyWords === 0 ? 0 : (cited / bodyWords) * 1000,
    unresolved: [...unresolvedSet].toSorted(),
    pages: mdFiles.length,
    bodyWords,
    uniqueFiles: uniquePaths.size,
    uncitedPages,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** A regular file inside the checkout, reached without traversing a symlink —
 *  a bare `stat` would follow one. Mirrors openwiki's `resolver.ts:201-223`,
 *  except refusal counts as unresolved rather than throwing. */
async function isCitableFile(realRoot: string, checkout: string, rel: string): Promise<boolean> {
  try {
    // `lstat`, so a symlink is not a file — and a directory never was one:
    // `repo://src` names no file to cite.
    if (!(await lstat(join(checkout, rel))).isFile()) return false;
    return (await realpath(join(checkout, rel))) === resolve(realRoot, rel);
  } catch {
    return false;
  }
}
