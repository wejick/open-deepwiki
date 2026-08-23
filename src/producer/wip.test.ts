import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { clearWip, planResume, readWipMeta, saveWip, stageWip, wipDir } from "./wip.ts";
import { runIsolatedProducer } from "./run.ts";
import { bundleDir } from "./verify.ts";
import { conceptPages } from "./acceptance.ts";
import {
  CLAUDE_PROBES,
  WRITE_PAGE,
  claudeHappy,
  claudeRateLimited,
  claudeSessions,
  claudeStallsOnOnePage,
  claudeSuccessButEmpty,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { removeRepoDir } from "../repoManager/pipeline.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

/** Resumable production: published bundle and work-in-progress live at
 *  different paths, so partial-preservation and full-restore don't conflict. */

/** The anchor the bundle was generated from, and the commit being built. The
 *  WIP pins the TARGET: pinning the anchor resumes against an empty diff. */
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let tmpDirs: string[] = [];
async function work(): Promise<{ dir: string; checkout: string }> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const checkout = join(dir, "checkout");
  await mkdir(checkout, { recursive: true });
  return { dir, checkout };
}
afterEach(async () => {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("Work-in-progress area (4.1)", () => {
  test("saves a partial bundle, records target and producer, counts attempts", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");

    const first = await saveWip(cfg, "repoA", bundleDir(checkout), {
      targetSha: SHA_A,
      producer: "claude",
    });
    expect(first.attempts).toBe(1);
    expect(first.targetSha).toBe(SHA_A);
    expect(first.producer).toBe("claude");
    expect(await exists(join(wipDir(cfg, "repoA"), "index.md"))).toBe(true);

    // A second save bumps the count rather than resetting it.
    const second = await saveWip(cfg, "repoA", bundleDir(checkout), {
      targetSha: SHA_A,
      producer: "claude",
    });
    expect(second.attempts).toBe(2);
  });

  test("forward progress resets the attempt counter; only stalled runs advance it", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");
    const save = (progressed: boolean) =>
      saveWip(cfg, "repoA", bundleDir(checkout), {
        targetSha: SHA_A,
        producer: "claude",
        ...(progressed ? { progressed: true } : {}),
      });

    // Two stalled runs count up…
    expect((await save(false)).attempts).toBe(1);
    expect((await save(false)).attempts).toBe(2);
    // …a run that completed units resets…
    expect((await save(true)).attempts).toBe(1);
    // …and only stalled runs advance from there.
    expect((await save(false)).attempts).toBe(2);
  });

  test("resume is detected, and a producer change discards the work", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");
    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_A, producer: "claude" });

    expect((await planResume(cfg, "repoA", "claude")).kind).toBe("resume");
    // Half a bundle in another producer's conventions is worse than starting clean.
    const other = await planResume(cfg, "repoA", "openwiki");
    expect(other.kind).toBe("discard");

    await clearWip(cfg, "repoA");
    expect((await planResume(cfg, "repoA", "claude")).kind).toBe("none");
  });

  test("attempts beyond the cap are reported exhausted, not resumed", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir, { ODW_MAX_RESUME_ATTEMPTS: "2" });
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");

    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_A, producer: "claude" });
    expect((await planResume(cfg, "repoA", "claude")).kind).toBe("resume");
    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_A, producer: "claude" });
    expect((await planResume(cfg, "repoA", "claude")).kind).toBe("exhausted");
  });

  test("a corrupt or absent meta file is simply no resumable work", async () => {
    const { dir } = await work();
    const cfg = testConfig(dir);
    expect(await readWipMeta(cfg, "nope")).toBeNull();
    await mkdir(wipDir(cfg, "repoB"), { recursive: true });
    await Bun.write(join(wipDir(cfg, "repoB"), ".odw-wip.json"), "{ not json");
    expect(await readWipMeta(cfg, "repoB")).toBeNull();
    expect((await planResume(cfg, "repoB", "claude")).kind).toBe("none");
  });

  test("staging never leaks the meta file into the bundle", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");
    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_A, producer: "claude" });

    await stageWip(cfg, "repoA", bundleDir(checkout));
    expect(await exists(join(bundleDir(checkout), "index.md"))).toBe(true);
    expect(await exists(join(bundleDir(checkout), ".odw-wip.json"))).toBe(false);
  });

  test("staging preserves a producer's in-bundle state file", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");
    // The claude producer's plan file doubles as its checkpoint; staging must
    // carry it through for a resumed run to find it.
    await Bun.write(join(bundleDir(checkout), ".odw-plan.json"), '{"pages":[]}\n');
    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_A, producer: "claude" });

    await stageWip(cfg, "repoA", bundleDir(checkout));

    expect(await exists(join(bundleDir(checkout), ".odw-plan.json"))).toBe(true);
    expect(await exists(join(bundleDir(checkout), ".odw-wip.json"))).toBe(false);
  });
});

