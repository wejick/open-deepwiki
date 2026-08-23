import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "@libsql/client";
import cron from "node-cron";
import { isProducerId, PRODUCER_IDS, type Config, type ProducerId } from "../config/config.ts";
import { purgeRepo } from "../index/db.ts";
import { registerRepo, runAddPipeline, validateSource } from "../repoManager/add.ts";
import type { Ctx } from "../repoManager/context.ts";
import { acquireRepoLock } from "../repoManager/lock.ts";
import {
  markRunStarted,
  recordRun,
  removeRepoDir,
  reinitRepo,
  resumeRepo,
  updateRepo,
} from "../repoManager/pipeline.ts";
import {
  getRepo,
  loadRegistry,
  producerFor,
  saveRegistry,
  saveState,
  saveYaml,
} from "../repoManager/registry.ts";
import { readWipMeta } from "../producer/wip.ts";

/**
 * Admin write API behind the dashboard (spec: admin-api). Mounted on the
 * serve process, which already holds a writable DB handle for the scheduler.
 * Add/update runs execute in the background (202 immediately; progress is
 * observable via /status) — `adminRuns` tracks them so tests await real
 * promises instead of sleeping. Auth is enforced by the caller (server.ts).
 */

export type AdminDeps = {
  cfg: Config;
  db: Client;
  /** Present when the serve process hosts the scheduler: a saved schedule is
   *  applied to the running cron jobs (a schedule edit takes effect live). */
  applySchedule?: ((repoId: string) => Promise<void> | void) | undefined;
};

/** In-flight admin-triggered runs by repoId — exported so tests can await them. */
export const adminRuns = new Map<string, Promise<void>>();

/** Returns false for non-`/api/*` paths; owns all routing under `/api/`. */
export async function handleAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith("/api/")) return false;
  try {
    await routeAdmin(req, res, deps, url);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

function trackRun(repoId: string, run: Promise<unknown>): void {
  const tracked = Promise.resolve(run)
    .then(
      () => undefined,
      () => undefined, // run failures are recorded in state.json — never reject here
    )
    .finally(() => adminRuns.delete(repoId));
  adminRuns.set(repoId, tracked);
}

async function routeAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
  url: string,
): Promise<void> {
  if (url === "/api/repos" && req.method === "POST") return addRepo(req, res, deps);

  // repoIds contain slashes — match the action suffix, decode the middle.
  const update = /^\/api\/repos\/(.+)\/update$/.exec(url);
  if (update && req.method === "POST")
    return requestUpdate(res, deps, decodeURIComponent(update[1]!));
  const reinit = /^\/api\/repos\/(.+)\/reinit$/.exec(url);
  if (reinit && req.method === "POST")
    return requestReinit(res, deps, decodeURIComponent(reinit[1]!));
  const resume = /^\/api\/repos\/(.+)\/resume$/.exec(url);
  if (resume && req.method === "POST")
    return requestResume(res, deps, decodeURIComponent(resume[1]!));
  const instructions = /^\/api\/repos\/(.+)\/instructions$/.exec(url);
  if (instructions && req.method === "GET")
    return getInstructions(res, deps, decodeURIComponent(instructions[1]!));
  if (instructions && req.method === "PUT")
    return putInstructions(req, res, deps, decodeURIComponent(instructions[1]!));
  const schedule = /^\/api\/repos\/(.+)\/schedule$/.exec(url);
  if (schedule && req.method === "GET")
    return getSchedule(res, deps, decodeURIComponent(schedule[1]!));
  if (schedule && req.method === "PUT")
    return putSchedule(req, res, deps, decodeURIComponent(schedule[1]!));
  const repo = /^\/api\/repos\/(.+)$/.exec(url);
  if (repo && req.method === "DELETE") return removeRepo(res, deps, decodeURIComponent(repo[1]!));

  sendJson(res, 404, { error: "not found" });
}

/** `body.producer` → a validated per-repo override, or undefined for "use the
 *  global default". An unknown id fails before any pre-flight or registry
 *  work; `error` is the only failure signal, matching `validateSource`'s
 *  `SourceCheck` idiom. */
function parseProducer(body: Record<string, unknown>): {
  producer: ProducerId | undefined;
  error: string | null;
} {
  const raw = body.producer;
  if (raw === undefined || raw === null) return { producer: undefined, error: null };
  if (typeof raw !== "string") return { producer: undefined, error: "producer must be a string" };
  const trimmed = raw.trim();
  if (trimmed === "") return { producer: undefined, error: null };
  if (!isProducerId(trimmed)) {
    return { producer: undefined, error: `producer must be one of: ${PRODUCER_IDS.join(", ")}` };
  }
  return { producer: trimmed, error: null };
}

/** `body.excludeGlobs` → per-repo exclude globs, or undefined for "global
 *  list alone". Any non-array or non-string/empty entry fails before any
 *  pre-flight or registry work; entries are trimmed and deduplicated. */
