import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client, InStatement } from "@libsql/client";
import { openDb, listChunks } from "./db.ts";
import { indexRepo, diffNames } from "./update.ts";
import { hybridSearch } from "./search.ts";
import { lexicalSearch, expandVariants, extractTerms } from "./rg.ts";
import { createGitRepo, commitFiles } from "../../test/helpers/gitFixture.ts";
import { stubFakeVecEmbeddings, stubFailingEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { pathWithoutRg, pathWith, writeShim } from "../../test/helpers/shim.ts";
import type { Config } from "../config/config.ts";

let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: Client[] = [];

async function tmp(): Promise<string> {
  const d = await makeTmp();
  tmpDirs.push(d);
  return d;
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

async function setupRepo(opts: {
  bundle?: string;
  sources?: Record<string, string>;
  overrides?: Record<string, string>;
}): Promise<{
  cfg: Config;
  db: Client;
  checkout: string;
  dir: string;
  stub: ReturnType<typeof stubFakeVecEmbeddings>;
}> {
  const dir = await tmp();
  const cfg = testConfig(dir, opts.overrides);
  const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
  dbs.push(db);
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);
  const checkout = join(dir, "checkout");
  if (opts.bundle) {
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture(opts.bundle), join(checkout, "openwiki"), { recursive: true });
  }
  if (opts.sources) {
    await createGitRepo(checkout, opts.sources);
    if (opts.bundle) {
      await cp(bundleFixture(opts.bundle), join(checkout, "openwiki"), { recursive: true });
    }
  }
  return { cfg, db, checkout, dir, stub };
}

