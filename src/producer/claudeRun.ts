import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeEffort, Config } from "../config/config.ts";
import { appendEvent } from "../monitor/events.ts";
import {
  ALLOWED_TOOLS,
  PLANNING_TOOLS,
  SETTING_SOURCES,
  authoringPrompt,
  pageDirectives,
  phasePrompt,
  plannerDirectives,
  probeCapabilities,
  runSession,
  stepOverrides,
  whyNotProduced,
  type Session,
  type SessionIdentity,
} from "./claude.ts";
import { finalizeClaudeBundle } from "./claudeFinalize.ts";
import { buildDigestTree, listDocumentableFiles, renderDigest } from "./claudeDigest.ts";
import { planSplit } from "./claudeSplit.ts";
import {
  OVERVIEW_PAGE,
  PLAN_FILE_NAME,
  clearPlanningArtifacts,
  clearSessionIdentity,
  loadPlan,
  enforcePageBudget,
  normalizePlan,
  recordedSession,
  recordSessionIdentity,
  stampPlan,
  type NormalizedPlan,
  type PlanFile,
  type PlanPage,
} from "./claudePlan.ts";
import type { ProducerInput, ProducerOutcome, ProducerRun, RunOptions } from "./contract.ts";
import { bundleDir, conceptPagePaths, pageConformance } from "./verify.ts";

/**
 * The `claude` producer's run lifecycle. `runClaude` orchestrates several
 * `claude -p` sessions against the managed clone — a planning session writes
 * the page plan into the bundle, up to a configured number of page sessions
 * concurrently (default one at a time), the overview last — openwiki's
 * planner/worker shape, so a stuck page costs one page and an interrupted run
 * resumes from the plan file itself (`claudePlan.ts`).
 *
 * Its sub-lifecycle, inside run.ts's PRODUCE phase:
 *
 *   STAGE     prompts + contract to scratch files; env; deadline
 *   REPAIR    (repairErrors only) one whole-bundle fix session → finalize;
 *             neither plan nor page sessions run
 *   PLAN      no usable plan file: a planning session — or, above the split
 *             threshold on an init, a map session then one per area, each
 *             writing a dot-file whose presence is the unit's checkpoint →
 *             validate → canonify
 *   APPLY     an unapplied plan first deletes every page it names, then is
 *             stamped with the commit being built — so a page present in the
 *             bundle was produced by this build, and resume needs no
 *             per-page state
 *   PAGES     up to `ODW_CLAUDE_PAGE_WORKERS` sessions per missing page (the
 *             overview last, after the pool) — a page that exists and conforms
 *             is already done; a session that fails loses its file
 *   FINISH    every page + overview present → finalize → remove the plan
 *             file → ok; anything missing → partial
 *
 * This reports only what the children said. Whether a usable bundle exists is
 * acceptance's decision, never the producer's.
 *
 * Each phase is a function below (`openRun`, `repairBundle`, `ensurePlan`,
 * `applyPlan`, `producePages`, `completeRun`) returning the terminal
 * ProducerRun or the next phase's input; split planning has its own module
 * (`claudeSplit.ts`), and one session's spawn and classification live in
 * `claude.ts`.
 */

/** Everything one run's phases share, named so the phases can be module-level
 *  functions. Constructed by `openRun`, consumed directly; there is no second
 *  implementation. */
