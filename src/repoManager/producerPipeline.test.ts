import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config/config.ts";
import type { Client } from "@libsql/client";
import { openDb } from "../index/db.ts";
import { reinitRepo, recordRun, resumeRepo, runPipeline, updateRepo } from "./pipeline.ts";
import { producerFor, type RepoRecord } from "./registry.ts";
import { classifyHealth } from "../monitor/health.ts";
import { readContinuity } from "../producer/anchor.ts";
import { bundleDir } from "../producer/verify.ts";
import { readWipMeta, saveWip } from "../producer/wip.ts";
import { acquireRepoLock } from "./lock.ts";
import { gitClone, gitHeadSha } from "./git.ts";
import { readEvents } from "../monitor/events.ts";
import { commitFiles, createGitRepo } from "../../test/helpers/gitFixture.ts";
import {
  CLAUDE_PROBES,
  claudeFailsOnePage,
  claudeHappy,
  claudeNotLoggedIn,
  claudeRateLimited,
  claudeSplit,
  claudeSuccessButEmpty,
  openwikiExit1,
  openwikiHappy,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

/**
 * Producer selection and outcome handling at the pipeline level (6.1-6.3, 6.6).
 * Producers are shims: what is under test is the pipeline's own behavior.
 */

let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: Client[] = [];

afterEach(async () => {
  for (const c of cleanups) c();
  cleanups = [];
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  dbs = [];
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

async function setup(
  overrides: Record<string, string> = {},
  files: Record<string, string> = { "src/a.ts": "export const a = 1;\n", "README.md": "# r\n" },
): Promise<{
  dir: string;
  cfg: ReturnType<typeof testConfig>;
  db: Client;
  repo: RepoRecord;
}> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const cfg = testConfig(dir, overrides);
  const db = await openDb(join(dir, "index.db"), { dim: cfg.embedding.dim });
  dbs.push(db);
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);

  const source = join(dir, "origin");
  await createGitRepo(source, files);
  const repo: RepoRecord = {
    repoId: "repoA",
    source,
    clonePath: join(dir, "checkout"),
    addedAt: new Date().toISOString(),
    schedule: null,
    options: {},
    instructions: undefined,
    producer: undefined,
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
  };
  return { dir, cfg, db, repo };
}

describe("Producer selection at the pipeline (6.1)", () => {
  test("Default producer runs openwiki", async () => {
    const { cfg, db, repo } = await setup();
    const shim = await openwikiHappy(bundleFixture("valid"));

    const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });

    expect(producerFor(cfg, repo)).toBe("openwiki");
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("ok");
    expect(res.wikiChunks).toBeGreaterThan(0);
  });

  test("Per-repo override wins over the global default", async () => {
    const { cfg, db, repo } = await setup();
    const withOverride: RepoRecord = { ...repo, producer: "claude" };
    // Only a `claude` shim is on PATH, so the run succeeds only if the
    // override was honored.
    const shim = await claudeHappy(bundleFixture("valid"));

    const res = await runPipeline(cfg, db, withOverride, "init", {
      env: { PATH: pathWith(shim) },
    });

    expect(producerFor(cfg, withOverride)).toBe("claude");
    expect(res.ok).toBe(true);
  });

  test("global ODW_PRODUCER=claude applies to repos with no override", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const shim = await claudeHappy(bundleFixture("valid"));

    expect(producerFor(cfg, repo)).toBe("claude");
    expect((await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } })).ok).toBe(
      true,
    );
  });

  test("Claude producer planning honors the merged exclude set › the producer receives the repo's globs", async () => {
    // vendor/** is in no default global list, so only the registry merge can
    // remove these files from the digest the map session is told to cover.
    const { dir, cfg, db, repo } = await setup(
      { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" },
      {
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "export const b = 2;\n",
        "README.md": "# r\n",
        "vendor/lib.js": "vendored\n",
      },
    );
    const argv = join(dir, "argv.txt");
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        'printf "%s\\n=====\\n" "$PROMPT" >> "$ODW_ARGV_OUT"',
        `MAP_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^MAP_FILE: //p' | head -1)`,
        `printf '%s' '{"areas":[{"id":"a0","title":"a0","paths":["src/"]}]}' > "$MAP_FILE"`,
        `cat <<'JSON'\n${JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" })}\nJSON`,
        "exit 0",
      ].join("\n"),
    );

    await runPipeline(cfg, db, { ...repo, excludeGlobs: ["vendor/**"] }, "init", {
      env: { PATH: pathWith(shim), ODW_ARGV_OUT: argv },
    });

    const prompts = (await readFile(argv, "utf8")).split("\n=====\n");
    const mapPrompt = prompts.find((p) => p.includes("MAP_FILE:")) ?? "";
    expect(mapPrompt).toContain("Cover the 3 documentable files the digest lists");
    expect(mapPrompt).not.toContain("4 documentable");
    expect(mapPrompt).not.toContain("vendor");
  });

  test("Missing prerequisite degrades the same way for either producer", async () => {
    for (const producer of ["openwiki", "claude"] as const) {
      const { dir, cfg, db, repo } = await setup({ ODW_PRODUCER: producer });
      const empty = join(dir, "empty-bin");
      await Bun.write(join(empty, ".keep"), "");

      const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: empty } });

      // Warns, skips wiki generation, indexes sources anyway.
      expect(res.ok).toBe(true);
      expect(res.warnings.join(" ")).toContain(`${producer} CLI not found`);
      expect(res.wikiChunks).toBe(0);
      expect(res.sourceChunks).toBeGreaterThan(0);
    }
  });

  test("no version warning is emitted for the claude producer", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const shim = await claudeHappy(bundleFixture("valid"));

    const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
    expect(res.warnings.join(" ")).not.toContain("does not match pinned");
  });

  test("a failed run's error names the producer that ran", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const shim = await claudeNotLoggedIn();

    const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });

    expect(res.ok).toBe(false);
    expect((res.error ?? "").split("\n")[0]).toBe("claude run exited 1");
    const events = await readEvents(cfg);
    const lifecycle = events.filter((e) => e.type.startsWith("run_"));
    expect(lifecycle.map((e) => e.type)).toEqual(["run_started", "run_failed"]);
    for (const e of lifecycle) expect(e.producer).toBe("claude");
    // The planner session's spawn beat is the last thing before the failure.
    expect(events.at(-2)?.note).toBe("plan");
    expect(events.at(-1)?.error).toContain("claude run exited 1");
  });

  test("a producer's own account of the failure is not dropped", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    // Every session claims success and writes nothing — no child stderr, so
    // only spawnError knows why.
    const shim = await claudeSuccessButEmpty();

    const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });

    expect(res.ok).toBe(false);
    expect((res.error ?? "").split("\n")[0]).toBe("the planning session produced no plan");
    const events = await readEvents(cfg);
    expect(events.at(-1)?.error).toContain("the planning session produced no plan");
  });

  test("progress events interleave but never replace the terminal event", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    // Fails mid-pages: a.md and overview.md produce, b.md's session exits 2.
    const shim = await claudeFailsOnePage(["a.md", "b.md"], "b.md");

    const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
    expect(res.ok).toBe(false);

    const events = await readEvents(cfg);
    // run_started first, exactly one terminal event last, none missing.
    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_failed");
    expect(events.filter((e) => e.type.startsWith("run_")).map((e) => e.type)).toEqual([
      "run_started",
      "run_failed",
    ]);
    // Progress sits between them, attributed, in completion order — the
    // planner's own beat counts its pages before the overview is added, and
    // every session's spawn beat precedes it (b.md's spawned and failed).
    const progress = events.filter((e) => e.type === "producer_progress");
    expect(progress.map((e) => e.note)).toEqual([
      "init, 2 documentable files",
      "plan",
      "2 pages",
      "page a.md",
      "a.md: 1/3",
      "page b.md",
      "page overview.md",
      "overview.md: 2/3",
    ]);
    for (const e of progress) expect(e.producer).toBe("claude");
  });
});

