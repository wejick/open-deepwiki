import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NO_MATTER_CACHE, RESERVED_NAMES, bundleDir, walkMd } from "./verify.ts";

/**
 * `.last-update.json` inside the bundle — the two-way continuity handshake
 * that lets either producer continue a bundle the other wrote. `gitHead` is
 * the commit the bundle was generated from, so an update run can scope its
 * work to what changed since; `readAnchor` is the producer-side read,
 * `writeContinuity` the one writer, `typeVocabulary` the reader feeding
 * acceptance's no-type-reassignment check.
 *
 * Three rules keep the handshake true: never drop or repurpose one of
 * openwiki's six fields; carry producer identity in `producer`, never by
 * overloading `model`; preserve unknown fields on rewrite. Shape verified
 * against a real 0.3.3 file
 * (`test/fixtures/continuity/openwiki-0.3.3.json`).
 *
 * Position vs `wip.ts`: the anchor describes the published bundle and
 * travels inside it; work in flight lives in the data dir (`repos/wip/`)
 * and is never published.
 */

/** The six fields openwiki reads. `status` gates its update no-op check. */
export type LastUpdate = {
  updatedAt: string;
  command: string;
  gitHead: string;
  model: string;
  status: string;
  language: string;
};

export type Continuity = LastUpdate & {
  /** Extension: which producer last wrote the bundle. */
  producer?: string | undefined;
  /** Any other keys found on disk, preserved verbatim. */
  [key: string]: unknown;
};

export const CONTINUITY_FILE = ".last-update.json";
const KNOWN: (keyof LastUpdate)[] = [
  "updatedAt",
  "command",
  "gitHead",
  "model",
  "status",
  "language",
];

export function continuityPath(checkoutDir: string): string {
  return join(bundleDir(checkoutDir), CONTINUITY_FILE);
}

/** A missing or corrupt file means "no anchor" — a full build, not an error. */
export async function readContinuity(checkoutDir: string): Promise<Continuity | null> {
  let raw: string;
  try {
    raw = await readFile(continuityPath(checkoutDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt — treat as absent
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // gitHead is the anchor; without it there is nothing to continue from.
  if (typeof obj.gitHead !== "string" || obj.gitHead === "") return null;
  return obj as Continuity;
}

/** The commit a bundle was generated from, or null when there is no anchor. */
export async function readAnchor(checkoutDir: string): Promise<string | null> {
  return (await readContinuity(checkoutDir))?.gitHead ?? null;
}

/** Write the file, preserving every on-disk field we are not setting — including
 *  keys this version does not know. Idempotent. */
export async function writeContinuity(
  checkoutDir: string,
  next: Partial<LastUpdate> & { producer?: string | undefined },
): Promise<Continuity> {
  const existing = (await readContinuity(checkoutDir)) ?? {};
  const merged: Record<string, unknown> = { ...existing };

  // Defaults fill only absent fields — never overwrite an openwiki value.
  const defaults: LastUpdate = {
    updatedAt: new Date().toISOString(),
    command: "update",
    gitHead: "",
    model: "",
    status: "complete",
    language: "en",
  };
  for (const key of KNOWN) {
    const supplied = next[key];
    if (supplied !== undefined) merged[key] = supplied;
    else if (merged[key] === undefined) merged[key] = defaults[key];
  }
  if (next.producer !== undefined) merged.producer = next.producer;

  await writeFile(continuityPath(checkoutDir), `${JSON.stringify(merged, null, 2)}\n`);
  return merged as Continuity;
}

/** The `type` values a bundle already uses. An update must not reassign an
 *  existing page's type; a new page may introduce a value outside this list. */
export async function typeVocabulary(bundle: string): Promise<string[]> {
  const files = (await walkMd(bundle)).filter(
    (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
  );
  const types = new Set<string>();
  for (const rel of files) {
    try {
      const fm = matter(await readFile(join(bundle, rel), "utf8"), NO_MATTER_CACHE).data;
      if (typeof fm.type === "string" && fm.type.trim() !== "") types.add(fm.type);
    } catch {
      continue; // malformed page — verifyBundle reports it
    }
  }
  return [...types].toSorted();
}
