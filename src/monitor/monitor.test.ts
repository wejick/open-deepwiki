import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { openDb } from "../index/db.ts";
import { classifyHealth, intervalMsOfSchedule } from "./health.ts";
import { buildStatusSummary } from "./status.ts";
import { appendEvent, readEvents } from "./events.ts";
import { startServer, type ServeResult } from "../server/server.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { paths } from "../config/config.ts";
import { wipDir } from "../producer/wip.ts";
import type { RepoRecord, Registry } from "../repoManager/registry.ts";

let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: Client[] = [];
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

function makeRepo(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    repoId: "gitlab.corp/team/repo",
    source: "git@gitlab.corp:team/repo.git",
    clonePath: "/tmp/unused/checkout",
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

describe("Deterministic repo health classification", () => {
  test("Failed run marks repo red", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const repo = makeRepo({
      lastRun: {
        startedAt: null,
        finishedAt: null,
        outcome: "failed",
        durationMs: 10,
        tokens: null,
        error: "openwiki exited 1",
      },
    });
    expect(classifyHealth(repo, cfg)).toBe("red");
  });

  test("Stale repo marked yellow", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const repo = makeRepo({ lastSuccessAt: threeDaysAgo });
    expect(classifyHealth(repo, cfg)).toBe("yellow"); // nightly: 2x interval = 48h
  });

  test("Healthy repo marked green", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const repo = makeRepo({ lastSuccessAt: new Date().toISOString() });
    expect(classifyHealth(repo, cfg)).toBe("green");
  });

  test("Interval estimates honor per-repo overrides", () => {
    expect(intervalMsOfSchedule(null, { hour: 2, minute: 0 })).toBe(24 * 3600 * 1000);
    expect(intervalMsOfSchedule("0 * * * *", { hour: 2, minute: 0 })).toBe(3600 * 1000);
    expect(intervalMsOfSchedule("*/15 * * * *", { hour: 2, minute: 0 })).toBe(15 * 60 * 1000);
    expect(intervalMsOfSchedule("0 3 * * *", { hour: 2, minute: 0 })).toBe(24 * 3600 * 1000);
  });

  test("Status summary aggregates health", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const registry: Registry = {
      repos: [
        makeRepo({ repoId: "a", lastSuccessAt: new Date().toISOString() }),
        makeRepo({
          repoId: "b",
          lastRun: {
            startedAt: null,
            finishedAt: null,
            outcome: "failed",
            durationMs: 1,
            tokens: null,
            error: "boom",
          },
        }),
      ],
    };
    const summary = await buildStatusSummary(cfg, db, registry);
    expect(summary.aggregates.health).toEqual({ green: 1, yellow: 0, red: 1 });
    const b = summary.repos.find((r) => r.repoId === "b");
    expect(b?.health).toBe("red");
    expect(b?.lastError).toBe("boom");
  });

  test("Status reports the repo's schedule override", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const registry: Registry = {
      repos: [makeRepo({ repoId: "a", schedule: "0 3 * * *" }), makeRepo({ repoId: "b" })],
    };
    const summary = await buildStatusSummary(cfg, db, registry);
    expect(summary.repos.find((r) => r.repoId === "a")?.schedule).toBe("0 3 * * *");
    expect(summary.repos.find((r) => r.repoId === "b")?.schedule).toBeNull();
  });
});

