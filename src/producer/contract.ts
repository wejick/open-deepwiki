/**
 * The producer contract's shared vocabulary — the types behind CONTRACT.md's
 * rule 4: a producer reports exactly one outcome and never decides its own
 * acceptance. Every producer implements these, and every consumer (pipeline,
 * CLI, monitoring) reads them, so adding a producer touches nothing here.
 *
 * `ENOENT` also lives here: both producers classify spawn failures with the
 * same pattern, and the neutral home keeps producers from importing each
 * other's modules.
 */

export const ENOENT = /not found in \$PATH|ENOENT|failed to spawn/i;

/** The one outcome. `rate_limited` is distinct from `failed` because a usage
 *  limit is "come back later", not a broken repo — recording it as a failure
 *  would turn the whole fleet red on one exhausted limit. */
export type ProducerOutcome = "ok" | "failed" | "rate_limited";

/**
 * What every producer reports.
 *
 * `ok` is shorthand for `outcome === "ok"` and means only that the child
 * exited cleanly — never that a usable bundle exists; acceptance decides that
 * from the artifact.
 */
export type ProducerRun = {
  ok: boolean;
  outcome: ProducerOutcome;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  spawnError: string | null;
  /** When the limit resets, if the producer said, so dispatch can wait. */
  resetAt: string | null;
  /** True when the run left resumable work behind. A producer that cannot
   *  resume never sets it — there is no `false`; absence means the same. */
  partial?: true | undefined;
  /** Units this run completed (a validated map or plan part, a merged plan,
   *  a produced page). Zero/absent means no forward progress: only such runs
   *  advance the resume-attempt counter toward exhaustion. */
  unitsCompleted?: number | undefined;
};

/** What a producer is given; each ignores what it does not need. openwiki
 *  derives its own change set and reads none of these. */
export type ProducerInput = {
  /** Commit the existing bundle was generated from (`.last-update.json`). */
  fromSha?: string | undefined;
  /** The commit this run is building — the checkout's HEAD. Distinct from
   *  `fromSha`, the commit the run is building *away from*: pinning work in
   *  progress to the anchor would resume against an empty diff. */
  targetSha?: string | undefined;
  /** Source paths changed since `fromSha`, for a scoped update. */
  changedPaths?: string[] | undefined;
  /** `type` values already in use, so an update cannot reassign them. */
  typeVocabulary?: string[] | undefined;
  /** Set when continuing a partial bundle: the commit it is pinned to. */
  resumeTargetSha?: string | undefined;
  /** On a repair retry, the specific acceptance errors to fix. */
  repairErrors?: string[] | undefined;
};

export type RunOptions = {
  /** Extra env for the child process (e.g. PATH with shims, OPENWIKI_CONFIG_DIR). */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Attributes producer_progress events to a repo; absent on direct runs. */
  repoId?: string;
};