describe("Continuity is written by the pipeline (6.2)", () => {
  test("both producers converge on the same continuity state", async () => {
    for (const producer of ["openwiki", "claude"] as const) {
      const { cfg, db, repo } = await setup({ ODW_PRODUCER: producer });
      const shim =
        producer === "openwiki"
          ? await openwikiHappy(bundleFixture("valid"))
          : await claudeHappy(bundleFixture("valid"));

      const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
      expect(res.ok).toBe(true);

      const c = await readContinuity(repo.clonePath);
      expect(c?.gitHead).toBe(res.sha ?? "");
      expect(c?.command).toBe("init");
      expect(c?.producer).toBe(producer);
      // openwiki's own fields are present and well-formed either way.
      expect(typeof c?.language).toBe("string");
      expect(typeof c?.status).toBe("string");
    }
  });

  test("the last-good snapshot carries the anchor the run just wrote", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const good = await claudeHappy(bundleFixture("valid"));

    const res = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(good) } });
    expect(res.ok).toBe(true);

    // The bundle is promoted to the snapshot inside runIsolatedProducer, i.e.
    // before the pipeline writes continuity. Without syncing the anchor across,
    // a later failed run restores a bundle whose gitHead names an older commit
    // and the next update re-derives already-published work.
    const snapshot = join(paths.repos(cfg), "snapshots", repo.repoId);
    const raw = await readFile(join(snapshot, ".last-update.json"), "utf8");
    expect(res.sha).not.toBeNull();
    expect((JSON.parse(raw) as { gitHead: string }).gitHead).toBe(res.sha ?? "");
  });
});

