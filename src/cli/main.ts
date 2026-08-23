/**
 * open-deepwiki CLI entry point.
 *
 * Subcommands:
 *   repo add <url|path> [--no-wiki] [--instructions <file|->] [--producer <id>] [--exclude <glob>]
 *   repo add --from-file <file> [--no-wiki]   batch import
 *   repo instructions <repoId> [--show]       show wiki instructions
 *   repo remove <repoId>
 *   repo list [--json]
 *   repo update <repoId>
 *   repo reinit <repoId>                      discard the wiki and rebuild from scratch
 *   update --all                        update all repos (standalone cron mode)
 *   index <repoId>                      re-index wiki bundle + sources
 *   serve                               run the MCP HTTP server
 *   status [--failing|--json|--server <url>]   per-repo health table
 *   logs [--repo <repoId>] [--progress]    tail the event log
 */

import { readFile } from "node:fs/promises";
import {
  isProducerId,
  loadConfig,
  paths,
  PRODUCER_IDS,
  type ProducerId,
} from "../config/config.ts";
import { docCounts, getRepoMeta, purgeRepo } from "../index/db.ts";
import { indexRepo } from "../index/update.ts";
import { appendEvent } from "../monitor/events.ts";
import { registerRepo, runAddPipeline } from "../repoManager/add.ts";
import { openContext, type Ctx } from "../repoManager/context.ts";
import { acquireRepoLock } from "../repoManager/lock.ts";
import {
  runPipeline,
  markRunStarted,
  recordRun,
  updateRepo,
  removeRepoDir,
  reinitRepo,
} from "../repoManager/pipeline.ts";
import { runQueue } from "../repoManager/queue.ts";
import {
  getRepo,
  producerFor,
  saveRegistry,
  saveState,
  type RepoRecord,
} from "../repoManager/registry.ts";
import { updateAllRepos } from "../repoManager/scheduler.ts";

const USAGE = `open-deepwiki — org-scale DeepWiki clone

Usage: open-deepwiki <command> [options]

Commands:
  repo add <url|path> [--no-wiki] [--instructions <file|->] [--producer <id>] [--exclude <glob>]   clone + wiki + index
  repo add --from-file <file>       batch import (one git URL per line)
  repo remove <repoId>              remove repo, clone, and index rows
  repo list [--json]                list registered repos with status
  repo update <repoId>              update a single repo
  repo reinit <repoId>              discard the wiki and rebuild from scratch
  repo instructions <repoId> [--show]  show configured wiki instructions
  update --all                      update all repos (system cron mode)
  index <repoId>                    re-index wiki bundle + sources
  serve                             run the MCP HTTP server
  status [--failing|--json|--server <url>]   per-repo health table
  logs [--repo <repoId>] [--progress]  tail the event log
`;

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    console.log(USAGE);
    return cmd === undefined ? 1 : 0;
  }
  const rest = argv.slice(1);
  switch (cmd) {
    case "repo":
      return repoCommand(rest);
    case "update":
      return updateAllCommand(rest);
    case "index":
      return indexCommand(rest);
    case "serve":
      return serveCommand(rest);
    case "status":
      return statusCommand(rest);
    case "logs":
      return logsCommand(rest);
    default:
      console.error(`unknown command "${cmd}"\n\n${USAGE}`);
      return 1;
  }
}

