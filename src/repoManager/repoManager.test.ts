import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import cron from "node-cron";
import type { Client } from "@libsql/client";
import { openDb, listChunks, docCounts } from "../index/db.ts";
import {
  getRepo,
  loadRegistry,
  normalizeGlobs,
  repoIdFromSource,
  saveRegistry,
  saveState,
  saveYaml,
  uniqueRepoId,
  type RepoRecord,
  type Registry,
} from "./registry.ts";
import { acquireRepoLock } from "./lock.ts";
import { runQueue } from "./queue.ts";
import { createScheduler, dispatchOrder } from "./scheduler.ts";
import { classifyHealth } from "../monitor/health.ts";
import {
  MAX_ERROR_DETAIL,
  runPipeline,
  updateRepo,
  removeRepoDir,
  markRunStarted,
  recordRun,
} from "./pipeline.ts";
import { createGitRepo, commitFiles } from "../../test/helpers/gitFixture.ts";
import {
  claudeRateLimited,
  openwikiHappy,
  openwikiExit1,
  openwikiExit1Noisy,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp, waitForFile } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { paths } from "../config/config.ts";
import { readEvents } from "../monitor/events.ts";
import type { Config } from "../config/config.ts";
import type { Ctx } from "./context.ts";
import { addRepo } from "../cli/main.ts";

let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: Client[] = [];

async function tmp(): Promise<string> {
  const d = await makeTmp();
  tmpDirs.push(d);
  return d;
}

function pushStub(cfg: Config) {
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);
  return stub;
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

describe("Repository registration", () => {
  test("Add remote repo", async () => {
    expect(repoIdFromSource("git@gitlab.corp:team/subgroup/repo.git")).toBe(
      "gitlab.corp/team/subgroup/repo",
    );
    expect(repoIdFromSource("https://gitlab.corp/team/subgroup/repo.git")).toBe(
      "gitlab.corp/team/subgroup/repo",
    );
    expect(repoIdFromSource("ssh://git@gitlab.corp:2222/team/repo.git")).toBe(
      "gitlab.corp/team/repo",
    );
    expect(repoIdFromSource("/srv/code/my-repo")).toBe("local/my-repo");
  });

  test("Add duplicate repo", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const registry: Registry = {
      repos: [
        makeRecord(dir, {
          repoId: "gitlab.corp/team/repo",
          source: "git@gitlab.corp:team/repo.git",
        }),
      ],
    };
    await saveRegistry(cfg, registry);
    const loaded = await loadRegistry(cfg);
    expect(getRepo(loaded, "gitlab.corp/team/repo")?.source).toBe("git@gitlab.corp:team/repo.git");
    // same source slug collides -> suffixed id
    expect(uniqueRepoId(loaded, "gitlab.corp/team/repo")).toBe("gitlab.corp/team/repo-2");
  });

  test("Add duplicate repo fails with a clear error", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    pushStub(cfg);
    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const ctx: Ctx = {
      cfg,
      db: await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim }),
      registry: { repos: [] },
    };
    dbs.push(ctx.db);

    const first = await addRepo(ctx, remote, true); // --no-wiki: skip openwiki
    expect(first).toBe(0);
    expect(ctx.registry.repos.length).toBe(1);

    const dup = await addRepo(ctx, remote, true);
    expect(dup).toBe(1); // clear error, no duplicate entry
    expect(ctx.registry.repos.length).toBe(1);
  });

  test("Registry persists and lists", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const registry: Registry = { repos: [makeRecord(dir)] };
    await saveRegistry(cfg, registry);
    const loaded = await loadRegistry(cfg);
    expect(loaded.repos.length).toBe(1);
    expect(loaded.repos[0]?.repoId).toBe("repoA");
  });

  test("Per-repo exclude globs › Register repo with excludes", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    pushStub(cfg);
    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const ctx: Ctx = {
      cfg,
      db: await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim }),
      registry: { repos: [] },
    };
    dbs.push(ctx.db);

    const code = await addRepo(ctx, remote, true, undefined, undefined, [
      "**/__snapshots__/**",
      "**/*.a",
    ]);
    expect(code).toBe(0);
    const repo = ctx.registry.repos[0];
    expect(repo?.excludeGlobs).toEqual(["**/__snapshots__/**", "**/*.a"]);
    // Registration writes both stores — the globs land in registry.yaml.
    const yaml = await readFile(paths.registryYaml(cfg), "utf8");
    expect(yaml).toContain("**/__snapshots__/**");
    expect(yaml).toContain("**/*.a");

    // Duplicate and comma forms collapse to the deduplicated list.
    const deduped = normalizeGlobs(["**/*.a", "**/*.a", " ci/** ", ""]);
    expect(deduped).toEqual(["**/*.a", "ci/**"]);
  });
});

