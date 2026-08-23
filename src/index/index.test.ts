import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { openDb, getChunk, getRepoMeta, listChunks, listEdges, docCounts } from "./db.ts";
import { indexRepo } from "./update.ts";
import { resolveLink } from "./ingest.ts";
import { crawlSourcePaths, crawlSources } from "./crawl.ts";
import { lexicalSearch } from "./rg.ts";
import { hybridSearch } from "./search.ts";
import { createGitRepo } from "../../test/helpers/gitFixture.ts";
import { stubFakeVecEmbeddings, stubFailingEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import type { Config } from "../config/config.ts";

let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: Client[] = [];

async function checkoutWith(bundle: string): Promise<{ dir: string; checkout: string }> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const checkout = join(dir, "checkout");
  await mkdir(checkout, { recursive: true });
  await cp(bundleFixture(bundle), join(checkout, "openwiki"), { recursive: true });
  return { dir, checkout };
}

afterEach(async () => {
  for (const c of cleanups) c();
  cleanups = [];
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

describe("Shared index database without body duplication", () => {
  test("Index created on first use", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);

    await expect(stat(join(dir, "index.db"))).resolves.toBeTruthy();
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.rows.map((r) => String(r.name));
    expect(names).toContain("chunks");
    expect(names).toContain("vectors");
    expect(names).toContain("edges");
    expect(names).toContain("repos_meta");
  });

  test("Repos are isolated by query scoping", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    const b = await checkoutWith("valid2");
    tmpDirs.push(a.dir, b.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);
    await indexRepo(db, cfg, "repoB", b.checkout);

    const scoped = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "bearer",
      limit: 10,
      style: "ask",
      checkouts: new Map([
        ["repoA", a.checkout],
        ["repoB", b.checkout],
      ]),
    });
    expect(scoped.results.length).toBeGreaterThan(0);
    for (const hit of scoped.results) {
      expect(hit.repoId).toBe("repoA");
      expect(hit.path).not.toBe("database");
    }

    const scopedB = await hybridSearch(cfg, db, {
      repoId: "repoB",
      query: "storage",
      limit: 10,
      style: "ask",
      checkouts: new Map([
        ["repoA", a.checkout],
        ["repoB", b.checkout],
      ]),
    });
    expect(scopedB.results.length).toBeGreaterThan(0);
    for (const hit of scopedB.results) expect(hit.repoId).toBe("repoB");
  });

  test("Body text read from disk", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);

    // The DB schema has no body/text column — only metadata.
    const cols = await db.execute("PRAGMA table_info(chunks)");
    const names = cols.rows.map((r) => String(r.name));
    expect(names).not.toContain("body");
    expect(names).not.toContain("content");

    // Snippets come from disk, not the DB.
    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "bearer",
      limit: 5,
      style: "ask",
      checkouts: new Map([["repoA", a.checkout]]),
    });
    const hit = res.results.find((h) => h.path === "token-validation");
    expect(hit).toBeDefined();
    expect(hit?.snippet).toContain("authenticating users via bearer tokens");
  });
});

describe("OKF bundle metadata ingestion", () => {
  test("Wiki concept indexed", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);

    const chunk = await getChunk(db, "repoA", "wiki", "token-validation");
    expect(chunk).not.toBeNull();
    expect(chunk?.title).toBe("Token Validation");
    const fm = JSON.parse(chunk?.frontmatter ?? "{}") as Record<string, unknown>;
    expect(fm.type).toBe("token-validation");
    expect(fm.tags).toEqual(["validation", "token"]);
    // Line range covers the body.
    const bodyText = await Bun.file(chunk?.filePath ?? "").text();
    const lines = bodyText.split("\n");
    const covered = lines.slice((chunk?.startLine ?? 1) - 1, chunk?.endLine).join("\n");
    expect(covered).toContain("authenticating users via bearer tokens");
  });

  test("Removed concept deleted", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);
    expect(await getChunk(db, "repoA", "wiki", "token-refresh")).not.toBeNull();

    await rm(join(a.checkout, "openwiki", "token-refresh.md"));
    await indexRepo(db, cfg, "repoA", a.checkout);

    expect(await getChunk(db, "repoA", "wiki", "token-refresh")).toBeNull();
    expect(await getChunk(db, "repoA", "wiki", "token-validation")).not.toBeNull();
  });
});