/** Record every SQL statement a search issues (instrumentation, not mocking). */
function recordingDb(db: Client): { db: Client; sqls: string[] } {
  const sqls: string[] = [];
  const execute = db.execute.bind(db);
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (arg: InStatement) => {
          sqls.push(typeof arg === "string" ? arg : arg.sql);
          return execute(arg);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Client;
  return { db: proxy, sqls };
}

describe("Lexical search via ripgrep", () => {
  test("Client-provided keywords used directly", async () => {
    const { cfg, db, checkout } = await setupRepo({ bundle: "valid" });
    // Kill the vector side: these assertions are about lexical semantics.
    const failing = stubFailingEmbeddings();
    cleanups.push(failing.restore);
    await indexRepo(db, cfg, "repoA", checkout);

    // Pattern built from exactly the keywords (no extraction): the only
    // matching files are those containing "bearer".
    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "totally unrelated question",
      entries: ["bearer"],
      limit: 10,
      style: "code",
      checkouts: new Map([["repoA", checkout]]),
    });
    expect(new Set(res.results.slice(0, 2).map((h) => h.path))).toEqual(
      new Set(["token-validation", "token-refresh"]),
    );
  });

  test("Multi-term keyword requires all its terms", async () => {
    const { cfg, db, checkout } = await setupRepo({ bundle: "valid" });
    const failing = stubFailingEmbeddings();
    cleanups.push(failing.restore);
    await indexRepo(db, cfg, "repoA", checkout);

    // token-validation contains both "authenticating" and "refresh";
    // token-refresh contains only "refresh" -> full-coverage ranks above.
    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "some question",
      entries: ["authenticating refresh"],
      limit: 10,
      style: "code",
      checkouts: new Map([["repoA", checkout]]),
    });
    const paths = res.results.map((h) => h.path);
    expect(paths[0]).toBe("token-validation");
    // token-refresh (only one term) ranks below if present at all.
    if (paths.includes("token-refresh")) {
      expect(paths.indexOf("token-validation")).toBeLessThan(paths.indexOf("token-refresh"));
    }
  });

  test("Fallback extraction when keywords absent", async () => {
    const terms = extractTerms("how does the token refresh work");
    expect(terms.flat().toSorted()).toEqual(["refresh", "token"]);
  });

  test("Identifier variants matched in one invocation", async () => {
    const variants = expandVariants("validateToken");
    expect(variants).toContain("validateToken");
    expect(variants).toContain("validate_token");
    expect(variants).toContain("validate-token");
    expect(variants).toContain("ValidateToken");

    const { cfg, db, checkout } = await setupRepo({
      sources: { "src/auth.ts": "export function validate_token(t: string) { return t; }\n" },
    });
    await indexRepo(db, cfg, "repoA", checkout);

    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "validateToken",
      mode: "auto",
      limit: 5,
      style: "code",
      checkouts: new Map([["repoA", checkout]]),
    });
    expect(res.results.map((h) => h.path)).toContain("src/auth.ts");
  });

  test("Identifier query returns file and line matches", async () => {
    const { cfg, db, checkout } = await setupRepo({
      sources: {
        "src/auth.ts": "const x = 1;\nexport function validateToken(t: string) { return t; }\n",
      },
    });
    await indexRepo(db, cfg, "repoA", checkout);

    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "validateToken",
      mode: "auto",
      limit: 5,
      style: "code",
      checkouts: new Map([["repoA", checkout]]),
    });
    const hit = res.results.find((h) => h.path === "src/auth.ts");
    expect(hit).toBeDefined();
    expect(hit?.snippet).toContain("validateToken");
  });

  test("Distinct-term coverage outranks raw hit count", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await writeFile(join(dir, "a.txt"), "alpha beta\n");
    await writeFile(join(dir, "b.txt"), "alpha alpha alpha alpha alpha\n");

    const res = await lexicalSearch(cfg, {
      dirs: [dir],
      lex: { mode: "auto", query: "alpha beta" },
    });
    expect(res.files[0]?.path).toBe(join(dir, "a.txt"));
    expect(res.files[1]?.path).toBe(join(dir, "b.txt"));
  });

  test("ripgrep unavailable", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const noRgPath = await pathWithoutRg();
    const res = await lexicalSearch(cfg, {
      dirs: [dir],
      lex: { mode: "auto", query: "alpha" },
      env: { PATH: noRgPath },
    });
    expect(res.available).toBe(false);
    expect(res.warning).toContain("rg not found");

    // Hybrid search degrades to vector-only with a warning.
    const { cfg: cfg2, db, checkout } = await setupRepo({ bundle: "valid" });
    await indexRepo(db, cfg2, "repoA", checkout);
    const hybrid = await hybridSearch(cfg2, db, {
      repoId: "repoA",
      query: "bearer",
      limit: 5,
      style: "ask",
      checkouts: new Map([["repoA", checkout]]),
      env: { PATH: noRgPath },
    });
    expect(hybrid.lexicalAvailable).toBe(false);
    expect(hybrid.warnings.join("\n")).toContain("rg not found");
    expect(hybrid.results.map((h) => h.path)).toContain("token-validation");
  });

  test("Per-repo exclude globs › Repo-excluded files are not searched", async () => {
    const { cfg, db, checkout } = await setupRepo({
      sources: {
        "src/keep.ts": "needle in a kept file\n",
        "excluded/secret.ts": "needle in an excluded file\n",
      },
    });
    // Production order: the repo is indexed WITH its globs, so the excluded
    // file gets no chunks (hence no vector recall either).
    const merged = { ...cfg, excludeGlobs: [...cfg.excludeGlobs, "excluded/**"] };
    await indexRepo(db, merged, "repoA", checkout);
    const checkouts = new Map([["repoA", checkout]]);

    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "needle",
      limit: 10,
      style: "code",
      checkouts,
      repoExcludes: new Map([["repoA", ["**/*.snap", "excluded/**"]]]),
    });
    expect(res.results.map((h) => h.path)).toEqual(["src/keep.ts"]);
  });

  test("Per-repo exclude globs reach rg as -g args", async () => {
    const { cfg, db, checkout } = await setupRepo({
      sources: { "src/keep.ts": "needle\n" },
    });
    await indexRepo(db, cfg, "repoA", checkout);

    const realRg = Bun.which("rg") ?? "/usr/bin/rg";
    const argvFile = join(await tmp(), "rg-argv.txt");
    const shimDir = await writeShim(
      "rg",
      [`printf '%s\\n' "$@" >> '${argvFile}'`, `exec '${realRg}' "$@"`].join("\n"),
    );

    await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "needle",
      limit: 5,
      style: "code",
      checkouts: new Map([["repoA", checkout]]),
      repoExcludes: new Map([["repoA", ["**/*.snap", "excluded/**"]]]),
      env: { PATH: pathWith(shimDir) },
    });

    const argv = (await readFile(argvFile, "utf8")).split("\n");
    // The repo's own globs ride the -g list alongside the global defaults.
    expect(argv).toContain("!**/*.snap");
    expect(argv).toContain("!excluded/**");
  });
});

