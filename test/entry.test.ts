import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb, listChunks } from "../src/index/db.ts";
import { indexRepo } from "../src/index/update.ts";
import { stubFakeVecEmbeddings } from "./helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "./helpers/tmp.ts";
import { testConfig } from "./helpers/config.ts";
import { paths } from "../src/config/config.ts";
import { mkdir, cp } from "node:fs/promises";

/**
 * Entry-file e2e: `bun odw ...` in a real subprocess — proves the shim
 * (shebang, import of main.ts, argv slicing) and config loading from the
 * process environment, which in-process tests cannot see. Still offline:
 * fixtures on disk, fakeVec embeddings, no network.
 */

describe("bun odw entry (subprocess)", () => {
  test("loads config from the environment and runs the command", async () => {
    const dir = await makeTmp();
    try {
      const cfg = testConfig(dir, { ODW_EMBEDDING_DIM: "1024" });
      const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
      const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
      try {
        // A registered+indexed fixture repo under the env-provided dataDir.
        const repoId = "local/entry-repo";
        const checkout = paths.checkout(cfg, repoId);
        await mkdir(checkout, { recursive: true });
        await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
        await indexRepo(db, cfg, repoId, checkout);
        const { saveRegistry } = await import("../src/repoManager/registry.ts");
        await saveRegistry(cfg, {
          repos: [
            {
              repoId,
              source: checkout,
              clonePath: checkout,
              addedAt: new Date().toISOString(),
              schedule: null,
              options: {},
              instructions: undefined,
              producer: undefined,
              lastRun: {
                startedAt: null,
                finishedAt: null,
                outcome: null,
                durationMs: null,
                tokens: null,
                error: null,
              },
              lastIndexedSha: null,
              lastSuccessAt: null,
            },
          ],
        });

        const proc = Bun.spawn(["bun", "odw", "repo", "list"], {
          cwd: import.meta.dir + "/..",
          env: {
            ...(process.env as Record<string, string>),
            ODW_DATA_DIR: dir,
            ODW_EMBEDDING_DIM: "1024",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("local/entry-repo");
        expect(stdout).toContain("wiki 5");
        expect(stderr).not.toContain("Error");
        // The command read the env-provided dataDir, not the default ./data.
        expect(stdout).not.toContain("no repos registered");
      } finally {
        stub.restore();
        db.close();
      }
      // Prove the subprocess saw the same data the in-process setup wrote.
      const db2 = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim, readOnly: true });
      const chunks = await listChunks(db2, "local/entry-repo", "wiki");
      db2.close();
      expect(chunks.length).toBeGreaterThan(0);
    } finally {
      await rmTmp(dir);
    }
  });
});