describe("Batch import", () => {
  test("Batch import respects concurrency cap", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxSeen = 0;
    await runQueue(items, 2, async (i) => {
      inFlight++;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((r) => setTimeout(r, 5 + i));
      inFlight--;
    });
    expect(maxSeen).toBe(2);
  });
});

describe("Scheduled updates", () => {
  test("Nightly run with changes triggers incremental re-index", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    // Create a source repo, commit, then clone it as the "remote" the pipeline pulls.
    const remote = await createGitRepo(join(dir, "remote"), {
      "src/a.ts": "export const a = 1; // alpha\n",
    });
    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const record = makeRecord(dir, {
      source: remote,
      repoId: "repoA",
      clonePath: join(dir, "repos", "repoA", "checkout"),
    });
    const init = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(shimDir) } });
    recordRun(record, init); // the CLI/scheduler records outcomes into the registry
    expect(init.ok).toBe(true);
    expect(record.lastIndexedSha).toBeTruthy();
    expect((await listChunks(db, "repoA", "source")).map((c) => c.path)).toEqual(["src/a.ts"]);

    // New commit on the remote; update pulls it and re-indexes incrementally.
    await commitFiles(remote, { "src/b.ts": "export const b = 2; // beta\n" }, "add b");
    const update = await updateRepo(cfg, db, record, { env: { PATH: pathWith(shimDir) } });
    expect(update.ok).toBe(true);
    expect(update.headMoved).toBe(true);
    expect((await listChunks(db, "repoA", "source")).map((c) => c.path).toSorted()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    // Head moved -> openwiki --update ran -> shim rewrote the bundle -> wiki chunks present.
    expect((await docCounts(db, "repoA")).wiki).toBeGreaterThan(0);
  });

  test("Pull with no changes", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const record = makeRecord(dir, {
      source: remote,
      repoId: "repoA",
      clonePath: join(dir, "repos", "repoA", "checkout"),
    });
    const init = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(shimDir) } });
    expect(init.ok).toBe(true);
    recordRun(record, init);
    const shaBefore = record.lastIndexedSha;
    await saveRegistry(cfg, { repos: [record] });

    const update = await updateRepo(cfg, db, record, { env: { PATH: pathWith(shimDir) } });
    expect(update.headMoved).toBe(false);
    expect(record.lastIndexedSha).toBe(shaBefore);
  });
});

describe("Run observability", () => {
  test("Stale error cleared when a run starts", () => {
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    const successAt = new Date(Date.now() - 86_400_000).toISOString();
    const record = makeRecord("/unused", {
      lastRun: {
        startedAt: null,
        finishedAt,
        outcome: "failed",
        durationMs: 1234,
        tokens: null,
        error: "openwiki exited 1: boom",
      },
      lastIndexedSha: "abc123",
      lastSuccessAt: successAt,
    });

    markRunStarted(record);

    expect(record.lastRun.error).toBeNull(); // superseded run's error dropped
    expect(record.lastRun.finishedAt).toBeNull();
    expect(record.lastRun.startedAt).not.toBeNull();
    // Outcome and last-success state stand until the run records — health
    // must not flip mid-run.
    expect(record.lastRun.outcome).toBe("failed");
    expect(record.lastRun.durationMs).toBe(1234);
    expect(record.lastIndexedSha).toBe("abc123");
    expect(record.lastSuccessAt).toBe(successAt);
  });
});

describe("Update concurrency safety", () => {
  test("Overlapping run skipped", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const first = await acquireRepoLock(cfg, "repoA");
    expect(first).not.toBeNull();
    const second = await acquireRepoLock(cfg, "repoA");
    expect(second).toBeNull(); // overlapping run skipped
    await first?.released();
    const third = await acquireRepoLock(cfg, "repoA");
    expect(third).not.toBeNull(); // released -> can lock again
    await third?.released();
  });
});

