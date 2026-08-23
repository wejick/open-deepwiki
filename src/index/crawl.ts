import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "../config/config.ts";
import type { NewChunk } from "./db.ts";

/**
 * Raw source crawler + chunker (3.3): walk the checkout honoring
 * include/exclude globs, skipping binary files, oversized files, secret
 * files (`.env` etc. — via the default exclude globs), and the openwiki
 * bundle directory itself. Registers path + line ranges + content hash; no
 * body copy.
 */

export const CHUNK_LINES = 400;

/** Minimal glob matcher: `*` within a segment, `**` across segments. */
export function globMatch(pattern: string, relPath: string): boolean {
  const pat = pattern.split("/");
  const segs = relPath.split("/");
  const match = (pi: number, si: number): boolean => {
    if (pi === pat.length) return si === segs.length;
    const p = pat[pi] ?? "";
    if (p === "**") {
      return match(pi + 1, si) || (si < segs.length && match(pi, si + 1));
    }
    if (si === segs.length) return false;
    const seg = segs[si] ?? "";
    // segment-level * (no slash crossing)
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return re.test(seg) && match(pi + 1, si + 1);
  };
  return match(0, 0);
}

export function isExcluded(relPath: string, cfg: Config): boolean {
  const rel = relPath.replaceAll("\\", "/");
  const included = cfg.includeGlobs.some((g) => globMatch(g, rel));
  if (!included) return true;
  return cfg.excludeGlobs.some((g) => globMatch(g, rel));
}

async function isBinary(filePath: string): Promise<boolean> {
  // NUL byte in the first 8KB -> binary (cheap, no full read).
  const buf = new Uint8Array(await Bun.file(filePath).slice(0, 8192).arrayBuffer());
  return buf.includes(0);
}

export type SourceChunk = NewChunk & { text: string };

async function walk(dir: string, baseDir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // hidden files/dirs (incl. .git)
    const abs = join(dir, entry.name);
    const rel = relative(baseDir, abs).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (rel === "openwiki" || rel.startsWith("openwiki/")) continue; // never index the bundle as source
      if (rel === "node_modules") continue; // always skip (fast path)
      await walk(abs, baseDir, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Repo-relative paths of every indexable source file. Same filters as
 * `crawlSources`, but nothing is read in full, split or hashed — acceptance
 * needs only the path set, and paying the chunking cost twice per run is what
 * this split avoids. Keep the two filter chains identical: this set is the
 * denominator for both the coverage floor and the churn ratio, so a divergence
 * would move those floors without anyone editing them.
 */
export async function crawlSourcePaths(checkoutDir: string, cfg: Config): Promise<string[]> {
  const files: string[] = [];
  await walk(checkoutDir, checkoutDir, files);

  const paths: string[] = [];
  for (const rel of files) {
    if (isExcluded(rel, cfg)) continue;
    const filePath = join(checkoutDir, rel);
    let info;
    try {
      info = await stat(filePath);
    } catch {
      continue;
    }
    if (info.size > cfg.maxFileSizeBytes) continue;
    if (await isBinary(filePath)) continue;
    paths.push(rel);
  }
  return paths;
}

export async function crawlSources(checkoutDir: string, cfg: Config): Promise<SourceChunk[]> {
  const chunks: SourceChunk[] = [];
  for (const rel of await crawlSourcePaths(checkoutDir, cfg)) {
    const filePath = join(checkoutDir, rel);
    let raw: string;
    try {
      raw = await Bun.file(filePath).text();
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (let start = 0; start < Math.max(lines.length, 1); start += CHUNK_LINES) {
      const end = Math.min(start + CHUNK_LINES, lines.length);
      const text = lines.slice(start, end).join("\n");
      chunks.push({
        repoId: "", // filled by the caller (pipeline knows the repoId)
        kind: "source",
        path: rel,
        filePath,
        startLine: start + 1,
        endLine: end,
        contentHash: createHash("sha256").update(text).digest("hex"),
        chunkIndex: Math.floor(start / CHUNK_LINES),
        title: null,
        description: null,
        frontmatter: null,
        text,
      });
    }
  }
  return chunks;
}
