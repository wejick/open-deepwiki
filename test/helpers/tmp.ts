import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

export const bundleFixture = (name: string): string => join(FIXTURES, "bundles", name);

export async function makeTmp(prefix = "odw-t-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function rmTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Poll for a file created by a child process (bounded — real condition, no blind sleep). */
export async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(file);
      return;
    } catch {
      // not there yet
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