async function repoCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const cfg = loadConfig();
  const ctx = await openContext(cfg);
  try {
    switch (sub) {
      case "add": {
        if (rest[0] === "--from-file") {
          return await batchAdd(ctx, rest[1] ?? "", rest.includes("--no-wiki"));
        }
        const noWiki = rest.includes("--no-wiki");
        const instrIdx = rest.indexOf("--instructions");
        let instructions: string | undefined;
        if (instrIdx >= 0) {
          const value = rest[instrIdx + 1];
          if (value === undefined || value === "" || value.startsWith("--")) {
            console.error(
              "usage: repo add <url|path> [--no-wiki] [--instructions <file|->] [--producer <id>]",
            );
            return 1;
          }
          instructions =
            value === "-" ? await new Response(Bun.stdin).text() : await readFile(value, "utf8");
          if (instructions.trim() === "") {
            console.error("error: instructions file/stdin is empty");
            return 1;
          }
        }
        const prodIdx = rest.indexOf("--producer");
        let producer: ProducerId | undefined;
        if (prodIdx >= 0) {
          const value = rest[prodIdx + 1];
          if (value === undefined || !isProducerId(value)) {
            console.error(`error: --producer must be one of: ${PRODUCER_IDS.join(", ")}`);
            return 1;
          }
          producer = value;
        }
        const excludeGlobs: string[] = [];
        let excludeError = false;
        rest.forEach((arg, i) => {
          if (arg !== "--exclude") return;
          const value = rest[i + 1];
          if (value === undefined || value.startsWith("--")) {
            console.error(
              "usage: repo add <url|path> [--no-wiki] [--instructions <file|->] [--producer <id>] [--exclude <glob>]",
            );
            excludeError = true;
            return;
          }
          // Comma-separated values accepted; entries validated after collection.
          for (const glob of value.split(",")) {
            const trimmed = glob.trim();
            if (trimmed === "") {
              console.error("error: --exclude globs must be non-empty");
              excludeError = true;
              return;
            }
            if (!excludeGlobs.includes(trimmed)) excludeGlobs.push(trimmed);
          }
        });
        if (excludeError) return 1;
        const skip = new Set<number>([
          ...(instrIdx >= 0 ? [instrIdx, instrIdx + 1] : []),
          ...(prodIdx >= 0 ? [prodIdx, prodIdx + 1] : []),
          ...rest.flatMap((arg, i) => (arg === "--exclude" ? [i, i + 1] : [])),
        ]);
        const source = rest.find((a, i) => !skip.has(i) && !a.startsWith("--"));
        return await addRepo(ctx, source ?? "", noWiki, instructions, producer, excludeGlobs);
      }
      case "remove":
        return await removeRepo(ctx, rest[0] ?? "");
      case "list":
        return await listRepos(ctx, rest.includes("--json"));
      case "update":
        return await updateOne(ctx, rest[0] ?? "");
      case "reinit":
        return await reinitOne(ctx, rest[0] ?? "");
      case "instructions":
        return await instructionsCommand(ctx, rest);
      case undefined: {
        // Bare `repo` defaults to the list view; the hint goes to stderr so
        // piped stdout carries only the listing. A misspelled subcommand must
        // still error below, not silently fall back to the listing.
        const code = await listRepos(ctx, false);
        console.error("commands: repo add|remove|list|update|reinit|instructions ...");
        return code;
      }
      default:
        console.error(`usage: repo add|remove|list|update|reinit|instructions ...\n\n${USAGE}`);
        return 1;
    }
  } finally {
    ctx.db.close();
  }
}

async function instructionsCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const repoId = argv.find((a) => !a.startsWith("--"));
  const raw = argv.includes("--show");
  if (!repoId) {
    console.error("usage: repo instructions <repoId> [--show]");
    return 1;
  }
  const repo = getRepo(ctx.registry, repoId);
  if (!repo) {
    console.error(`error: unknown repo ${repoId}`);
    return 1;
  }
  if (repo.instructions === undefined) {
    console.log(
      `No custom instructions configured for ${repoId} — set them with 'repo add --instructions <file|->' or edit ${paths.registryYaml(ctx.cfg)}.`,
    );
    return 0;
  }
  if (raw) {
    console.log(repo.instructions);
  } else {
    console.log(`# ${repoId} wiki instructions\n\n${repo.instructions}`);
  }
  return 0;
}

/**
 * `repo add` — intended flow (see runPipeline for the full pipeline):
 * register in registry.yaml → clone → seed wiki instructions → openwiki
 * --init (verified, failure-isolated) → index → record run state.
 */
