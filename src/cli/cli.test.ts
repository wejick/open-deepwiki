import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Client as DbClient } from "@libsql/client";
import { openDb } from "../index/db.ts";
import { indexRepo } from "../index/update.ts";
import { appendEvent } from "../monitor/events.ts";
import { createScheduler } from "../repoManager/scheduler.ts";
import {
  loadRegistry,
  saveRegistry,
  type RepoRecord,
  type Registry,
} from "../repoManager/registry.ts";
import { startServer, type ServeResult } from "../server/server.ts";
import { statusCommand, logsCommand, listRepos } from "../cli/main.ts";
import { openContext } from "../repoManager/context.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { paths } from "../config/config.ts";
import { cp, mkdir, stat } from "node:fs/promises";
import { bundleFixture } from "../../test/helpers/tmp.ts";
import { openwikiHappy, pathWith } from "../../test/helpers/shim.ts";
import { createGitRepo } from "../../test/helpers/gitFixture.ts";

let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: DbClient[] = [];
let servers: ServeResult[] = [];

afterEach(async () => {
  for (const c of cleanups) c();
  cleanups = [];
  for (const s of servers) {
    try {
      await s.stop();
    } catch {
      // already stopped
    }
  }
  servers = [];
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

async function tmp(): Promise<string> {
  const d = await makeTmp();
  tmpDirs.push(d);
  return d;
}

// Separate stdout/stderr captures: the pipe-clean guarantee is that the
// listing lands on stdout and the command hint on stderr.
function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.join(" "));
  });
  return {
    out,
    err,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

async function withDataDir(dir: string, run: () => Promise<void>): Promise<void> {
  const prev = process.env.ODW_DATA_DIR;
  process.env.ODW_DATA_DIR = dir;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.ODW_DATA_DIR;
    else process.env.ODW_DATA_DIR = prev;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(repoId: string, dir: string, overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    repoId,
    source: "git@gitlab.corp:team/repo.git",
    clonePath: join(dir, "repos", repoId, "checkout"),
    addedAt: new Date().toISOString(),
    schedule: null,
    instructions: undefined,
    producer: undefined,
    options: {},
    lastRun: {
      startedAt: null,
      finishedAt: null,
      outcome: null,
      durationMs: null,
      tokens: null,
      error: null,
    },
    lastIndexedSha: "abc1234",
    lastSuccessAt: new Date().toISOString(),
    ...overrides,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

describe("CLI status and logs", () => {
  test("repo list through the main dispatcher", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    const checkout = join(dir, "repos", "r1", "checkout");
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "r1", checkout);
    await (
      await import("../repoManager/registry.ts")
    ).saveRegistry(cfg, {
      repos: [makeRepo("r1", dir)],
    });

    // Regression: dispatch through main() — the try/finally around the
    // command must not close the DB while the command is still running.
    const prevDataDir = process.env.ODW_DATA_DIR;
    process.env.ODW_DATA_DIR = dir;
    const out: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    const { main } = await import("../cli/main.ts");
    const code = await main(["repo", "list"]);
    spy.mockRestore();
    if (prevDataDir === undefined) delete process.env.ODW_DATA_DIR;
    else process.env.ODW_DATA_DIR = prevDataDir;

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("r1");
    expect(out.join("\n")).toContain("wiki 5");
  });

  test("Per-repo exclude globs › Excludes visible in listing", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    const checkout = join(dir, "repos", "r1", "checkout");
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "r1", checkout);
    await saveRegistry(cfg, {
      repos: [
        makeRepo("with-globs", dir, { excludeGlobs: ["**/*.snap", "**/*.a"] }),
        makeRepo("plain-repo", dir),
      ],
    });

    const out: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    const ctx = await openContext(cfg);
    const code = await listRepos(ctx, false);
    spy.mockRestore();
    ctx.db.close();
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("+excludes:**/*.snap,**/*.a");
    expect(text).not.toContain("plain-repo +excludes");
  });

  test("Status table from registry", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const checkout = join(dir, "repos", "r1", "checkout");
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "r1", checkout);
    const failed = makeRepo("r2", dir, {
      lastRun: {
        startedAt: null,
        finishedAt: null,
        outcome: "failed",
        durationMs: 5,
        tokens: null,
        error: "boom",
      },
    });
    const healthy = makeRepo("r1", dir);
    await (
      await import("../repoManager/registry.ts")
    ).saveRegistry(cfg, { repos: [healthy, failed] });

    const out: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    const code = await statusCommand([], { ODW_DATA_DIR: dir, ODW_EMBEDDING_DIM: "1024" });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("r1");
    expect(out.join("\n")).toContain("r2");
    expect(out.join("\n")).toContain("red");

    // --failing filters to red/yellow only
    const out2: string[] = [];
    const spy2 = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out2.push(args.join(" "));
    });
    await statusCommand(["--failing"], { ODW_DATA_DIR: dir, ODW_EMBEDDING_DIM: "1024" });
    spy2.mockRestore();
    expect(out2.join("\n")).toContain("r2");
    expect(out2.join("\n")).not.toContain("r1");
  });

  test("Live queue merge", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const port = await freePort();
    const scfg = testConfig(dir, { ODW_PORT: String(port) });
    const registry: Registry = { repos: [makeRepo("r1", dir)] };
    const scheduler = createScheduler(scfg, db, { pending: 3, inFlight: 1 });
    const served = await startServer({ cfg: scfg, db, registry, schedulerState: scheduler.state });
    servers.push(served);
    scheduler.stop();

    const out: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    const code = await statusCommand(["--server", `http://127.0.0.1:${port}`], {
      ODW_DATA_DIR: dir,
      ODW_EMBEDDING_DIM: "1024",
    });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("pending 3");
  });

  test("Status --json carries the run-state classification", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const started = makeRepo("r1", dir, {
      lastRun: {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: null,
        durationMs: null,
        tokens: null,
        error: null,
      },
    });
    await (await import("../repoManager/registry.ts")).saveRegistry(cfg, { repos: [started] });

    const { out, restore } = capture();
    const code = await statusCommand(["--json"], { ODW_DATA_DIR: dir, ODW_EMBEDDING_DIM: "1024" });
    restore();
    expect(code).toBe(0);
    const summary = JSON.parse(out.join("\n")) as {
      repos: { repoId: string; runState: string | null }[];
    };
    expect(summary.repos.find((r) => r.repoId === "r1")?.runState).toBe("running");
  });

  test("Live-merge fallback when server unreachable", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    await (
      await import("../repoManager/registry.ts")
    ).saveRegistry(cfg, {
      repos: [makeRepo("r1", dir)],
    });

    const errs: string[] = [];
    const spyErr = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errs.push(args.join(" "));
    });
    const out: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    const code = await statusCommand(["--server", "http://127.0.0.1:1"], {
      ODW_DATA_DIR: dir,
      ODW_EMBEDDING_DIM: "1024",
    });
    spy.mockRestore();
    spyErr.mockRestore();
    expect(code).toBe(0); // registry-only view still works
    expect(errs.join("\n")).toContain("registry-only view");
    expect(out.join("\n")).toContain("r1");
  });

  test("Filtered logs", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await appendEvent(cfg, { type: "run_started", repoId: "a" });
    await appendEvent(cfg, { type: "run_failed", repoId: "b", error: "x" });

    const out: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    const code = await logsCommand(["--repo", "a"], {
      ODW_DATA_DIR: dir,
      ODW_EMBEDDING_DIM: "1024",
    });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("run_started a");
    expect(out.join("\n")).not.toContain("run_failed b");
  });

  test("Progress beats hidden unless --progress", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await appendEvent(cfg, { type: "run_started", repoId: "a", producer: "claude" });
    await appendEvent(cfg, {
      type: "producer_progress",
      repoId: "a",
      producer: "claude",
      stage: "page",
      note: "a.md: 1/2",
    });
    await appendEvent(cfg, { type: "run_failed", repoId: "a", producer: "claude", error: "x" });

    const run = async (flags: string[]): Promise<string> => {
      const out: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...logged: unknown[]) => {
        out.push(logged.join(" "));
      });
      const code = await logsCommand(flags, { ODW_DATA_DIR: dir, ODW_EMBEDDING_DIM: "1024" });
      spy.mockRestore();
      expect(code).toBe(0);
      return out.join("\n");
    };

    expect(await run([])).not.toContain("producer_progress");
    // Lifecycle events stay visible with beats flooding between them.
    expect(await run([])).toContain("run_started a");
    expect(await run([])).toContain("run_failed a");
    const withFlag = await run(["--progress"]);
    expect(withFlag).toContain("producer_progress");
    expect(withFlag).toContain("a.md: 1/2");
    expect(withFlag).toContain("run_started a");
  });
});

