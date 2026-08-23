import { describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "../config/config.ts";
import { acquireRepoLock, isPidAlive, readLockHolder } from "./lock.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";

const STALE_MS = 12 * 60 * 60 * 1000;

function lockBody(pid: number): string {
  return `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`;
}

async function plantLock(cfg: ReturnType<typeof testConfig>, body: string, ageMs = 0) {
  const file = paths.lock(cfg, "gitlab.corp/team/repo");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    await utimes(file, old, old);
  }
}

async function spawnLivePid(): Promise<number> {
  const proc = Bun.spawn(["sleep", "30"]);
  return proc.pid;
}

async function spawnDeadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

describe("Update concurrency safety", () => {
  test("Overlapping run skipped", async () => {
    const tmp = await makeTmp();
    try {
      const cfg = testConfig(tmp);
      const live = await spawnLivePid();
      await plantLock(cfg, lockBody(live));
      expect(await acquireRepoLock(cfg, "gitlab.corp/team/repo")).toBeNull();
    } finally {
      await rmTmp(tmp);
    }
  });

  test("Dead holder taken over immediately", async () => {
    const tmp = await makeTmp();
    try {
      const cfg = testConfig(tmp);
      const dead = await spawnDeadPid();
      expect(isPidAlive(dead)).toBe(false);
      await plantLock(cfg, lockBody(dead)); // fresh mtime — age rule alone would skip
      const lock = await acquireRepoLock(cfg, "gitlab.corp/team/repo");
      expect(lock).not.toBeNull();
      expect(await readLockHolder(cfg, "gitlab.corp/team/repo")).toEqual({
        pid: process.pid,
        startedAt: expect.any(String),
      });
      await lock!.released();
    } finally {
      await rmTmp(tmp);
    }
  });

  test("Live or unparseable lock blocks until the staleness window passes", async () => {
    const tmp = await makeTmp();
    try {
      const cfg = testConfig(tmp);
      const live = await spawnLivePid();
      await plantLock(cfg, lockBody(live));
      expect(await acquireRepoLock(cfg, "gitlab.corp/team/repo")).toBeNull();
      await plantLock(cfg, "not json at all\n");
      expect(await readLockHolder(cfg, "gitlab.corp/team/repo")).toBeNull();
      expect(await acquireRepoLock(cfg, "gitlab.corp/team/repo")).toBeNull();
    } finally {
      await rmTmp(tmp);
    }
  });

  test("A stale lock is genuinely taken over", async () => {
    const tmp = await makeTmp();
    try {
      const cfg = testConfig(tmp);
      const live = await spawnLivePid();
      await plantLock(cfg, lockBody(live), STALE_MS + 60_000);
      expect(await acquireRepoLock(cfg, "gitlab.corp/team/repo")).not.toBeNull();
      await plantLock(cfg, "not json at all\n", STALE_MS + 60_000);
      expect(await acquireRepoLock(cfg, "gitlab.corp/team/repo")).not.toBeNull();
    } finally {
      await rmTmp(tmp);
    }
  });

  test("readLockHolder parses the written body", async () => {
    const tmp = await makeTmp();
    try {
      const cfg = testConfig(tmp);
      const lock = await acquireRepoLock(cfg, "gitlab.corp/team/repo");
      expect(lock).not.toBeNull();
      expect(await readLockHolder(cfg, "gitlab.corp/team/repo")).toEqual({
        pid: process.pid,
        startedAt: expect.any(String),
      });
      await lock!.released();
      expect(await readLockHolder(cfg, "gitlab.corp/team/repo")).toBeNull();
    } finally {
      await rmTmp(tmp);
    }
  });
});