async function addRepo(
  ctx: Ctx,
  source: string,
  noWiki: boolean,
  instructions: string | undefined = undefined,
  producer: ProducerId | undefined = undefined,
  excludeGlobs: string[] | undefined = undefined,
): Promise<number> {
  if (!source) {
    console.error(
      "usage: repo add <url|path> [--no-wiki] [--instructions <file|->] [--producer <id>] [--exclude <glob>]",
    );
    return 1;
  }
  if (ctx.registry.repos.some((r) => r.source === source.trim())) {
    const existing = ctx.registry.repos.find((r) => r.source === source.trim());
    console.error(`error: source already registered as ${existing?.repoId}`);
    return 1;
  }
  const record = registerRepo(ctx, source, noWiki, instructions, producer, excludeGlobs);
  await saveRegistry(ctx.cfg, ctx.registry);

  console.log(`[${record.repoId}] cloning + indexing...`);
  const result = await runAddPipeline(ctx, record);
  if (!result.ok) {
    console.error(`[${record.repoId}] FAILED: ${result.error}`);
    for (const w of result.warnings) console.error(`[${record.repoId}] warning: ${w}`);
    return 1;
  }
  console.log(
    `[${record.repoId}] done — wiki ${result.wikiChunks}, sources ${result.sourceChunks}, embedded ${result.embedded} (${result.durationMs}ms)`,
  );
  for (const w of result.warnings) console.log(`[${record.repoId}] warning: ${w}`);
  return 0;
}