/** Poll helper lives in test/helpers/tmp.ts. */

/** Task ids node-cron had before a test's scheduler — patterns are read only
 *  from tasks created since, so stopped tasks from earlier tests in this file
 *  cannot leak into an assertion. */
function taskPatterns(since: Set<string>): string[] {
  return [...cron.getTasks()].filter(([id]) => !since.has(id)).map(([, task]) => task.getPattern());
}

function taskIds(): Set<string> {
  return new Set(cron.getTasks().keys());
}

/** Live schedule update tests leave node-cron tasks behind; destroy them so
 *  no timer outlives the test. */
function destroyAllCronTasks(): void {
  for (const task of cron.getTasks().values()) task.destroy();
}

describe("Live schedule updates", () => {
  test("Edited override takes effect without restart", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, { ODW_NIGHTLY_TIME: "02:00" });
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    await saveRegistry(cfg, { repos: [makeRecord(dir, { schedule: "0 3 * * *" })] });

    const known = taskIds();
    cleanups.push(destroyAllCronTasks);
    const scheduler = createScheduler(cfg, db);
    cleanups.push(() => scheduler.stop());

    await scheduler.applySchedule("repoA"); // settles the startup registry load
    expect(taskPatterns(known)).toContain("0 3 * * *");

    await saveRegistry(cfg, { repos: [makeRecord(dir, { schedule: "30 4 * * *" })] });
    await scheduler.applySchedule("repoA");

    const patterns = taskPatterns(known);
    expect(patterns).toContain("30 4 * * *");
    expect(patterns).not.toContain("0 3 * * *"); // the old expression no longer fires it
    expect(patterns).toContain("0 2 * * *"); // default nightly job still present

    const next = [...cron.getTasks().values()]
      .find((t) => t.getPattern() === "30 4 * * *")
      ?.getNextRun();
    expect(next).toBeInstanceOf(Date);
    expect(next?.getHours()).toBe(4);
    expect(next?.getMinutes()).toBe(30);
  });

  test("Cleared override falls back to the default", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, { ODW_NIGHTLY_TIME: "02:00" });
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    await saveRegistry(cfg, { repos: [makeRecord(dir, { schedule: "0 3 * * *" })] });

    const known = taskIds();
    cleanups.push(destroyAllCronTasks);
    const scheduler = createScheduler(cfg, db);
    cleanups.push(() => scheduler.stop());

    await scheduler.applySchedule("repoA");
    expect(taskPatterns(known)).toContain("0 3 * * *");

    await saveRegistry(cfg, { repos: [makeRecord(dir, { schedule: null })] });
    await scheduler.applySchedule("repoA");

    const patterns = taskPatterns(known);
    expect(patterns).not.toContain("0 3 * * *"); // per-repo job removed
    expect(patterns).toContain("0 2 * * *"); // default job covers the repo
  });

  test("Invalid override ignored", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, { ODW_NIGHTLY_TIME: "02:00" });
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    await saveRegistry(cfg, { repos: [makeRecord(dir, { schedule: "not a cron" })] });

    const known = taskIds();
    cleanups.push(destroyAllCronTasks);
    const scheduler = createScheduler(cfg, db);
    cleanups.push(() => scheduler.stop());

    await scheduler.applySchedule("repoA");
    const patterns = taskPatterns(known);
    expect(patterns).not.toContain("not a cron");
    expect(patterns).toContain("0 2 * * *"); // scheduler unharmed, default applies
  });

  test("Untouched repos unaffected", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, { ODW_NIGHTLY_TIME: "02:00" });
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    await saveRegistry(cfg, {
      repos: [
        makeRecord(dir, { repoId: "repoA", schedule: "0 3 * * *" }),
        makeRecord(dir, { repoId: "repoB", schedule: "0 5 * * *" }),
      ],
    });

    const known = taskIds();
    cleanups.push(destroyAllCronTasks);
    const scheduler = createScheduler(cfg, db);
    cleanups.push(() => scheduler.stop());

    await scheduler.applySchedule("repoA");
    await saveRegistry(cfg, {
      repos: [
        makeRecord(dir, { repoId: "repoA", schedule: "30 4 * * *" }),
        makeRecord(dir, { repoId: "repoB", schedule: "0 5 * * *" }),
      ],
    });
    await scheduler.applySchedule("repoA");

    const patterns = taskPatterns(known);
    expect(patterns).toContain("30 4 * * *"); // repoA moved
    expect(patterns).toContain("0 5 * * *"); // repoB kept firing as before
    expect(patterns).not.toContain("0 3 * * *");
  });
});