export type Run = {
  cfg: Config;
  mode: "init" | "update";
  checkoutDir: string;
  bundle: string;
  targetSha: string;
  planPath: string;
  started: number;
  deadline: number;
  promptDir: string;
  prompts: { contract: string; planner: string; page: string; map: string };
  env: Record<string, string>;
  extraArgs: string[];
  /** Operator-facing diagnostics, landed last in the report's stderr. */
  notes: string[];
  /** Units this run completed — map, part, merged plan, or produced page. A
   *  zero count is the difference between "converging" and "stalled" for the
   *  resume-attempt counter, so every completion increments it. */
  units: number;
  /** Accepted exclusion globs this run applied to its planning scope —
   *  reported on a successful completion so the pipeline can persist them to
   *  the repo's registry `excludeGlobs` (spec: okf-producer › Claude producer
   *  map exclusion gate). */
  appliedGlobs: string[];
  /** What is left of the whole-run budget, capped by the per-session budget. */
  stepMs(): number;
  /** The installed CLI advertised `--session-id` and `--resume`; page
   *  sessions may carry an identity and be resumed. */
  sessionFlags: boolean;
  session(
    systemPromptFile: string,
    prompt: string,
    overrides?: { model?: string; effort?: ClaudeEffort },
    tools?: string,
    /** Abort kills the child early — page workers use it to cancel in-flight
     *  peers when one session reports a usage limit. */
    signal?: AbortSignal,
    /** Assigned identity for a page session; ignored without sessionFlags. */
    identity?: SessionIdentity,
  ): Promise<Session>;
  /** Unit-completion beats for the event log. */
  progress(
    stage: "planning" | "session" | "map" | "area" | "plan" | "page",
    note: string,
  ): Promise<void>;
  /** The run's one report. A null session is a run that never reached one. */
  finish(
    session: Session | null,
    over: Partial<ProducerRun> & { outcome: ProducerOutcome },
  ): ProducerRun;
};

/** Phase boundary: either the terminal report or the next phase's input. */
function isProducerRun(x: unknown): x is ProducerRun {
  return typeof x === "object" && x !== null && "outcome" in x;
}

/** The run's one report shape — openRun's early staging failure and every
 *  phase's exit share it. `run.finish` delegates here. */
function finishRun(
  run: Pick<Run, "started" | "notes" | "units" | "appliedGlobs">,
  s: Session | null,
  over: Partial<ProducerRun> & { outcome: ProducerOutcome },
): ProducerRun {
  return {
    ok: over.outcome === "ok",
    exitCode: s?.exitCode ?? null,
    signal: s?.signal ?? null,
    stdout: s?.stdout ?? "",
    stderr: [s?.stderr ?? "", ...run.notes].filter(Boolean).join("\n"),
    timedOut: s?.timedOut ?? false,
    durationMs: Date.now() - run.started,
    spawnError: s?.spawnError ?? null,
    resetAt: s?.resetAt ?? null,
    ...(run.units > 0 ? { unitsCompleted: run.units } : {}),
    ...(over.outcome === "ok" && run.appliedGlobs.length > 0
      ? { excludeGlobsApplied: [...run.appliedGlobs] }
      : {}),
    ...over,
  };
}

/** The session's job, from the directive line every prompt leads with —
 * the same machine contract the test shims parse. No directive (the
 * repair prompt) means the repair session. */
function sessionJob(prompt: string): string {
  const first = prompt.split("\n", 1)[0] ?? "";
  const m = /^(MAP_FILE|AREA_ID|PLAN_FILE|PAGE_PATH): ?(.*)$/.exec(first);
  if (m === null) return "repair";
  const tag = m[1] ?? "";
  const value = m[2] ?? "";
  if (tag === "MAP_FILE") return "map";
  if (tag === "AREA_ID") return `area ${value}`;
  if (tag === "PAGE_PATH") return `page ${value}`;
  return "plan";
}

/** `verifyBundle`'s bar, no higher — page quality is acceptance's call. A
 *  session can claim success having written nothing, so this checks the file. */
async function pageIsWritten(bundle: string, page: string): Promise<boolean> {
  const raw = await readFile(join(bundle, page), "utf8").catch(() => null);
  return raw !== null && pageConformance(raw) === null;
}

/** The one call site — mirrors openwiki's own pre-exit finalizer. */
async function finalize(bundle: string): Promise<string | null> {
  try {
    await finalizeClaudeBundle(bundle);
    return null;
  } catch (err) {
    return `bundle finalization failed: ${String(err)}`;
  }
}