describe("Update flow derives the run mode from published state", () => {
  test("Update on a repo with no published bundle runs as init", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    // A clone that never got a bundle: the failed-first-build shape, reached
    // through the update path.
    await gitClone(repo.source, repo.clonePath);
    const shim = await claudeHappy(bundleFixture("valid"));

    const res = await updateRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } });

    expect(res.ok).toBe(true);
    expect(res.headMoved).toBe(true);
    // The producer was not told a bundle exists: the anchor it wrote says
    // init, and the planning beat carries the mode.
    expect((await readContinuity(repo.clonePath))?.command).toBe("init");
    const planning = (await readEvents(cfg)).find((e) => e.stage === "planning");
    expect(planning?.note).toBe("init, 2 documentable files");
  });

  test("Update on a repo with a published bundle keeps update semantics", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const shim = await claudeHappy(bundleFixture("valid"));
    const init = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
    recordRun(repo, init);
    expect(init.ok).toBe(true);
    await commitFiles(repo.source, { "src/b.ts": "export const b = 2;\n" }, "add b");

    const res = await updateRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } });

    expect(res.ok).toBe(true);
    expect(res.headMoved).toBe(true);
    expect((await readContinuity(repo.clonePath))?.command).toBe("update");
    const planning = (await readEvents(cfg)).filter((e) => e.stage === "planning");
    expect(planning.map((e) => e.note)).toContain("update");
  });

  test("A repo whose bundle is gone is rebuilt despite an unchanged head", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const shim = await claudeHappy(bundleFixture("valid"));
    const init = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
    recordRun(repo, init);
    expect(init.ok).toBe(true);
    await rm(bundleDir(repo.clonePath), { recursive: true, force: true });

    const res = await updateRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } });

    // Not skipped for being at its last indexed sha: rebuilt as an init.
    expect(res.headMoved).toBe(true);
    expect(res.ok).toBe(true);
    expect((await readContinuity(repo.clonePath))?.command).toBe("init");
  });

  test("A no-wiki repo at its indexed sha stays skipped", async () => {
    const { cfg, db, repo } = await setup();
    repo.options = { noWiki: true };
    await gitClone(repo.source, repo.clonePath);
    repo.lastIndexedSha = await gitHeadSha(repo.clonePath);

    const res = await updateRepo(cfg, db, repo, {});

    // Bundle absent by configuration, not by loss: the skip holds.
    expect(res.ok).toBe(true);
    expect(res.headMoved).toBe(false);

    // A moved head still pulls and re-indexes it.
    await commitFiles(repo.source, { "src/b.ts": "export const b = 2;\n" }, "add b");
    const moved = await updateRepo(cfg, db, repo, {});
    expect(moved.ok).toBe(true);
    expect(moved.headMoved).toBe(true);
  });

  test("A failed first build recovered by the batch is an init", async () => {
    const files = {
      "src/a.ts": "a\n",
      "src/b.ts": "b\n",
      "src/c.ts": "c\n",
      "README.md": "# r\n",
    };
    const { cfg, db, repo } = await setup(
      { ODW_PRODUCER: "claude", ODW_CLAUDE_SPLIT_PLAN_FILES: "2" },
      files,
    );
    // First run: a map that is valid-sized but off-count — one one-file area
    // where the sizing rule implies 4 (accepted 2–8) — is rejected, so nothing
    // is published. Over-budget maps no longer reject: they are split.
    const bad = await claudeSplit([{ id: "only", paths: ["src/a.ts"], pages: ["only.md"] }]);
    const first = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(bad) } });
    expect(first.ok).toBe(false);
    expect(first.error ?? "").toContain("the map was rejected");

    const good = await claudeSplit(
      Object.keys(files).map((p, i) => ({
        id: `a${i}`,
        paths: [p],
        pages: [`area${i}.md`],
      })),
    );
    const before = (await readEvents(cfg)).length;
    const res = await updateRepo(cfg, db, repo, { env: { PATH: pathWith(good) } });

    expect(res.ok).toBe(true);
    expect((await readContinuity(repo.clonePath))?.command).toBe("init");
    // The recovery decomposed planning: a map session before any area, and
    // no undecomposed planner session.
    const progress = (await readEvents(cfg))
      .slice(before)
      .filter((e) => e.type === "producer_progress");
    expect(progress[0]?.note).toBe("init, 4 documentable files");
    const sessions = progress.filter((e) => e.stage === "session").map((e) => e.note);
    expect(sessions[0]).toBe("map");
    expect(sessions).not.toContain("plan");
  });
});

