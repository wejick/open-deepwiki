import { createClient, type Client } from "@libsql/client";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Shared libSQL index store: one `<dataDir>/index.db`, every table scoped by
 * `repo_id`, WAL mode (single writer, concurrent readers). No body text is
 * ever stored — chunks carry path + line ranges + hash; bodies are read from
 * disk at query time. Vectors use libSQL's built-in F32_BLOB +
 * vector_distance_cos (no extensions).
 */

export type ChunkKind = "wiki" | "source";

export type NewChunk = {
  repoId: string;
  kind: ChunkKind;
  path: string; // wiki: concept id (bundle-relative, sans .md) | source: repo-relative file path
  filePath: string; // absolute path for on-disk body reads
  startLine: number;
  endLine: number;
  contentHash: string;
  chunkIndex: number;
  title: string | null;
  description: string | null;
  frontmatter: string | null; // JSON object (wiki only)
};

export type ChunkRow = NewChunk & { id: number };

export type Edge = { fromId: string; toId: string };

export type RepoMeta = {
  repoId: string;
  conceptTerms: string[];
  centroid: number[] | null;
  linkResolved: number;
  linkTotal: number;
};

const SCHEMA = (dim: number) => `
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wiki','source')),
  path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  description TEXT,
  frontmatter TEXT,
  UNIQUE(repo_id, kind, path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks(repo_id, kind, path);

CREATE TABLE IF NOT EXISTS vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vec F32_BLOB(${dim})
);

CREATE TABLE IF NOT EXISTS edges (
  repo_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(repo_id, from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(repo_id, to_id);

CREATE TABLE IF NOT EXISTS repos_meta (
  repo_id TEXT PRIMARY KEY,
  concept_terms TEXT NOT NULL DEFAULT '[]',
  centroid F32_BLOB(${dim}),
  link_resolved INTEGER NOT NULL DEFAULT 0,
  link_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

export async function openDb(
  filePath: string,
  opts: { dim: number; readOnly?: boolean },
): Promise<Client> {
  if (!opts.readOnly) {
    await mkdir(dirname(filePath), { recursive: true });
  }
  const db = createClient({
    url: `file:${filePath}`,
    ...(opts.readOnly ? { readOnly: true } : {}),
  });
  if (!opts.readOnly) {
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA foreign_keys = ON");
    await db.executeMultiple(SCHEMA(opts.dim));
  }
  return db;
}

// ---- chunks ----

const ROW = `id, repo_id, kind, path, file_path, start_line, end_line, content_hash, chunk_index, title, description, frontmatter`;

function toChunk(row: Record<string, unknown>): ChunkRow {
  return {
    id: Number(row.id),
    repoId: String(row.repo_id),
    kind: row.kind as ChunkKind,
    path: String(row.path),
    filePath: String(row.file_path),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    contentHash: String(row.content_hash),
    chunkIndex: Number(row.chunk_index),
    title: row.title === null ? null : String(row.title),
    description: row.description === null ? null : String(row.description),
    frontmatter: row.frontmatter === null ? null : String(row.frontmatter),
  };
}

export async function insertChunk(db: Client, chunk: NewChunk): Promise<number> {
  const r = await db.execute({
    sql: `INSERT INTO chunks (repo_id, kind, path, file_path, start_line, end_line, content_hash, chunk_index, title, description, frontmatter)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      chunk.repoId,
      chunk.kind,
      chunk.path,
      chunk.filePath,
      chunk.startLine,
      chunk.endLine,
      chunk.contentHash,
      chunk.chunkIndex,
      chunk.title,
      chunk.description,
      chunk.frontmatter,
    ],
  });
  return Number(r.rows[0]?.id);
}

export async function upsertChunk(db: Client, chunk: NewChunk): Promise<number> {
  const r = await db.execute({
    sql: `INSERT INTO chunks (repo_id, kind, path, file_path, start_line, end_line, content_hash, chunk_index, title, description, frontmatter)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_id, kind, path, chunk_index)
          DO UPDATE SET file_path = excluded.file_path, start_line = excluded.start_line,
                        end_line = excluded.end_line, content_hash = excluded.content_hash,
                        title = excluded.title, description = excluded.description,
                        frontmatter = excluded.frontmatter
          RETURNING id`,
    args: [
      chunk.repoId,
      chunk.kind,
      chunk.path,
      chunk.filePath,
      chunk.startLine,
      chunk.endLine,
      chunk.contentHash,
      chunk.chunkIndex,
      chunk.title,
      chunk.description,
      chunk.frontmatter,
    ],
  });
  return Number(r.rows[0]?.id);
}