/** The continuation prompt: the page's ordinary directives against the
 *  current bundle — fresh link targets — plus the one fact the transcript
 *  may lack, that the previous session never finished. The first line stays
 *  `PAGE_PATH:` so `sessionJob` and the test shims parse it unchanged. */
function continuationPrompt(page: PlanPage, targets: string[], input: ProducerInput): string {
  return [
    pageDirectives(page, targets, input),
    "",
    "Your previous session for this page was interrupted before the page was finished.",
    "The page may be missing or half-written on disk: verify what is already there, then finish the page.",
  ].join("\n");
}

/** A CLI refusal to resume — measured as `No conversation found with session
 *  ID: …`, exit 1, no JSON: the transcript is gone. Any non-ok resume WITH a
 *  payload is that attempt's ordinary result instead. */
function isUnresumable(s: Session): boolean {
  if (s.outcome !== "failed" || s.timedOut || s.aborted) return false;
  if (s.exitCode === null || s.exitCode === 0) return false;
  try {
    return typeof (JSON.parse(s.stdout) as { result?: unknown }).result !== "string";
  } catch {
    return true;
  }
}

/** The record's keep/drop rule, applied to whichever attempt ran: an
 *  interruption (rate limit, timeout, abort) keeps the identity resumable
 *  for the next run; producing the page or any terminal failure drops it. */
function settle(run: Run, page: PlanPage, s: Session): Promise<Session> {
  if (s.outcome !== "rate_limited" && !s.timedOut && !s.aborted) {
    return clearSessionIdentity(run.bundle, page.path).then(() => s);
  }
  return Promise.resolve(s);
}

/** One page-session spawn serving both the pool and the overview. The
 *  identity is assigned and persisted before the child starts, a planned
 *  page carrying a record resumes its recorded session, and a CLI refusal
 *  falls back to a fresh session in the same run. A CLI without the flags
 *  (`sessionFlags: false`) takes exactly the old fresh-session path. */
async function pageSession(
  run: Run,
  page: PlanPage,
  targets: string[],
  input: ProducerInput,
  signal?: AbortSignal,
): Promise<Session> {
  const overrides = stepOverrides(run.cfg, "page");
  const spawnFresh = (identity: SessionIdentity | undefined): Promise<Session> =>
    run.session(
      run.prompts.page,
      pageDirectives(page, targets, input),
      overrides,
      undefined,
      signal,
      identity,
    );
  if (!run.sessionFlags) return spawnFresh(undefined);

  const prior = await recordedSession(run.bundle, page.path);
  if (prior === null) {
    const identity: SessionIdentity = { mode: "new", id: crypto.randomUUID() };
    await recordSessionIdentity(run.bundle, page.path, identity.id);
    return settle(run, page, await spawnFresh(identity));
  }

  const resumed = await run.session(
    run.prompts.page,
    continuationPrompt(page, targets, input),
    overrides,
    undefined,
    signal,
    { mode: "resume", id: prior },
  );
  if (!isUnresumable(resumed)) return settle(run, page, resumed);
  run.notes.push(`${page.path}: the recorded session could not be resumed; starting fresh`);
  await clearSessionIdentity(run.bundle, page.path);
  const identity: SessionIdentity = { mode: "new", id: crypto.randomUUID() };
  await recordSessionIdentity(run.bundle, page.path, identity.id);
  return settle(run, page, await spawnFresh(identity));
}

/* REPAIR — a targeted fix, not a fresh build: replanning would discard
 * the pages being corrected. Neither PLAN nor PAGES runs. */
