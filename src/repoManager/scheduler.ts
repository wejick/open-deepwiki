import cron from "node-cron";
import type { Client } from "@libsql/client";
import type { Config } from "../config/config.ts";
import { getRepo, loadRegistry, saveState } from "./registry.ts";
import { recordRun, updateRepo } from "./pipeline.ts";
import { runQueue } from "./queue.ts";
import { appendEvent } from "../monitor/events.ts";

/**
 * Nightly batch scheduler (default 02:00, configurable) + per-repo schedule
 * overrides. Runs in-process with `serve` and standalone via
 * `open-deepwiki update --all`. Bounded concurrency (maxParallelIndexing);
 * per-repo locks skip overlapping runs.
 */

export type SchedulerState = {
  nextRunAt: string | null;
  lastTickAt: string | null;
  pending: number;
  inFlight: number;
  maxParallel: number;
  locksHeld: string[];
};

export type Scheduler = {
  state: SchedulerState;
  stop: () => void;
  /** One full batch now (also used by `update --all`). */
  updateAll: () => Promise<void>;
  /** Replace one repo's cron job from the current registry — how a schedule
   *  edit made while `serve` runs takes effect without a restart. */
  applySchedule: (repoId: string) => Promise<void>;
};

function cronExpr(hour: number, minute: number): string {
  return `${minute} ${hour} * * *`;
}

export function createScheduler(
  cfg: Config,
  db: Client,
  state?: Partial<SchedulerState>,
): Scheduler {
  const schedulerState: SchedulerState = {
    nextRunAt: null,
    lastTickAt: null,
    pending: 0,
    inFlight: 0,
    maxParallel: cfg.maxParallelIndexing,
    locksHeld: [],
    ...state,
  };

  async function tick(): Promise<void> {
    schedulerState.lastTickAt = new Date().toISOString();
    await updateAll();
  }

  async function updateAll(): Promise<void> {
    const registry = await loadRegistry(cfg);
    const order = dispatchOrder(registry.repos);
    schedulerState.pending = order.length;
    for (const repo of order) {
      await appendEvent(cfg, { type: "queue_enqueued", repoId: repo.repoId });
    }
    const results = new Map<string, { ok: boolean; error: string | null }>();
    await runQueue(order, cfg.maxParallelIndexing, async (repo) => {
      schedulerState.pending--;
      schedulerState.inFlight++;
      schedulerState.locksHeld.push(repo.repoId);
      try {
        const result = await updateRepo(cfg, db, repo);
        results.set(repo.repoId, { ok: result.ok, error: result.error });
        // The same recorder the CLI and admin paths use. Its own boolean would
        // flatten `rate_limited` to "failed" and drop `resetAt` — which is what
        // `dispatchOrder` ranks on and what keeps health yellow instead of
        // painting the fleet red on one exhausted limit.
        recordRun(repo, result);
      } finally {
        schedulerState.inFlight--;
        schedulerState.locksHeld = schedulerState.locksHeld.filter((r) => r !== repo.repoId);
        schedulerState.nextRunAt = null;
      }
    });
    await saveState(cfg, registry);
  }

  const defaultJob = cron.schedule(cronExpr(cfg.nightlyTime.hour, cfg.nightlyTime.minute), () => {
    void tick();
  });
  const repoJobs = new Map<string, ReturnType<typeof cron.schedule>>();

  // One job per valid override; an invalid expression is ignored (repo stays
  // on the default job) — same rule at startup and in applySchedule, so a
  // hand-edited yaml can never crash the scheduler.
  function scheduleRepo(repoId: string, expression: string): void {
    if (!cron.validate(expression)) return;
    repoJobs.set(
      repoId,
      cron.schedule(expression, () => void tick()),
    );
  }

  const loaded = loadRegistry(cfg).then((registry) => {
    for (const repo of registry.repos) {
      if (repo.schedule) scheduleRepo(repo.repoId, repo.schedule);
    }
  });

  // The just-saved registry.yaml is the source of truth; destroy + recreate
  // only this repo's job (destroy, not stop, so node-cron drops the task).
  async function applySchedule(repoId: string): Promise<void> {
    await loaded;
    repoJobs.get(repoId)?.destroy();
    repoJobs.delete(repoId);
    const repo = getRepo(await loadRegistry(cfg), repoId);
    if (repo?.schedule) scheduleRepo(repoId, repo.schedule);
  }

  return {
    state: schedulerState,
    stop: () => {
      defaultJob.stop();
      for (const job of repoJobs.values()) job.stop();
    },
    updateAll,
    applySchedule,
  };
}

/** One-shot batch for system cron/launchd (`update --all`). */
export async function updateAllRepos(cfg: Config, db: Client): Promise<void> {
  const scheduler = createScheduler(cfg, db);
  await scheduler.updateAll();
  scheduler.stop();
}

/**
 * Least-recently-succeeded first, so a batch truncated by an exhausted budget
 * reaches every repo across successive nights — registration order starves the
 * tail forever. Existing wikis go ahead of first builds, so one large new repo
 * cannot stall the fleet's refresh. A repo still waiting on a limit reset goes
 * to the back rather than being dropped from the batch.
 */
export function dispatchOrder<
  T extends {
    repoId: string;
    lastSuccessAt: string | null;
    lastIndexedSha: string | null;
    lastRun: { resetAt?: string | undefined };
  },
>(repos: T[], now: number = Date.now()): T[] {
  const rank = (r: T): [number, number, string] => {
    const waiting = r.lastRun.resetAt !== undefined && Date.parse(r.lastRun.resetAt) > now ? 1 : 0;
    // A repo with no wiki yet is a first build: after the updates.
    const firstBuild = r.lastIndexedSha === null ? 1 : 0;
    const staleness = r.lastSuccessAt === null ? 0 : Date.parse(r.lastSuccessAt);
    return [waiting, firstBuild, String(staleness).padStart(20, "0")];
  };
  return repos.toSorted((a, b) => {
    const [aw, af, as] = rank(a);
    const [bw, bf, bs] = rank(b);
    if (aw !== bw) return aw - bw;
    if (af !== bf) return af - bf;
    if (as !== bs) return as < bs ? -1 : 1;
    return a.repoId.localeCompare(b.repoId); // stable, deterministic
  });
}