describe("Concept graph derivation", () => {
  async function indexedFixtureRepo(): Promise<{ cfg: Config; db: Client; checkout: string }> {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);
    return { cfg, db, checkout: a.checkout };
  }

  test("Defensive link resolution", async () => {
    const { db } = await indexedFixtureRepo();
    const guide = await listEdges(db, "repoA", "guide");
    expect(guide.outgoing).toEqual(["token-refresh", "token-validation"]);
    const validation = await listEdges(db, "repoA", "token-validation");
    expect(validation.outgoing).toEqual(["token-refresh"]);
    const refresh = await listEdges(db, "repoA", "token-refresh");
    expect(refresh.outgoing).toEqual(["token-validation"]);

    const meta = await getRepoMeta(db, "repoA");
    expect(meta?.linkResolved).toBe(4);
    expect(meta?.linkTotal).toBe(6);
  });

  test("Broken link dropped", async () => {
    const { db } = await indexedFixtureRepo();
    const guide = await listEdges(db, "repoA", "guide");
    expect(guide.outgoing).not.toContain("missing");
    expect(guide.outgoing).not.toContain("guide"); // self-link dropped
  });

  test("Repo-root-absolute links resolve", () => {
    const ids = new Set(["workflows/repository-generation", "concepts/okf-output"]);

    // What openwiki actually writes: the bundle directory as a leading segment.
    expect(resolveLink("/openwiki/workflows/repository-generation.md", "concepts", ids)).toBe(
      "workflows/repository-generation",
    );
    // The bundle-absolute and relative forms keep working.
    expect(resolveLink("/workflows/repository-generation.md", "concepts", ids)).toBe(
      "workflows/repository-generation",
    );
    expect(resolveLink("./okf-output.md", "concepts", ids)).toBe("concepts/okf-output");

    // The prefix is only stripped when doing so names a real concept — a
    // genuinely missing page must stay unresolved either way.
    expect(resolveLink("/openwiki/workflows/nope.md", "concepts", ids)).toBeNull();
    expect(resolveLink("/openwiki/nope.md", "concepts", ids)).toBeNull();
    // A repo that legitimately has a concept *called* openwiki/... is preferred
    // over stripping, since the unstripped id matches first.
    expect(resolveLink("/openwiki/thing.md", "", new Set(["openwiki/thing", "thing"]))).toBe(
      "openwiki/thing",
    );
  });

  test("Backlinks queryable", async () => {
    const { db } = await indexedFixtureRepo();
    const validation = await listEdges(db, "repoA", "token-validation");
    expect(validation.incoming).toEqual(["guide", "token-refresh"]);
  });

  test("Edges removed with deleted concept", async () => {
    const { cfg, db, checkout } = await indexedFixtureRepo();
    await rm(join(checkout, "openwiki", "token-refresh.md"));
    await indexRepo(db, cfg, "repoA", checkout);

    const refresh = await listEdges(db, "repoA", "token-refresh");
    expect(refresh.outgoing).toEqual([]);
    expect(refresh.incoming).toEqual([]);
    const validation = await listEdges(db, "repoA", "token-validation");
    expect(validation.incoming).toEqual(["guide"]);
  });
});

describe("Raw source ingestion", () => {
  test("Excluded files are skipped", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const checkout = await createGitRepo(join(dir, "repo"), {
      "src/a.ts": "export const a = 1; // alpha\n",
      "src/b.ts": "export const b = 2; // beta\n",
      "node_modules/x.js": "module.exports = 1;\n",
      "package-lock.json": "{}\n",
      ".env": "SECRET=1\n",
      "openwiki/index.md": "---\nokf_version: '0.1'\n---\n",
    });
    await indexRepo(db, cfg, "repoA", checkout);

    const sources = (await listChunks(db, "repoA", "source")).map((c) => c.path).toSorted();
    expect(sources).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("Deleted source file removed", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const checkout = await createGitRepo(join(dir, "repo"), {
      "src/a.ts": "export const a = 1; // alpha\n",
      "src/b.ts": "export const b = 2; // beta\n",
    });
    await indexRepo(db, cfg, "repoA", checkout);
    expect((await listChunks(db, "repoA", "source")).map((c) => c.path).toSorted()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);

    await rm(join(checkout, "src", "a.ts"));
    await indexRepo(db, cfg, "repoA", checkout);
    expect((await listChunks(db, "repoA", "source")).map((c) => c.path)).toEqual(["src/b.ts"]);
  });

  test("Per-repo exclude globs › Repo-excluded files are skipped", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const checkout = await createGitRepo(join(dir, "repo"), {
      "src/a.ts": "export const a = 1; // alpha\n",
      "ci/snapshots/x.snap": "snapshot\n",
    });
    // The pipeline's merge: global globs plus the repo's registry globs.
    const repoCfg = { ...cfg, excludeGlobs: [...cfg.excludeGlobs, "**/*.snap"] };
    await indexRepo(db, repoCfg, "repoA", checkout);

    const sources = (await listChunks(db, "repoA", "source")).map((c) => c.path).toSorted();
    expect(sources).toEqual(["src/a.ts"]);
  });

  test("Per-repo exclude globs › Registry edit applies on next run", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const checkout = await createGitRepo(join(dir, "repo"), {
      "src/a.ts": "export const a = 1; // alpha\n",
      "ci/plan.yml": "stages: [build]\n",
      "src/keep.ts": "export const k = 1;\n",
    });
    await indexRepo(db, cfg, "repoA", checkout);
    expect((await listChunks(db, "repoA", "source")).length).toBe(3);

    // The operator extends excludeGlobs in registry.yaml; the next run hands
    // indexRepo the merged config. The newly excluded file's chunks are
    // dropped (on disk but no longer crawled), the rest are untouched.
    const edited = { ...cfg, excludeGlobs: [...cfg.excludeGlobs, "ci/**"] };
    await indexRepo(db, edited, "repoA", checkout);

    const sources = (await listChunks(db, "repoA", "source")).map((c) => c.path).toSorted();
    expect(sources).toEqual(["src/a.ts", "src/keep.ts"]);
  });
});