function parseExcludeGlobs(body: Record<string, unknown>): {
  excludeGlobs: string[] | undefined;
  error: string | null;
} {
  const raw = body.excludeGlobs;
  if (raw === undefined || raw === null) return { excludeGlobs: undefined, error: null };
  if (!Array.isArray(raw)) {
    return { excludeGlobs: undefined, error: "excludeGlobs must be an array of glob strings" };
  }
  const globs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return { excludeGlobs: undefined, error: "excludeGlobs must be an array of glob strings" };
    }
    const glob = entry.trim();
    if (glob === "") {
      return { excludeGlobs: undefined, error: "excludeGlobs entries must be non-empty" };
    }
    if (!globs.includes(glob)) globs.push(glob);
  }
  return { excludeGlobs: globs.length > 0 ? globs : undefined, error: null };
}

async function addRepo(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<void> {
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  const source = typeof body.source === "string" ? body.source : "";
  if (source.trim() === "") return sendJson(res, 400, { error: "source is required" });

  const producerCheck = parseProducer(body);
  if (producerCheck.error) return sendJson(res, 400, { error: producerCheck.error });
  const excludesCheck = parseExcludeGlobs(body);
  if (excludesCheck.error) return sendJson(res, 400, { error: excludesCheck.error });

  const check = await validateSource(source);
  if (!check.ok) return sendJson(res, 400, { error: check.error });

  const registry = await loadRegistry(deps.cfg);
  const existing = registry.repos.find((r) => r.source === source.trim());
  if (existing) {
    return sendJson(res, 409, { error: `source already registered as ${existing.repoId}` });
  }

  const ctx: Ctx = { cfg: deps.cfg, db: deps.db, registry };
  const record = registerRepo(
    ctx,
    source,
    false,
    undefined,
    producerCheck.producer,
    excludesCheck.excludeGlobs,
  );
  await saveRegistry(deps.cfg, registry); // registration writes both stores
  trackRun(record.repoId, runAddPipeline(ctx, record));
  sendJson(res, 202, {
    repoId: record.repoId,
    producer: producerFor(deps.cfg, record),
    status: "queued",
  });
}

async function requestUpdate(res: ServerResponse, deps: AdminDeps, repoId: string): Promise<void> {
  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });

  // Probe the lock so a busy repo gets a synchronous 409; the background run
  // re-acquires it (updateRepo takes its own lock, like `repo update`).
  const probe = await acquireRepoLock(deps.cfg, repoId);
  if (!probe) return sendJson(res, 409, { error: `${repoId} is already being updated` });
  await probe.released();

  const ctx: Ctx = { cfg: deps.cfg, db: deps.db, registry };
  trackRun(repoId, runUpdate(ctx, repoId));
  sendJson(res, 202, { repoId, status: "queued" });
}

async function runUpdate(ctx: Ctx, repoId: string): Promise<void> {
  const repo = getRepo(ctx.registry, repoId);
  if (!repo) return;
  markRunStarted(repo);
  await saveState(ctx.cfg, ctx.registry);
  const result = await updateRepo(ctx.cfg, ctx.db, repo);
  recordRun(repo, result);
  await saveState(ctx.cfg, ctx.registry); // run outcomes write state only
}

async function requestReinit(res: ServerResponse, deps: AdminDeps, repoId: string): Promise<void> {
  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });

  // Probe the lock so a busy repo gets a synchronous 409; the background run
  // re-acquires it (reinitRepo takes its own lock, like `repo reinit`).
  const probe = await acquireRepoLock(deps.cfg, repoId);
  if (!probe) return sendJson(res, 409, { error: `${repoId} is already being updated` });
  await probe.released();

  const ctx: Ctx = { cfg: deps.cfg, db: deps.db, registry };
  trackRun(repoId, runReinit(ctx, repoId));
  sendJson(res, 202, { repoId, status: "queued" });
}

async function runReinit(ctx: Ctx, repoId: string): Promise<void> {
  const repo = getRepo(ctx.registry, repoId);
  if (!repo) return;
  markRunStarted(repo);
  await saveState(ctx.cfg, ctx.registry);
  const result = await reinitRepo(ctx.cfg, ctx.db, repo);
  recordRun(repo, result);
  await saveState(ctx.cfg, ctx.registry); // run outcomes write state only
}

async function requestResume(res: ServerResponse, deps: AdminDeps, repoId: string): Promise<void> {
  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });

  // Probe the lock so a busy repo gets a synchronous 409; the background run
  // re-acquires it (resumeRepo takes its own lock, like the others).
  const probe = await acquireRepoLock(deps.cfg, repoId);
  if (!probe) return sendJson(res, 409, { error: `${repoId} is already being updated` });
  await probe.released();

  // A healthy repo has no preserved build: answer synchronously rather than
  // queueing a run that would refuse anyway (design D2 — resumeRepo re-checks
  // under its own lock, so a WIP that vanishes between here and the run no-ops).
  const preserved = await readWipMeta(deps.cfg, repoId);
  if (preserved === null) {
    return sendJson(res, 409, { error: `nothing to resume: ${repoId} has no preserved build` });
  }

  const ctx: Ctx = { cfg: deps.cfg, db: deps.db, registry };
  trackRun(repoId, runResume(ctx, repoId));
  sendJson(res, 202, { repoId, status: "queued" });
}

