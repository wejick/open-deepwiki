import { cp, rm, stat } from "node:fs/promises";
import { type ProducerInput, type ProducerRun, type RunOptions } from "./contract.ts";
import { checkClaude } from "./claude.ts";
import { runClaude } from "./claudeRun.ts";
import { checkOpenwikiVersion, runOpenwiki, seedOpenwikiConfig } from "./openwiki.ts";
import { bundleDir, type VerifyResult } from "./verify.ts";
import { acceptBundle, conceptPages, type AcceptanceResult } from "./acceptance.ts";
import { typeVocabulary } from "./anchor.ts";
import { clearWip, planResume, saveWip, stageWip, type WipMeta } from "./wip.ts";
import type { Config, ProducerId } from "../config/config.ts";

/**
 * The producer run cycle — PRE → PRODUCE → POST — over four places bundle
 * state can live, so each phase's movement is between named states:
 *
 *   published  <clone>/openwiki/    the only served path; producers write here
 *   snapshot   <snapshotDir>        last verified copy — restores overwrite
 *                                   published, promotions overwrite snapshot
 *   prerun     <snapshotDir>.prerun update runs only; a scoped repair's clean
 *                                   base, dropped at every ending
 *   wip        repos/wip/<repoId>/  unfinished work — staged in before
 *                                   produce, harvested at settle
 *
 *   PRE      capture  page bytes + type vocabulary + prerun snapshot
 *            resume   stage WIP in, discard it, or surface exhausted
 *   PRODUCE  the one producer branch (openwiki | claude)
 *   POST     gate     acceptance decides on the artifact, then at most one
 *                     scoped repair retry
 *            settle   preserve WIP | restore | promote (snapshot + drop WIP)
 *
 * Around the cycle the pipeline owns the bookends: `prepareProducer` before
 * (CLI present, HOME seeded) and the record after (anchor write, index,
 * events).
 *
 * This is the one file allowed to branch on the selected producer —
 * `contract.test.ts` fails if selection leaks anywhere else.
 *
 * A producer's own success signal is never trusted — a run can exit 0 claiming
 * completion having written nothing — so the gate reads the artifact.
 * `rate_limited` preserves the published bundle exactly as a failure would,
 * but records nothing as broken and carries a reset time for dispatch.
 */

export type IsolatedRun = {
  ok: boolean;
  run: ProducerRun;
  /** Structural conformance alone, for callers that need only that. */
  verification: VerifyResult | null;
  acceptance: AcceptanceResult | null;
  restored: boolean;
  repaired: boolean;
  /** Set when this run continued (or abandoned) work in progress. */
  wip: { resumed: boolean; preserved: WipMeta | null; exhausted: boolean };
};