async function repairBundle(run: Run, errors: string[]): Promise<ProducerRun> {
  const prompt = [
    "The OKF wiki bundle at ./openwiki/ was REJECTED. Fix exactly these problems and change nothing else:",
    errors.map((e) => `- ${e}`).join("\n"),
  ].join("\n\n");
  const repair = await run.session(run.prompts.contract, prompt, stepOverrides(run.cfg, "page"));
  if (repair.outcome !== "ok") return run.finish(repair, { outcome: repair.outcome });
  const failure = await finalize(run.bundle);
  if (failure !== null) return run.finish(repair, { outcome: "failed", stderr: failure });
  // A published bundle carries no plan — this exit is not an exception.
  await rm(run.planPath, { force: true });
  await clearPlanningArtifacts(run.bundle);
  return run.finish(repair, { outcome: "ok" });
}

type PlanReady = {
  /** The plan APPLY consumes: written this run (unapplied), merged from the
   *  split (unapplied), or already applied on this commit by an earlier run
   *  (resumable). */
  loaded: Extract<PlanFile, { kind: "unapplied" } | { kind: "resumable" }>;
  /** The session APPLY's failure report falls back to; null when the plan
   *  file was already there. */
  planned: Session | null;
};

/* PLAN — a usable plan file is present only when a previous run left it (the
 * work-in-progress area restored it); otherwise a planning session — or,
 * above the split threshold on an init, split planning — writes one. A stale
 * or corrupt file replans. */
async function ensurePlan(run: Run, input: ProducerInput): Promise<ProducerRun | PlanReady> {
  let loaded = await loadPlan(run.bundle, run.targetSha);
  if (loaded.kind === "stale") {
    run.notes.push(
      `replanning: plan was applied to ${loaded.appliedAtSha}, now building ${run.targetSha}`,
    );
  }
  if (loaded.kind === "invalid") run.notes.push(`replanning: ${loaded.error}`);
  if (loaded.kind === "unapplied" || loaded.kind === "resumable") {
    return { loaded, planned: null };
  }

  /* The merged exclude set rides cfg.excludeGlobs (the pipeline merges the
   * repo's registry globs in, exactly as it does for the index), so
   * sizing, handouts, and the gate all start from one documentable set. */
  const tracked =
    run.mode === "init"
      ? await listDocumentableFiles(run.checkoutDir, run.cfg.excludeGlobs).catch(() => null)
      : null;
  await run.progress(
    "planning",
    tracked === null ? run.mode : `${run.mode}, ${tracked.length} documentable files`,
  );
  /* The structure handout, built once per init planning run — a resumed
   * run can reach the area loop with the map already present, so this is
   * built before the map is even consulted, not when the map runs. Null
   * only when git itself fails (then no split and a degraded planner). */
  const tree =
    run.mode === "init" && tracked !== null
      ? await buildDigestTree(run.checkoutDir, run.cfg.excludeGlobs).catch(() => null)
      : null;
  if (tracked !== null && tracked.length > run.cfg.claude.splitPlanFiles) {
    /* Split planning — a map session, the exclusion gate, one bounded
     * session per area, then the merge; each unit's dot-file is its
     * checkpoint (claudeSplit.ts). */
    const split = await planSplit(run, tracked, tree);
    if (isProducerRun(split)) return split;
    return { loaded: split.loaded, planned: split.planned };
  }

  /* The undecomposed init planner gets the whole structure handout; on
   * an update the planner works from `changedPaths` and keeps the full
   * toolset. A null tree (git failed) degrades the same way an update
   * does, so a planner never spawns without both enumeration and a
   * handout. */
  let handoutFile: string | null = null;
  if (run.mode === "init" && tree !== null) {
    handoutFile = join(run.promptDir, "digest.txt");
    await writeFile(handoutFile, renderDigest(tree));
  }
  const plannerTools = handoutFile === null ? ALLOWED_TOOLS : PLANNING_TOOLS;
  const planning = await run.session(
    run.prompts.planner,
    plannerDirectives(run.mode, input, run.planPath, { handoutFile }),
    stepOverrides(run.cfg, "plan"),
    plannerTools,
  );
  if (planning.outcome !== "ok") {
    /* A planner that died after writing a usable plan left resumable
     * work: say so, or the restore path deletes the plan it wrote. */
    const after = await loadPlan(run.bundle, run.targetSha);
    const usable = after.kind === "unapplied" || after.kind === "resumable";
    return run.finish(planning, {
      outcome: planning.outcome,
      ...(usable ? { partial: true } : {}),
    });
  }
  loaded = await loadPlan(run.bundle, run.targetSha);
  // The planner was told its one answer is the plan file; anything else
  // (no write, garbage, a file it stamped itself) fails the run.
  if (loaded.kind !== "unapplied") {
    const why = loaded.kind === "invalid" ? loaded.error : "the planning session produced no plan";
    return run.finish(planning, { outcome: "failed", spawnError: why });
  }
  // Init plans are budgeted like merged ones: same ratio, same
  // deterministic repair, applied before anything consumes the plan.
  // Repair is deterministic, so a resumed run re-derives it from the
  // file the session wrote; no rewrite needed here.
  let plan = loaded.plan;
  if (tracked !== null) {
    const budgeted = enforcePageBudget(plan, tracked.length, null);
    if (!budgeted.ok) {
      return run.finish(planning, { outcome: "failed", spawnError: budgeted.error });
    }
    plan = budgeted.plan;
  }
  // A beat only — undecomposed planning is not a resume unit, so the
  // units counter is untouched.
  await run.progress("plan", `${plan.pages.length} pages`);
  return { loaded: { kind: "unapplied", plan }, planned: planning };
}

