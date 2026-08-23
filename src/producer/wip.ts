import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/config.ts";
import type { ProducerId } from "../config/config.ts";

/**
 * Work-in-progress production. Two states at two paths: `<clone>/openwiki/` is
 * published and never partial, `<dataDir>/repos/wip/<repoId>/` accumulates
 * across runs and is never indexed or served. `saveWip` harvests a partial
 * bundle into the WIP area and counts the attempt, `stageWip` stages it back
 * for the next run, and `planResume` decides resume vs discard vs exhausted.
 *
 * Without this, a repo too big for one budget window livelocks — every night
 * burns quota and starts over. Producers only ever write to the published
 * path, so "promotion" is simply keeping what was published and dropping the
 * WIP.
 *
 * Position vs `anchor.ts`: that file travels inside the bundle and
 * describes what is published — the commit a bundle is current for. This
 * area lives outside it and describes what is in flight — the commit being
 * built and the attempts spent on it.
 */

export type WipMeta = {
  /** The commit this build is pinned to, so it converges. */
  targetSha: string;
  /** A different producer means discard — half a bundle in the other's
   *  conventions is worse than starting clean. */
  producer: ProducerId;
  attempts: number;
};

const META_FILE = ".odw-wip.json";

export function wipDir(cfg: Config, repoId: string): string {
  return join(cfg.dataDir, "repos", "wip", repoId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readWipMeta(cfg: Config, repoId: string): Promise<WipMeta | null> {
  try {
    const raw = await readFile(join(wipDir(cfg, repoId), META_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<WipMeta>;
    if (typeof parsed.targetSha !== "string" || typeof parsed.producer !== "string") return null;
    return {
      targetSha: parsed.targetSha,
      producer: parsed.producer as ProducerId,
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
    };
  } catch {
    return null; // absent or corrupt
  }
}

/** Persist a partial bundle as this repo's WIP, bumping the attempt count.
 *  A run that completed at least one unit (`progressed`) resets the counter
 *  instead: exhaustion is for runs that make no forward progress, and a
 *  many-window build must not exhaust merely by being long. */
export async function saveWip(
  cfg: Config,
  repoId: string,
  bundle: string,
  meta: { targetSha: string; producer: ProducerId; progressed?: boolean },
): Promise<WipMeta> {
  const dir = wipDir(cfg, repoId);
  const previous = await readWipMeta(cfg, repoId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (await exists(bundle)) await cp(bundle, dir, { recursive: true });
  const next: WipMeta = {
    targetSha: meta.targetSha,
    producer: meta.producer,
    attempts: meta.progressed === true ? 1 : (previous?.attempts ?? 0) + 1,
  };
  await writeFile(join(dir, META_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function clearWip(cfg: Config, repoId: string): Promise<void> {
  await rm(wipDir(cfg, repoId), { recursive: true, force: true });
}

export type ResumePlan =
  | { kind: "none" }
  | { kind: "resume"; meta: WipMeta }
  | { kind: "discard"; reason: string }
  | { kind: "exhausted"; meta: WipMeta };

/** What to do with an existing WIP, given the selected producer and the cap. */
export async function planResume(
  cfg: Config,
  repoId: string,
  producer: ProducerId,
): Promise<ResumePlan> {
  const meta = await readWipMeta(cfg, repoId);
  if (meta === null) return { kind: "none" };
  if (meta.producer !== producer) {
    return {
      kind: "discard",
      reason: `work in progress was created by ${meta.producer}, now running ${producer}`,
    };
  }
  if (meta.attempts >= cfg.maxResumeAttempts) return { kind: "exhausted", meta };
  return { kind: "resume", meta };
}

/** Stage the WIP into the published path so the producer can continue it. The
 *  caller must already have snapshotted what was published. */
export async function stageWip(cfg: Config, repoId: string, bundle: string): Promise<void> {
  const dir = wipDir(cfg, repoId);
  if (!(await exists(dir))) return;
  await rm(bundle, { recursive: true, force: true });
  await cp(dir, bundle, { recursive: true });
  // Ours, not part of the bundle — never let it reach a wiki.
  await rm(join(bundle, META_FILE), { force: true });
}
