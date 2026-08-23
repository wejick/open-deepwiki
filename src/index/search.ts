import type { Client } from "@libsql/client";
import type { Config } from "../config/config.ts";
import { existsSync } from "node:fs";
import { lexicalSearch, type LexOptions } from "./rg.ts";
import { embedTexts } from "./embed.ts";
import {
  getChunksByIds,
  listChunksByPaths,
  listRepoCentroids,
  vectorArg,
  type ChunkRow,
} from "./db.ts";
import { bundleDir } from "../producer/verify.ts";
import { cosine } from "./vector.ts";

/**
 * Hybrid search (3.6): weighted RRF fusion of ripgrep lexical results and
 * libSQL vector similarity, fused at path level (best chunk rank per list per
 * path). Unscoped queries route via repo centroids to the top-k repos with
 * per-repo attribution. Snippets are read from disk (never from the DB).
 *
 * Path identity: wiki chunks are keyed by concept id (bundle-relative sans
 * `.md`); source chunks by repo-relative file path. Lexical results (absolute
 * file paths) are normalized into that namespace before fusion.
 */

export type SearchHit = {
  repoId: string;
  path: string;
  kind: "wiki" | "source";
  title: string | null;
  description: string | null;
  snippet: string;
  score: number;
  /** Cosine similarity of the best vector match (null for lexical-only hits). */
  vectorSim: number | null;
  lineRanges: { start: number; end: number }[];
};

export type SearchOutput = {
  results: SearchHit[];
  warnings: string[];
  lexicalAvailable: boolean;
};

const VECTOR_LIMIT = 50;

function rrf(rank: number): number {
  return 1 / (60 + rank);
}

export async function readSnippet(
  filePath: string,
  startLine: number,
  matchLines: number[],
  maxChars = 600,
): Promise<string> {
  let text: string;
  try {
    text = await Bun.file(filePath).text();
  } catch {
    return "";
  }
  const lines = text.split("\n");
  const picks = matchLines.length > 0 ? matchLines.slice(0, 2) : [startLine];
  const first = Math.max(1, Math.min(...picks) - 2);
  const last = Math.max(...picks) + 2;
  const window = lines
    .slice(first - 1, last)
    .join("\n")
    .trim();
  return window.length > maxChars ? `${window.slice(0, maxChars)}…` : window;
}

function repoOfFile(absPath: string, checkouts: Map<string, string>): string | null {
  let best: string | null = null;
  let bestLen = 0;
  for (const [repoId, dir] of checkouts) {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    if (absPath.startsWith(prefix) && dir.length > bestLen) {
      best = repoId;
      bestLen = dir.length;
    }
  }
  return best;
}