describe("Registry write discipline", () => {
  test("Batch end leaves human config untouched", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    // Checkout already at the last indexed sha with a published bundle → the
    // batch takes the no-changes path (no openwiki run needed). The bundle
    // matters: a bundle-less repo is rebuilt as an init even at its sha.
    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);
    await mkdir(join(checkout, "openwiki"));
    const headSha = (await simpleGit({ baseDir: checkout }).revparse(["HEAD"])).trim();

    // Hand-written human-owned yaml (comments included) — the bytes that must survive.
    await Bun.write(
      paths.registryYaml(cfg),
      `# team registry — hand-maintained\nrepos:\n  - repoId: repoA\n    source: ${remote}\n    # watch this repo closely\n`,
    );
    await saveState(cfg, {
      repos: [makeRecord(dir, { source: remote, clonePath: checkout, lastIndexedSha: headSha })],
    });
    const yamlBefore = await Bun.file(paths.registryYaml(cfg)).text();

    const scheduler = createScheduler(cfg, db);
    await scheduler.updateAll();
    scheduler.stop();

    expect(await Bun.file(paths.registryYaml(cfg)).text()).toBe(yamlBefore); // byte-identical
    const after = await loadRegistry(cfg);
    expect(after.repos[0]?.lastRun.outcome).toBe("success"); // state.json did move
  });

  test("Mid-batch edit survives", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);

    // lastIndexedSha null → head moves → full update run through a gated shim.
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { source: remote, clonePath: checkout })],
    });

    const gate = join(dir, "ow-gate");
    const started = join(dir, "ow-started");
    const shimDir = await writeShim(
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

    // The producer spawns children with process.env as the base — prepend the
    // shim so the scheduler-driven batch (which passes no env) picks it up.
    const originalPath = process.env.PATH;
    process.env.PATH = pathWith(shimDir);
    try {
      const scheduler = createScheduler(cfg, db);
      const batch = scheduler.updateAll(); // in-flight, blocked inside the gated shim
      await waitForFile(started);

      // Mid-batch human edit — yaml-only save, exactly what the dashboard's
      // instructions PUT does.
      const editing = await loadRegistry(cfg);
      const editingRepo = editing.repos[0];
      if (!editingRepo) throw new Error("repo missing");
      editingRepo.instructions = "focus on the auth flows";
      await saveYaml(cfg, editing);

      await Bun.write(gate, "go\n");
      await batch;
      scheduler.stop();
    } finally {
      process.env.PATH = originalPath;
    }

    const after = await loadRegistry(cfg);
    expect(after.repos[0]?.instructions).toBe("focus on the auth flows"); // edit survived
    expect(after.repos[0]?.lastRun.outcome).toBe("success"); // run outcome still recorded
  });
});

