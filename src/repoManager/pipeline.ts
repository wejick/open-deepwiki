import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type { Config } from "../config/config.ts";
import { paths } from "../config/config.ts";
import { prepareProducer, runIsolatedProducer } from "../producer/run.ts";
import {
  CONTINUITY_FILE,
  continuityPath,
  readAnchor,
  typeVocabulary,
  writeContinuity,
} from "../producer/anchor.ts";
import { clearWip, readWipMeta } from "../producer/wip.ts";
import { bundleDir } from "../producer/verify.ts";
import { diffNames, indexRepo } from "../index/update.ts";
import { acquireRepoLock } from "./lock.ts";
import { gitClone, gitHeadSha, gitPull, gitResetHard } from "./git.ts";
import { appendEvent } from "../monitor/events.ts";
import { effectiveExcludes, producerFor, type RepoRecord } from "./registry.ts";

/**
 * Full pipeline for one repo run. Intended flow (mirrored by `addRepo` in cli):
 *
 *   1. register       — repo added to registry.yaml (human config)
 *   2. clone          — plain git clone into <dataDir>/repos/<repoId>/checkout
 *   3. seed           — openwiki home + wiki instructions (bundle INSTRUCTIONS.md)
 *   4. openwiki run   — --init/--update, verified; failure restores last good bundle
 *   5. index          — wiki + sources into the shared DB (incremental)
 *   6. record         — run outcome/duration/sha into state.json + events.jsonl
 *
 * A per-repo lock skips overlapping runs. Pure git — no provider APIs.
 */

export type PipelineResult = {
  ok: boolean;
  /** So health can tell a usage limit from a break. */
  outcome: "ok" | "failed" | "rate_limited";
  error: string | null;
  /** When a rate limit reported its reset time, so dispatch can wait. */
  resetAt: string | null;
  /** Recorded so grounding regressions are observable over time. */
  groundingScore: number | null;
  wikiChunks: number;
  sourceChunks: number;
  embedded: number;
  warnings: string[];
  durationMs: number;
  /** Head sha the index was built from (null when the run failed early). */
  sha: string | null;
  /** Resume-only: no preserved build existed, so nothing ran. Not a failure —
   *  recorders must not treat it as one. */
  skipped?: boolean;
};

