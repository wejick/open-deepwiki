import type { Client } from "@libsql/client";
import type { Config } from "../config/config.ts";
import { simpleGit } from "simple-git";
import { ingestBundle } from "./ingest.ts";
import { crawlSources } from "./crawl.ts";
import { embedTexts } from "./embed.ts";
import { deleteChunksByPath, listChunks, setVector, upsertChunk } from "./db.ts";
import { deriveRepoMeta } from "./centroid.ts";

/**
 * Index a repo (full or incremental) — the orchestrator the repo manager
 * pipeline calls. Bundle concepts are diffed by path+hash; source files are
 * diffed by content hash (full index) or restricted to a changed-path set
 * (`git diff --name-only old..new` from the updater). Only changed chunks are
 * re-embedded. Embedding failures degrade to metadata-only indexing.
 */

export type IndexRun = {
  wikiChunks: number;
  sourceChunks: number;
  embedded: number;
  linkResolved: number;
  linkTotal: number;
  warnings: string[];
};

export async function indexRepo(
  db: Client,
  cfg: Config,
  repoId: string,
  checkoutDir: string,
  opts: { changedSourcePaths?: Set<string> | undefined } = {},
): Promise<IndexRun> {
  const warnings: string[] = [];
  let wikiChunks = 0;
  let linkResolved = 0;
  let linkTotal = 0;

  // ---- wiki bundle (path+hash diff; edges rebuilt; removed concepts purged) ----
  const toEmbed: { chunkId: number; text: string }[] = [];
  const bundle = `${checkoutDir}/openwiki`;
  try {
    const ingested = await ingestBundle(db, repoId, bundle);
    wikiChunks = ingested.concepts;
    linkResolved = ingested.linkResolved;
    linkTotal = ingested.linkTotal;
    for (const c of ingested.changed) toEmbed.push({ chunkId: c.chunkId, text: c.text });
  } catch {
    warnings.push("bundle missing or unreadable — indexed sources only");
  }

  // ---- raw sources (restricted to changed paths for incremental updates) ----
  let sourceChunks = 0;
  const existingSource = new Map(
    (await listChunks(db, repoId, "source")).map((c) => [
      `${c.path}#${c.chunkIndex}`,
      c.contentHash,
    ]),
  );
  const crawled = await crawlSources(checkoutDir, cfg);
  const wanted = opts.changedSourcePaths
    ? crawled.filter((c) => opts.changedSourcePaths?.has(c.path))
    : crawled;
  for (const chunk of wanted) {
    const fresh = { ...chunk, repoId };
    const key = `${fresh.path}#${fresh.chunkIndex}`;
    if (existingSource.get(key) === fresh.contentHash) continue; // unchanged
    const chunkId = await upsertChunk(db, fresh);
    toEmbed.push({ chunkId, text: fresh.text });
    sourceChunks++;
  }
  // Source paths no longer on disk are purged.
  const onDisk = new Set(crawled.map((c) => c.path));
  for (const [key] of existingSource) {
    const path = key.slice(0, key.lastIndexOf("#"));
    if (!onDisk.has(path)) {
      await deleteChunksByPath(db, repoId, "source", path);
    }
  }

  // ---- embed only changed chunks ----
  let embedded = 0;
  const vecs = await embedTexts(
    cfg,
    toEmbed.map((c) => c.text),
  );
  if (vecs === null) {
    warnings.push("embedding provider unavailable — indexed metadata only (lexical search works)");
  } else {
    for (let i = 0; i < toEmbed.length; i++) {
      const entry = toEmbed[i];
      const vec = vecs[i];
      if (entry && vec) {
        await setVector(db, entry.chunkId, vec);
        embedded++;
      }
    }
  }

  // ---- per-repo derived metadata (concept terms + centroid) ----
  await deriveRepoMeta(db, repoId, { dim: cfg.embedding.dim, linkResolved, linkTotal });

  return { wikiChunks, sourceChunks, embedded, linkResolved, linkTotal, warnings };
}

/** git diff --name-only between two shas (used by the updater). */
export async function diffNames(
  oldSha: string,
  newSha: string,
  checkoutDir: string,
): Promise<string[]> {
  const g = simpleGit({ baseDir: checkoutDir });
  const out = await g.diff(["--name-only", `${oldSha}..${newSha}`]);
  return out.split("\n").filter((l) => l.trim() !== "");
}