describe("Source path crawl", () => {
  test("Crawl and rg exclude the same paths for a mixed glob list", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const checkout = join(dir, "checkout");
    await createGitRepo(checkout, {
      "src/alpha.ts": "alpha marker\n",
      "y.a": "top marker\n", // *.a (suffix globs are top-level: segment match)
      "snapshots/x.snap": "snap marker\n", // **/*.snap
      "lib/y.a": "deep marker\n", // **/*.a
      "ci/build.yml": "ci marker\n", // ci/**
    });
    const cfg = testConfig(dir, {
      ODW_EXCLUDE_GLOBS: "node_modules/**,.git/**,**/*.snap,**/*.a,*.a,ci/**",
    });

    const crawled = await crawlSourcePaths(checkout, cfg);
    expect(crawled).toEqual(["src/alpha.ts"]);

    // One real rg invocation with the same globs must agree with the crawl.
    const lex = await lexicalSearch(cfg, {
      dirs: [checkout],
      lex: { mode: "literal", query: "marker" },
    });
    expect(lex.available).toBe(true);
    const lexRel = lex.files.map((f) => f.path.slice(checkout.length + 1));
    expect(lexRel).toEqual(["src/alpha.ts"]);
  });

  test("crawlSourcePaths yields exactly the paths crawlSources chunks", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const checkout = join(dir, "checkout");
    await createGitRepo(checkout, {
      "src/a.ts": "export const a = 1;\n",
      "src/nested/b.ts": "export const b = 2;\n",
      "README.md": "# r\n",
      "package-lock.json": "{}\n", // excluded by the default globs
    });
    await mkdir(join(checkout, "openwiki"), { recursive: true });
    await Bun.write(join(checkout, "openwiki", "index.md"), "# bundle\n"); // never source
    const cfg = testConfig(dir);

    const paths = await crawlSourcePaths(checkout, cfg);
    const chunked = [...new Set((await crawlSources(checkout, cfg)).map((c) => c.path))];

    // Acceptance uses the cheap crawl as the denominator for the coverage and
    // churn floors; if the two filter chains drift, those floors move with them.
    expect(paths.toSorted()).toEqual(chunked.toSorted());
    expect(paths).toContain("src/nested/b.ts");
    expect(paths.some((p) => p.startsWith("openwiki/"))).toBe(false);
  });
});

describe("Vector search with quantization", () => {
  test("Semantic query finds related document", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);

    // "authentication" never appears literally in the bundle — only
    // "authenticating" — so only vectors can find it.
    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "how is authentication handled",
      limit: 5,
      style: "ask",
      checkouts: new Map([["repoA", a.checkout]]),
    });
    expect(res.results[0]?.path).toBe("token-validation");
  });

  test("Embedding provider unavailable", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFailingEmbeddings();
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    const run = await indexRepo(db, cfg, "repoA", a.checkout);
    expect(run.warnings.join("\n")).toContain("embedding provider unavailable");
    expect(run.embedded).toBe(0);

    // Lexical search still works.
    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "bearer",
      limit: 5,
      style: "code",
      checkouts: new Map([["repoA", a.checkout]]),
    });
    expect(res.results.map((h) => h.path)).toContain("token-validation");
  });
});

describe("Repo concept derivation and centroid", () => {
  test("Concept terms derived from wiki frontmatter", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);

    const meta = await getRepoMeta(db, "repoA");
    expect(meta?.conceptTerms).toContain("token");
    expect(meta?.conceptTerms).toContain("validation");
    expect(meta?.centroid).not.toBeNull();
    expect(meta?.centroid?.length).toBe(cfg.embedding.dim);
  });

  test("Centroid updated on incremental re-index", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const a = await checkoutWith("valid");
    tmpDirs.push(a.dir);
    await indexRepo(db, cfg, "repoA", a.checkout);
    const before = await getRepoMeta(db, "repoA");

    // Change one concept body; centroid must be recomputed.
    const file = join(a.checkout, "openwiki", "token-validation.md");
    await Bun.write(
      file,
      `${await Bun.file(file).text()}\n\nToken issuance uses dynamoflux protocols.\n`,
    );
    await indexRepo(db, cfg, "repoA", a.checkout);

    const after = await getRepoMeta(db, "repoA");
    expect(JSON.stringify(after?.centroid)).not.toBe(JSON.stringify(before?.centroid));
  });

  test("Doc counts by kind", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const cfg = testConfig(dir);
    const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const checkout = await createGitRepo(join(dir, "repo"), {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "repoA", checkout);

    expect(await docCounts(db, "repoA")).toEqual({ wiki: 5, source: 2 });
  });
});