/* APPLY — an unapplied plan first deletes every page it names: after this
 * point a page present in the bundle was produced by this build, which is
 * what lets the page loop tell done from pending with no per-page state. The
 * stamp records that application ran (and on which commit); a kill before it
 * re-runs the idempotent deletion next time. */
async function applyPlan(
  run: Run,
  ensured: PlanReady,
): Promise<ProducerRun | { plan: NormalizedPlan }> {
  if (ensured.loaded.kind === "resumable") {
    run.notes.push("resuming: plan already applied, skipping its pages that exist");
    return { plan: ensured.loaded.plan };
  }
  const normalized = normalizePlan(ensured.loaded.plan, {
    mode: run.mode,
    existingPages: await conceptPagePaths(run.bundle),
  });
  if (!normalized.ok) {
    return run.finish(ensured.planned, { outcome: "failed", spawnError: normalized.error });
  }
  for (const page of [
    ...normalized.plan.pages.map((p) => p.path),
    ...normalized.plan.deletePages,
  ]) {
    await rm(join(run.bundle, page), { force: true });
  }
  await stampPlan(run.bundle, normalized.plan, run.targetSha);
  /* The stamped plan is the checkpoint from here on; the split planning
   * artifacts it was merged from are spent. Unconditional on purpose: an
   * undecomposed run never wrote artifacts, so the clear is a readdir
   * no-op there, and one rule beats a flag. */
  await clearPlanningArtifacts(run.bundle);
  return { plan: normalized.plan };
}

/* PAGES — a bounded pool of page sessions, then the overview last. A page
 * that exists and conforms is already done; a session that fails or times out
 * loses its file, so a half-written page never survives to be mistaken for a
 * produced one. Workers claim pages in plan order up to a configurable cap
 * (`ODW_CLAUDE_PAGE_WORKERS`) and share one whole-run deadline, never divided
 * among them; a session reporting a usage limit cancels its in-flight peers.
 * Completions race, so failure notes and the run's headline session are
 * recovered from the launch-order table afterwards, not from whichever promise
 * settled last. The run is complete only when every planned page (the overview
 * is always one of them) is present and conformant, whatever the sessions
 * claimed. */
