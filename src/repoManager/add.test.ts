import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validateSource } from "./add.ts";
import { createGitRepo } from "../../test/helpers/gitFixture.ts";
import { pathWith, writeShim } from "../../test/helpers/shim.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";

let tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

async function tmp(): Promise<string> {
  const d = await makeTmp();
  tmpDirs.push(d);
  return d;
}

/**
 * git shim: intercept `ls-remote` (retrievable by default, 128 for hosts
 * containing "bad-host"), pass everything else through to the real git.
 */
async function gitLsRemoteShim(): Promise<string> {
  const realGit = Bun.which("git") ?? "/usr/bin/git";
  return writeShim(
    "git",
    [
      'if [ "$1" = "ls-remote" ]; then',
      '  case "$2" in *bad-host*) echo "fatal: unable to connect" >&2; exit 128;; esac',
      "  exit 0",
      "fi",
      `exec '${realGit}' "$@"`,
    ].join("\n"),
  );
}

async function withShimmedGit<T>(fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = pathWith(await gitLsRemoteShim());
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

describe("Pre-flight source validation", () => {
  test("Unreachable remote rejected", async () => {
    await withShimmedGit(async () => {
      const check = await validateSource("https://bad-host.corp/team/repo.git");
      expect(check.ok).toBe(false);
      expect(check.error).toContain("not retrievable");
    });
  });

  test("Reachable remote accepted", async () => {
    await withShimmedGit(async () => {
      const check = await validateSource("git@gitlab.corp:team/repo.git");
      expect(check.ok).toBe(true);
    });
  });

  test("Valid local git path accepted", async () => {
    const dir = await tmp();
    const repo = await createGitRepo(join(dir, "local-src"), { "a.ts": "a\n" });
    const check = await validateSource(repo);
    expect(check.ok).toBe(true);
  });

  test("Non-git local path rejected", async () => {
    const dir = await tmp();
    const plain = join(dir, "plain");
    await mkdir(plain, { recursive: true });
    const check = await validateSource(plain);
    expect(check.ok).toBe(false);
    expect(check.error).toContain("not a git repository");
  });

  test("Missing local path rejected", async () => {
    const dir = await tmp();
    const check = await validateSource(join(dir, "nope"));
    expect(check.ok).toBe(false);
    expect(check.error).toContain("does not exist");
  });

  test("Empty source rejected", async () => {
    const check = await validateSource("   ");
    expect(check.ok).toBe(false);
  });
});
