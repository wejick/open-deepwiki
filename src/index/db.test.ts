import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import {
  openDb,
  insertChunk,
  setRepoMeta,
  setVector,
  getChunksByIds,
  listChunksByPaths,
  listChunkSummaries,
  listRepoCentroids,
  listAllDocCounts,
  listRepoSummaries,
  type NewChunk,
} from "./db.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

let tmpDirs: string[] = [];
let dbs: Client[] = [];

afterEach(async () => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs = [];
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

async function openFixtureDb(): Promise<Client> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const cfg = testConfig(dir);
  const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
  dbs.push(db);
  return db;
}

function chunk(repoId: string, kind: "wiki" | "source", path: string, chunkIndex = 0): NewChunk {
  return {
    repoId,
    kind,
    path,
    filePath: `/fixture/${repoId}/${path}`,
    startLine: 1,
    endLine: 10,
    contentHash: `hash-${repoId}-${kind}-${path}-${chunkIndex}`,
    chunkIndex,
    title: kind === "wiki" ? `Title ${path}` : null,
    description: kind === "wiki" ? `Desc ${path}` : null,
    frontmatter: kind === "wiki" ? `{"type":"Code Wiki Page"}` : null,
  };
}

/** Seed a two-repo fixture: repoA has wiki+source chunks (one path with 2 chunk indices), repoB has one wiki chunk. */
async function seed(db: Client): Promise<{ wikiIds: number[] }> {
  const ids: number[] = [];
  ids.push(await insertChunk(db, chunk("repoA", "wiki", "overview")));
  ids.push(await insertChunk(db, chunk("repoA", "wiki", "token-validation")));
  ids.push(await insertChunk(db, chunk("repoA", "source", "src/a.ts")));
  ids.push(await insertChunk(db, chunk("repoA", "source", "src/a.ts", 1))); // 2nd chunk of same path
  ids.push(await insertChunk(db, chunk("repoB", "wiki", "overview")));

  const centroids: [string, number[]][] = [
    ["repoA", [0.1, 0.2, 0.3]],
    ["repoB", [0.9, 0.8, 0.7]],
  ];
  for (const [repoId, centroid] of centroids) {
    await setRepoMeta(db, {
      repoId,
      conceptTerms: repoId === "repoA" ? ["token", "auth"] : ["guide"],
      centroid,
      linkResolved: 3,
      linkTotal: 5,
    });
    await setVector(db, 1, centroid);
  }
  return { wikiIds: ids.slice(0, 2) };
}

describe("Batched index read helpers", () => {
  test("getChunksByIds returns only the requested ids, scoped to the repo", async () => {
    const db = await openFixtureDb();
    const { wikiIds } = await seed(db);

    const rows = await getChunksByIds(db, "repoA", [wikiIds[1]!, 999, wikiIds[0]!]);
    expect(rows.map((r) => r.id).toSorted()).toEqual([wikiIds[0]!, wikiIds[1]!].toSorted());
    expect(rows.every((r) => r.repoId === "repoA")).toBe(true);

    // repoB's chunk is invisible from repoA's scope even when its id is passed
    const other = await getChunksByIds(db, "repoA", [999]);
    expect(other).toEqual([]);
    expect(await getChunksByIds(db, "repoA", [])).toEqual([]);
  });

  test("listChunksByPaths returns both kinds and all chunk indices for the paths", async () => {
    const db = await openFixtureDb();
    await seed(db);

    const rows = await listChunksByPaths(db, "repoA", ["src/a.ts", "missing", "overview"]);
    const paths = rows.map((r) => `${r.kind}:${r.path}:${r.chunkIndex}`).toSorted();
    expect(paths).toEqual(["source:src/a.ts:0", "source:src/a.ts:1", "wiki:overview:0"]);

    // unknown paths yield nothing; empty set short-circuits
    expect(await listChunksByPaths(db, "repoA", ["missing"])).toEqual([]);
    expect(await listChunksByPaths(db, "repoA", [])).toEqual([]);
  });

  test("listChunkSummaries returns wiki chunk-0 titles and descriptions keyed by path", async () => {
    const db = await openFixtureDb();
    await seed(db);

    const map = await listChunkSummaries(db, "repoA", ["overview", "token-validation", "missing"]);
    expect(map.size).toBe(2);
    expect(map.get("overview")).toEqual({ title: "Title overview", description: "Desc overview" });
    expect(map.get("token-validation")).toEqual({
      title: "Title token-validation",
      description: "Desc token-validation",
    });
    expect(map.has("missing")).toBe(false);
    expect(await listChunkSummaries(db, "repoA", [])).toEqual(new Map());
  });

  test("listRepoCentroids returns one entry per repo with a centroid, in one read", async () => {
    const db = await openFixtureDb();
    await seed(db);

    const centroids = await listRepoCentroids(db);
    expect([...centroids.keys()].toSorted()).toEqual(["repoA", "repoB"]);
    const repoA = centroids.get("repoA")!;
    expect(repoA.length).toBe(3);
    repoA.forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.2, 0.3][i]!, 5)); // F32 storage rounds slightly
  });

  test("listAllDocCounts aggregates distinct paths per kind per repo", async () => {
    const db = await openFixtureDb();
    await seed(db);

    const counts = await listAllDocCounts(db);
    expect(counts.get("repoA")).toEqual({ wiki: 2, source: 1 }); // src/a.ts counted once despite 2 chunks
    expect(counts.get("repoB")).toEqual({ wiki: 1, source: 0 });
  });

  test("listRepoSummaries carries concept terms and link health without centroids", async () => {
    const db = await openFixtureDb();
    await seed(db);

    const summaries = await listRepoSummaries(db);
    const repoA = summaries.get("repoA");
    expect(repoA?.conceptTerms).toEqual(["token", "auth"]);
    expect(repoA?.linkResolved).toBe(3);
    expect(repoA?.linkTotal).toBe(5);
    expect(summaries.size).toBe(2);
  });
});