describe("Repository listing", () => {
  test("List repos", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    const checkout = join(dir, "repos", "gitlab.corp/team/repo", "checkout");
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "gitlab.corp/team/repo", checkout);
    await (
      await import("../repoManager/registry.ts")
    ).saveRegistry(cfg, {
      repos: [makeRepo("gitlab.corp/team/repo", dir)],
    });

    const out: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    const ctx = await openContext(cfg);
    const code = await listRepos(ctx, false);
    spy.mockRestore();
    ctx.db.close();
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("gitlab.corp/team/repo");
    expect(text).toContain("wiki 5");
    expect(text).toContain("abc1234");
    expect(text).toContain("links 4/6");
    expect(text).toContain("token");
  });
});

describe("Scheduled updates", () => {
  test("Per-repo override honored", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    await (
      await import("../repoManager/registry.ts")
    ).saveRegistry(cfg, {
      repos: [
        makeRepo("hourly-repo", dir, { schedule: "0 * * * *" }),
        makeRepo("nightly-repo", dir, { schedule: null }),
      ],
    });
    // A scheduler with a valid per-repo override starts cleanly; the override
    // repo gets its own cron job, the rest ride the nightly default.
    const scheduler = createScheduler(cfg, db);
    expect(scheduler.state.maxParallel).toBe(cfg.maxParallelIndexing);
    scheduler.stop();

    // Invalid override cron is tolerated (ignored at start).
    await (
      await import("../repoManager/registry.ts")
    ).saveRegistry(cfg, {
      repos: [makeRepo("bad", dir, { schedule: "not-a-cron" })],
    });
    const scheduler2 = createScheduler(cfg, db);
    scheduler2.stop();
    expect((await loadRegistry(cfg)).repos[0]?.repoId).toBe("bad");
  });
});