async function producePages(
  run: Run,
  plan: NormalizedPlan,
  input: ProducerInput,
): Promise<ProducerRun | { last: Session | null }> {
  const plannedPaths = plan.pages.map((p) => p.path);
  /** The overview links to what shipped; every other page to the neighbours
   *  the planner curated, or to the whole plan when it named none. */
  const linkTargets = async (page: PlanPage): Promise<string[]> => {
    if (page.path === OVERVIEW_PAGE) {
      return (await conceptPagePaths(run.bundle)).filter((p) => p !== OVERVIEW_PAGE);
    }
    if (page.relatedPages.length > 0) return page.relatedPages;
    return plannedPaths.filter((p) => p !== page.path);
  };
  // Notes land in `stderr` in plan order whatever order the workers finished,
  // so they are buffered with their plan index and flushed sorted.
  const noteOf = (page: PlanPage): number => plan.pages.indexOf(page);
  const notes: { at: number; text: string }[] = [];
  const note = (at: number, text: string): void => {
    notes.push({ at, text });
  };
  const flushNotes = (): void => {
    notes.sort((a, b) => a.at - b.at);
    for (const n of notes) run.notes.push(n.text);
  };
  const recordFailure = async (page: PlanPage, produced: Session): Promise<void> => {
    const left = await readFile(join(run.bundle, page.path), "utf8").catch(() => null);
    await rm(join(run.bundle, page.path), { force: true });
    note(noteOf(page), `${page.path}: not produced (${whyNotProduced(produced, left)})`);
  };

  /* The overview links to the pages that shipped, so it is produced after the
   * pool drains — a worker never touches it. */
  const poolPages = plan.pages.filter((p) => p.path !== OVERVIEW_PAGE);
  const overview = plan.pages.find((p) => p.path === OVERVIEW_PAGE) ?? null;
  const sessions: (Session | null)[] = poolPages.map(() => null);
  const done = poolPages.map(() => false);
  const abort = new AbortController();
  let rateLimited: Session | null = null;
  let outOfTime = false;
  let pagesDone = 0;

  /** One of up to `pageWorkers` concurrent runners: claim the next page in plan
   *  order — a page that exists and conforms is already done — and stop at the
   *  deadline or on the first usage limit. */
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < poolPages.length && rateLimited === null && !outOfTime) {
      const i = cursor++;
      const page = poolPages[i]!;
      if (await pageIsWritten(run.bundle, page.path)) {
        pagesDone++;
        continue;
      }
      // The pool may have been cancelled while this worker was checking.
      if (rateLimited !== null) return;
      if (Date.now() >= run.deadline) {
        if (!outOfTime) {
          outOfTime = true;
          note(noteOf(page), `out of budget with ${page.path} and later pages unproduced`);
        }
        return;
      }
      const produced = await pageSession(run, page, await linkTargets(page), input, abort.signal);
      sessions[i] = produced;
      if (produced.outcome === "ok" && (await pageIsWritten(run.bundle, page.path))) {
        done[i] = true;
        run.units++;
        pagesDone++;
        await run.progress("page", `${page.path}: ${pagesDone}/${plan.pages.length}`);
        continue;
      }
      if (produced.outcome === "rate_limited") {
        rateLimited = produced;
        abort.abort();
        return;
      }
    }
  };

  const cap = Math.min(run.cfg.claude.pageWorkers, poolPages.length);
  await Promise.all(Array.from({ length: cap }, () => worker()));

  // Recover per-page outcomes in launch order. A cancelled peer is a peer that
  // the usage limit stopped: no note of its own, and its partial file is left
  // for the resume's conformance check to treat as unproduced.
  let last: Session | null = null;
  let firstFailure: Session | null = null;
  for (let i = 0; i < poolPages.length; i++) {
    const page = poolPages[i]!;
    const produced = sessions[i] ?? null;
    if (produced === null) continue;
    last = produced;
    if (done[i] || produced.aborted) continue;
    await recordFailure(page, produced);
    if (produced.outcome !== "rate_limited") firstFailure ??= produced;
  }
  if (rateLimited !== null) {
    flushNotes();
    return run.finish(rateLimited, { outcome: "rate_limited", partial: true });
  }

  if (overview !== null && !(await pageIsWritten(run.bundle, overview.path))) {
    if (Date.now() >= run.deadline) {
      if (!outOfTime) {
        outOfTime = true;
        note(noteOf(overview), `out of budget with ${overview.path} and later pages unproduced`);
      }
    } else {
      const produced = await pageSession(run, overview, await linkTargets(overview), input);
      last = produced;
      if (produced.outcome === "ok" && (await pageIsWritten(run.bundle, overview.path))) {
        run.units++;
        pagesDone++;
        await run.progress("page", `${overview.path}: ${pagesDone}/${plan.pages.length}`);
      } else {
        await recordFailure(overview, produced);
        firstFailure ??= produced;
        if (produced.outcome === "rate_limited") {
          flushNotes();
          return run.finish(produced, { outcome: "rate_limited", partial: true });
        }
      }
    }
  }

  flushNotes();
  const missing: string[] = [];
  for (const page of plan.pages) {
    if (!(await pageIsWritten(run.bundle, page.path))) missing.push(page.path);
  }
  if (missing.length > 0) {
    // The budget can kill the last session without a later pre-session
    // check ever noticing, so the deadline is read here too.
    return run.finish(firstFailure ?? last, {
      outcome: "failed",
      partial: true,
      timedOut: outOfTime || Date.now() >= run.deadline,
    });
  }
  return { last };
}