describe("Hybrid search API", () => {
  test("Hybrid merge ordering", async () => {
    const { cfg, db, checkout } = await setupRepo({
      sources: {
        "x.ts": "foobar details elaborated\n",
        "y.ts": "foobar\n",
        "z.ts": "foobar details\n",
      },
    });
    await indexRepo(db, cfg, "repoA", checkout);

    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "foobar details",
      limit: 10,
      style: "ask",
      checkouts: new Map([["repoA", checkout]]),
    });
    const paths = res.results.map((h) => h.path);
    // x.ts ranks in both lists; z.ts is vector-top but lex-second; y.ts is
    // weak in both. Fusion must rank x and z above y, deduplicated by path.
    expect(paths.indexOf("x.ts")).toBeLessThan(paths.indexOf("y.ts"));
    expect(paths.indexOf("z.ts")).toBeLessThan(paths.indexOf("y.ts"));
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("Multiple chunks do not inflate rank", async () => {
    const big = Array.from({ length: 2100 }, (_, i) => `token line ${i}`).join("\n");
    const {
      cfg: c2,
      db,
      checkout,
    } = await setupRepo({
      sources: { "big.ts": `${big}\n`, "small.ts": "unrelated content here\n" },
    });
    await indexRepo(db, c2, "repoA", checkout);

    const res = await hybridSearch(c2, db, {
      repoId: "repoA",
      query: "token",
      limit: 10,
      style: "ask",
      checkouts: new Map([["repoA", checkout]]),
    });
    const bigHit = res.results.find((h) => h.path === "big.ts");
    expect(bigHit).toBeDefined();
    // Best-chunk-rank only (rank 0 both lists), never a sum across chunks.
    const expected = 1 * (1 / 60) + 0.7 * (1 / 60);
    expect(bigHit?.score ?? 0).toBeCloseTo(expected, 10);
    expect(bigHit?.lineRanges.length).toBe(1);
  });
});

describe("Cross-repo routing for unscoped search", () => {
  test("Unscoped question routed to relevant repos", async () => {
    const { cfg, db } = await setupRepo({ overrides: { ODW_TOP_K_REPOS: "2" } });
    const checkoutA = join(await tmp(), "a");
    const checkoutB = join(await tmp(), "b");
    const checkoutC = join(await tmp(), "c");
    for (const [checkout, bundle] of [
      [checkoutA, "valid"],
      [checkoutB, "valid2"],
    ] as const) {
      await mkdir(checkout, { recursive: true });
      await cp(bundleFixture(bundle), join(checkout, "openwiki"), { recursive: true });
    }
    await mkdir(checkoutC, { recursive: true });
    await cp(bundleFixture("valid3"), join(checkoutC, "openwiki"), { recursive: true });

    await indexRepo(db, cfg, "repoA", checkoutA);
    await indexRepo(db, cfg, "repoB", checkoutB);
    await indexRepo(db, cfg, "repoC", checkoutC);

    const res = await hybridSearch(cfg, db, {
      query: "token authentication database",
      limit: 10,
      style: "ask",
      checkouts: new Map([
        ["repoA", checkoutA],
        ["repoB", checkoutB],
        ["repoC", checkoutC],
      ]),
    });
    const repos = new Set(res.results.map((h) => h.repoId));
    expect(repos.has("repoA")).toBe(true); // token/auth centroid nearest
    expect(repos.has("repoB")).toBe(true); // shares "database" stem
    expect(repos.has("repoC")).toBe(false); // excluded by top-k = 2
  });

  test("Scoped search stays in one repo", async () => {
    const { cfg, db } = await setupRepo({});
    const checkoutA = join(await tmp(), "a");
    const checkoutB = join(await tmp(), "b");
    await mkdir(checkoutA, { recursive: true });
    await mkdir(checkoutB, { recursive: true });
    await cp(bundleFixture("valid"), join(checkoutA, "openwiki"), { recursive: true });
    await cp(bundleFixture("valid2"), join(checkoutB, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "repoA", checkoutA);
    await indexRepo(db, cfg, "repoB", checkoutB);

    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "storage",
      limit: 10,
      style: "ask",
      checkouts: new Map([
        ["repoA", checkoutA],
        ["repoB", checkoutB],
      ]),
    });
    expect(res.results.length).toBeGreaterThan(0);
    for (const hit of res.results) expect(hit.repoId).toBe("repoA");
  });

  test("Query embedded once per search", async () => {
    const { cfg, db, stub } = await setupRepo({ overrides: { ODW_TOP_K_REPOS: "2" } });
    const checkoutA = join(await tmp(), "a");
    const checkoutB = join(await tmp(), "b");
    await mkdir(checkoutA, { recursive: true });
    await mkdir(checkoutB, { recursive: true });
    await cp(bundleFixture("valid"), join(checkoutA, "openwiki"), { recursive: true });
    await cp(bundleFixture("valid2"), join(checkoutB, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "repoA", checkoutA);
    await indexRepo(db, cfg, "repoB", checkoutB);

    // The same vector drives centroid routing and per-repo vector ranking:
    // exactly one embeddings API request for the whole unscoped search.
    const before = stub.calls.length;
    await hybridSearch(cfg, db, {
      query: "token authentication database",
      limit: 10,
      style: "ask",
      checkouts: new Map([
        ["repoA", checkoutA],
        ["repoB", checkoutB],
      ]),
    });
    expect(stub.calls.length - before).toBe(1);
  });
});