describe("Bare repo command defaults to listing", () => {
  // Fixture repo indexed into a tmp config, mirroring the dispatcher test
  // above, so the listing has real rows to print.
  async function withIndexedRepo(): Promise<string> {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    const checkout = join(dir, "repos", "r1", "checkout");
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "r1", checkout);
    await saveRegistry(cfg, { repos: [makeRepo("r1", dir)] });
    return dir;
  }

  test("Bare invocation lists repos", async () => {
    const dir = await withIndexedRepo();
    const { main } = await import("../cli/main.ts");

    let listedOut: string[] = [];
    let bareOut: string[] = [];
    let bareErr: string[] = [];
    let bareCode: number | undefined;
    await withDataDir(dir, async () => {
      const listed = capture();
      const listCode = await main(["repo", "list"]);
      listed.restore();
      expect(listCode).toBe(0);
      listedOut = listed.out;

      const bare = capture();
      bareCode = await main(["repo"]);
      bare.restore();
      bareOut = bare.out;
      bareErr = bare.err;
    });

    // Same listing as `repo list`, byte for byte, and exit 0.
    expect(bareCode).toBe(0);
    expect(bareOut).toEqual(listedOut);
    expect(bareOut.join("\n")).toContain("r1");
    expect(bareOut.join("\n")).toContain("wiki 5");
    // The hint names every repo subcommand — on stderr only.
    const hint = bareErr.join("\n");
    for (const sub of ["add", "remove", "list", "update", "reinit", "instructions"]) {
      expect(hint).toContain(sub);
    }
  });

  test("Bare invocation with empty registry", async () => {
    const dir = await tmp();
    const { main } = await import("../cli/main.ts");

    let out: string[] = [];
    let err: string[] = [];
    let code: number | undefined;
    await withDataDir(dir, async () => {
      const cap = capture();
      code = await main(["repo"]);
      cap.restore();
      out = cap.out;
      err = cap.err;
    });

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("no repos registered");
    expect(err.join("\n")).toContain("instructions");
  });

  test("Unknown subcommand still fails", async () => {
    const dir = await withIndexedRepo();
    const { main } = await import("../cli/main.ts");

    let out: string[] = [];
    let err: string[] = [];
    let code: number | undefined;
    await withDataDir(dir, async () => {
      const cap = capture();
      code = await main(["repo", "frobnicate"]);
      cap.restore();
      out = cap.out;
      err = cap.err;
    });

    expect(code).toBe(1);
    const usage = err.join("\n");
    for (const sub of ["add", "remove", "list", "update", "reinit", "instructions"]) {
      expect(usage).toContain(sub);
    }
    // No fallback listing: the typo must not look like a successful run.
    expect(out.join("\n")).not.toContain("r1");
  });
});