async function plantLock(cfg: ReturnType<typeof testConfig>, pid: number) {
  const file = paths.lock(cfg, "gitlab.corp/team/repo");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`);
}

describe("Run-state classification", () => {
  function startedRun(overrides: Partial<RepoRecord> = {}): RepoRecord {
    return makeRepo({
      lastRun: {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: null,
        durationMs: null,
        tokens: null,
        error: null,
      },
      ...overrides,
    });
  }

  function trackProc(proc: { kill: () => void }) {
    cleanups.push(() => proc.kill());
  }

  test("Run with a live lock holder reads running", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const live = Bun.spawn(["sleep", "30"]);
    trackProc(live);
    await plantLock(cfg, live.pid);
    const registry: Registry = { repos: [startedRun()] };
    const summary = await buildStatusSummary(cfg, db, registry);
    expect(summary.repos[0]?.runState).toBe("running");
  });

  test("Orphaned run reads interrupted", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await plantLock(cfg, dead.pid);
    const repo = startedRun();
    const registry: Registry = { repos: [repo] };
    const summary = await buildStatusSummary(cfg, db, registry);
    expect(summary.repos[0]?.runState).toBe("interrupted");
    expect(summary.repos[0]?.health).toBe(classifyHealth(repo, cfg));
    expect(repo.lastRun.finishedAt).toBeNull(); // not persisted
  });

  test("No lock evidence keeps the running classification", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const registry: Registry = { repos: [startedRun()] };
    const summary = await buildStatusSummary(cfg, db, registry);
    expect(summary.repos[0]?.runState).toBe("running");
  });

  test("Unparseable lock evidence keeps the running classification", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const file = paths.lock(cfg, "gitlab.corp/team/repo");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "not json\n");
    const registry: Registry = { repos: [startedRun()] };
    const summary = await buildStatusSummary(cfg, db, registry);
    expect(summary.repos[0]?.runState).toBe("running");
  });

  test("Finished and never-run repos read null", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const finished = startedRun({
      lastRun: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: "success",
        durationMs: 5,
        tokens: null,
        error: null,
      },
    });
    const registry: Registry = { repos: [finished, makeRepo()] };
    const summary = await buildStatusSummary(cfg, db, registry);
    expect(summary.repos.find((r) => r.repoId === finished.repoId)?.runState).toBeNull();
    expect(summary.repos.find((r) => r.repoId === "gitlab.corp/team/repo")?.runState).toBeNull();
  });
});

describe("Health and status endpoints", () => {
  test("Liveness check without token", async () => {
    const dir = await tmp();
    const { served } = await serveForEndpoints(dir, "127.0.0.1", undefined);
    const res = await fetch(`${served.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; repoCount: number };
    expect(body.ok).toBe(true);
    expect(body.repoCount).toBe(1);
  });

  test("Full status with token", async () => {
    const dir = await tmp();
    const { served, token } = await serveForEndpoints(dir, "0.0.0.0", "secret-token");
    const res = await fetch(`${served.url}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scheduler: unknown; repos: { repoId: string }[] };
    expect(body.scheduler).toBeDefined();
    expect(body.repos[0]?.repoId).toBe("gitlab.corp/team/repo");
  });

  test("Status requires token", async () => {
    const dir = await tmp();
    const { served } = await serveForEndpoints(dir, "0.0.0.0", "secret-token");
    const res = await fetch(`${served.url}/status`);
    expect(res.status).toBe(401);
  });
});

async function serveForEndpoints(
  dir: string,
  bindHost: string,
  token: string | undefined,
): Promise<{ served: ServeResult; token: string | undefined }> {
  // Find a free port for the endpoint tests.
  const { createServer } = await import("node:http");
  const port = await new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
  const cfg = testConfig(dir, {
    ODW_PORT: String(port),
    ODW_BIND_HOST: bindHost,
    ...(token ? { ODW_BEARER_TOKEN: token } : {}),
  });
  const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
  dbs.push(db);
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);
  const registry: Registry = { repos: [makeRepo({ lastSuccessAt: new Date().toISOString() })] };
  const served = await startServer({ cfg, db, registry });
  servers.push(served);
  return { served, token };
}

describe("Append-only event log", () => {
  test("Failed run recorded", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await appendEvent(cfg, { type: "run_failed", repoId: "r1", error: "boom" });
    const events = await readEvents(cfg);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run_failed");
    expect(events[0]?.error).toBe("boom");
    expect(events[0]?.ts).toBeDefined();
  });

  test("Producer progress round-trips with attribution", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await appendEvent(cfg, {
      type: "producer_progress",
      repoId: "r1",
      producer: "claude",
      stage: "area",
      note: "a2: 2/8",
    });
    const events = await readEvents(cfg);
    expect(events).toHaveLength(1);
    expect(events[0]?.producer).toBe("claude");
    expect(events[0]?.stage).toBe("area");
    expect(events[0]?.note).toBe("a2: 2/8");
    expect(events[0]?.ts).toBeDefined();
  });

  test("Rotation on size", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, { ODW_EVENT_LOG_MAX_BYTES: "200" });
    for (let i = 0; i < 5; i++) {
      await appendEvent(cfg, { type: "run_started", repoId: "r1" });
    }
    // After rotation the file stays under the limit and holds recent events.
    const raw = await readFile(paths.events(cfg), "utf8");
    expect(raw.length).toBeLessThan(200);
    const events = await readEvents(cfg);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]?.type).toBe("run_started");
  });

  test("Log filtering by repo", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await appendEvent(cfg, { type: "run_started", repoId: "a" });
    await appendEvent(cfg, { type: "run_succeeded", repoId: "a" });
    await appendEvent(cfg, { type: "run_failed", repoId: "b", error: "x" });
    const filtered = await readEvents(cfg, { repoId: "a" });
    expect(filtered.map((e) => e.repoId)).toEqual(["a", "a"]);
  });
});

/* ── Production progress in status (read-time, never stored) ─────────────── */

/** A staged bundle carrying a stamped plan and one conformant page of two. */
async function bundleInProgress(checkout: string): Promise<void> {
  const bundle = join(checkout, "openwiki");
  await mkdir(bundle, { recursive: true });
  await Bun.write(
    join(bundle, ".odw-plan.json"),
    JSON.stringify({
      pages: [
        { path: "a.md", type: "concept", title: "A", brief: "", sourcePaths: [], relatedPages: [] },
        { path: "b.md", type: "concept", title: "B", brief: "", sourcePaths: [], relatedPages: [] },
      ],
      deletePages: [],
      appliedAtSha: "s".repeat(40),
    }),
  );
  await Bun.write(join(bundle, "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
}

/** A WIP area carrying a map and one part of two areas. */
async function wipInProgress(cfg: ReturnType<typeof testConfig>, repoId: string): Promise<void> {
  const dir = wipDir(cfg, repoId);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, ".odw-map.json"),
    JSON.stringify({
      areas: [
        { id: "a0", title: "a0", scope: "", paths: ["f0.ts"] },
        { id: "a1", title: "a1", scope: "", paths: ["f1.ts"] },
      ],
      targetSha: "s".repeat(40),
    }),
  );
  await Bun.write(
    join(dir, ".odw-plan.part-a0.json"),
    JSON.stringify({
      pages: [
        { path: "a.md", type: "concept", title: "A", brief: "", sourcePaths: [], relatedPages: [] },
      ],
    }),
  );
}

describe("Production progress in status", () => {
  test("Decomposed planning reports area progress", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const checkout = join(dir, "checkout");
    await mkdir(checkout, { recursive: true });
    const bundle = join(checkout, "openwiki");
    await mkdir(bundle, { recursive: true });
    await Bun.write(
      join(bundle, ".odw-map.json"),
      JSON.stringify({
        areas: [
          { id: "a0", title: "a0", scope: "", paths: ["f0.ts"] },
          { id: "a1", title: "a1", scope: "", paths: ["f1.ts"] },
          { id: "a2", title: "a2", scope: "", paths: ["f2.ts"] },
        ],
      }),
    );
    await Bun.write(join(bundle, ".odw-plan.part-a0.json"), JSON.stringify({ pages: [] }));
    await Bun.write(join(bundle, ".odw-plan.part-a1.json"), JSON.stringify({ pages: [] }));
    const registry: Registry = {
      repos: [makeRepo({ repoId: "a", clonePath: checkout, lastRun: runOf("in-flight") })],
    };

    const summary = await buildStatusSummary(cfg, db, registry);

    const progress = summary.repos.find((r) => r.repoId === "a")?.progress ?? null;
    expect(progress?.phase).toBe("planning");
    expect(progress?.done).toBe(2);
    expect(progress?.total).toBe(3);
    expect(progress?.lastUnitAt).not.toBeNull();
  });

  test("Page generation reports page progress", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const checkout = join(dir, "checkout");
    await bundleInProgress(checkout);
    const registry: Registry = {
      repos: [makeRepo({ repoId: "a", clonePath: checkout, lastRun: runOf("in-flight") })],
    };

    const summary = await buildStatusSummary(cfg, db, registry);

    const progress = summary.repos.find((r) => r.repoId === "a")?.progress ?? null;
    expect(progress?.phase).toBe("pages");
    expect(progress?.done).toBe(1);
    expect(progress?.total).toBe(2);
  });

  test("Undecomposed planning is labeled, not blank", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const checkout = join(dir, "checkout");
    await mkdir(checkout, { recursive: true }); // no artifacts at all
    const registry: Registry = {
      repos: [makeRepo({ repoId: "a", clonePath: checkout, lastRun: runOf("in-flight") })],
    };

    const summary = await buildStatusSummary(cfg, db, registry);

    expect(summary.repos.find((r) => r.repoId === "a")?.progress).toEqual({
      phase: "planning",
      split: false,
      done: 0,
      total: 0,
      lastUnitAt: null,
    });
  });

  test("A preserved partial build stays legible between runs", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const checkout = join(dir, "checkout");
    await mkdir(checkout, { recursive: true });
    await wipInProgress(cfg, "a");
    const registry: Registry = {
      repos: [makeRepo({ repoId: "a", clonePath: checkout, lastRun: runOf("failed") })],
    };

    const summary = await buildStatusSummary(cfg, db, registry);

    const progress = summary.repos.find((r) => r.repoId === "a")?.progress ?? null;
    expect(progress?.phase).toBe("planning");
    expect(progress?.done).toBe(1);
    expect(progress?.total).toBe(2);
  });

  test("An idle repo with nothing legible reports null", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const checkout = join(dir, "checkout");
    await mkdir(checkout, { recursive: true });
    const registry: Registry = {
      repos: [makeRepo({ repoId: "a", clonePath: checkout, lastRun: runOf("done") })],
    };

    const summary = await buildStatusSummary(cfg, db, registry);

    expect(summary.repos.find((r) => r.repoId === "a")?.progress).toBeNull();
  });

  test("Progress never changes health", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const checkout = join(dir, "checkout");
    await bundleInProgress(checkout);
    const registry: Registry = {
      repos: [makeRepo({ repoId: "a", clonePath: checkout, lastRun: runOf("in-flight") })],
    };

    const summary = await buildStatusSummary(cfg, db, registry);

    // A repo mid-pages with progress is still green: run outcomes and
    // staleness alone decide the colour.
    expect(summary.repos.find((r) => r.repoId === "a")?.health).toBe("green");
    expect(summary.repos.find((r) => r.repoId === "a")?.progress?.phase).toBe("pages");
  });
});

/** A `lastRun` shape in one of three states the progress read cares about. */
function runOf(state: "in-flight" | "failed" | "done") {
  const now = new Date().toISOString();
  if (state === "in-flight") {
    return {
      startedAt: now,
      finishedAt: null,
      outcome: null,
      durationMs: null,
      tokens: null,
      error: null,
    };
  }
  if (state === "failed") {
    return {
      startedAt: now,
      finishedAt: now,
      outcome: "failed" as const,
      durationMs: 1,
      tokens: null,
      error: "cut short",
    };
  }
  return {
    startedAt: now,
    finishedAt: now,
    outcome: "success" as const,
    durationMs: 1,
    tokens: null,
    error: null,
  };
}
