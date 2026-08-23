import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths, type Config } from "../config/config.ts";

/**
 * Per-repo update lock: a lock file under `<dataDir>/locks/<repoId>.lock`
 * recording the holder's pid. Overlapping runs for the same repo are
 * skipped. A lock whose holder process is dead is taken over immediately;
 * one whose body is unparseable or whose holder looks alive (a pid recycled
 * after a reboot is indistinguishable from a wedged holder) is taken over
 * after 12h by file age.
 */

const STALE_MS = 12 * 60 * 60 * 1000;

export type LockHolder = { pid: number; startedAt: string };

export type RepoLock = { released: () => Promise<void> };

/** ESRCH = the pid is gone; success or EPERM (exists, other uid) = alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The lock's parsed holder — null when absent, unparseable, or pid-less. */
export async function readLockHolder(cfg: Config, repoId: string): Promise<LockHolder | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.lock(cfg, repoId), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const { pid, startedAt } = parsed as { pid?: unknown; startedAt?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: typeof startedAt === "string" ? startedAt : "" };
  } catch {
    return null;
  }
}

export async function acquireRepoLock(cfg: Config, repoId: string): Promise<RepoLock | null> {
  const file = paths.lock(cfg, repoId);
  await mkdir(dirname(file), { recursive: true });
  let takeover = false;
  try {
    const info = await stat(file);
    const holder = await readLockHolder(cfg, repoId);
    const dead = holder !== null && !isPidAlive(holder.pid);
    if (!dead && Date.now() - info.mtimeMs < STALE_MS) return null; // in progress elsewhere
    takeover = true;
  } catch {
    // no lock file — proceed
  }
  if (takeover) await rm(file, { force: true });
  try {
    await writeFile(
      file,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      {
        flag: "wx",
      },
    );
  } catch {
    return null; // lost the race
  }
  return {
    released: async () => {
      await rm(file, { force: true });
    },
  };
}