async function batchAdd(ctx: Ctx, file: string, noWiki: boolean): Promise<number> {
  if (!file) {
    console.error("usage: repo add --from-file <file> [--no-wiki]");
    return 1;
  }
  let lines: string[];
  try {
    lines = (await readFile(file, "utf8")).split("\n");
  } catch (err) {
    console.error(`error: cannot read ${file}: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  const sources = [
    ...new Set(lines.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"))),
  ];
  const records: RepoRecord[] = [];
  for (const source of sources) {
    if (ctx.registry.repos.some((r) => r.source === source)) {
      console.log(`skipping duplicate: ${source}`);
      continue;
    }
    records.push(registerRepo(ctx, source, noWiki));
  }
  await saveRegistry(ctx.cfg, ctx.registry);

  let done = 0;
  const failed: string[] = [];
  await runQueue(records, ctx.cfg.maxParallelIndexing, async (record) => {
    const lock = await acquireRepoLock(ctx.cfg, record.repoId);
    if (!lock) return;
    try {
      markRunStarted(record);
      const result = await runPipeline(ctx.cfg, ctx.db, record, "init");
      recordRun(record, result);
      done++;
      if (result.ok) {
        console.log(
          `[${done}/${records.length}] ${record.repoId} — wiki ${result.wikiChunks}, sources ${result.sourceChunks}`,
        );
      } else {
        failed.push(record.repoId);
        console.error(`[${done}/${records.length}] ${record.repoId} FAILED: ${result.error}`);
      }
      await saveState(ctx.cfg, ctx.registry);
    } finally {
      await lock.released();
    }
  });
  if (failed.length > 0) {
    console.error(`batch finished with ${failed.length} failures: ${failed.join(", ")}`);
    return 1;
  }
  console.log(`batch finished: ${done} repos indexed`);
  return 0;
}

async function removeRepo(ctx: Ctx, repoId: string): Promise<number> {
  if (!repoId) {
    console.error("usage: repo remove <repoId>");
    return 1;
  }
  const record = getRepo(ctx.registry, repoId);
  if (!record) {
    console.error(`error: unknown repo ${repoId}`);
    return 1;
  }
  ctx.registry.repos = ctx.registry.repos.filter((r) => r.repoId !== repoId);
  await saveRegistry(ctx.cfg, ctx.registry);
  await purgeRepo(ctx.db, repoId);
  await removeRepoDir(ctx.cfg, repoId);
  try {
    await ctx.db.execute("VACUUM");
  } catch {
    // busy or unsupported — space reuse happens on a later run
  }
  console.log(`removed ${repoId}`);
  return 0;
}

async function listRepos(ctx: Ctx, json: boolean): Promise<number> {
  const rows: Record<string, unknown>[] = [];
  for (const repo of ctx.registry.repos) {
    const counts = await docCounts(ctx.db, repo.repoId);
    const meta = await getRepoMeta(ctx.db, repo.repoId);
    rows.push({
      repoId: repo.repoId,
      source: repo.source,
      hasInstructions: repo.instructions !== undefined,
      // The producer actually in effect, so `repo list` shows a mixed fleet.
      producer: producerFor(ctx.cfg, repo),
      producerOverridden: repo.producer !== undefined,
      excludeGlobs: repo.excludeGlobs ?? [],
      groundingScore: repo.lastRun.groundingScore ?? null,
      lastIndexedSha: repo.lastIndexedSha,
      lastSuccessAt: repo.lastSuccessAt,
      docs: counts,
      linkHealth: meta
        ? { resolved: meta.linkResolved, total: meta.linkTotal }
        : { resolved: 0, total: 0 },
      conceptTerms: meta?.conceptTerms ?? [],
      lastRun: {
        outcome: repo.lastRun.outcome,
        durationMs: repo.lastRun.durationMs,
        tokens: repo.lastRun.tokens,
        error: repo.lastRun.error,
      },
    });
  }
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("no repos registered");
    return 0;
  }
  for (const r of rows) {
    const docs = r.docs as { wiki: number; source: number };
    const link = r.linkHealth as { resolved: number; total: number };
    const terms = (r.conceptTerms as string[]).slice(0, 6).join(", ");
    const instr = r.hasInstructions === true ? " +instructions" : "";
    // Only annotate a non-default producer: a homogeneous fleet stays quiet.
    const prod = r.producerOverridden === true ? ` +${String(r.producer)}` : "";
    const globs = r.excludeGlobs as string[];
    const excl = globs.length > 0 ? ` +excludes:${globs.join(",")}` : "";
    const score = typeof r.groundingScore === "number" ? ` g${r.groundingScore.toFixed(2)}` : "";
    console.log(
      `${String(r.repoId).padEnd(40)} wiki ${docs.wiki} src ${docs.source} links ${link.resolved}/${link.total} sha ${String(r.lastIndexedSha ?? "-").slice(0, 8)}${terms ? ` [${terms}]` : ""}${instr}${prod}${excl}${score}`,
    );
  }
  return 0;
}

async function updateOne(ctx: Ctx, repoId: string): Promise<number> {
  if (!repoId) {
    console.error("usage: repo update <repoId>");
    return 1;
  }
  const repo = getRepo(ctx.registry, repoId);
  if (!repo) {
    console.error(`error: unknown repo ${repoId}`);
    return 1;
  }
  markRunStarted(repo);
  const result = await updateRepo(ctx.cfg, ctx.db, repo);
  recordRun(repo, result);
  await saveState(ctx.cfg, ctx.registry);
  if (!result.ok) {
    console.error(`[${repoId}] ${result.error}`);
    return 1;
  }
  console.log(
    result.headMoved
      ? `[${repoId}] updated — wiki ${result.wikiChunks}, sources ${result.sourceChunks}`
      : `[${repoId}] up to date (no changes)`,
  );
  return 0;
}

async function reinitOne(ctx: Ctx, repoId: string): Promise<number> {
  if (!repoId) {
    console.error("usage: repo reinit <repoId>");
    return 1;
  }
  const repo = getRepo(ctx.registry, repoId);
  if (!repo) {
    console.error(`error: unknown repo ${repoId}`);
    return 1;
  }
  markRunStarted(repo);
  const result = await reinitRepo(ctx.cfg, ctx.db, repo);
  recordRun(repo, result);
  await saveState(ctx.cfg, ctx.registry);
  if (!result.ok) {
    console.error(`[${repoId}] ${result.error}`);
    return 1;
  }
  console.log(
    `[${repoId}] re-initialized — wiki ${result.wikiChunks}, sources ${result.sourceChunks}`,
  );
  return 0;
}

async function updateAllCommand(argv: string[]): Promise<number> {
  if (argv[0] !== "--all") {
    console.error("usage: update --all");
    return 1;
  }
  const cfg = loadConfig();
  const ctx = await openContext(cfg);
  try {
    await updateAllRepos(cfg, ctx.db);
    console.log("update --all finished");
    return 0;
  } finally {
    ctx.db.close();
  }
}

async function indexCommand(argv: string[]): Promise<number> {
  const repoId = argv[0];
  if (!repoId) {
    console.error("usage: index <repoId>");
    return 1;
  }
  const cfg = loadConfig();
  const ctx = await openContext(cfg);
  try {
    const repo = getRepo(ctx.registry, repoId);
    if (!repo) {
      console.error(`error: unknown repo ${repoId}`);
      return 1;
    }
    const lock = await acquireRepoLock(cfg, repoId);
    if (!lock) {
      console.error(`error: ${repoId} is already being updated`);
      return 1;
    }
    try {
      await appendEvent(cfg, { type: "run_started", repoId });
      const started = Date.now();
      const result = await indexRepo(ctx.db, cfg, repoId, repo.clonePath);
      recordRun(repo, {
        ok: true,
        outcome: "ok",
        resetAt: null,
        groundingScore: null,
        error: null,
        wikiChunks: result.wikiChunks,
        sourceChunks: result.sourceChunks,
        embedded: result.embedded,
        warnings: result.warnings,
        durationMs: Date.now() - started,
        sha: repo.lastIndexedSha,
      });
      await saveState(ctx.cfg, ctx.registry);
      console.log(
        `[${repoId}] re-indexed — wiki ${result.wikiChunks}, sources ${result.sourceChunks}, embedded ${result.embedded}`,
      );
      for (const w of result.warnings) console.log(`[${repoId}] warning: ${w}`);
      return 0;
    } finally {
      await lock.released();
    }
  } finally {
    ctx.db.close();
  }
}

async function serveCommand(_argv: string[]): Promise<number> {
  const cfg = loadConfig();
  const { startServer } = await import("../server/server.ts");
  const { createScheduler } = await import("../repoManager/scheduler.ts");
  const { openContext: openCtx } = await import("../repoManager/context.ts");

  // Writable DB for the scheduler + admin API; the server opens its own
  // read-only handle for MCP/status reads.
  const ctx = await openCtx(cfg);
  const scheduler = createScheduler(cfg, ctx.db);
  const served = await startServer({
    cfg,
    schedulerState: scheduler.state,
    adminDb: ctx.db,
    applySchedule: scheduler.applySchedule,
  });

  console.log(`open-deepwiki serving:`);
  console.log(`  MCP endpoint:   ${served.mcpUrl}`);
  console.log(`  health:         ${served.url}/healthz`);
  console.log(`  status:         ${served.url}/status`);
  console.log(
    `  scheduler:      daily at ${String(cfg.nightlyTime.hour).padStart(2, "0")}:${String(cfg.nightlyTime.minute).padStart(2, "0")} (${cfg.maxParallelIndexing} parallel)`,
  );
  if (!["127.0.0.1", "localhost", "::1"].includes(cfg.bindHost)) {
    if (!cfg.bearerToken) {
      console.error(
        `warning: bound to ${cfg.bindHost} without ODW_BEARER_TOKEN — all requests will be rejected`,
      );
    } else {
      console.log(`  auth:           bearer token required (ODW_BEARER_TOKEN)`);
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    await served.stop();
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {}); // serve until signal
  return 0;
}

async function statusCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const cfg = loadConfig(env);
  const { buildStatusSummary } = await import("../monitor/status.ts");
  const { openContext: openCtx } = await import("../repoManager/context.ts");
  const { loadRegistry } = await import("../repoManager/registry.ts");

  const failing = argv.includes("--failing");
  const json = argv.includes("--json");
  const serverIdx = argv.indexOf("--server");
  const serverUrl = serverIdx >= 0 ? (argv[serverIdx + 1] ?? "") : null;
  const registry = await loadRegistry(cfg);
  const ctx = await openCtx(cfg);
  try {
    let summary = await buildStatusSummary(cfg, ctx.db, registry);

    if (serverUrl) {
      try {
        const headers: Record<string, string> = cfg.bearerToken
          ? { authorization: `Bearer ${cfg.bearerToken}` }
          : {};
        const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/status`, { headers });
        if (!res.ok) {
          console.error(`warning: server returned ${res.status} — showing registry-only view`);
        } else {
          const live = (await res.json()) as {
            scheduler?: { pending?: number; inFlight?: number };
          };
          if (live.scheduler) {
            summary = {
              ...summary,
              scheduler: {
                running: true,
                nextRunAt: null,
                lastTickAt: null,
                pending: live.scheduler.pending ?? 0,
                inFlight: live.scheduler.inFlight ?? 0,
                maxParallel: cfg.maxParallelIndexing,
                locksHeld: [],
              },
            };
          }
        }
      } catch (err) {
        console.error(
          `warning: cannot reach ${serverUrl} (${err instanceof Error ? err.message : err}) — showing registry-only view`,
        );
      }
    }

    const repos = failing ? summary.repos.filter((r) => r.health !== "green") : summary.repos;
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    console.log(
      `queue: pending ${summary.scheduler.pending}, in flight ${summary.scheduler.inFlight} (max ${summary.scheduler.maxParallel})`,
    );
    if (summary.repos.length === 0) {
      console.log("no repos registered");
      return 0;
    }
    for (const r of repos) {
      const errSuffix = r.lastError ? ` — ${r.lastError.split("\n")[0]?.slice(0, 80)}` : "";
      // Only annotate what is not the default, so a homogeneous healthy fleet
      // stays readable: producer when it is not openwiki, grounding when it
      // has been measured, and a build only while one is in progress.
      const prod = r.producer === "openwiki" ? "" : ` [${r.producer}]`;
      const ground = r.groundingScore === null ? "" : ` g${r.groundingScore.toFixed(2)}`;
      const build =
        r.build === null
          ? ""
          : ` building@${r.build.pinnedSha.slice(0, 8)} (attempt ${r.build.attempts})`;
      console.log(
        `${r.health.padEnd(6)} ${r.repoId.padEnd(40)} wiki ${r.docs.wiki} src ${r.docs.source} links ${r.linkHealth.resolved}/${r.linkHealth.total}${prod}${ground}${build}${errSuffix}`,
      );
    }
    return 0;
  } finally {
    ctx.db.close();
  }
}

async function logsCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const cfg = loadConfig(env);
  const { readEvents } = await import("../monitor/events.ts");
  const repoIdx = argv.indexOf("--repo");
  const repoId = repoIdx >= 0 ? (argv[repoIdx + 1] ?? "") : undefined;
  // Filter before tailing: a mid-build repo's beats would otherwise push the
  // lifecycle events out of the tail they are being tailed to find.
  const all = await readEvents(cfg, repoId ? { repoId } : {});
  const events = (
    argv.includes("--progress") ? all : all.filter((e) => e.type !== "producer_progress")
  ).slice(-200);
  if (events.length === 0) {
    console.log("no events");
    return 0;
  }
  for (const e of events) {
    const detail =
      e.type === "producer_progress"
        ? ` (${e.stage ?? "?"} ${e.note ?? ""})`
        : e.type === "run_succeeded" || e.type === "run_failed"
          ? ` (${e.durationMs ?? "?"}ms${e.error ? ` ${e.error}` : ""})`
          : "";
    console.log(`${e.ts} ${e.type} ${e.repoId}${detail}`);
  }
  return 0;
}

export { addRepo, listRepos, statusCommand, logsCommand, instructionsCommand };

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