async function copyDir(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type Prerequisite = {
  missing: boolean;
  mismatch: boolean;
  installed: string | null;
  pinned: string;
};

/** One policy for every producer: a missing CLI warns, wiki generation is
 *  skipped, source-only indexing continues. */
export async function prepareProducer(
  cfg: Config,
  producerId: ProducerId,
  opts: { env?: Record<string, string> } = {},
): Promise<Prerequisite> {
  if (producerId === "claude") {
    const c = await checkClaude(opts);
    // No config seeding: isolating claude's config dir breaks auth.
    return { missing: c.missing, mismatch: false, installed: c.installed, pinned: "" };
  }
  const v = await checkOpenwikiVersion(cfg, opts);
  // openwiki hardcodes ~/.openwiki, so its home is seeded to skip onboarding.
  if (!v.missing) await seedOpenwikiConfig(cfg);
  return { missing: v.missing, mismatch: v.mismatch, installed: v.installed, pinned: v.pinned };
}

export async function runIsolatedProducer(
  cfg: Config,
  producerId: ProducerId,
  mode: "init" | "update",
  checkoutDir: string,
  snapshotDir: string,
  opts: RunOptions = {},
  input: ProducerInput = {},
  /** Enables resumable production; omit to run without a WIP area. */
  repoId?: string,
): Promise<IsolatedRun> {
  const bundle = bundleDir(checkoutDir);

  /* PRE · capture — freeze what the gate compares against (update scope
   * checks) and what a scoped repair restarts from, before anything writes. */
  const pagesBefore = mode === "update" ? await conceptPages(bundle) : undefined;
  const typesBefore = mode === "update" ? await typeVocabulary(bundle) : undefined;
  const preRunSnapshot = `${snapshotDir}.prerun`;
  if (mode === "update" && (await exists(bundle))) await copyDir(bundle, preRunSnapshot);

  /* PRE · resume — stage work in progress, discard a foreign producer's, or
   * surface the repo as exhausted. `resumeTarget` is the pin carried through
   * produce and settle: the commit being built, never the anchor. */
  let resumed = false;
  let resumeTarget: string | undefined;
  if (repoId !== undefined) {
    const plan = await planResume(cfg, repoId, producerId);
    if (plan.kind === "discard") {
      await clearWip(cfg, repoId);
    } else if (plan.kind === "exhausted") {
      // Surface for a human: splitting, excluding, or switching to an API key
      // are all decisions more retries cannot make.
      await clearWip(cfg, repoId);
      return {
        ok: false,
        run: {
          ok: false,
          outcome: "failed",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          durationMs: 0,
          spawnError: `production abandoned after ${plan.meta.attempts} attempts for commit ${plan.meta.targetSha} — needs attention`,
          resetAt: null,
        },
        verification: null,
        acceptance: null,
        restored: false,
        repaired: false,
        wip: { resumed: false, preserved: null, exhausted: true },
      };
    } else if (plan.kind === "resume") {
      // Publish is snapshotted, so the partial work can take its place.
      if (await exists(bundle)) await copyDir(bundle, snapshotDir);
      await stageWip(cfg, repoId, bundle);
      resumed = true;
      resumeTarget = plan.meta.targetSha;
    }
  }

  /* PRODUCE — THE producer branch. A second `producerId === …` outside this
   * file means the contract has leaked — see contract.test.ts. */
  const produce = async (extra: ProducerInput = {}): Promise<ProducerRun> => {
    const merged = {
      ...input,
      ...(resumeTarget === undefined ? {} : { resumeTargetSha: resumeTarget }),
      ...extra,
    };
    return producerId === "claude"
      ? await runClaude(
          cfg,
          mode,
          checkoutDir,
          { ...opts, ...(repoId === undefined ? {} : { repoId }) },
          merged,
        )
      : await runOpenwiki(cfg, mode, checkoutDir, opts, merged);
  };

  /* POST settle — every ending restores-or-keeps publish and drops the prerun
   * snapshot. Restore: the last verified snapshot overwrites publish; if
   * nothing was ever published, what sits there is the failed run's
   * unaccepted output and is removed — the published bundle is never partial. */
  const restore = async (): Promise<boolean> => {
    if (await exists(snapshotDir)) {
      await copyDir(snapshotDir, bundle);
      return true;
    }
    await rm(bundle, { recursive: true, force: true });
    return false;
  };
  const cleanup = async (): Promise<void> => {
    await rm(preRunSnapshot, { recursive: true, force: true });
  };
  const settleRestored = async (
    run: ProducerRun,
    acceptance: AcceptanceResult | null,
    repaired: boolean,
  ): Promise<IsolatedRun> => {
    const restored = await restore();
    await cleanup();
    return {
      ok: false,
      run,
      verification: acceptance === null ? null : acceptance.verification,
      acceptance,
      restored,
      repaired,
      wip: { resumed, preserved: null, exhausted: false },
    };
  };

  let run = await produce();

  /* POST settle · preserve — `rate_limited`, or a timeout with pages left.
   * The WIP area keeps the partial work — pinned to the commit being BUILT,
   * never the anchor: `updateRepo` resumes against `targetSha`, and pinning
   * the anchor would hand it an empty diff. An init run has no anchor at all,
   * which is precisely the case that livelocks. Neither ending is retried
   * here; publish is restored untouched. */
  if (run.outcome === "rate_limited" || run.partial === true) {
    const pin = resumeTarget ?? input.targetSha;
    let preserved: WipMeta | null = null;
    if (repoId !== undefined && pin !== undefined) {
      preserved = await saveWip(cfg, repoId, bundle, {
        targetSha: pin,
        producer: producerId,
        // Forward progress resets the attempt counter (unitsCompleted on the
        // run report); only zero-progress runs advance toward exhaustion.
        ...(run.unitsCompleted !== undefined && run.unitsCompleted > 0 ? { progressed: true } : {}),
      });
    }
    const restored = await restore();
    await cleanup();
    return {
      ok: false,
      run,
      verification: null,
      acceptance: null,
      restored,
      repaired: false,
      wip: { resumed, preserved, exhausted: false },
    };
  }

  /* POST settle · restore — failed execution: nothing resumable, and no
   * repair retry — a spawn error, non-zero exit or timeout is not fixable by
   * re-prompting. */
  if (run.outcome === "failed") return settleRestored(run, null, false);

  /* POST gate — conformance, grounding, links, coverage, scope: the artifact
   * decides, never the producer's `ok`. */
  const acceptanceInput = {
    mode,
    ...(input.changedPaths === undefined ? {} : { changedPaths: input.changedPaths }),
    ...(pagesBefore === undefined ? {} : { pagesBefore }),
    ...(typesBefore === undefined ? {} : { typesBefore }),
  };
  let acceptance = await acceptBundle(cfg, bundle, checkoutDir, acceptanceInput);
  let repaired = false;

  /* POST repair — one retry, gate failures only: those errors are specific
   * enough to feed back. After an over-broad rewrite the retry starts from
   * the prerun snapshot, not the producer's own rejected output. */
  if (!acceptance.ok) {
    if (acceptance.failure === "scope" && (await exists(preRunSnapshot))) {
      await copyDir(preRunSnapshot, bundle);
    }
    repaired = true;
    run = await produce({ repairErrors: acceptance.errors });
    if (run.outcome === "ok") {
      acceptance = await acceptBundle(cfg, bundle, checkoutDir, acceptanceInput);
    }
  }

  /* POST settle · promote — rejected restores; accepted promotes. The bundle
   * is already at the published path, so promoting is snapshotting it and
   * dropping the WIP. */
  if (!acceptance.ok || run.outcome !== "ok") return settleRestored(run, acceptance, repaired);
  await copyDir(bundle, snapshotDir);
  if (repoId !== undefined) await clearWip(cfg, repoId);
  await cleanup();
  return {
    ok: true,
    run,
    verification: acceptance.verification,
    acceptance,
    restored: false,
    repaired,
    wip: { resumed, preserved: null, exhausted: false },
  };
}