export async function listChunks(
  db: Client,
  repoId: string,
  kind?: ChunkKind,
): Promise<ChunkRow[]> {
  const rows = kind
    ? (
        await db.execute({
          sql: `SELECT ${ROW} FROM chunks WHERE repo_id = ? AND kind = ?`,
          args: [repoId, kind],
        })
      ).rows
    : (await db.execute({ sql: `SELECT ${ROW} FROM chunks WHERE repo_id = ?`, args: [repoId] }))
        .rows;
  return rows.map(toChunk);
}

export async function getChunk(
  db: Client,
  repoId: string,
  kind: ChunkKind,
  path: string,
): Promise<ChunkRow | null> {
  const r = await db.execute({
    sql: `SELECT ${ROW} FROM chunks WHERE repo_id = ? AND kind = ? AND path = ? AND chunk_index = 0`,
    args: [repoId, kind, path],
  });
  return r.rows[0] ? toChunk(r.rows[0]) : null;
}

/** Batch lookup by primary key (e.g. vector top-k chunk ids for id→path mapping). */
export async function getChunksByIds(
  db: Client,
  repoId: string,
  ids: number[],
): Promise<ChunkRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT ${ROW} FROM chunks WHERE repo_id = ? AND id IN (${placeholders})`,
    args: [repoId, ...ids],
  });
  return r.rows.map(toChunk);
}

/** Batch lookup by path (both kinds, all chunk indices) for fusion materialization. */
export async function listChunksByPaths(
  db: Client,
  repoId: string,
  paths: string[],
): Promise<ChunkRow[]> {
  if (paths.length === 0) return [];
  const placeholders = paths.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT ${ROW} FROM chunks WHERE repo_id = ? AND path IN (${placeholders})`,
    args: [repoId, ...paths],
  });
  return r.rows.map(toChunk);
}

/** Wiki concept summaries (title/description) for a path set — neighbor/edge enrichment. */
export async function listChunkSummaries(
  db: Client,
  repoId: string,
  paths: string[],
): Promise<Map<string, { title: string | null; description: string | null }>> {
  if (paths.length === 0) return new Map();
  const placeholders = paths.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT path, title, description FROM chunks
          WHERE repo_id = ? AND kind = 'wiki' AND chunk_index = 0 AND path IN (${placeholders})`,
    args: [repoId, ...paths],
  });
  const out = new Map<string, { title: string | null; description: string | null }>();
  for (const row of r.rows) {
    out.set(String(row.path), {
      title: row.title === null ? null : String(row.title),
      description: row.description === null ? null : String(row.description),
    });
  }
  return out;
}

export async function deleteChunksByPath(
  db: Client,
  repoId: string,
  kind: ChunkKind,
  path: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM chunks WHERE repo_id = ? AND kind = ? AND path = ?`,
    args: [repoId, kind, path],
  });
}

export async function deleteChunksByIds(db: Client, repoId: string, ids: number[]): Promise<void> {
  for (const id of ids) {
    await db.execute({
      sql: `DELETE FROM chunks WHERE repo_id = ? AND id = ?`,
      args: [repoId, id],
    });
  }
}

// ---- vectors ----

export function vec32(v: number[] | Float32Array): Float32Array {
  return v instanceof Float32Array ? v : new Float32Array(v);
}

/** Vector values as a typed SQL argument (libSQL accepts bytes; keep TS happy). */
export function vectorArg(v: number[] | Float32Array): Uint8Array {
  const f = vec32(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export async function setVector(
  db: Client,
  chunkId: number,
  v: number[] | Float32Array,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO vectors (chunk_id, vec) VALUES (?, vector32(?))
          ON CONFLICT(chunk_id) DO UPDATE SET vec = excluded.vec`,
    args: [chunkId, vectorArg(v)],
  });
}

export async function deleteVector(db: Client, chunkId: number): Promise<void> {
  await db.execute({ sql: `DELETE FROM vectors WHERE chunk_id = ?`, args: [chunkId] });
}

// ---- edges ----

export async function setRepoEdges(db: Client, repoId: string, edges: Edge[]): Promise<void> {
  await db.execute({ sql: `DELETE FROM edges WHERE repo_id = ?`, args: [repoId] });
  for (const e of edges) {
    await db.execute({
      sql: `INSERT INTO edges (repo_id, from_id, to_id) VALUES (?, ?, ?)`,
      args: [repoId, e.fromId, e.toId],
    });
  }
}

export async function listEdges(
  db: Client,
  repoId: string,
  id: string,
): Promise<{ outgoing: string[]; incoming: string[] }> {
  const out = await db.execute({
    sql: `SELECT to_id FROM edges WHERE repo_id = ? AND from_id = ? ORDER BY to_id`,
    args: [repoId, id],
  });
  const inc = await db.execute({
    sql: `SELECT from_id FROM edges WHERE repo_id = ? AND to_id = ? ORDER BY from_id`,
    args: [repoId, id],
  });
  return {
    outgoing: out.rows.map((r) => String(r.to_id)),
    incoming: inc.rows.map((r) => String(r.from_id)),
  };
}

// ---- repo meta / centroids ----

export async function getRepoMeta(db: Client, repoId: string): Promise<RepoMeta | null> {
  const r = await db.execute({
    sql: `SELECT repo_id, concept_terms, centroid, link_resolved, link_total FROM repos_meta WHERE repo_id = ?`,
    args: [repoId],
  });
  const row = r.rows[0];
  if (!row) return null;
  return {
    repoId: String(row.repo_id),
    conceptTerms: JSON.parse(String(row.concept_terms)) as string[],
    centroid:
      row.centroid === null ? null : Array.from(new Float32Array(row.centroid as ArrayBuffer)),
    linkResolved: Number(row.link_resolved),
    linkTotal: Number(row.link_total),
  };
}

export async function setRepoMeta(
  db: Client,
  meta: {
    repoId: string;
    conceptTerms: string[];
    centroid: number[] | null;
    linkResolved: number;
    linkTotal: number;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO repos_meta (repo_id, concept_terms, centroid, link_resolved, link_total, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_id) DO UPDATE SET concept_terms = excluded.concept_terms,
            centroid = excluded.centroid, link_resolved = excluded.link_resolved,
            link_total = excluded.link_total, updated_at = excluded.updated_at`,
    args: [
      meta.repoId,
      JSON.stringify(meta.conceptTerms),
      meta.centroid ? vectorArg(meta.centroid) : null,
      meta.linkResolved,
      meta.linkTotal,
      new Date().toISOString(),
    ],
  });
}