describe("Bounded query-time I/O", () => {
  test("Chunks fetched by candidate keys", async () => {
    const { cfg, db, checkout } = await setupRepo({ bundle: "valid" });
    await indexRepo(db, cfg, "repoA", checkout);

    const rec = recordingDb(db);
    await hybridSearch(cfg, rec.db, {
      repoId: "repoA",
      query: "bearer",
      limit: 5,
      style: "code",
      checkouts: new Map([["repoA", checkout]]),
    });

    // No full-table chunk scan (the listChunks form has no extra qualifiers),
    // only candidate-key reads.
    const fullScans = rec.sqls.filter((s) => /FROM chunks WHERE repo_id = \?(?!\s+AND)/.test(s));
    expect(fullScans).toEqual([]);
    expect(rec.sqls.some((s) => /FROM chunks WHERE repo_id = \? AND path IN \(/.test(s))).toBe(
      true,
    );
  });
});

describe("Incremental index updates", () => {
  test("Changed source file re-indexed", async () => {
    const { cfg, db, checkout } = await setupRepo({
      sources: {
        "src/a.ts": "export const a = 1; // alpha\n",
        "src/b.ts": "export const b = 2; // beta\n",
      },
    });
    const before = await indexRepo(db, cfg, "repoA", checkout);
    expect(before.sourceChunks).toBe(2);
    const bBefore = (await listChunks(db, "repoA", "source")).find((c) => c.path === "src/b.ts");

    const aPath = join(checkout, "src", "a.ts");
    await writeFile(aPath, "export const a = 999; // gamma delta\n");
    const run = await indexRepo(db, cfg, "repoA", checkout, {
      changedSourcePaths: new Set(["src/a.ts"]),
    });

    // Only a.ts was re-registered and re-embedded.
    expect(run.sourceChunks).toBe(1);
    const bAfter = (await listChunks(db, "repoA", "source")).find((c) => c.path === "src/b.ts");
    expect(bAfter?.contentHash).toBe(bBefore?.contentHash);
    const aAfter = (await listChunks(db, "repoA", "source")).find((c) => c.path === "src/a.ts");
    expect(aAfter?.contentHash).not.toBe(bAfter?.contentHash);
  });

  test("Updated concept content searchable", async () => {
    const { cfg, db, checkout } = await setupRepo({ bundle: "valid" });
    await indexRepo(db, cfg, "repoA", checkout);

    const file = join(checkout, "openwiki", "token-validation.md");
    const updated = `${await Bun.file(file).text()}\n\nQuantumflux marker line.\n`;
    await writeFile(file, updated);
    await indexRepo(db, cfg, "repoA", checkout);

    const res = await hybridSearch(cfg, db, {
      repoId: "repoA",
      query: "quantumflux",
      limit: 5,
      style: "code",
      checkouts: new Map([["repoA", checkout]]),
    });
    expect(res.results.map((h) => h.path)).toContain("token-validation");
  });

  test("Unchanged repo re-index is a no-op for embeddings", async () => {
    const { cfg, db, checkout, dir } = await setupRepo({ bundle: "valid" });
    void dir;
    await indexRepo(db, cfg, "repoA", checkout);
    const run = await indexRepo(db, cfg, "repoA", checkout);
    expect(run.embedded).toBe(0);
    expect(run.sourceChunks).toBe(0);
  });
});

describe("Git diff helpers", () => {
  test("commitFiles adds a commit to a fixture repo", async () => {
    const dir = await tmp();
    await createGitRepo(dir, { "a.ts": "one\n" });
    await commitFiles(dir, { "b.ts": "two\n" });
    const files = await diffNames("HEAD~1", "HEAD", dir);
    expect(files).toEqual(["b.ts"]);
  });
});
