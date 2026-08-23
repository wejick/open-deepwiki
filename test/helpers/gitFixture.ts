import { simpleGit } from "simple-git";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Identity via env, not `addConfig`: each git exec is a process spawn, and
 * with ~100 fixture repos per suite run the two config calls per repo are
 * measurable wall time. Git accepts author/committer from the environment. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

/**
 * Create a real git repo (offline) with the given file contents and an
 * initial commit. Returns the repo directory path.
 */
export async function createGitRepo(
  dir: string,
  files: Record<string, string>,
  opts: { message?: string; bare?: boolean } = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const g = simpleGit({ baseDir: dir }).env(GIT_IDENTITY);
  await g.init(opts.bare ?? false);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  await g.add(".");
  await g.commit(opts.message ?? "initial");
  return dir;
}

/** Append files + a new commit on top of an existing fixture repo. */
export async function commitFiles(
  dir: string,
  files: Record<string, string>,
  message = "update",
): Promise<void> {
  const g = simpleGit({ baseDir: dir }).env(GIT_IDENTITY);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  await g.add(".");
  await g.commit(message);
}
