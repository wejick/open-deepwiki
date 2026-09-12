import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The live session-resume spike — the whole `claude` producer's resume
 * feature stands on these two CLI behaviors, so they are asserted, not
 * assumed. Skipped unless ODW_SPIKE=1, so the default suite stays offline:
 *
 *   ODW_SPIKE=1 bun test test/spike/sessionResume.spike.test.ts
 *
 * Costs real quota; the prompts are deliberately trivial. Measured live
 * against 2.1.251 before the feature was wired: a fabricated `--session-id`
 * is honored at creation (the transcript file exists before any API
 * success), a SIGKILLed session's transcript resumes with its context, and
 * an unknown id refuses with a non-zero exit and no result JSON.
 */

const ENABLED = process.env.ODW_SPIKE === "1";
const TIMEOUT = Number(process.env.ODW_SPIKE_TIMEOUT_MS ?? 5 * 60 * 1000);
const SECRET = "MAGENTA-OTTER-7";

/** The CLI keys transcripts by a slug of the resolved cwd — separators AND
 *  underscores become dashes (a `/var/folders/.../T/foo_bar` tmpdir slugs its
 *  underscore) — so the spike polls the real file to learn when the word is
 *  durably flushed; killing on a clock instead would make the test flaky
 *  where the feature is not. */
async function transcriptPath(cwd: string, id: string): Promise<string> {
  const slug = (await realpath(cwd)).replaceAll(/[/_]/g, "-");
  return join(homedir(), ".claude", "projects", slug, `${id}.jsonl`);
}

describe.skipIf(!ENABLED)("claude session resume (live CLI)", () => {
  test(
    "a fabricated --session-id survives SIGKILL and resumes with its context",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "odw-session-resume-"));
      const id = crypto.randomUUID();
      const first = Bun.spawn(
        [
          "claude",
          "-p",
          `Remember the secret word ${SECRET}. Reply with just: noted. Then count slowly from 1 to 60, one number per line.`,
          "--session-id",
          id,
          "--output-format",
          "json",
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );

      const transcript = await transcriptPath(cwd, id);
      const deadline = Date.now() + 90_000;
      let flushed = false;
      while (Date.now() < deadline) {
        const raw = await readFile(transcript, "utf8").catch(() => "");
        if (raw.includes(SECRET)) {
          flushed = true;
          break;
        }
        await Bun.sleep(500);
      }
      expect(flushed).toBe(true);

      first.kill("SIGKILL");
      await first.exited;

      const resumed = Bun.spawn(
        [
          "claude",
          "-p",
          "--resume",
          id,
          "What was the secret word I asked you to remember? Reply with only the word.",
          "--output-format",
          "json",
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(resumed.stdout).text();
      expect(await resumed.exited).toBe(0);
      expect(out).toContain(SECRET);

      await rm(cwd, { recursive: true, force: true });
    },
    TIMEOUT,
  );

  test(
    "an unknown session id refuses to resume: non-zero exit, no result JSON",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "odw-session-resume-"));
      const proc = Bun.spawn(
        ["claude", "-p", "--resume", crypto.randomUUID(), "hi", "--output-format", "json"],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).not.toBe(0);
      // The refusal is plain text — the shape the producer's unresumable
      // fallback classifies on.
      expect(() => JSON.parse(out)).toThrow();

      await rm(cwd, { recursive: true, force: true });
    },
    TIMEOUT,
  );
});
