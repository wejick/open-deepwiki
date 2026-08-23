import { stat } from "node:fs/promises";
import { simpleGit } from "simple-git";
import { paths, type ProducerId } from "../config/config.ts";
import type { Ctx } from "./context.ts";
import { acquireRepoLock } from "./lock.ts";
import { runPipeline, recordRun, markRunStarted, type PipelineResult } from "./pipeline.ts";
import { repoIdFromSource, saveState, uniqueRepoId, type RepoRecord } from "./registry.ts";

/**
 * Repo registration — shared by the CLI (`repo add`) and the admin API
 * (`POST /api/repos`). `registerRepo` only mutates the in-memory registry
 * (caller saves); `runAddPipeline` runs the init pipeline under the per-repo
 * lock and records the outcome state-only (write discipline).
 */

export function registerRepo(
  ctx: Ctx,
  source: string,
  noWiki: boolean,
  instructions: string | undefined = undefined,
  /** Per-repo producer override (`repo add --producer`); undefined = global default. */
  producer: ProducerId | undefined = undefined,
  /** Per-repo exclude globs (`repo add --exclude` / API `excludeGlobs`); undefined = global list alone. */
  excludeGlobs: string[] | undefined = undefined,
): RepoRecord {
  const repoId = uniqueRepoId(ctx.registry, repoIdFromSource(source));
  const record: RepoRecord = {
    repoId,
    source: source.trim(),
    clonePath: paths.checkout(ctx.cfg, repoId),
    addedAt: new Date().toISOString(),
    schedule: null,
    options: noWiki ? { noWiki: true } : {},
    instructions,
    producer,
    excludeGlobs,
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
  ctx.registry.repos.push(record);
  return record;
}

/** Lock → mark started → init pipeline → record outcome (state-only save). */
export async function runAddPipeline(ctx: Ctx, record: RepoRecord): Promise<PipelineResult> {
  const lock = await acquireRepoLock(ctx.cfg, record.repoId);
  if (!lock) {
    return {
      ok: false,
      outcome: "failed",
      resetAt: null,
      groundingScore: null,
      error: `${record.repoId} is already being updated`,
      wikiChunks: 0,
      sourceChunks: 0,
      embedded: 0,
      warnings: [],
      durationMs: 0,
      sha: null,
    };
  }
  try {
    markRunStarted(record);
    await saveState(ctx.cfg, ctx.registry); // publish in-flight state for /status
    const result = await runPipeline(ctx.cfg, ctx.db, record, "init");
    recordRun(record, result);
    await saveState(ctx.cfg, ctx.registry);
    return result;
  } finally {
    await lock.released();
  }
}

/**
 * Pre-flight source validation (spec: admin-api › Add repository with
 * pre-flight validation): fail in seconds instead of after a multi-minute
 * pipeline run. Remote sources (URLs, scp-like) must answer `git ls-remote`;
 * local paths must exist and be a git worktree.
 */
export type SourceCheck = { ok: boolean; error: string | null };

const LS_REMOTE_TIMEOUT_MS = 15_000;

function looksRemote(source: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || // proto://…
    /^[^\s/]+@/.test(source) || // user@host:…
    /^[^\s/:]+:[^\s]/.test(source) // host:path…
  );
}

export async function validateSource(source: string): Promise<SourceCheck> {
  const s = source.trim();
  if (s === "") return { ok: false, error: "source is empty" };
  if (!looksRemote(s)) {
    try {
      await stat(s);
    } catch {
      return { ok: false, error: `local path does not exist: ${s}` };
    }
    if (!(await simpleGit({ baseDir: s }).checkIsRepo())) {
      return { ok: false, error: `not a git repository: ${s}` };
    }
    return { ok: true, error: null };
  }
  try {
    await simpleGit({ timeout: { block: LS_REMOTE_TIMEOUT_MS } }).listRemote([s]);
    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const tail = (msg.trim().split("\n").at(-1) ?? msg).slice(0, 200);
    return { ok: false, error: `source not retrievable: ${tail}` };
  }
}