/* FINISH — the deterministic index sync + Mermaid degrade (the claude-side
 * equivalent of openwiki's own pre-exit finalizer), then the report: a
 * published bundle carries no plan, and no planning artifacts either. */
async function completeRun(run: Run, last: Session | null): Promise<ProducerRun> {
  const failure = await finalize(run.bundle);
  if (failure !== null) {
    return run.finish(last, { outcome: "failed", stderr: [...run.notes, failure].join("\n") });
  }
  await rm(run.planPath, { force: true });
  await clearPlanningArtifacts(run.bundle);
  return run.finish(last, { outcome: "ok" });
}

/** STAGE — the run context: prompts staged as files rather than argv (too
 *  long to paste, and they stay diffable), env, flag detection, deadline. A
 *  staging failure fails the run before any session, as a ProducerRun. */
export async function openRun(
  cfg: Config,
  mode: "init" | "update",
  checkoutDir: string,
  opts: RunOptions = {},
  input: ProducerInput = {},
): Promise<Run | ProducerRun> {
  const started = Date.now();
  const budgetMs = opts.timeoutMs ?? cfg.claude.timeoutSec * 1000;
  const deadline = started + budgetMs;
  const bundle = bundleDir(checkoutDir);
  // A plan stamped for another commit is replanned.
  const targetSha = input.resumeTargetSha ?? input.targetSha ?? "";
  const planPath = join(bundle, PLAN_FILE_NAME);

  const notes: string[] = [];
  const appliedGlobs: string[] = [];
  /* The staging failure reports before any Run exists — same arrays the
   * constructed run shares, so the early report and later ones read alike. */
  const stagedEarly = { started, notes, units: 0, appliedGlobs };

  let promptDir: string;
  const prompts = { contract: "", planner: "", page: "", map: "" };
  try {
    promptDir = await mkdtemp(join(tmpdir(), "odw-claude-"));
    prompts.contract = join(promptDir, "contract.md");
    prompts.planner = join(promptDir, "planner.md");
    prompts.page = join(promptDir, "page.md");
    prompts.map = join(promptDir, "map.md");
    await writeFile(prompts.contract, `${await authoringPrompt()}\n`);
    await writeFile(prompts.planner, await phasePrompt("planner"));
    await writeFile(prompts.page, await phasePrompt("page"));
    await writeFile(prompts.map, await phasePrompt("map"));
  } catch (err) {
    return finishRun(stagedEarly, null, {
      outcome: "failed",
      spawnError: `could not stage the authoring contract: ${String(err)}`,
    });
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };
  // An unauthenticated dir means "Not logged in".
  if (cfg.claude.configDir !== undefined) env.CLAUDE_CONFIG_DIR = cfg.claude.configDir;

  const stepMs = (): number =>
    Math.min(cfg.claude.stepTimeoutSec * 1000, Math.max(0, deadline - Date.now()));

  const caps = await probeCapabilities(env, checkoutDir);
  const extraArgs = caps.settingSources ? ["--setting-sources", SETTING_SOURCES] : [];
  if (!caps.settingSources) {
    notes.push(
      "this claude has no --setting-sources: the checkout's own settings files are only " +
        "ignored because the workspace was never trusted",
    );
  }
  if (!caps.sessionFlags) {
    notes.push(
      "this claude has no --session-id/--resume: page sessions get no identity and are never resumed",
    );
  }

  /** Unit-completion beats for the event log. An append failure must never
   * fail the run it is describing; a missing repoId (direct runs, eval)
   * means there is no log to write to. */
  const progress = async (
    stage: "planning" | "session" | "map" | "area" | "plan" | "page",
    note: string,
  ): Promise<void> => {
    if (opts.repoId === undefined) return;
    await appendEvent(cfg, {
      type: "producer_progress",
      repoId: opts.repoId,
      producer: "claude",
      stage,
      note,
    }).catch(() => {});
  };

  const spawnSession = async (
    systemPromptFile: string,
    prompt: string,
    overrides: { model?: string; effort?: ClaudeEffort } = {},
    tools: string = ALLOWED_TOOLS,
    signal?: AbortSignal,
    identity?: SessionIdentity,
  ): Promise<Session> => {
    // Before the spawn: a hung session must be the last thing the log shows.
    await progress("session", sessionJob(prompt));
    return runSession(cfg, {
      systemPromptFile,
      prompt,
      cwd: checkoutDir,
      env,
      timeoutMs: stepMs(),
      extraArgs,
      allowedTools: tools,
      ...overrides,
      ...(signal === undefined ? {} : { signal }),
      ...(identity === undefined ? {} : { identity }),
    });
  };

  /* finish closes over the run being constructed: the arrow is created here
   * but only ever called after `run` is initialized. */
  const run: Run = {
    cfg,
    mode,
    checkoutDir,
    bundle,
    targetSha,
    planPath,
    started,
    deadline,
    promptDir,
    prompts,
    env,
    extraArgs,
    notes,
    units: 0,
    appliedGlobs,
    sessionFlags: caps.sessionFlags,
    stepMs,
    session: spawnSession,
    progress,
    finish: (s, over) => finishRun(run, s, over),
  };
  return run;
}

