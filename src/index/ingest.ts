import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import {
  deleteChunksByPath,
  getChunk,
  insertChunk,
  listChunks,
  listEdges,
  setRepoEdges,
  upsertChunk,
  type ChunkKind,
  type Edge,
  type NewChunk,
} from "./db.ts";
import { BUNDLE_DIR_NAME, NO_MATTER_CACHE, RESERVED_NAMES, walkMd } from "../producer/verify.ts";

/**
 * OKF bundle ingestion (3.2): parse concept files (YAML frontmatter + body),
 * register wiki chunks (id = bundle-relative path sans `.md`), compute body
 * line ranges, and derive advisory concept edges from markdown links
 * (defensive absolute/relative resolution; broken/self/duplicate links are
 * silently dropped).
 */

export type IngestBundleResult = {
  /** Concept ids (changed) whose chunk text needs (re-)embedding. */
  changed: { id: string; text: string; chunkId: number; filePath: string }[];
  concepts: number;
  removed: string[];
  edges: Edge[];
  linkResolved: number;
  linkTotal: number;
};

/** Exported so the acceptance layer's link-resolution score reuses this exact
 *  pattern rather than a second, potentially-drifting one. */
export const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Normalizes a Markdown link target into a bundle-relative path: strips any
 *  `#fragment` and trailing slash, then resolves `.`/`..` segments against
 *  `fromDir` for a relative target, or treats a leading `/` as bundle-root-
 *  absolute. `resolveLink` layers `.md` + concept-id validation on top; the
 *  wiki viewer's directory-link rewriting (e.g. `index.md`'s `[x](x/)`
 *  entries, which aren't concepts) uses this directly. */
export function joinBundlePath(target: string, fromDir: string): string {
  const clean = (target.split("#")[0] ?? "").replace(/\/+$/, "");
  if (clean.startsWith("/")) return clean.slice(1);
  const parts = (fromDir ? `${fromDir}/${clean}` : clean).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Resolve a markdown link target to a concept id (bundle-relative, sans .md). */
export function resolveLink(
  target: string,
  fromDir: string,
  conceptIds: Set<string>,
): string | null {
  const clean = target.split("#")[0] ?? "";
  if (!clean.endsWith(".md")) return null;
  const rel = joinBundlePath(target, fromDir);
  const id = rel.replace(/\.md$/, "");
  if (conceptIds.has(id)) return id;
  // openwiki writes its cross-page links repo-root-absolute — `/openwiki/x.md`
  // rather than the bundle-absolute `/x.md` — so the bundle directory shows up
  // as a leading path segment that is not part of any concept id. Accepting
  // that form too is what keeps real bundles' link graph intact.
  if (clean.startsWith("/") && id.startsWith(`${BUNDLE_DIR_NAME}/`)) {
    const withoutBundleDir = id.slice(BUNDLE_DIR_NAME.length + 1);
    if (conceptIds.has(withoutBundleDir)) return withoutBundleDir;
  }
  return null;
}

/** Split frontmatter + body line ranges. Returns [bodyStartLine(1-based), totalLines]. */
export function bodyRange(raw: string): { startLine: number; endLine: number } {
  const lines = raw.split("\n");
  if (!lines[0]?.trim().startsWith("---")) return { startLine: 1, endLine: lines.length };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      const start = i + 2; // 1-based line after the closing ---
      return { startLine: start, endLine: lines.length };
    }
  }
  return { startLine: 1, endLine: lines.length };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function ingestBundle(
  db: Client,
  repoId: string,
  bundleDir: string,
): Promise<IngestBundleResult> {
  const mdFiles = await walkMd(bundleDir);
  const conceptFiles = mdFiles.filter((f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""));
  const conceptIds = new Set(conceptFiles.map((f) => f.replace(/\.md$/, "")));

  const existing = new Map(
    (await listChunks(db, repoId, "wiki")).map((c) => [c.path, c.contentHash]),
  );
  const seen = new Set<string>();
  const changed: IngestBundleResult["changed"] = [];
  const linkTotalByFrom = new Map<string, number>();

  for (const rel of conceptFiles) {
    const id = rel.replace(/\.md$/, "");
    seen.add(id);
    const filePath = join(bundleDir, rel);
    const raw = await readFile(filePath, "utf8");
    const hash = sha256(raw);
    if (existing.get(id) === hash) continue; // unchanged — skip re-embed

    const parsed = matter(raw, NO_MATTER_CACHE);
    const type = typeof parsed.data.type === "string" ? parsed.data.type : "";
    const title = typeof parsed.data.title === "string" ? parsed.data.title : null;
    const description =
      typeof parsed.data.description === "string" ? parsed.data.description : null;
    const fm = {
      type,
      title,
      description,
      ...Object.fromEntries(
        Object.entries(parsed.data).filter(([k]) => !["type", "title", "description"].includes(k)),
      ),
    };

    const { startLine, endLine } = bodyRange(raw);
    const body = parsed.content;
    const chunk: NewChunk = {
      repoId,
      kind: "wiki" as ChunkKind,
      path: id,
      filePath,
      startLine,
      endLine,
      contentHash: hash,
      chunkIndex: 0,
      title,
      description,
      frontmatter: JSON.stringify(fm),
    };
    const chunkId = existing.has(id) ? await upsertChunk(db, chunk) : await insertChunk(db, chunk);
    if (body.trim().length > 0) {
      changed.push({ id, text: body, chunkId, filePath });
    }
  }

  // Removed concepts: delete chunks (vectors cascade) + their edges.
  const removed: string[] = [];
  for (const path of existing.keys()) {
    if (!seen.has(path)) {
      removed.push(path);
      await deleteChunksByPath(db, repoId, "wiki", path);
    }
  }

  // Edge derivation: parse links from every current concept body. Rebuilt for
  // the whole repo so removed/changed concepts always stay in sync.
  const edges = new Map<string, Edge>();
  for (const rel of conceptFiles) {
    const id = rel.replace(/\.md$/, "");
    const fromDir = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
    const raw = await readFile(join(bundleDir, rel), "utf8");
    const body = matter(raw, NO_MATTER_CACHE).content;
    const seenTargets = new Set<string>();
    let total = 0;
    for (const m of body.matchAll(LINK_RE)) {
      const target = m[1] ?? "";
      if (!target) continue;
      total++;
      const toId = resolveLink(target, fromDir, conceptIds);
      if (toId === null || toId === id || seenTargets.has(toId)) continue; // broken / self / dup
      seenTargets.add(toId);
      edges.set(`${id}->${toId}`, { fromId: id, toId });
    }
    linkTotalByFrom.set(id, total);
  }
  const edgeList = [...edges.values()];
  await setRepoEdges(db, repoId, edgeList);

  return {
    changed,
    concepts: conceptFiles.length,
    removed,
    edges: edgeList,
    linkResolved: edgeList.length,
    linkTotal: [...linkTotalByFrom.values()].reduce((a, b) => a + b, 0),
  };
}

/** One-hop neighbors of a concept (used by list_related and ask_repo context). */
export async function relatedConcepts(
  db: Client,
  repoId: string,
  id: string,
): Promise<{ outgoing: string[]; incoming: string[] }> {
  return listEdges(db, repoId, id);
}

/** Concept row lookup (used by get_wiki_page). */
export async function getConcept(db: Client, repoId: string, id: string) {
  return getChunk(db, repoId, "wiki", id);
}