describe("Exhausted budget preserves partial work (4.3)", () => {
  test("a rate-limited run keeps the partial bundle and leaves published intact", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    const snapshot = join(dir, "snapshot");

    // Establish a published bundle.
    const good = await claudeHappy(bundleFixture("valid"));
    const first = await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      checkout,
      snapshot,
      { env: { PATH: pathWith(good) } },
      {},
      "repoA",
    );
    expect(first.ok).toBe(true);
    const published = await conceptPages(bundleDir(checkout));

    // A rate-limited update that wrote a partial page before giving up.
    const limited = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'printf -- "---\\ntype: concept\\n---\\n\\npartial work\\n" > ./openwiki/partial.md',
        `cat <<'JSON'\n${JSON.stringify({
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 429,
          result: "Usage limit reached.",
        })}\nJSON`,
        "exit 1",
      ].join("\n"),
    );

    const second = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(limited) } },
      { fromSha: SHA_A, targetSha: SHA_B },
      "repoA",
    );

    expect(second.run.outcome).toBe("rate_limited");
    // The partial work survives, pinned to the commit it was BUILDING (SHA_B),
    // not the anchor it was building away from (SHA_A).
    expect(second.wip.preserved?.attempts).toBe(1);
    expect(second.wip.preserved?.targetSha).toBe(SHA_B);
    expect(await exists(join(wipDir(cfg, "repoA"), "partial.md"))).toBe(true);
    // ...and the published bundle is exactly what it was.
    expect(await conceptPages(bundleDir(checkout))).toEqual(published);
  });

  test("the next run resumes from the partial bundle", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    const snapshot = join(dir, "snapshot");
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), '---\nokf_version: "0.2"\n---\n\n# x\n');
    await Bun.write(
      join(bundleDir(checkout), "done.md"),
      "---\ntype: concept\n---\n\nalready done\n",
    );
    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_B, producer: "claude" });

    // An update needing no page work is still a legitimate plan.
    const listing = join(dir, "seen.txt");
    const ok = JSON.stringify({ is_error: false, terminal_reason: "completed", result: "ok" });
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        'PROMPT="$2"',
        `PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
        `PAGE_PATH=$(printf '%s\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
        'if [ -n "$PLAN_FILE" ]; then',
        `  ls ./openwiki > '${listing}'`,
        `  printf '{"pages":[],"deletePages":[]}' > "$PLAN_FILE"`,
        'elif [ -n "$PAGE_PATH" ]; then',
        '  printf -- "---\ntype: overview\ntitle: Overview\n---\n\nEntry point.\n" > "./openwiki/$PAGE_PATH"',
        "fi",
        `cat <<'JSON'\n${ok}\nJSON`,
        "exit 0",
      ].join("\n"),
    );

    const res = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(shim) } },
      { fromSha: SHA_A, targetSha: SHA_B },
      "repoA",
    );

    expect(res.wip.resumed).toBe(true);
    // The planning session ran with an accurate view of the staged bundle.
    expect(await readFile(listing, "utf8")).toContain("done.md");
    expect(res.ok).toBe(true);
  });

  test("Promotion is all-or-nothing: acceptance clears the WIP", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");
    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_A, producer: "claude" });

    const good = await claudeHappy(bundleFixture("valid"));
    const res = await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(good) } },
      {},
      "repoA",
    );

    expect(res.ok).toBe(true);
    // No WIP survives an accepted run — the published bundle is complete.
    expect(await readWipMeta(cfg, "repoA")).toBeNull();
  });
});

