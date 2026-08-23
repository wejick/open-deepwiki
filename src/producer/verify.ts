import matter from "gray-matter";
/** gray-matter caches by content string, and a throw leaves a poisoned `{}`
 *  entry that later returns empty frontmatter. An options object skips it. */
export const NO_MATTER_CACHE = {} as const;
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * OKF v0.2 bundle primitives, shared by everything that reads a bundle:
 * `bundleDir` (where the bundle lives in a checkout), `walkMd` and
 * `conceptPagePaths` (its pages), `RESERVED_NAMES` (the structural files
 * exempt from every check), and `verifyBundle` — the conformance gate: every
 * non-reserved `.md` has parseable frontmatter with a non-empty `type`, and
 * the root `index.md` exists.
 */

/**
 * Structural files at any depth: exempt from the frontmatter check and not
 * counted as concepts. openwiki emits section `index.md` files without
 * frontmatter, and `INSTRUCTIONS.md` is its wiki-goal prompt — counting either
 * as a concept skews coverage and the type vocabulary.
 */
export const RESERVED_NAMES = new Set(["index.md", "log.md", "INSTRUCTIONS.md"]);

export type VerifyError = { file: string; reason: string };
export type VerifyResult = {
  ok: boolean;
  concepts: number;
  errors: VerifyError[];
  indexPresent: boolean;
};

/** The bundle's directory name inside a checkout. Also the prefix openwiki uses
 *  when it writes repo-root-absolute cross-page links (`/openwiki/<page>.md`). */
export const BUNDLE_DIR_NAME = "openwiki";

export function bundleDir(checkoutDir: string): string {
  return join(checkoutDir, BUNDLE_DIR_NAME);
}

export async function walkMd(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .claims/, hidden files
    const rel = entry.isDirectory()
      ? (await walkMd(join(dir, entry.name))).map((f) => `${entry.name}/${f}`)
      : entry.name.endsWith(".md")
        ? [entry.name]
        : [];
    out.push(...rel);
  }
  return out;
}

/** The bundle's concept pages: every `.md` file that is not structural. */
export async function conceptPagePaths(dir: string): Promise<string[]> {
  return (await walkMd(dir))
    .filter((f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""))
    .toSorted();
}

/** One page's conformance, as a reason it fails or `null` when it passes.
 *  Shared so a producer checking its own output applies the same bar. */
export function pageConformance(raw: string): string | null {
  if (!raw.trimStart().startsWith("---")) return "missing frontmatter";
  // The `---` check catches only a *missing* block; an unparseable one is a
  // conformance failure to report, not an exception to propagate.
  let parsed;
  try {
    parsed = matter(raw, NO_MATTER_CACHE);
  } catch (err) {
    return `unparseable frontmatter: ${String(err)}`;
  }
  const type = typeof parsed.data.type === "string" ? parsed.data.type : "";
  return type.trim() === "" ? "empty type" : null;
}

export async function verifyBundle(dir: string): Promise<VerifyResult> {
  const mdFiles = await walkMd(dir);
  const errors: VerifyError[] = [];
  let concepts = 0;

  if (mdFiles.length === 0) {
    return {
      ok: false,
      concepts: 0,
      errors: [{ file: dir, reason: "bundle directory missing or empty" }],
      indexPresent: false,
    };
  }
  const indexPresent = mdFiles.includes("index.md");
  if (!indexPresent) {
    errors.push({ file: "index.md", reason: "missing root index.md" });
  }

  for (const rel of mdFiles) {
    if (RESERVED_NAMES.has(rel.split("/").at(-1) ?? "")) continue;
    concepts++;
    let raw: string;
    try {
      raw = await readFile(join(dir, rel), "utf8");
    } catch {
      errors.push({ file: rel, reason: "unreadable file" });
      continue;
    }
    const reason = pageConformance(raw);
    if (reason !== null) errors.push({ file: rel, reason });
  }

  return { ok: errors.length === 0, concepts, errors, indexPresent };
}