async function runResume(ctx: Ctx, repoId: string): Promise<void> {
  const repo = getRepo(ctx.registry, repoId);
  if (!repo) return;
  // The endpoint probed for a preserved build synchronously, but a concurrent
  // run can promote and clear it before this queued run starts. Re-check so a
  // no-op is never marked started — resumeRepo re-checks under its own lock.
  if ((await readWipMeta(ctx.cfg, repoId)) === null) return;
  const prior = {
    lastRun: { ...repo.lastRun },
    lastIndexedSha: repo.lastIndexedSha,
    lastSuccessAt: repo.lastSuccessAt,
  };
  markRunStarted(repo);
  await saveState(ctx.cfg, ctx.registry);
  const result = await resumeRepo(ctx.cfg, ctx.db, repo);
  if (result.skipped !== true) {
    recordRun(repo, result);
    await saveState(ctx.cfg, ctx.registry); // run outcomes write state only
    return;
  }
  // Nothing to resume after all (the WIP vanished under the resume's lock): a
  // non-run, not a failure — leave the registry as the run that cleared the
  // WIP recorded it, instead of painting the repo red for a run that never ran.
  repo.lastRun = prior.lastRun;
  repo.lastIndexedSha = prior.lastIndexedSha;
  repo.lastSuccessAt = prior.lastSuccessAt;
  await saveState(ctx.cfg, ctx.registry);
}

async function removeRepo(res: ServerResponse, deps: AdminDeps, repoId: string): Promise<void> {
  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });

  // Hold the lock across the purge so no run can start mid-removal.
  const lock = await acquireRepoLock(deps.cfg, repoId);
  if (!lock) return sendJson(res, 409, { error: `${repoId} is already being updated` });
  try {
    registry.repos = registry.repos.filter((r) => r.repoId !== repoId);
    await saveRegistry(deps.cfg, registry); // removal writes both stores
    await purgeRepo(deps.db, repoId);
    await removeRepoDir(deps.cfg, repoId);
    try {
      await deps.db.execute("VACUUM");
    } catch {
      // busy or unsupported — space reuse happens on a later run
    }
    sendJson(res, 200, { removed: repoId });
  } finally {
    await lock.released();
  }
}

async function getInstructions(
  res: ServerResponse,
  deps: AdminDeps,
  repoId: string,
): Promise<void> {
  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });
  sendJson(res, 200, { instructions: repo.instructions ?? null });
}

async function putInstructions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
  repoId: string,
): Promise<void> {
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  if (typeof body.instructions !== "string") {
    return sendJson(res, 400, { error: "instructions must be a string" });
  }

  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });

  const text = body.instructions;
  repo.instructions = text.trim() === "" ? undefined : text;
  await saveYaml(deps.cfg, registry); // human-config edits write yaml only
  sendJson(res, 200, { instructions: repo.instructions ?? null });
}

/** `body.schedule` → a validated per-repo cron override, or null to clear.
 *  node-cron's parser is the authority — it is what `cron.schedule` defers
 *  to, so a second parser could only disagree with it. */
function parseSchedule(body: Record<string, unknown>): {
  schedule: string | null;
  error: string | null;
} {
  const raw = body.schedule;
  if (raw === undefined || raw === null) return { schedule: null, error: null };
  if (typeof raw !== "string") {
    return { schedule: null, error: "schedule must be a string or null" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { schedule: null, error: null };
  if (!cron.validate(trimmed)) {
    const detail = cron
      .validateDetailed(trimmed)
      .errors.map((e) => `${e.field}: ${e.message}`)
      .join("; ");
    return { schedule: null, error: `invalid cron expression${detail ? ` — ${detail}` : ""}` };
  }
  return { schedule: trimmed, error: null };
}

async function getSchedule(res: ServerResponse, deps: AdminDeps, repoId: string): Promise<void> {
  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });
  sendJson(res, 200, { schedule: repo.schedule });
}

async function putSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
  repoId: string,
): Promise<void> {
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  const parsed = parseSchedule(body);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });

  const registry = await loadRegistry(deps.cfg);
  const repo = getRepo(registry, repoId);
  if (!repo) return sendJson(res, 404, { error: `unknown repo ${repoId}` });

  repo.schedule = parsed.schedule;
  await saveYaml(deps.cfg, registry); // human-config edits write yaml only
  await deps.applySchedule?.(repoId); // running scheduler drops/recreates this repo's job
  sendJson(res, 200, { schedule: repo.schedule });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