describe("An interrupted first build is not thrown away (4.1)", () => {
  test("a rate-limited init keeps its partial bundle, pinned to the target commit", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    const shim = await writeShim(
      "claude",
      [
        ...CLAUDE_PROBES,
        "mkdir -p ./openwiki",
        "printf '---\ntype: concept\n---\n\npartial\n' > ./openwiki/partial.md",
        `cat <<'JSON'\n${JSON.stringify({
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 429,
          result: "Usage limit reached.",
        })}\nJSON`,
        "exit 1",
      ].join("\n"),
    );

    const res = await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
      // An init run has no anchor at all — no previous bundle to key off.
      { targetSha: SHA_B },
      "repoA",
    );

    expect(res.run.outcome).toBe("rate_limited");
    expect(res.wip.preserved?.targetSha).toBe(SHA_B);
    expect(res.wip.preserved?.attempts).toBe(1);
    expect(await exists(join(wipDir(cfg, "repoA"), "partial.md"))).toBe(true);
    // Nothing was ever published, so nothing partial is served.
    expect(await exists(bundleDir(checkout))).toBe(false);
  });

  test("removing a repo clears its work in progress", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(join(bundleDir(checkout), "index.md"), "# partial\n");
    await saveWip(cfg, "repoA", bundleDir(checkout), { targetSha: SHA_B, producer: "claude" });
    expect(await readWipMeta(cfg, "repoA")).not.toBeNull();

    await removeRepoDir(cfg, "repoA");

    // `repo add` on the same source hands the id straight back, so a survivor
    // would be staged over the new repo's fresh bundle.
    expect(await readWipMeta(cfg, "repoA")).toBeNull();
    expect(await exists(wipDir(cfg, "repoA"))).toBe(false);
  });
});

describe("Resume attempts are bounded (4.5)", () => {
  test("retrying stops at the cap and the published bundle stays queryable", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir, { ODW_MAX_RESUME_ATTEMPTS: "2" });
    const snapshot = join(dir, "snapshot");

    // Publish something worth keeping.
    const good = await claudeHappy(bundleFixture("valid"));
    expect(
      (
        await runIsolatedProducer(
          cfg,
          "claude",
          "init",
          checkout,
          snapshot,
          { env: { PATH: pathWith(good) } },
          {},
          "repoA",
        )
      ).ok,
    ).toBe(true);
    const published = await conceptPages(bundleDir(checkout));

    const limited = await claudeRateLimited();
    // Burn through the attempt cap.
    for (let i = 0; i < 2; i++) {
      await runIsolatedProducer(
        cfg,
        "claude",
        "update",
        checkout,
        snapshot,
        { env: { PATH: pathWith(limited) } },
        { fromSha: SHA_A, targetSha: SHA_B },
        "repoA",
      );
    }

    const exhausted = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(limited) } },
      { fromSha: SHA_A, targetSha: SHA_B },
      "repoA",
    );

    expect(exhausted.wip.exhausted).toBe(true);
    expect(exhausted.run.spawnError ?? "").toContain("needs attention");
    // The WIP is discarded so it stops consuming budget...
    expect(await readWipMeta(cfg, "repoA")).toBeNull();
    // ...and the published bundle is untouched throughout.
    expect(await conceptPages(bundleDir(checkout))).toEqual(published);
  });

  test("a run without a repoId simply has no WIP behavior", async () => {
    const { dir, checkout } = await work();
    const shim = await claudeSuccessButEmpty();

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "init",
      checkout,
      join(dir, "s"),
      {
        env: { PATH: pathWith(shim) },
      },
    );

    expect(res.wip).toEqual({ resumed: false, preserved: null, exhausted: false });
  });
});

