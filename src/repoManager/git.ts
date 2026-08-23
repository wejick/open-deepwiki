import { simpleGit } from "simple-git";
import { mkdir } from "node:fs/promises";

/**
 * Pure-git operations: clone, fetch/pull, head sha. No hosting-provider APIs
 * — remote access rides the server's own git credentials (SSH key / credential
 * helper configured on the box).
 */

export async function gitClone(source: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await simpleGit().clone(source, targetDir);
}

export async function gitPull(checkoutDir: string): Promise<void> {
  const g = simpleGit({ baseDir: checkoutDir });
  await g.fetch();
  await g.pull();
}

export async function gitHeadSha(checkoutDir: string): Promise<string> {
  const g = simpleGit({ baseDir: checkoutDir });
  return (await g.revparse(["HEAD"])).trim();
}

/** Move a checkout to an exact commit, discarding tracked-file drift. Used to
 *  realign a preserved build's clone to its pin before resuming. */
export async function gitResetHard(checkoutDir: string, sha: string): Promise<void> {
  const g = simpleGit({ baseDir: checkoutDir });
  await g.reset(["--hard", sha]);
}