/** The state a preserved build leaves behind: a published bundle, a clone at
 *  the commit being built, and a WIP pinned to it. The remote may then move on
 *  — the resume must not follow it. */
async function seedPreserved(
  cfg: ReturnType<typeof testConfig>,
  db: Client,
  repo: RepoRecord,
): Promise<{ pinned: string; happy: string }> {
  const producer = producerFor(cfg, repo);
  const happy =
    producer === "claude"
      ? await claudeHappy(bundleFixture("valid"))
      : await openwikiHappy(bundleFixture("valid"));
  const init = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(happy) } });
  expect(init.ok).toBe(true);
  recordRun(repo, init);
  // The interrupted run pulled once and died at its target; its partial work
  // was preserved pinned to that commit.
  await commitFiles(repo.source, { "src/b.ts": "export const b = 2;\n" }, "add b");
  const pinned = await gitHeadSha(repo.source);
  execFileSync("git", ["-C", repo.clonePath, "fetch", "origin"]);
  execFileSync("git", ["-C", repo.clonePath, "reset", "--hard", pinned]);
  await saveWip(cfg, repo.repoId, join(repo.clonePath, "openwiki"), {
    targetSha: pinned,
    producer,
  });
  return { pinned, happy };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function snapshotOf(cfg: ReturnType<typeof testConfig>, repo: RepoRecord): string {
  return join(paths.repos(cfg), "snapshots", repo.repoId);
}

