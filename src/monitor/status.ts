import type { Client } from "@libsql/client";
import { join } from "node:path";
import type { Config } from "../config/config.ts";
import { docCounts, getRepoMeta } from "../index/db.ts";
import { producerFor, type Registry } from "../repoManager/registry.ts";
import { isPidAlive, readLockHolder } from "../repoManager/lock.ts";
import type { SchedulerState } from "../repoManager/scheduler.ts";
import { readPlanProgress, type PlanProgress } from "../producer/claudePlan.ts";
import { readWipMeta, wipDir } from "../producer/wip.ts";
import { classifyHealth, type Health } from "./health.ts";

/**
 * Status summary — the read surface behind `/status`, `server_status`, and
 * `open-deepwiki status`. Computed at read time from registry + index + live
 * scheduler state; nothing is stored.
 */

export type RepoStatus = {
  repoId: string;
  health: Health;
  lastSuccessAt: string | null;
  lastIndexedSha: string | null;
  docs: { wiki: number; source: number };
  linkHealth: { resolved: number; total: number };
  lastError: string | null;
  lastDurationMs: number | null;
  tokens: number | null;
  /** Last run start/finish — finish null while a run is in flight. */
  runStartedAt: string | null;
  runFinishedAt: string | null;
  /** Read-time liveness of a started-not-finished run; null otherwise.
   *  Never stored, never affects health. */
  runState: "running" | "interrupted" | null;
  conceptTerms: string[];
  /** Which producer wrote this repo's bundle. */
  producer: string;
  /** Per-repo cron override; null = the default nightly schedule. */
  schedule: string | null;
  /** Last recorded grounding score, so regressions are visible over time. */
  groundingScore: number | null;
  /** A build in progress: the commit it is pinned to and attempts so far. */
  build: { pinnedSha: string; attempts: number } | null;
  /** Read-time production progress from the durable planning/page artifacts;
   *  null when nothing is legible, an undecomposed marker when in-flight
   *  planning has no units. Never stored, never affects health. */
  progress: PlanProgress | null;
};

export type StatusSummary = {
  generatedAt: string;
  uptimeSec: number;
  repoCount: number;
  aggregates: {
    health: Record<Health, number>;
    wikiDocs: number;
    sourceDocs: number;
  };
  scheduler: {
    running: boolean;
    nextRunAt: string | null;
    lastTickAt: string | null;
    pending: number;
    inFlight: number;
    maxParallel: number;
    locksHeld: string[];
  };
  repos: RepoStatus[];
};

export async function buildStatusSummary(
  cfg: Config,
  db: Client,
  registry: Registry,
  opts: { scheduler?: SchedulerState | null; startedAt?: number | null } = {},
): Promise<StatusSummary> {
  const aggregates = { health: { green: 0, yellow: 0, red: 0 }, wikiDocs: 0, sourceDocs: 0 };
  const repos: RepoStatus[] = [];
  for (const repo of registry.repos) {
    const health = classifyHealth(repo, cfg);
    const docs = await docCounts(db, repo.repoId);
    const meta = await getRepoMeta(db, repo.repoId);
    aggregates.health[health]++;
    aggregates.wikiDocs += docs.wiki;
    aggregates.sourceDocs += docs.source;
    repos.push({
      repoId: repo.repoId,
      health,
      lastSuccessAt: repo.lastSuccessAt,
      lastIndexedSha: repo.lastIndexedSha,
      docs,
      linkHealth: meta
        ? { resolved: meta.linkResolved, total: meta.linkTotal }
        : { resolved: 0, total: 0 },
      lastError: repo.lastRun.error,
      producer: producerFor(cfg, repo),
      schedule: repo.schedule,
      groundingScore: repo.lastRun.groundingScore ?? null,
      build: await buildProgress(cfg, repo.repoId),
      progress: await productionProgress(cfg, repo),
      lastDurationMs: repo.lastRun.durationMs,
      tokens: repo.lastRun.tokens,
      runStartedAt: repo.lastRun.startedAt,
      runFinishedAt: repo.lastRun.finishedAt,
      runState: await runStateFor(cfg, repo),
      conceptTerms: meta?.conceptTerms ?? [],
    });
  }
  const scheduler = opts.scheduler ?? null;
  return {
    generatedAt: new Date().toISOString(),
    uptimeSec: opts.startedAt ? Math.floor((Date.now() - opts.startedAt) / 1000) : 0,
    repoCount: registry.repos.length,
    aggregates,
    scheduler: {
      running: scheduler !== null,
      nextRunAt: scheduler?.nextRunAt ?? null,
      lastTickAt: scheduler?.lastTickAt ?? null,
      pending: scheduler?.pending ?? 0,
      inFlight: scheduler?.inFlight ?? 0,
      maxParallel: scheduler?.maxParallel ?? cfg.maxParallelIndexing,
      locksHeld: scheduler?.locksHeld ?? [],
    },
    repos,
  };
}

/** `interrupted` needs positive evidence of death — a parsed lock whose holder
 * pid is gone. A live, absent, or unparseable lock reads `running`: a run
 * legitimately holds no lock between its start record and acquisition, and
 * between release and the outcome record. */
async function runStateFor(
  cfg: Config,
  repo: { repoId: string; lastRun: { startedAt: string | null; finishedAt: string | null } },
): Promise<"running" | "interrupted" | null> {
  if (repo.lastRun.startedAt === null || repo.lastRun.finishedAt !== null) return null;
  const holder = await readLockHolder(cfg, repo.repoId);
  return holder !== null && !isPidAlive(holder.pid) ? "interrupted" : "running";
}

/** Any work in progress for this repo, for the status view. */
async function buildProgress(
  cfg: Config,
  repoId: string,
): Promise<{ pinnedSha: string; attempts: number } | null> {
  const meta = await readWipMeta(cfg, repoId);
  return meta === null ? null : { pinnedSha: meta.targetSha, attempts: meta.attempts };
}

/** Where an in-flight or preserved build stands, counted from the artifacts
 *  at read time. The staged bundle first (a run is writing it now), then the
 *  WIP area, so a multi-night build stays legible between runs. */
async function productionProgress(
  cfg: Config,
  repo: {
    repoId: string;
    clonePath: string;
    lastRun: { startedAt: string | null; finishedAt: string | null };
  },
): Promise<PlanProgress | null> {
  const inFlight = repo.lastRun.startedAt !== null && repo.lastRun.finishedAt === null;
  // A missing directory is simply nothing legible — the reader degrades.
  return readPlanProgress(join(repo.clonePath, "openwiki"), wipDir(cfg, repo.repoId), inFlight);
}
