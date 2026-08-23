import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import cron from "node-cron";
import type { Client as DbClient } from "@libsql/client";
import { adminRuns } from "./admin.ts";
import { startServer, type ServeResult } from "./server.ts";
import { docCounts, openDb } from "../index/db.ts";
import { indexRepo } from "../index/update.ts";
import { acquireRepoLock } from "../repoManager/lock.ts";
import { createScheduler } from "../repoManager/scheduler.ts";
import { loadRegistry, saveRegistry, type RepoRecord } from "../repoManager/registry.ts";
import { paths, type Config } from "../config/config.ts";
import { gitHeadSha } from "../repoManager/git.ts";
import { saveWip } from "../producer/wip.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp, waitForFile } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { createGitRepo, commitFiles } from "../../test/helpers/gitFixture.ts";
import { claudeHappy, openwikiHappy, pathWith, writeShim } from "../../test/helpers/shim.ts";

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

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function serveAdmin(
  opts: { bindHost?: string; token?: string; admin?: boolean; scheduler?: boolean } = {},
): Promise<{
  cfg: Config;
  db: DbClient;
  served: ServeResult;
  dir: string;
}> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const cfg = testConfig(dir, {
    ODW_PORT: String(await freePort()),
    ODW_BIND_HOST: opts.bindHost ?? "127.0.0.1",
    ...(opts.token ? { ODW_BEARER_TOKEN: opts.token } : {}),
  });
  const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
  dbs.push(db);
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);
  let scheduler: ReturnType<typeof createScheduler> | undefined;
  if (opts.scheduler) {
    scheduler = createScheduler(cfg, db);
    cleanups.push(() => scheduler?.stop());
  }
  const served = await startServer({
    cfg,
    db,
    adminDb: opts.admin === false ? null : db,
    ...(scheduler ? { applySchedule: scheduler.applySchedule } : {}),
  });
  servers.push(served);
  return { cfg, db, served, dir };
}

function makeRecord(dir: string, overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    repoId: "repoA",
    source: "git@gitlab.corp:team/repo.git",
    clonePath: join(dir, "repos", "repoA", "checkout"),
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
    lastIndexedSha: null,
    lastSuccessAt: null,
    ...overrides,
  };
}