// Named so alphabetical order matches production order.
const PAGES_THREE = ["p1.md", "p2.md", "p3.md"];

/** How many page sessions have run, so a shim can give each night one page's
 *  worth of budget. Counted in a file: every session is its own process. */
const countSessions = (counterFile: string): string[] => [
  `N=0; [ -f '${counterFile}' ] && N=$(cat '${counterFile}')`,
  `echo $((N + 1)) > '${counterFile}'`,
];

/** One night's budget: produces exactly ONE page, then reports a usage limit.
 *  The counter file gives each night a fresh budget. */
function limitedAfterOnePage(counterFile: string): Promise<string> {
  return claudeSessions({
    plan: PAGES_THREE,
    page: [
      ...countSessions(counterFile),
      'if [ "$N" != "0" ]; then',
      `  cat <<'JSON'\n{"is_error": true, "terminal_reason": "api_error", "api_error_status": 429, "result": "Usage limit reached."}\nJSON`,
      "  exit 1",
      "fi",
      WRITE_PAGE,
    ],
  });
}

/** No budget limit: produces every page it is handed. */
function producesEveryPage(): Promise<string> {
  return claudeSessions({ plan: PAGES_THREE, page: [WRITE_PAGE] });
}

describe("Multi-run production converges (7.3 / D13)", () => {
  test("a build cut short twice completes on the third run, published once, at the end", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    const snapshot = join(dir, "snapshot");
    const bundle = bundleDir(checkout);

    const publishedExists = async (): Promise<boolean> => {
      try {
        await stat(join(bundle, "index.md"));
        return true;
      } catch {
        return false;
      }
    };

    // Night 1: partial, rate limited. Nothing may be published.
    const n1 = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(await limitedAfterOnePage(join(dir, "n1"))) } },
      { fromSha: SHA_A, targetSha: SHA_B },
      "repoA",
    );
    expect(n1.run.outcome).toBe("rate_limited");
    expect(await publishedExists()).toBe(false);
    expect(await exists(join(wipDir(cfg, "repoA"), "p1.md"))).toBe(true);

    // Night 2: resumes, writes another page, limited again.
    const n2 = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(await limitedAfterOnePage(join(dir, "n2"))) } },
      { fromSha: SHA_A, targetSha: SHA_B },
      "repoA",
    );
    expect(n2.wip.resumed).toBe(true);
    expect(n2.run.outcome).toBe("rate_limited");
    expect(await publishedExists()).toBe(false);
    // Both nights' work is accumulating in the WIP, not the published path.
    expect(await exists(join(wipDir(cfg, "repoA"), "p2.md"))).toBe(true);
    // Night 2 completed a unit (p2), so the counter reset rather than
    // advanced — exhaustion is for runs that make no forward progress.
    expect(n2.wip.preserved?.attempts).toBe(1);
    // Still pinned to the same commit across both nights.
    expect(n2.wip.preserved?.targetSha).toBe(SHA_B);

    // Night 3: completes.
    const complete = await producesEveryPage();
    const n3 = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(complete) } },
      { fromSha: SHA_A, targetSha: SHA_B },
      "repoA",
    );

    expect(n3.ok).toBe(true);
    expect(n3.wip.resumed).toBe(true);
    // Published exactly once, at the end...
    expect(await publishedExists()).toBe(true);
    // ...carrying no plan file, and neither does the promoted snapshot.
    expect(await exists(join(bundle, ".odw-plan.json"))).toBe(false);
    expect(await exists(join(snapshot, ".odw-plan.json"))).toBe(false);
    // ...and the WIP is gone, so the next run walks forward from here.
    expect(await readWipMeta(cfg, "repoA")).toBeNull();
  });

  test("a failed run's restore leaves no plan file at the published path", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    const snapshot = join(dir, "snapshot");

    // Publish something first, so there is a snapshot to restore.
    const good = await claudeHappy(bundleFixture("valid"));
    const init = await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      checkout,
      snapshot,
      { env: { PATH: pathWith(good) } },
      {},
      "repoA",
    );
    expect(init.ok).toBe(true);
    const published = await conceptPages(bundleDir(checkout));

    // An update whose plan names a reserved file fails AFTER the planner
    // wrote its plan into the bundle.
    const badPlan = await claudeSessions({ plan: ["index.md"] });
    const res = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(badPlan) } },
      { fromSha: SHA_A, targetSha: SHA_B },
      "repoA",
    );

    expect(res.run.outcome).toBe("failed");
    expect(res.run.partial ?? false).toBe(false);
    expect(res.restored).toBe(true);
    expect(await conceptPages(bundleDir(checkout))).toEqual(published);
    expect(await exists(join(bundleDir(checkout), ".odw-plan.json"))).toBe(false);
  });
});