describe("Resume a preserved build without pulling", () => {
  test("Resume runs at the pinned commit without pulling", async () => {
    const { cfg, db, repo } = await setup();
    const { pinned, happy } = await seedPreserved(cfg, db, repo);
    // The remote moved on while the build sat preserved.
    await commitFiles(repo.source, { "src/c.ts": "export const c = 3;\n" }, "add c");
    const head = await gitHeadSha(repo.source);
    expect(head).not.toBe(pinned);

    const res = await resumeRepo(cfg, db, repo, { env: { PATH: pathWith(happy) } });

    expect(res.ok).toBe(true);
    // Recorded sha is the pinned one, not the remote head the clone never pulled.
    expect(res.sha).toBe(pinned);
    expect(res.wikiChunks).toBeGreaterThan(0);
    expect(await gitHeadSha(repo.clonePath)).toBe(pinned); // no fetch or pull
    expect((await readContinuity(repo.clonePath))?.gitHead).toBe(pinned);
  });

  test("A clone drifted ahead of its preserved pin is realigned before resuming", async () => {
    const { cfg, db, repo } = await setup();
    const { pinned, happy } = await seedPreserved(cfg, db, repo);
    // Earlier pipeline versions pulled a pinned clone to the remote head, so a
    // preserved build can sit ahead of the commit it is pinned to. Resume must
    // realign it, or it would index a different tree than the recorded pin.
    await commitFiles(repo.source, { "src/c.ts": "export const c = 3;\n" }, "add c");
    const drifted = await gitHeadSha(repo.source);
    execFileSync("git", ["-C", repo.clonePath, "fetch", "origin"]);
    execFileSync("git", ["-C", repo.clonePath, "reset", "--hard", drifted]);
    expect(await gitHeadSha(repo.clonePath)).not.toBe(pinned);

    const res = await resumeRepo(cfg, db, repo, { env: { PATH: pathWith(happy) } });

    expect(res.ok).toBe(true);
    // The clone was moved back to the pin and the build ran there, not on the
    // drifted head the old pull left behind.
    expect(res.sha).toBe(pinned);
    expect(await gitHeadSha(repo.clonePath)).toBe(pinned);
    expect((await readContinuity(repo.clonePath))?.gitHead).toBe(pinned);
  });

  test("Resume is not skipped at the last indexed sha", async () => {
    const { cfg, db, repo } = await setup();
    const { pinned, happy } = await seedPreserved(cfg, db, repo);
    // The pinned target equals the last indexed sha: an update would say "up to
    // date", a resume must still execute so the preserved work can finish.
    repo.lastIndexedSha = pinned;
    const before = (await readEvents(cfg)).filter((e) => e.type.startsWith("run_")).length;

    const res = await resumeRepo(cfg, db, repo, { env: { PATH: pathWith(happy) } });

    expect(res.ok).toBe(true);
    expect(res.durationMs).toBeGreaterThan(0);
    expect(res.wikiChunks).toBeGreaterThan(0);
    expect(res.sha).toBe(pinned);
    const after = (await readEvents(cfg)).filter((e) => e.type.startsWith("run_")).length;
    expect(after).toBe(before + 2); // run_started + run_succeeded — it ran
  });

  test("Nothing to resume", async () => {
    const { cfg, db, repo } = await setup();
    const before = (await readEvents(cfg)).filter((e) => e.type.startsWith("run_")).length;
    const indexSha = repo.lastIndexedSha;

    const res = await resumeRepo(cfg, db, repo, {});

    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("nothing to resume");
    expect(res.skipped).toBe(true);
    expect(res.durationMs).toBe(0);
    expect(res.sha).toBeNull();
    expect(await readWipMeta(cfg, repo.repoId)).toBeNull();
    expect(repo.lastIndexedSha).toBe(indexSha); // registry state unchanged
    // No run started: a "resume" on a healthy repo must not silently rebuild it.
    const after = (await readEvents(cfg)).filter((e) => e.type.startsWith("run_")).length;
    expect(after).toBe(before);
  });

  test("Failed resume keeps the last good wiki", async () => {
    const { cfg, db, repo } = await setup();
    const { pinned } = await seedPreserved(cfg, db, repo);
    // Mark the published bundle after the WIP was preserved, so a restore from
    // the last-good snapshot is observable.
    await Bun.write(join(bundleDir(repo.clonePath), "index.md"), "# SENTINEL\n");
    const failing = await openwikiExit1();

    const res = await resumeRepo(cfg, db, repo, { env: { PATH: pathWith(failing) } });

    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("failed");
    expect(res.error ?? "").toContain("openwiki run exited 1");
    // The published bundle is exactly what was queryable before the resume:
    // run.ts snapshots it before staging the WIP, and a failure restores it.
    const restored = await readFile(join(bundleDir(repo.clonePath), "index.md"), "utf8");
    expect(restored).toContain("SENTINEL");
    expect(await pathExists(snapshotOf(cfg, repo))).toBe(true);
    expect(await pathExists(bundleDir(repo.clonePath))).toBe(true);
    expect(res.sha).toBe(pinned);
  });

  test("Rate-limited resume stays resumable", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const { pinned, happy } = await seedPreserved(cfg, db, repo);
    const limited = await claudeRateLimited("2026-09-01T12:00:00Z");

    const res = await resumeRepo(cfg, db, repo, { env: { PATH: pathWith(limited) } });

    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("rate_limited");
    // The WIP survives with its attempt advanced, still pinned to the same commit.
    const meta = await readWipMeta(cfg, repo.repoId);
    expect(meta?.targetSha).toBe(pinned);
    expect(meta?.attempts).toBe(2); // seed's preservation (1) + this zero-progress run
    expect(res.resetAt).toBe("2026-09-01T12:00:00Z");

    // A later resume continues the same pinned build and clears the WIP.
    const later = await resumeRepo(cfg, db, repo, { env: { PATH: pathWith(happy) } });
    expect(later.ok).toBe(true);
    expect(later.sha).toBe(pinned);
    expect(await readWipMeta(cfg, repo.repoId)).toBeNull();
  });

  test("An exhausted preserved build refuses and clears the WIP", async () => {
    const { cfg, db, repo } = await setup({ ODW_MAX_RESUME_ATTEMPTS: "1" });
    await gitClone(repo.source, repo.clonePath);
    // One prior zero-progress attempt is already the cap: attempts 1 >= 1.
    await saveWip(cfg, repo.repoId, join(repo.clonePath, "openwiki"), {
      targetSha: "deadbeef",
      producer: "openwiki",
    });
    const happy = await openwikiHappy(bundleFixture("valid"));

    const res = await resumeRepo(cfg, db, repo, { env: { PATH: pathWith(happy) } });

    expect(res.ok).toBe(false);
    // planResume's refusal surfaces through the run, and the WIP is dropped so
    // the repo stops silently retrying — it is surfaced for a human decision.
    expect(res.error ?? "").toContain("abandoned after 1 attempts for commit deadbeef");
    expect(res.error ?? "").toContain("needs attention");
    expect(await readWipMeta(cfg, repo.repoId)).toBeNull();
  });
});