export async function runPipeline(
  cfg: Config,
  db: Client,
  repo: RepoRecord,
  mode: "init" | "update",
  opts: {
    env?: Record<string, string> | undefined;
    changedSourcePaths?: Set<string> | undefined;
    /** The commit to build when the caller has already placed the checkout
     *  there (updateRepo after its pull, a resume at its pin): skip clone and
     *  fetch/pull, or a pinned resume would chase the remote head it must not
     *  reach. Absent = the entry-point flows that clone or pull here. */
    targetSha?: string | undefined;
  } = {},
): Promise<PipelineResult> {
  const started = Date.now();
  const checkout = repo.clonePath;
  const warnings: string[] = [];
  let sha: string | null = null;
  let groundingScore: number | null = null;
  const producerId = producerFor(cfg, repo);

  await appendEvent(cfg, { type: "run_started", repoId: repo.repoId, producer: producerId });
  try {
    await mkdir(paths.repos(cfg), { recursive: true });

    if (opts.targetSha !== undefined) {
      sha = opts.targetSha;
    } else {
      if (mode === "init") {
        if (!(await exists(checkout))) {
          await gitClone(repo.source, checkout);
        }
      } else {
        await gitPull(checkout);
      }
      sha = await gitHeadSha(checkout);
    }

    if (!repo.options.noWiki) {
      const prerequisite = await prepareProducer(
        cfg,
        producerId,
        opts.env ? { env: opts.env } : {},
      );

      if (prerequisite.missing) {
        warnings.push(`${producerId} CLI not found — indexing sources only`);
      } else {
        if (prerequisite.mismatch) {
          warnings.push(
            `openwiki version ${prerequisite.installed ?? "?"} does not match pinned ${prerequisite.pinned} — attempting run`,
          );
        }
        await seedWikiInstructions(repo, checkout);

        // The bundle's own anchor (wiki truth) beats the registry's
        // lastIndexedSha (index truth); they legitimately diverge.
        const anchor = (await readAnchor(checkout)) ?? repo.lastIndexedSha ?? undefined;
        const changed =
          opts.changedSourcePaths === undefined ? undefined : [...opts.changedSourcePaths];
        const snapshot = `${paths.repos(cfg)}/snapshots/${repo.repoId}`;
        /* The producer plans from the same merged exclude set the index step
         * below uses — one Config copy, so the mapper can never be shown a
         * tree the crawl ignores (spec: okf-producer › Claude producer
         * planning honors the merged exclude set). */
        const wikiRun = await runIsolatedProducer(
          { ...cfg, excludeGlobs: effectiveExcludes(cfg, repo) },
          producerId,
          mode,
          checkout,
          snapshot,
          opts.env ? { env: opts.env } : {},
          {
            ...(anchor === undefined ? {} : { fromSha: anchor }),
            ...(sha === null ? {} : { targetSha: sha }),
            ...(changed === undefined ? {} : { changedPaths: changed }),
            ...(mode === "update"
              ? { typeVocabulary: await typeVocabulary(bundleDir(checkout)) }
              : {}),
          },
          repo.repoId,
        );

        groundingScore = wikiRun.acceptance?.grounding.score ?? null;

        // Not a failure: bundle and index are untouched, and last-success
        // state must not move.
        if (wikiRun.run.outcome === "rate_limited") {
          const result: PipelineResult = {
            ok: false,
            outcome: "rate_limited",
            error: "producer usage limit exhausted — will retry",
            resetAt: wikiRun.run.resetAt,
            groundingScore,
            wikiChunks: 0,
            sourceChunks: 0,
            embedded: 0,
            warnings,
            durationMs: Date.now() - started,
            sha,
          };
          await appendEvent(cfg, {
            type: "run_rate_limited",
            repoId: repo.repoId,
            producer: producerId,
            durationMs: result.durationMs,
            ...(wikiRun.run.resetAt === null ? {} : { resetAt: wikiRun.run.resetAt }),
          });
          return result;
        }

        if (!wikiRun.ok) {
          const error =
            wikiRun.acceptance?.errors.join("; ") ?? describeWikiFailure(wikiRun, producerId);
          const result: PipelineResult = {
            ok: false,
            outcome: "failed",
            error,
            resetAt: null,
            groundingScore,
            wikiChunks: 0,
            sourceChunks: 0,
            embedded: 0,
            warnings,
            durationMs: Date.now() - started,
            sha,
          };
          await appendEvent(cfg, {
            type: "run_failed",
            repoId: repo.repoId,
            producer: producerId,
            durationMs: result.durationMs,
            error,
          });
          return result;
        }

        // An idempotent overwrite, so a producer that maintains continuity
        // itself and one that does not converge on the same state.
        if (sha !== null) {
          await writeContinuity(checkout, {
            gitHead: sha,
            command: mode,
            producer: producerId,
            updatedAt: new Date().toISOString(),
          });
          // The bundle was promoted to the snapshot inside runIsolatedProducer,
          // i.e. before this write. Without syncing the anchor across, a later
          // failed run restores a bundle whose gitHead names an older commit
          // and the next update re-derives already-published work.
          if (await exists(snapshot)) {
            await cp(continuityPath(checkout), join(snapshot, CONTINUITY_FILE));
          }
        }
      }
    }

    // The repo's merged exclude set rides the config: the crawl skips its
    // globs and the on-disk purge below (in indexRepo) drops stale chunks.
    const indexed = await indexRepo(
      db,
      { ...cfg, excludeGlobs: effectiveExcludes(cfg, repo) },
      repo.repoId,
      checkout,
      {
        changedSourcePaths: opts.changedSourcePaths,
      },
    );
    warnings.push(...indexed.warnings);

    const result: PipelineResult = {
      ok: true,
      outcome: "ok",
      error: null,
      resetAt: null,
      groundingScore,
      wikiChunks: indexed.wikiChunks,
      sourceChunks: indexed.sourceChunks,
      embedded: indexed.embedded,
      warnings,
      durationMs: Date.now() - started,
      sha,
    };
    await appendEvent(cfg, {
      type: "run_succeeded",
      repoId: repo.repoId,
      producer: producerId,
      durationMs: result.durationMs,
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const result: PipelineResult = {
      ok: false,
      outcome: "failed",
      resetAt: null,
      groundingScore,
      error,
      wikiChunks: 0,
      sourceChunks: 0,
      embedded: 0,
      warnings,
      durationMs: Date.now() - started,
      sha,
    };
    await appendEvent(cfg, {
      type: "run_failed",
      repoId: repo.repoId,
      producer: producerId,
      durationMs: result.durationMs,
      error,
    });
    return result;
  }
}

export const MAX_ERROR_DETAIL = 8000;

function errorDetail(stderr: string): string {
  const text = stderr.trim();
  if (text.length <= MAX_ERROR_DETAIL) return text;
  return `… ${text.length - MAX_ERROR_DETAIL} earlier characters omitted\n${text.slice(-MAX_ERROR_DETAIL)}`;
}

function describeWikiFailure(
  run: {
    run: {
      stderr: string;
      timedOut: boolean;
      exitCode: number | null;
      spawnError: string | null;
    };
    verification: { errors: { file: string; reason: string }[] } | null;
  },
  producer: string,
): string {
  const detail = errorDetail(run.run.stderr);
  const headed = (headline: string): string =>
    detail === "" ? headline : `${headline}\n${detail}`;

  if (run.run.timedOut) return headed(`${producer} run timed out`);
  if (run.run.exitCode !== null && run.run.exitCode !== 0) {
    return headed(`${producer} run exited ${run.run.exitCode}`);
  }
  // The producer's own account of a run that never produced one: a map or
  // plan that never appeared, a rejected plan, an abandoned WIP. These
  // carry no child stderr, so without this branch they vanish.
  if (run.run.spawnError !== null) return headed(run.run.spawnError);
  const errs = run.verification?.errors ?? [];
  if (errs.length > 0) {
    return [
      `bundle verification failed: ${errs.length} problem${errs.length === 1 ? "" : "s"}`,
      ...errs.map((e) => `${e.file} — ${e.reason}`),
    ].join("\n");
  }
  return detail === "" ? "run failed with no further detail" : `run failed\n${detail}`;
}

/** Mark a run started on its record: start time set, finish cleared, previous
 *  run's error dropped — it describes a run this one supersedes. Outcome and
 *  last-success state stand until the run records; health must not flip mid-run. */
export function markRunStarted(repo: RepoRecord): void {
  repo.lastRun.startedAt = new Date().toISOString();
  repo.lastRun.finishedAt = null;
  repo.lastRun.error = null;
}

/** Record a run's outcome in the registry entry (cost visibility, health). */
export function recordRun(repo: RepoRecord, result: PipelineResult): void {
  const now = new Date().toISOString();
  // Neither success nor failure: the repo is not broken, but nothing was
  // produced, so last-success state must not move either.
  const outcome =
    result.outcome === "rate_limited" ? "rate_limited" : result.ok ? "success" : "failed";
  repo.lastRun = {
    startedAt: repo.lastRun.startedAt,
    finishedAt: now,
    outcome,
    durationMs: result.durationMs,
    tokens: null,
    error: result.error,
    ...(result.resetAt === null ? {} : { resetAt: result.resetAt }),
    ...(result.groundingScore === null ? {} : { groundingScore: result.groundingScore }),
  };
  if (result.ok && result.sha) {
    repo.lastIndexedSha = result.sha;
    repo.lastSuccessAt = now;
  }
}

/** Seed the repo's wiki instructions into `openwiki/INSTRUCTIONS.md`, the
 *  per-repo goal openwiki reads every run and the one bundle file we write.
 *  Wrapped in `type: instructions` frontmatter so it passes conformance;
 *  openwiki reads the raw file as the goal either way. */
export async function seedWikiInstructions(
  repo: Pick<RepoRecord, "instructions">,
  checkoutDir: string,
): Promise<boolean> {
  const text = repo.instructions;
  if (text === undefined || text.trim() === "") return false;
  const body = text.endsWith("\n") ? text : `${text}\n`;
  await mkdir(`${checkoutDir}/openwiki`, { recursive: true });
  await Bun.write(
    `${checkoutDir}/openwiki/INSTRUCTIONS.md`,
    `---\ntype: instructions\n---\n\n${body}`,
  );
  return true;
}

/** Update flow: pull; if head moved -> wiki run -> incremental re-index. The
 * run's mode is the repo's published state, not the entry point that got
 * here: a first build recovered through this path (a failed add left nothing
 * published) runs as an init. */ export async function updateRepo(
  cfg: Config,
  db: Client,
  repo: RepoRecord,
  opts: { env?: Record<string, string> } = {},
): Promise<PipelineResult & { headMoved: boolean }> {
  const lock = await acquireRepoLock(cfg, repo.repoId);
  if (!lock) {
    return {
      ok: false,
      outcome: "failed",
      resetAt: null,
      groundingScore: null,
      error: `skipped: another update for ${repo.repoId} is in progress`,
      wikiChunks: 0,
      sourceChunks: 0,
      embedded: 0,
      warnings: [],
      durationMs: 0,
      sha: null,
      headMoved: false,
    };
  }
  try {
    // A build in progress pins its commit: resuming against a moving HEAD
    // means every night's work is stale by the next one — a livelock.
    const pinned = await readWipMeta(cfg, repo.repoId);
    if (pinned === null) await gitPull(repo.clonePath);
    const newSha = pinned?.targetSha ?? (await gitHeadSha(repo.clonePath));
    const published = await exists(bundleDir(repo.clonePath));
    // Wiki truth gates the skip: a repo whose bundle is gone is rebuilt, not
    // skipped for being at its last indexed sha. A repo configured without a
    // wiki is absent by configuration rather than by loss and keeps the skip.
    if (
      pinned === null &&
      repo.lastIndexedSha === newSha &&
      (repo.options.noWiki === true || published)
    ) {
      return {
        ok: true,
        outcome: "ok",
        resetAt: null,
        groundingScore: null,
        error: null,
        wikiChunks: 0,
        sourceChunks: 0,
        embedded: 0,
        warnings: [],
        durationMs: 0,
        sha: newSha,
        headMoved: false,
      };
    }
    const result = await realignThenRun(cfg, db, repo, pinned, newSha, opts);
    return { ...result, headMoved: true };
  } finally {
    await lock.released();
  }
}

/** Realign a preserved build's clone to its pin, then run the shared update/
 *  resume body. Earlier pipeline versions pulled a pinned clone to the remote
 *  head (defeating the pin), so a preserved clone can sit ahead of the commit
 *  it is pinned to — building there would index a different tree than the
 *  recorded pin. A hard reset to the pin discards nothing: the bundle and WIP
 *  are untracked. An unreachable pin (an orphaned WIP) is left to planResume's
 *  refusal below rather than a failed git call. */
async function realignThenRun(
  cfg: Config,
  db: Client,
  repo: RepoRecord,
  pinned: { targetSha: string } | null,
  newSha: string,
  opts: { env?: Record<string, string> } = {},
): Promise<PipelineResult> {
  if (pinned !== null) {
    try {
      await gitResetHard(repo.clonePath, pinned.targetSha);
    } catch {
      // The pin is not a commit in this clone. Downstream still decides:
      // exhausted/discard refuse before any producer runs, and a resume
      // against a missing commit fails on its own terms.
    }
  }
  return runAtTarget(cfg, db, repo, newSha, opts);
}

/** The run body update and resume share (design D1): derive the run mode from
 *  the published bundle's state, diff the change set against the last indexed
 *  sha, and run the pipeline at a target commit the caller has already placed
 *  in the checkout — no clone, no fetch/pull, and no "nothing to do" skip.
 *  Git state and the no-run decisions stay with each entry point. */
async function runAtTarget(
  cfg: Config,
  db: Client,
  repo: RepoRecord,
  targetSha: string,
  opts: { env?: Record<string, string> } = {},
): Promise<PipelineResult> {
  const oldSha = repo.lastIndexedSha;
  const mode = (await exists(bundleDir(repo.clonePath))) ? "update" : "init";
  const changed =
    mode === "update" && oldSha !== null
      ? new Set(await diffNames(oldSha, targetSha, repo.clonePath))
      : undefined;
  return runPipeline(cfg, db, repo, mode, {
    env: opts.env,
    targetSha,
    changedSourcePaths: changed,
  });
}

/** Resume a preserved build now, from the operator (admin API + dashboard)
 *  rather than the next batch. Mirrors what the batch does when a WIP pins a
 *  commit: run the same pipeline as an update at the pinned target — no pull,
 *  never the head-moved skip — so the producer continues the preserved work
 *  and the index is brought to the run's result. Every ordinary failure mode
 *  applies (a failed resume restores the last good bundle; a rate-limited one
 *  preserves the WIP with its attempt advanced). Nothing preserved is not a
 *  run: the WIP gate below refuses before any producer is touched. */
export async function resumeRepo(
  cfg: Config,
  db: Client,
  repo: RepoRecord,
  opts: { env?: Record<string, string> } = {},
): Promise<PipelineResult> {
  const lock = await acquireRepoLock(cfg, repo.repoId);
  if (!lock) {
    return {
      ok: false,
      outcome: "failed",
      resetAt: null,
      groundingScore: null,
      error: `skipped: another update for ${repo.repoId} is in progress`,
      wikiChunks: 0,
      sourceChunks: 0,
      embedded: 0,
      warnings: [],
      durationMs: 0,
      sha: null,
    };
  }
  try {
    const pinned = await readWipMeta(cfg, repo.repoId);
    // A healthy repo has nothing to resume; clicking Resume on one must not
    // silently start a whole fresh production (design D2 — the admin endpoint
    // answers the same probe synchronously as a 409).
    if (pinned === null) {
      return {
        ok: false,
        outcome: "failed",
        resetAt: null,
        groundingScore: null,
        error: `nothing to resume: ${repo.repoId} has no preserved build`,
        wikiChunks: 0,
        sourceChunks: 0,
        embedded: 0,
        warnings: [],
        durationMs: 0,
        sha: null,
        skipped: true,
      };
    }
    return await realignThenRun(cfg, db, repo, pinned, pinned.targetSha, opts);
  } finally {
    await lock.released();
  }
}

/** Re-run a repo's init from its existing clone — the operator's escape hatch
 *  for a wedged or exhausted build, short of remove + re-add. Discards the wiki
 *  build state (published bundle, verified snapshot, pre-run snapshot, WIP),
 *  keeps the registration, clone and index rows, then runs the init pipeline:
 *  whole-repo planning, init-coverage acceptance, full re-index. The snapshot
 *  is discarded with the bundle so a failed rebuild restores nothing — the repo
 *  stays bundle-less and every later run is an init, instead of silently
 *  reverting to incremental updates of the wiki the operator discarded. */
export async function reinitRepo(
  cfg: Config,
  db: Client,
  repo: RepoRecord,
  opts: { env?: Record<string, string> | undefined } = {},
): Promise<PipelineResult> {
  const lock = await acquireRepoLock(cfg, repo.repoId);
  if (!lock) {
    return {
      ok: false,
      outcome: "failed",
      resetAt: null,
      groundingScore: null,
      error: `skipped: another update for ${repo.repoId} is in progress`,
      wikiChunks: 0,
      sourceChunks: 0,
      embedded: 0,
      warnings: [],
      durationMs: 0,
      sha: null,
    };
  }
  try {
    const checkout = repo.clonePath;
    const snapshot = `${paths.repos(cfg)}/snapshots/${repo.repoId}`;
    // Pull first: a failed fetch must not cost the wiki it was about to
    // discard. Only once the rebuild can actually run is the old state wiped.
    if (await exists(checkout)) await gitPull(checkout);
    await rm(bundleDir(checkout), { recursive: true, force: true });
    await rm(snapshot, { recursive: true, force: true });
    await rm(`${snapshot}.prerun`, { recursive: true, force: true });
    await clearWip(cfg, repo.repoId);
    // A missing clone is an ordinary init's job to (re)create.
    return await runPipeline(cfg, db, repo, "init", opts.env ? { env: opts.env } : {});
  } finally {
    await lock.released();
  }
}

export async function removeRepoDir(cfg: Config, repoId: string): Promise<void> {
  await rm(`${paths.repos(cfg)}/${repoId}`, { recursive: true, force: true });
  await rm(`${paths.repos(cfg)}/snapshots/${repoId}`, { recursive: true, force: true });
  // Every repoId-keyed directory, not just the clone: `repo add` on the same
  // source hands the id straight back, so a leftover WIP would be staged over
  // the new repo's fresh bundle and reported as a build in progress.
  await rm(`${paths.repos(cfg)}/snapshots/${repoId}.prerun`, { recursive: true, force: true });
  await clearWip(cfg, repoId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