describe("The nightly batch records what the run actually was", () => {
  test("a rate-limited repo is recorded as rate_limited, carrying its reset time", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude" });
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { source: remote, clonePath: checkout })],
    });

    const shimDir = await claudeRateLimited("2026-09-01T12:00:00Z");
    const originalPath = process.env.PATH;
    process.env.PATH = pathWith(shimDir);
    try {
      const scheduler = createScheduler(cfg, db);
      await scheduler.updateAll();
      scheduler.stop();
    } finally {
      process.env.PATH = originalPath;
    }

    const after = await loadRegistry(cfg);
    const rec = after.repos[0];
    // The batch used to persist its own boolean, flattening this to "failed"
    // and dropping resetAt — the field dispatchOrder ranks on and the one that
    // keeps health yellow instead of painting the fleet red on one limit.
    expect(rec?.lastRun.outcome).toBe("rate_limited");
    expect(rec?.lastRun.resetAt).toBe("2026-09-01T12:00:00Z");
    expect(rec?.lastSuccessAt).toBeNull();
    expect(classifyHealth(rec as RepoRecord, cfg)).toBe("yellow");
    // And dispatch can now see it is waiting.
    expect(dispatchOrder([rec as RepoRecord], Date.parse("2026-08-29T00:00:00Z"))).toHaveLength(1);
  });

  test("a successful batch run still records success and advances the sha", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const checkout = join(dir, "repos", "repoA", "checkout");
    await simpleGit().clone(remote, checkout);
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { source: remote, clonePath: checkout })],
    });

    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const originalPath = process.env.PATH;
    process.env.PATH = pathWith(shimDir);
    try {
      const scheduler = createScheduler(cfg, db);
      await scheduler.updateAll();
      scheduler.stop();
    } finally {
      process.env.PATH = originalPath;
    }

    const after = await loadRegistry(cfg);
    expect(after.repos[0]?.lastRun.outcome).toBe("success");
    expect(after.repos[0]?.lastSuccessAt).not.toBeNull();
    expect(after.repos[0]?.lastIndexedSha).not.toBeNull();
    expect(after.repos[0]?.lastRun.resetAt).toBeUndefined();
  });
});

describe("Run observability", () => {
  test("Cost of a wiki run recorded", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const record = makeRecord(dir, {
      source: remote,
      repoId: "repoA",
      clonePath: join(dir, "repos", "repoA", "checkout"),
    });
    const result = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(shimDir) } });

    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);

    const events = await readEvents(cfg);
    expect(events.map((e) => e.type)).toEqual(["run_started", "run_succeeded"]);
    expect(events[1]?.durationMs).toBeGreaterThan(0);
  });
});

describe("Failure isolation in the pipeline", () => {
  test("Failed openwiki run leaves index untouched and records the failure", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const failing = await openwikiExit1();
    const record = makeRecord(dir, {
      source: remote,
      repoId: "repoA",
      clonePath: join(dir, "repos", "repoA", "checkout"),
    });

    const result = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(failing) } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("openwiki run exited 1");

    const events = await readEvents(cfg);
    expect(events.map((e) => e.type)).toEqual(["run_started", "run_failed"]);
    for (const e of events) expect(e.producer).toBe("openwiki");
    expect(events[1]?.error).toContain("openwiki run exited 1");
  });

  test("The whole of the producer's output is recorded, headline first", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const failing = await openwikiExit1Noisy(40);
    const record = makeRecord(dir, {
      source: remote,
      repoId: "repoA",
      clonePath: join(dir, "repos", "repoA", "checkout"),
    });

    const result = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(failing) } });

    const lines = (result.error ?? "").split("\n");
    expect(lines[0]).toBe("openwiki run exited 1");
    expect(lines).toContain("stderr line 1");
    expect(lines).toContain("stderr line 40");
    expect(lines.at(-1)).toBe("the last word");
  });

  test("A runaway producer is capped, keeping the informative tail", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const failing = await openwikiExit1Noisy(2000);
    const record = makeRecord(dir, {
      source: remote,
      repoId: "repoA",
      clonePath: join(dir, "repos", "repoA", "checkout"),
    });

    const result = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(failing) } });
    const error = result.error ?? "";

    expect(error.length).toBeLessThan(MAX_ERROR_DETAIL + 200);
    expect(error).toContain("earlier characters omitted");
    expect(error.trimEnd().endsWith("the last word")).toBe(true);
    expect(error).not.toContain("stderr line 1\n");
  });
});

describe("Repository removal and listing", () => {
  test("Remove repo", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    pushStub(cfg);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const record = makeRecord(dir, {
      source: remote,
      repoId: "repoA",
      clonePath: join(dir, "repos", "repoA", "checkout"),
    });
    const result = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(shimDir) } });
    expect(result.ok).toBe(true);
    expect((await listChunks(db, "repoA")).length).toBeGreaterThan(0);
    await expect(stat(record.clonePath)).resolves.toBeTruthy();

    await removeRepoDir(cfg, "repoA");
    await expect(stat(record.clonePath)).rejects.toBeTruthy();
  });
});