describe("Repository re-initialization (repo reinit)", () => {
  test("Re-initialization rebuilds a repo from its existing clone", async () => {
    const { cfg, db, repo } = await setup();
    const shim = await openwikiHappy(bundleFixture("valid"));
    const first = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
    expect(first.ok).toBe(true);

    // A marker only a re-clone would wipe.
    await Bun.write(join(repo.clonePath, "sentinel.txt"), "keep me");
    // The failed-first-build shape: nothing published, nothing verified.
    await rm(bundleDir(repo.clonePath), { recursive: true, force: true });
    await rm(snapshotOf(cfg, repo), { recursive: true, force: true });
    // The remote moved; the rebuild must target the current head.
    await commitFiles(repo.source, { "src/b.ts": "export const b = 2;\n" }, "second commit");
    const head = await gitHeadSha(repo.source);

    const res = await reinitRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } });

    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("ok");
    expect(res.sha).toBe(head);
    // Same clone (sentinel survived the pull), rebuilt as an init.
    expect(await readFile(join(repo.clonePath, "sentinel.txt"), "utf8")).toBe("keep me");
    expect((await readContinuity(repo.clonePath))?.command).toBe("init");
    expect((await readContinuity(repo.clonePath))?.gitHead).toBe(head);
    expect(await pathExists(bundleDir(repo.clonePath))).toBe(true);
    expect(await pathExists(snapshotOf(cfg, repo))).toBe(true);
  });

  test("Re-initialization unblocks an exhausted work-in-progress build", async () => {
    const { cfg, db, repo } = await setup({ ODW_MAX_RESUME_ATTEMPTS: "1" });
    const shim = await openwikiHappy(bundleFixture("valid"));
    await gitClone(repo.source, repo.clonePath);
    const wipBundle = join(repo.clonePath, "openwiki");
    await saveWip(cfg, repo.repoId, wipBundle, {
      targetSha: "deadbeef",
      producer: "openwiki",
    });

    // The exhausted WIP genuinely blocks every run: updateRepo aborts before
    // any producer is touched.
    const blocked = await updateRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } });
    expect(blocked.ok).toBe(false);
    expect(blocked.error ?? "").toContain("abandoned");

    // Re-plant the wedged state, then reinit: it clears the WIP and rebuilds.
    await saveWip(cfg, repo.repoId, wipBundle, {
      targetSha: "deadbeef",
      producer: "openwiki",
    });
    const res = await reinitRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } });
    expect(res.ok).toBe(true);
    expect(await readWipMeta(cfg, repo.repoId)).toBeNull();
    expect(await pathExists(bundleDir(repo.clonePath))).toBe(true);
  });

  test("A failed re-initialization leaves nothing published", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const happy = await claudeHappy(bundleFixture("valid"));
    const first = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(happy) } });
    expect(first.ok).toBe(true);

    // Reinit with a producer that claims success but writes nothing.
    const empty = await claudeSuccessButEmpty();
    const res = await reinitRepo(cfg, db, repo, { env: { PATH: pathWith(empty) } });
    expect(res.ok).toBe(false);

    // Nothing restored: the discarded snapshot is gone and nothing is published.
    expect(await pathExists(bundleDir(repo.clonePath))).toBe(false);
    expect(await pathExists(snapshotOf(cfg, repo))).toBe(false);

    // A later run rebuilds the repo as an init, not an incremental update.
    const later = await updateRepo(cfg, db, repo, { env: { PATH: pathWith(happy) } });
    expect(later.ok).toBe(true);
    expect((await readContinuity(repo.clonePath))?.command).toBe("init");
  });

  test("Re-initialization is refused while another run holds the lock", async () => {
    const { cfg, db, repo } = await setup();
    const shim = await openwikiHappy(bundleFixture("valid"));
    const first = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
    expect(first.ok).toBe(true);

    const lock = await acquireRepoLock(cfg, repo.repoId);
    expect(lock).not.toBeNull();
    if (lock === null) return;
    try {
      const res = await reinitRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } });
      expect(res.ok).toBe(false);
      expect(res.error ?? "").toContain("in progress");
      // No state was touched: the bundle survives the refused reinit.
      expect(await pathExists(bundleDir(repo.clonePath))).toBe(true);
    } finally {
      await lock.released();
    }
  });

  test("a failed pull costs nothing: the wiki it was about to discard survives", async () => {
    const { cfg, db, repo } = await setup();
    const shim = await openwikiHappy(bundleFixture("valid"));
    const first = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(shim) } });
    expect(first.ok).toBe(true);
    // The remote vanishes: the pull in reinitRepo now fails before any clear.
    await rm(repo.source, { recursive: true, force: true });

    await expect(reinitRepo(cfg, db, repo, { env: { PATH: pathWith(shim) } })).rejects.toThrow();
    // Nothing was discarded by the failed command.
    expect(await pathExists(bundleDir(repo.clonePath))).toBe(true);
    expect(await pathExists(snapshotOf(cfg, repo))).toBe(true);
  });
});