describe("repo reinit (Repository re-initialization)", () => {
  test("End-to-end: discards wiki state and rebuilds, recording the run", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    const origin = await createGitRepo(join(dir, "origin"), {
      "src/a.ts": "export const a = 1;\n",
      "README.md": "# r\n",
    });
    await saveRegistry(cfg, {
      repos: [makeRepo("r1", dir, { source: origin, lastIndexedSha: null, lastSuccessAt: null })],
    });
    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const prevPath = process.env.PATH;
    process.env.PATH = pathWith(shimDir);
    const { main } = await import("../cli/main.ts");

    let code: number | undefined;
    let out: string[] = [];
    let err: string[] = [];
    await withDataDir(dir, async () => {
      const cap = capture();
      code = await main(["repo", "reinit", "r1"]);
      cap.restore();
      out = cap.out;
      err = cap.err;
    });
    process.env.PATH = prevPath;

    expect(code).toBe(0);
    expect(err.join("\n")).toBe("");
    expect(out.join("\n")).toContain("re-initialized");
    expect(await pathExists(join(dir, "repos", "r1", "checkout", "openwiki"))).toBe(true);
    // Recorded through the same recorder as every other run.
    const loaded = await loadRegistry(cfg);
    expect(loaded.repos.find((r) => r.repoId === "r1")?.lastRun.outcome).toBe("success");
  });

  test("refuses an unknown repo", async () => {
    const dir = await tmp();
    const { main } = await import("../cli/main.ts");
    let code: number | undefined;
    let err: string[] = [];
    await withDataDir(dir, async () => {
      const cap = capture();
      code = await main(["repo", "reinit", "ghost"]);
      cap.restore();
      err = cap.err;
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown repo ghost");
  });

  test("without an id prints usage", async () => {
    const dir = await tmp();
    const { main } = await import("../cli/main.ts");
    let code: number | undefined;
    let err: string[] = [];
    await withDataDir(dir, async () => {
      const cap = capture();
      code = await main(["repo", "reinit"]);
      cap.restore();
      err = cap.err;
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage: repo reinit <repoId>");
  });
});