export async function runClaude(
  cfg: Config,
  mode: "init" | "update",
  checkoutDir: string,
  opts: RunOptions = {},
  input: ProducerInput = {},
): Promise<ProducerRun> {
  const opened = await openRun(cfg, mode, checkoutDir, opts, input);
  if (isProducerRun(opened)) return opened;
  const run = opened;

  try {
    /* REPAIR — a targeted fix, not a fresh build. */
    if (input.repairErrors !== undefined && input.repairErrors.length > 0) {
      return await repairBundle(run, input.repairErrors);
    }

    /* PLAN — a plan file is present only when a previous run left it (the
     * work-in-progress area restored it); otherwise a planning session (or,
     * above the split threshold on an init, split planning) writes one. */
    const ensured = await ensurePlan(run, input);
    if (isProducerRun(ensured)) return ensured;

    /* APPLY — an unapplied plan first deletes every page it names. */
    const applied = await applyPlan(run, ensured);
    if (isProducerRun(applied)) return applied;
    const plan = applied.plan;

    /* PAGES — one session per missing page; complete only when every planned
     * page is present and conformant. */
    const produced = await producePages(run, plan, input);
    if (isProducerRun(produced)) return produced;

    /* FINISH — finalize, drop the plan, report. */
    return await completeRun(run, produced.last);
  } finally {
    // Otherwise a long-lived `serve` leaks one directory per repo per night.
    await rm(run.promptDir, { recursive: true, force: true });
  }
}