describe("Resumable production across runs \u203a a run that ends incomplete", () => {
  /** One stall night: p2.md hangs past the step budget, p1/p3 complete. The
   *  shim is stateless, so every night reuses it and stalls on the same page. */
  const runNight = async (
    dir: string,
    checkout: string,
    shim: string,
  ): ReturnType<typeof runIsolatedProducer> =>
    runIsolatedProducer(
      testConfig(dir, { ODW_CLAUDE_STEP_TIMEOUT_SEC: "1", ODW_MAX_RESUME_ATTEMPTS: "2" }),
      "claude",
      "init",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
      { targetSha: SHA_B },
      "repoA",
    );

  test("A run that runs out of time preserves partial work", async () => {
    const { dir, checkout } = await work();
    const shim = await claudeStallsOnOnePage(PAGES_THREE, "p2.md");

    const res = await runNight(dir, checkout, shim);

    // A timeout is a failure, not a rate limit — but it is a resumable one.
    expect(res.run.outcome).toBe("failed");
    expect(res.run.partial).toBe(true);
    expect(res.wip.preserved?.attempts).toBe(1);
    expect(res.wip.preserved?.targetSha).toBe(SHA_B);
    // The page that finished is in the work-in-progress area...
    expect(await exists(join(wipDir(testConfig(dir), "repoA"), "p1.md"))).toBe(true);
    // ...and nothing partial was published.
    expect(await exists(join(bundleDir(checkout), "p1.md"))).toBe(false);
  });

  test("A run that leaves no resumable work preserves nothing", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir);
    const empty = join(dir, "empty-bin");
    await mkdir(empty, { recursive: true });

    const res = await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: empty } },
      { targetSha: SHA_B },
      "repoA",
    );

    expect(res.run.outcome).toBe("failed");
    expect(res.run.partial ?? false).toBe(false);
    expect(res.wip.preserved).toBeNull();
    expect(await readWipMeta(cfg, "repoA")).toBeNull();
  });

  test("A repo too large for one budget window converges or is surfaced", async () => {
    const { dir, checkout } = await work();
    const cfg = testConfig(dir, { ODW_CLAUDE_STEP_TIMEOUT_SEC: "1", ODW_MAX_RESUME_ATTEMPTS: "2" });
    const shim = await claudeStallsOnOnePage(PAGES_THREE, "p2.md");

    // The livelock case: a bare timeout used to keep no work at all.
    for (let night = 1; night <= 2; night++) {
      const res = await runNight(dir, checkout, shim);
      expect(res.run.partial).toBe(true);
      expect(res.wip.preserved?.attempts).toBe(night);
    }

    // The next run reaches the cap and surfaces for a human.
    const exhausted = await runNight(dir, checkout, shim);
    expect(exhausted.wip.exhausted).toBe(true);
    expect(exhausted.run.spawnError ?? "").toContain("needs attention");
    expect(await readWipMeta(cfg, "repoA")).toBeNull();
  });
});