/** Normalize an absolute file path into the per-repo chunk path namespace. */
function chunkPathOf(absPath: string, checkout: string): string {
  const bdir = bundleDir(checkout);
  const bprefix = `${bdir}/`;
  if (absPath.startsWith(bprefix)) {
    return absPath.slice(bprefix.length).replace(/\.md$/, ""); // concept id
  }
  const prefix = checkout.endsWith("/") ? checkout : `${checkout}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

export async function hybridSearch(
  cfg: Config,
  db: Client,
  opts: {
    repoId?: string | undefined;
    query: string;
    entries?: string[] | undefined;
    mode?: "auto" | "literal" | "regex" | undefined;
    limit: number;
    style: "ask" | "code";
    /** repoId -> checkout dir; also the "registered repos" view. */
    checkouts: Map<string, string>;
    /** repoId -> the repo's registry excludeGlobs (only repos that have them).
     *  Repos whose effective glob lists differ are searched in separate rg
     *  invocations so per-repo excludes stay per-repo. */
    repoExcludes?: Map<string, string[]> | undefined;
    env?: Record<string, string> | undefined;
  },
): Promise<SearchOutput> {
  const warnings: string[] = [];
  const weights = opts.style === "ask" ? cfg.fusion.ask : cfg.fusion.code;

  // ---- embed once: the same query vector drives routing and vector ranking ----
  const queryVec = await embedTexts(cfg, [opts.query]);
  if (queryVec === null) warnings.push("embedding provider unavailable — vector search disabled");
  const qv = queryVec?.[0] ?? null;

  // ---- choose target repos (scoped vs centroid routing) ----
  let repos: string[];
  if (opts.repoId) {
    if (!opts.checkouts.has(opts.repoId)) {
      throw new Error(`repo not registered: ${opts.repoId}`);
    }
    repos = [opts.repoId];
  } else {
    repos = await routeRepos(cfg, db, qv, opts.checkouts, warnings);
  }

  // ---- lexical: one rg invocation per distinct effective glob list ----
  // Repos whose merged exclude lists are identical share an invocation; the
  // common case (no repo has excludes) stays a single call over all dirs.
  const byGlobs = new Map<string, { globs: string[]; dirs: string[] }>();
  for (const repoId of repos) {
    const dir = opts.checkouts.get(repoId);
    if (!dir) continue;
    const globs = [...cfg.excludeGlobs, ...(opts.repoExcludes?.get(repoId) ?? [])];
    const key = JSON.stringify(globs);
    const group = byGlobs.get(key) ?? { globs, dirs: [] };
    group.dirs.push(bundleDir(dir), dir);
    byGlobs.set(key, group);
  }
  const lexEntries =
    opts.entries?.map((e) => e.split(/\s+/).filter((t) => t.length > 0)) ?? undefined;
  const lex: LexOptions = {
    mode: opts.mode ?? "auto",
    query: opts.query,
    ...(lexEntries ? { entries: lexEntries } : {}),
  };
  const lexicalFiles = [];
  let lexicalAvailable = true;
  for (const { globs, dirs } of byGlobs.values()) {
    const existingDirs = dirs.filter((d) => existsSync(d));
    if (existingDirs.length === 0) continue;
    const res = await lexicalSearch(
      { ...cfg, excludeGlobs: globs },
      {
        dirs: existingDirs,
        lex,
        ...(opts.env ? { env: opts.env } : {}),
      },
    );
    lexicalFiles.push(...res.files);
    if (!res.available) {
      lexicalAvailable = false;
      warnings.push(res.warning ?? "lexical search unavailable");
    } else if (res.warning) {
      warnings.push(res.warning);
    }
  }
  const lexical = { files: lexicalFiles, available: lexicalAvailable };

  // ---- vector: concurrent per-repo queries ----
  const vecByRepo = new Map<string, Map<number, { rank: number; sim: number }>>();
  if (qv) {
    const perRepo = await Promise.all(
      repos.map(async (repoId) => {
        const r = await db.execute({
          sql: `SELECT v.chunk_id, vector_distance_cos(v.vec, vector32(?)) AS d
                FROM vectors v JOIN chunks c ON c.id = v.chunk_id
                WHERE c.repo_id = ?
                ORDER BY d LIMIT ?`,
          args: [vectorArg(qv), repoId, VECTOR_LIMIT],
        });
        const m = new Map<number, { rank: number; sim: number }>();
        r.rows.forEach((row, rank) => {
          m.set(Number(row.chunk_id), { rank, sim: 1 - Number(row.d) });
        });
        return [repoId, m] as const;
      }),
    );
    for (const [repoId, m] of perRepo) vecByRepo.set(repoId, m);
  }

  // ---- phase 1: score every candidate path (no chunk-table reads) ----
  type Candidate = {
    repoId: string;
    path: string;
    score: number;
    lexLines: number[];
    vectorSim: number | null;
  };
  const candidates: Candidate[] = [];
  for (const repoId of repos) {
    const checkout = opts.checkouts.get(repoId);
    if (!checkout) continue;

    // lexical rank per path (best = lowest rank across its chunks' files)
    const lexByPath = new Map<string, { rank: number; lines: number[] }>();
    lexical.files.forEach((f, rank) => {
      if (repoOfFile(f.path, opts.checkouts) !== repoId) return;
      const key = chunkPathOf(f.path, checkout);
      const cur = lexByPath.get(key);
      if (!cur || rank < cur.rank) lexByPath.set(key, { rank, lines: f.lines });
    });

    // vector rank per path: top-k chunk ids → paths via one batched lookup
    const vecRanks = vecByRepo.get(repoId);
    const vecByPath = new Map<string, { rank: number; sim: number }>();
    if (vecRanks && vecRanks.size > 0) {
      const rows = await getChunksByIds(db, repoId, [...vecRanks.keys()]);
      for (const row of rows) {
        const v = vecRanks.get(row.id);
        if (!v) continue;
        const cur = vecByPath.get(row.path);
        if (!cur || v.rank < cur.rank) vecByPath.set(row.path, { rank: v.rank, sim: v.sim });
      }
    }

    const paths = new Set([...lexByPath.keys(), ...vecByPath.keys()]);
    for (const path of paths) {
      const lexHit = lexByPath.get(path);
      const vecHit = vecByPath.get(path);
      candidates.push({
        repoId,
        path,
        score:
          (lexHit ? weights.lexical * rrf(lexHit.rank) : 0) +
          (vecHit ? weights.vector * rrf(vecHit.rank) : 0),
        lexLines: lexHit?.lines ?? [],
        vectorSim: vecHit ? vecHit.sim : null,
      });
    }
  }
  const ranked = candidates.toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // ---- phase 2: materialize survivors in batches of `limit` (chunk rows and
  // snippet reads bounded to the returned set; unindexed lexical files are
  // silently skipped, so batching preserves the exact output semantics) ----
  const results: SearchHit[] = [];
  for (let i = 0; i < ranked.length && results.length < opts.limit; i += opts.limit) {
    const batch = ranked.slice(i, i + opts.limit);
    const byRepo = new Map<string, Candidate[]>();
    for (const c of batch) {
      const list = byRepo.get(c.repoId) ?? [];
      list.push(c);
      byRepo.set(c.repoId, list);
    }
    const chunksByRepo = new Map<string, Map<string, ChunkRow[]>>();
    await Promise.all(
      [...byRepo.entries()].map(async ([repoId, cands]) => {
        const rows = await listChunksByPaths(
          db,
          repoId,
          cands.map((c) => c.path),
        );
        const byPath = new Map<string, ChunkRow[]>();
        for (const row of rows) {
          const list = byPath.get(row.path) ?? [];
          list.push(row);
          byPath.set(row.path, list);
        }
        chunksByRepo.set(repoId, byPath);
      }),
    );
    for (const c of batch) {
      if (results.length >= opts.limit) break;
      const chunksOf = chunksByRepo.get(c.repoId)?.get(c.path) ?? [];
      const wiki = chunksOf.find((ch) => ch.kind === "wiki" && ch.chunkIndex === 0);
      // best source chunk: the one covering the first lexical match line, else chunk 0
      const firstMatch = c.lexLines[0];
      const source =
        chunksOf
          .filter((ch) => ch.kind === "source")
          .find(
            (ch) =>
              firstMatch !== undefined && firstMatch >= ch.startLine && firstMatch <= ch.endLine,
          ) ?? chunksOf.find((ch) => ch.kind === "source" && ch.chunkIndex === 0);
      const chosen = wiki ?? source ?? chunksOf[0];
      if (!chosen) continue;

      const snippet = await readSnippet(chosen.filePath, chosen.startLine, c.lexLines);
      results.push({
        repoId: c.repoId,
        path: c.path,
        kind: chosen.kind,
        title: wiki?.title ?? null,
        description: wiki?.description ?? null,
        snippet,
        score: c.score,
        vectorSim: c.vectorSim,
        lineRanges: [{ start: chosen.startLine, end: chosen.endLine }],
      });
    }
  }

  return {
    results,
    warnings,
    lexicalAvailable: lexical.available,
  };
}

/** Centroid routing: top-k repos by cosine similarity of the query embedding. */
async function routeRepos(
  cfg: Config,
  db: Client,
  queryVec: number[] | null,
  checkouts: Map<string, string>,
  warnings: string[],
): Promise<string[]> {
  if (queryVec === null) {
    // No query vector: degrade to lexical fan-out over all registered repos.
    warnings.push("centroid routing unavailable — searching all repos lexically");
    return [...checkouts.keys()];
  }
  const centroids = await listRepoCentroids(db);
  if (centroids.size === 0) {
    warnings.push("centroid routing unavailable — searching all repos lexically");
    const registered = [...checkouts.keys()];
    return registered.length > 0 ? registered : [...centroids.keys()];
  }
  const ranked = [...centroids.entries()]
    .map(([repoId, centroid]) => ({ repoId, sim: cosine(queryVec, centroid) }))
    .toSorted((a, b) => b.sim - a.sim);
  return ranked.slice(0, cfg.topKRepos).map((r) => r.repoId);
}