describe("Rate limit threads through as its own outcome (6.3, 6.6)", () => {
  test("a rate-limited run leaves last-success state untouched", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });

    // First: a good run establishes last-success state.
    const good = await claudeHappy(bundleFixture("valid"));
    const first = await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(good) } });
    recordRun(repo, first);
    const successAt = repo.lastSuccessAt;
    const indexedSha = repo.lastIndexedSha;
    expect(successAt).not.toBeNull();

    // Then: a rate-limited run.
    const limited = await claudeRateLimited("2026-09-01T12:00:00Z");
    const second = await runPipeline(cfg, db, repo, "update", {
      env: { PATH: pathWith(limited) },
    });
    recordRun(repo, second);

    expect(second.ok).toBe(false);
    expect(second.outcome).toBe("rate_limited");
    expect(second.resetAt).toBe("2026-09-01T12:00:00Z");
    // Not recorded as failed, and last-success state is unmoved.
    expect(repo.lastRun.outcome).toBe("rate_limited");
    expect(repo.lastSuccessAt).toBe(successAt);
    expect(repo.lastIndexedSha).toBe(indexedSha);
  });

  test("a rate-limited run emits run_rate_limited and no run_failed", async () => {
    const { cfg, db, repo } = await setup({ ODW_PRODUCER: "claude" });
    const limited = await claudeRateLimited();

    await runPipeline(cfg, db, repo, "init", { env: { PATH: pathWith(limited) } });

    const events = await readEvents(cfg);
    const types = events.filter((e) => e.repoId === "repoA").map((e) => e.type);
    expect(types).toContain("run_rate_limited");
    expect(types).not.toContain("run_failed");
  });

  test("health: rate_limited is yellow, never red", () => {
    const cfg = testConfig("/tmp/x");
    const base: RepoRecord = {
      repoId: "r",
      source: "s",
      clonePath: "/x",
      addedAt: new Date().toISOString(),
      schedule: null,
      options: {},
      instructions: undefined,
      producer: undefined,
      lastRun: {
        startedAt: null,
        finishedAt: null,
        outcome: "rate_limited",
        durationMs: null,
        tokens: null,
        error: null,
      },
      lastIndexedSha: null,
      lastSuccessAt: new Date().toISOString(),
    };
    expect(classifyHealth(base, cfg)).toBe("yellow");
    expect(classifyHealth({ ...base, lastRun: { ...base.lastRun, outcome: "failed" } }, cfg)).toBe(
      "red",
    );
  });

  test("health: sub-floor grounding is yellow when a floor is configured", () => {
    const gated = testConfig("/tmp/x", { ODW_GROUNDING_MIN: "0.9" });
    const ungated = testConfig("/tmp/x"); // floor 0 => measure, do not gate
    const repo: RepoRecord = {
      repoId: "r",
      source: "s",
      clonePath: "/x",
      addedAt: new Date().toISOString(),
      schedule: null,
      options: {},
      instructions: undefined,
      producer: undefined,
      lastRun: {
        startedAt: null,
        finishedAt: null,
        outcome: "success",
        durationMs: null,
        tokens: null,
        error: null,
        groundingScore: 0.4,
      },
      lastIndexedSha: "abc",
      lastSuccessAt: new Date().toISOString(),
    };
    expect(classifyHealth(repo, gated)).toBe("yellow");
    expect(classifyHealth(repo, ungated)).toBe("green");
  });
});