function req(
  served: ServeResult,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  return fetch(`${served.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Run fn with the openwiki shim dir prepended to PATH (restored after). */
async function withPath<T>(shimDir: string, fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = pathWith(shimDir);
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

describe("Admin API authentication", () => {
  test("Unauthenticated admin request rejected on LAN bind", async () => {
    const { served } = await serveAdmin({ bindHost: "0.0.0.0", token: "secret" });
    const denied = await req(served, "POST", "/api/repos", { source: "/x" });
    expect(denied.status).toBe(401);

    const allowed = await req(served, "POST", "/api/repos", { source: "/x" }, "secret");
    expect(allowed.status).not.toBe(401); // reached the handler (pre-flight 400)
  });

  test("Localhost bind requires no token", async () => {
    const { served } = await serveAdmin();
    const res = await req(served, "POST", "/api/repos", { source: "/x" });
    expect(res.status).toBe(400); // handled, not auth-rejected
  });

  test("Admin API unavailable without a writable handle", async () => {
    const { served } = await serveAdmin({ admin: false });
    const res = await req(served, "POST", "/api/repos", { source: "/x" });
    expect(res.status).toBe(404);
  });
});

describe("Add repository with pre-flight validation", () => {
  test("Unreachable remote rejected", async () => {
    const { cfg, served } = await serveAdmin();
    const realGit = Bun.which("git") ?? "/usr/bin/git";
    const gitShim = await writeShim(
      "git",
      [
        'if [ "$1" = "ls-remote" ]; then echo "fatal: unable to connect" >&2; exit 128; fi',
        `exec '${realGit}' "$@"`,
      ].join("\n"),
    );
    await withPath(gitShim, async () => {
      const res = await req(served, "POST", "/api/repos", {
        source: "https://git.corp/team/repo.git",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not retrievable");
    });
    expect((await loadRegistry(cfg)).repos.length).toBe(0); // nothing registered
  });

  test("Duplicate source rejected", async () => {
    const { cfg, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), { "a.ts": "a\n" });
    await saveRegistry(cfg, { repos: [makeRecord(dir, { source: remote })] });

    const res = await req(served, "POST", "/api/repos", { source: remote });
    expect(res.status).toBe(409);
    expect((await loadRegistry(cfg)).repos.length).toBe(1); // unchanged
  });

  test("Valid source accepted", async () => {
    const { cfg, db, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), {
      "src/a.ts": "export const a = 1;\n",
    });
    const shim = await openwikiHappy(bundleFixture("valid"));

    const repoId = await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos", { source: remote });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { repoId: string };
      const run = adminRuns.get(body.repoId);
      expect(run).toBeDefined();
      await run;
      return body.repoId;
    });

    expect(repoId).toBe("local/remote");
    const registry = await loadRegistry(cfg);
    expect(registry.repos[0]?.lastRun.outcome).toBe("success");
    const counts = await docCounts(db, repoId);
    expect(counts.wiki).toBeGreaterThan(0); // bundle indexed
    expect(counts.source).toBeGreaterThan(0); // sources indexed
  });

  test("Producer override persisted", async () => {
    const { cfg, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), { "a.ts": "a\n" });
    const shim = await claudeHappy(bundleFixture("valid"));

    const body = await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos", { source: remote, producer: "claude" });
      expect(res.status).toBe(202);
      const parsed = (await res.json()) as { repoId: string; producer: string };
      await adminRuns.get(parsed.repoId); // let the background run settle before teardown
      return parsed;
    });
    expect(body.producer).toBe("claude");

    const registry = await loadRegistry(cfg);
    expect(registry.repos[0]?.producer).toBe("claude");
  });

  test("Omitted producer follows the global default", async () => {
    const { cfg, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), { "a.ts": "a\n" });

    const res = await req(served, "POST", "/api/repos", { source: remote });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { repoId: string; producer: string };
    expect(body.producer).toBe(cfg.producer);

    const registry = await loadRegistry(cfg);
    expect(registry.repos[0]?.producer).toBeUndefined();
    await adminRuns.get(body.repoId);
  });

  test("Unknown producer rejected before any work", async () => {
    const { cfg, served } = await serveAdmin();

    // A source that would also fail pre-flight — proves the producer check
    // runs first, since the returned error names the producer, not the source.
    const res = await req(served, "POST", "/api/repos", {
      source: "/nonexistent-repo-xyz",
      producer: "nonesuch",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    for (const id of ["openwiki", "claude"]) expect(body.error).toContain(id);

    expect((await loadRegistry(cfg)).repos.length).toBe(0);
    expect(adminRuns.size).toBe(0);
  });

  test("Per-repo exclude globs › Exclude globs persisted with the registration", async () => {
    const { cfg, db, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), { "a.ts": "a\n" });
    const shim = await openwikiHappy(bundleFixture("valid"));

    const repoId = await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos", {
        source: remote,
        excludeGlobs: ["**/*.snap", "**/*.a"],
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { repoId: string };
      await adminRuns.get(body.repoId);
      return body.repoId;
    });

    const registry = await loadRegistry(cfg);
    const repo = registry.repos.find((r) => r.repoId === repoId);
    expect(repo?.excludeGlobs).toEqual(["**/*.snap", "**/*.a"]);
    // The first run indexed nothing matching the globs.
    const counts = await docCounts(db, repoId);
    expect(counts.wiki).toBeGreaterThan(0);
    expect(counts.source).toBeGreaterThan(0);
  });

  test("Per-repo exclude globs › Malformed exclude globs rejected before any work", async () => {
    const { cfg, served } = await serveAdmin();
    for (const bad of ["ci/**", 42, ""]) {
      // A source that would also fail pre-flight — a 400 naming excludeGlobs
      // proves the glob check runs first, registering nothing.
      const res = await req(served, "POST", "/api/repos", {
        source: "/nonexistent-repo-xyz",
        excludeGlobs: bad,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("excludeGlobs");
    }
    expect((await loadRegistry(cfg)).repos.length).toBe(0);
    expect(adminRuns.size).toBe(0);
  });

  test("Per-repo exclude globs › Omitted exclude globs record none", async () => {
    const { cfg, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), { "a.ts": "a\n" });

    const repoId = await withPath(await openwikiHappy(bundleFixture("valid")), async () => {
      const res = await req(served, "POST", "/api/repos", { source: remote });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { repoId: string };
      await adminRuns.get(body.repoId);
      return body.repoId;
    });

    const repo = (await loadRegistry(cfg)).repos.find((r) => r.repoId === repoId);
    expect(repo?.excludeGlobs).toBeUndefined();
  });
});

describe("Asynchronous run handling", () => {
  test("Add returns before the run completes", async () => {
    const { cfg, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), {
      "src/a.ts": "export const a = 1;\n",
    });
    const gate = join(dir, "ow-gate");
    const started = join(dir, "ow-started");
    const shim = await writeShim(
      "openwiki",
      [
        'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
        `touch '${started}'`,
        `n=0; while [ ! -f '${gate}' ] && [ $n -lt 1200 ]; do sleep 0.05; n=$((n+1)); done`,
        "mkdir -p ./openwiki",
        `cp -r '${bundleFixture("valid")}/.' ./openwiki/`,
        "exit 0",
      ].join("\n"),
    );

    await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos", { source: remote });
      expect(res.status).toBe(202); // returned immediately…
      const body = (await res.json()) as { repoId: string };
      const run = adminRuns.get(body.repoId);
      expect(run).toBeDefined(); // …while the run is still in flight

      await waitForFile(started); // blocked inside the gated openwiki shim

      // In-flight run observable via /status: started, no finish time.
      const status = (await (await req(served, "GET", "/status")).json()) as {
        repos: { repoId: string; runStartedAt: string | null; runFinishedAt: string | null }[];
      };
      const row = status.repos.find((r) => r.repoId === body.repoId);
      expect(row?.runStartedAt).not.toBeNull();
      expect(row?.runFinishedAt).toBeNull();

      await Bun.write(gate, "go\n");
      await run;
    });
    expect((await loadRegistry(cfg)).repos[0]?.lastRun.outcome).toBe("success");
  });

  test("Overlapping update rejected", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    const lock = await acquireRepoLock(cfg, "repoA");
    try {
      const res = await req(served, "POST", "/api/repos/repoA/update");
      expect(res.status).toBe(409);
      expect(adminRuns.has("repoA")).toBe(false); // no second run started
    } finally {
      await lock?.released();
    }
  });
});

describe("Update repository endpoint", () => {
  test("Unknown repo rejected", async () => {
    const { served } = await serveAdmin();
    const res = await req(served, "POST", "/api/repos/nope/update");
    expect(res.status).toBe(404);
  });

  test("Update runs the pipeline", async () => {
    const { cfg, db, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), {
      "src/a.ts": "export const a = 1;\n",
    });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);
    const oldSha = (await simpleGit({ baseDir: checkout }).revparse(["HEAD"])).trim();
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { source: remote, clonePath: checkout, lastIndexedSha: oldSha })],
    });
    const shim = await openwikiHappy(bundleFixture("valid"));

    await commitFiles(remote, { "src/b.ts": "export const b = 2;\n" }, "add b");
    await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos/repoA/update");
      expect(res.status).toBe(202);
      const run = adminRuns.get("repoA");
      expect(run).toBeDefined();
      await run;
    });

    const repo = (await loadRegistry(cfg)).repos[0];
    expect(repo?.lastRun.outcome).toBe("success");
    expect(repo?.lastIndexedSha).not.toBe(oldSha); // head moved
    expect((await docCounts(db, "repoA")).wiki).toBeGreaterThan(0);
  });

  test("Stale error cleared while the new run is in flight", async () => {
    const { cfg, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), {
      "src/a.ts": "export const a = 1;\n",
    });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);
    const oldSha = (await simpleGit({ baseDir: checkout }).revparse(["HEAD"])).trim();
    const failedAt = new Date(Date.now() - 3_600_000).toISOString();
    await saveRegistry(cfg, {
      repos: [
        makeRecord(dir, {
          source: remote,
          clonePath: checkout,
          lastIndexedSha: oldSha,
          lastRun: {
            startedAt: null,
            finishedAt: failedAt,
            outcome: "failed",
            durationMs: 5000,
            tokens: null,
            error: "openwiki run exited 1: boom",
          },
        }),
      ],
    });
    const gate = join(dir, "ow-gate");
    const started = join(dir, "ow-started");
    const shim = await writeShim(
      "openwiki",
      [
        'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
        `touch '${started}'`,
        `n=0; while [ ! -f '${gate}' ] && [ $n -lt 1200 ]; do sleep 0.05; n=$((n+1)); done`,
        "mkdir -p ./openwiki",
        `cp -r '${bundleFixture("valid")}/.' ./openwiki/`,
        "exit 0",
      ].join("\n"),
    );

    await commitFiles(remote, { "src/b.ts": "export const b = 2;\n" }, "add b");
    await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos/repoA/update");
      expect(res.status).toBe(202);
      await waitForFile(started); // run is in flight inside the gated shim

      const status = (await (await req(served, "GET", "/status")).json()) as {
        repos: {
          repoId: string;
          lastError: string | null;
          health: string;
          runStartedAt: string | null;
          runFinishedAt: string | null;
        }[];
      };
      const row = status.repos.find((r) => r.repoId === "repoA");
      // The superseded run's error is gone; outcome-derived health stands.
      expect(row?.lastError).toBeNull();
      expect(row?.runStartedAt).not.toBeNull();
      expect(row?.runFinishedAt).toBeNull();
      expect(row?.health).toBe("red");

      await Bun.write(gate, "go\n");
      await adminRuns.get("repoA");
    });

    const repo = (await loadRegistry(cfg)).repos[0];
    expect(repo?.lastRun.outcome).toBe("success"); // recorded by the ordinary recorder
    expect(repo?.lastRun.error).toBeNull();
  });
});

describe("Re-initialize repository endpoint", () => {
  test("Unknown repo rejected", async () => {
    const { served } = await serveAdmin();
    const res = await req(served, "POST", "/api/repos/nope/reinit");
    expect(res.status).toBe(404);
  });

  test("Overlapping re-initialization rejected", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    const lock = await acquireRepoLock(cfg, "repoA");
    try {
      const res = await req(served, "POST", "/api/repos/repoA/reinit");
      expect(res.status).toBe(409);
      expect(adminRuns.has("repoA")).toBe(false); // no second run started
    } finally {
      await lock?.released();
    }
  });

  test("Re-initialization runs the pipeline", async () => {
    const { cfg, db, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), {
      "src/a.ts": "export const a = 1;\n",
    });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { source: remote, clonePath: checkout })],
    });
    const shim = await openwikiHappy(bundleFixture("valid"));

    await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos/repoA/reinit");
      expect(res.status).toBe(202);
      const run = adminRuns.get("repoA");
      expect(run).toBeDefined();
      await run;
    });

    const repo = (await loadRegistry(cfg)).repos[0];
    expect(repo?.lastRun.outcome).toBe("success");
    expect((await docCounts(db, "repoA")).wiki).toBeGreaterThan(0);
  });
});

describe("Resume repository endpoint", () => {
  test("Unknown repo rejected", async () => {
    const { served } = await serveAdmin();
    const res = await req(served, "POST", "/api/repos/nope/resume");
    expect(res.status).toBe(404);
    expect(adminRuns.size).toBe(0);
  });

  test("Overlapping resume rejected", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    const lock = await acquireRepoLock(cfg, "repoA");
    try {
      const res = await req(served, "POST", "/api/repos/repoA/resume");
      expect(res.status).toBe(409);
      expect(adminRuns.has("repoA")).toBe(false); // no second run started
    } finally {
      await lock?.released();
    }
  });

  test("Nothing to resume rejected", async () => {
    const { cfg, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), { "a.ts": "a\n" });
    await saveRegistry(cfg, {
      repos: [
        makeRecord(dir, { source: remote, clonePath: join(dir, "repos", "repoA", "checkout") }),
      ],
    });
    const shim = await openwikiHappy(bundleFixture("valid"));

    await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos/repoA/resume");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("nothing to resume");
      expect(adminRuns.has("repoA")).toBe(false); // idle repo, no run queued
    });
  });

  test("Resume runs the pipeline", async () => {
    const { cfg, db, served, dir } = await serveAdmin();
    const remote = await createGitRepo(join(dir, "remote"), {
      "src/a.ts": "export const a = 1;\n",
    });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);
    const pinned = await gitHeadSha(checkout);
    // A preserved build, then the remote moves on — resume must not follow it.
    await saveWip(cfg, "repoA", join(checkout, "openwiki"), {
      targetSha: pinned,
      producer: "openwiki",
    });
    await commitFiles(remote, { "src/b.ts": "export const b = 2;\n" }, "add b");
    const head = await gitHeadSha(remote);
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { source: remote, clonePath: checkout })],
    });
    const shim = await openwikiHappy(bundleFixture("valid"));

    await withPath(shim, async () => {
      const res = await req(served, "POST", "/api/repos/repoA/resume");
      expect(res.status).toBe(202);
      const run = adminRuns.get("repoA");
      expect(run).toBeDefined();
      await run;
    });

    const repo = (await loadRegistry(cfg)).repos[0];
    expect(repo?.lastRun.outcome).toBe("success");
    expect(repo?.lastRun.startedAt).not.toBeNull();
    expect(repo?.lastRun.finishedAt).not.toBeNull();
    // Recorded sha is the preserved build's pin, not the remote head.
    expect(repo?.lastIndexedSha).toBe(pinned);
    expect(repo?.lastIndexedSha).not.toBe(head);
    expect(await gitHeadSha(checkout)).toBe(pinned); // no fetch or pull
    expect((await docCounts(db, "repoA")).wiki).toBeGreaterThan(0);
  });
});

describe("Remove repository endpoint", () => {
  test("Remove while running rejected", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    const lock = await acquireRepoLock(cfg, "repoA");
    try {
      const res = await req(served, "DELETE", "/api/repos/repoA");
      expect(res.status).toBe(409);
      expect((await loadRegistry(cfg)).repos.length).toBe(1); // still registered
    } finally {
      await lock?.released();
    }
  });

  test("Remove purges everything", async () => {
    const { cfg, db, served, dir } = await serveAdmin();
    const checkout = join(dir, "repos", "repoA", "checkout");
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, "repoA", checkout);
    expect((await docCounts(db, "repoA")).wiki).toBeGreaterThan(0);
    await saveRegistry(cfg, { repos: [makeRecord(dir, { clonePath: checkout })] });

    const res = await req(served, "DELETE", "/api/repos/repoA");
    expect(res.status).toBe(200);

    expect((await loadRegistry(cfg)).repos.length).toBe(0); // registration gone
    expect((await docCounts(db, "repoA")).wiki).toBe(0); // index rows purged
    await expect(stat(checkout)).rejects.toBeTruthy(); // clone removed

    // …and the repo vanishes from /status.
    const status = (await (await req(served, "GET", "/status")).json()) as { repos: unknown[] };
    expect(status.repos.length).toBe(0);
  });
});

describe("Instructions endpoints", () => {
  test("Round-trip instructions", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    const stateBefore = await Bun.file(paths.state(cfg)).text();

    const put = await req(served, "PUT", "/api/repos/repoA/instructions", {
      instructions: "focus on the auth flows",
    });
    expect(put.status).toBe(200);

    const get = await req(served, "GET", "/api/repos/repoA/instructions");
    const body = (await get.json()) as { instructions: string | null };
    expect(body.instructions).toBe("focus on the auth flows");

    // Yaml-only save: the machine-owned state store is untouched.
    expect(await Bun.file(paths.state(cfg)).text()).toBe(stateBefore);
  });

  test("Clearing instructions", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { instructions: "old instructions" })],
    });

    const res = await req(served, "PUT", "/api/repos/repoA/instructions", { instructions: "  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instructions: string | null };
    expect(body.instructions).toBeNull();
    expect((await loadRegistry(cfg)).repos[0]?.instructions).toBeUndefined();
  });

  test("Unknown repo rejected", async () => {
    const { served } = await serveAdmin();
    expect((await req(served, "GET", "/api/repos/nope/instructions")).status).toBe(404);
    expect(
      (await req(served, "PUT", "/api/repos/nope/instructions", { instructions: "x" })).status,
    ).toBe(404);
  });
});

describe("Schedule endpoints", () => {
  test("Round-trip schedule", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    const stateBefore = await Bun.file(paths.state(cfg)).text();

    const put = await req(served, "PUT", "/api/repos/repoA/schedule", { schedule: "0 3 * * *" });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { schedule: string | null }).schedule).toBe("0 3 * * *");

    const get = await req(served, "GET", "/api/repos/repoA/schedule");
    expect(((await get.json()) as { schedule: string | null }).schedule).toBe("0 3 * * *");

    // Yaml-only save: state untouched and no run tracked for the repo.
    expect(await Bun.file(paths.state(cfg)).text()).toBe(stateBefore);
    expect(adminRuns.has("repoA")).toBe(false);
  });

  test("Clearing the override", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir, { schedule: "0 3 * * *" })] });

    const res = await req(served, "PUT", "/api/repos/repoA/schedule", { schedule: "  " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { schedule: string | null }).schedule).toBeNull();
    expect((await loadRegistry(cfg)).repos[0]?.schedule).toBeNull();
    expect(await Bun.file(paths.registryYaml(cfg)).text()).toContain("schedule: null");
  });

  test("Invalid cron rejected", async () => {
    const { cfg, served, dir } = await serveAdmin();
    await saveRegistry(cfg, { repos: [makeRecord(dir, { schedule: "0 3 * * *" })] });
    const yamlBefore = await Bun.file(paths.registryYaml(cfg)).text();

    const res = await req(served, "PUT", "/api/repos/repoA/schedule", { schedule: "not a cron" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid cron");

    expect((await loadRegistry(cfg)).repos[0]?.schedule).toBe("0 3 * * *"); // prior override kept
    expect(await Bun.file(paths.registryYaml(cfg)).text()).toBe(yamlBefore); // nothing persisted
  });

  test("Unknown repo rejected", async () => {
    const { served } = await serveAdmin();
    expect((await req(served, "GET", "/api/repos/nope/schedule")).status).toBe(404);
    expect(
      (await req(served, "PUT", "/api/repos/nope/schedule", { schedule: "0 3 * * *" })).status,
    ).toBe(404);
  });

  test("Saved schedule is applied to the running scheduler", async () => {
    const { served, dir, cfg } = await serveAdmin({ scheduler: true });
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });

    const known = new Set(cron.getTasks().keys());
    cleanups.push(() => {
      for (const t of cron.getTasks().values()) t.destroy();
    });

    const res = await req(served, "PUT", "/api/repos/repoA/schedule", { schedule: "30 4 * * *" });
    expect(res.status).toBe(200);

    // The handler awaits the scheduler hook, so the job exists by response time.
    const patterns = [...cron.getTasks()]
      .filter(([id]) => !known.has(id))
      .map(([, task]) => task.getPattern());
    expect(patterns).toContain("30 4 * * *");
  });
});