export async function listIndexedRepos(db: Client): Promise<string[]> {
  const r = await db.execute(`SELECT repo_id FROM repos_meta ORDER BY repo_id`);
  return r.rows.map((row) => String(row.repo_id));
}

/** All repo centroids in one query (routing). */
export async function listRepoCentroids(db: Client): Promise<Map<string, number[]>> {
  const r = await db.execute(`SELECT repo_id, centroid FROM repos_meta WHERE centroid IS NOT NULL`);
  const out = new Map<string, number[]>();
  for (const row of r.rows) {
    out.set(String(row.repo_id), Array.from(new Float32Array(row.centroid as ArrayBuffer)));
  }
  return out;
}

/** Per-repo document counts in one query (listing). */
export async function listAllDocCounts(
  db: Client,
): Promise<Map<string, { wiki: number; source: number }>> {
  const r = await db.execute(
    `SELECT repo_id, kind, COUNT(DISTINCT path) AS n FROM chunks GROUP BY repo_id, kind`,
  );
  const out = new Map<string, { wiki: number; source: number }>();
  for (const row of r.rows) {
    const repoId = String(row.repo_id);
    const cur = out.get(repoId) ?? { wiki: 0, source: 0 };
    if (row.kind === "wiki") cur.wiki = Number(row.n);
    if (row.kind === "source") cur.source = Number(row.n);
    out.set(repoId, cur);
  }
  return out;
}

/** Per-repo listing metadata (no centroid column) in one query. */
export async function listRepoSummaries(
  db: Client,
): Promise<Map<string, { conceptTerms: string[]; linkResolved: number; linkTotal: number }>> {
  const r = await db.execute(
    `SELECT repo_id, concept_terms, link_resolved, link_total FROM repos_meta`,
  );
  const out = new Map<
    string,
    { conceptTerms: string[]; linkResolved: number; linkTotal: number }
  >();
  for (const row of r.rows) {
    out.set(String(row.repo_id), {
      conceptTerms: JSON.parse(String(row.concept_terms)) as string[],
      linkResolved: Number(row.link_resolved),
      linkTotal: Number(row.link_total),
    });
  }
  return out;
}

export async function purgeRepo(db: Client, repoId: string): Promise<void> {
  // Chunks cascade to vectors; edges and meta are deleted explicitly.
  await db.execute({ sql: `DELETE FROM chunks WHERE repo_id = ?`, args: [repoId] });
  await db.execute({ sql: `DELETE FROM edges WHERE repo_id = ?`, args: [repoId] });
  await db.execute({ sql: `DELETE FROM repos_meta WHERE repo_id = ?`, args: [repoId] });
}

export async function docCounts(
  db: Client,
  repoId: string,
): Promise<{ wiki: number; source: number }> {
  const r = await db.execute({
    sql: `SELECT kind, COUNT(DISTINCT path) AS n FROM chunks WHERE repo_id = ? GROUP BY kind`,
    args: [repoId],
  });
  let wiki = 0;
  let source = 0;
  for (const row of r.rows) {
    if (row.kind === "wiki") wiki = Number(row.n);
    if (row.kind === "source") source = Number(row.n);
  }
  return { wiki, source };
}
