import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { acceptBundle, conceptPages, initCoverage, scoreLinks } from "./acceptance.ts";
import { runIsolatedProducer } from "./run.ts";
import { typeVocabulary } from "./anchor.ts";
import { bundleDir } from "./verify.ts";
import {
  claudeFailsThenRepairs,
  claudeHang,
  claudeHappy,
  claudeReassignsType,
  claudeRewritesEverything,
  claudeAlwaysUnacceptable,
  openwikiHappy,
  pathWith,
} from "../../test/helpers/shim.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

/**
 * Acceptance — the same gate for every producer (3.1-3.5).
 *
 * The floors default to 0 (measure, do not gate) because 1.5 is what calibrates
 * them; every test here sets them explicitly, which is also the only honest way
 * to test a gate.
 */

const GROUNDING = fileURLToPath(new URL("../../test/fixtures/grounding", import.meta.url));

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

/** A checkout whose sources and bundle come from the grounding fixtures. */
async function groundedCheckout(bundle: string): Promise<{ dir: string; checkout: string }> {
  const { dir, checkout } = await work();
  await cp(join(GROUNDING, "checkout"), checkout, { recursive: true });
  await cp(join(GROUNDING, bundle), bundleDir(checkout), { recursive: true });
  return { dir, checkout };
}

describe("Bundle grounding verification (3.1)", () => {
  test("Grounded bundle accepted and scored", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const cfg = testConfig(dir, { ODW_GROUNDING_MIN: "1", ODW_GROUNDING_MIN_DENSITY: "1" });

    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "update" });

    expect(res.ok).toBe(true);
    expect(res.grounding.score).toBe(1);
    expect(res.errors).toEqual([]);
  });

  test("Fabricated citation fails the run", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-fabricated");
    const cfg = testConfig(dir, { ODW_GROUNDING_MIN: "0.9" });

    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "update" });

    expect(res.ok).toBe(false);
    expect(res.failure).toBe("grounding");
    expect(res.errors.join(" ")).toContain("grounding score");
    // The offending paths are named, so a repair retry can act on it.
    expect(res.errors.join(" ")).toContain("does-not-exist");
  });

  test("Bundle that cites nothing is rejected for density, not accepted vacuously", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-nocites");
    // Score floor is satisfiable only vacuously here; density is what catches it.
    const cfg = testConfig(dir, { ODW_GROUNDING_MIN: "0", ODW_GROUNDING_MIN_DENSITY: "1" });

    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "update" });

    expect(res.ok).toBe(false);
    expect(res.failure).toBe("grounding");
    expect(res.errors.join(" ")).toContain("density");
    expect(res.errors.join(" ")).toContain("cite nothing");
  });

  test("floors default to measuring without gating", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-nocites");
    const cfg = testConfig(dir); // defaults

    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "update" });

    expect(res.ok).toBe(true);
    // Still measured, so a regression is observable before it is enforced.
    expect(res.grounding.cited).toBe(0);
    expect(res.grounding.uncitedPages).toBe(1);
  });
});

describe("Initial bundles must cover the repository (3.2)", () => {
  test("Truncated initial bundle rejected", async () => {
    const { dir, checkout } = await work();
    // Sources in three directories; the bundle only cites one.
    for (const rel of ["a/one.ts", "b/two.ts", "c/three.ts"]) {
      await mkdir(join(checkout, rel, ".."), { recursive: true });
      await Bun.write(join(checkout, rel), "export const x = 1;\n");
    }
    await mkdir(bundleDir(checkout), { recursive: true });
    await Bun.write(
      join(bundleDir(checkout), "index.md"),
      '---\nokf_version: "0.2"\n---\n\n# Files\n',
    );
    await Bun.write(
      join(bundleDir(checkout), "a.md"),
      "---\ntype: module\nsources:\n  - id: a\n    resource: repo://a/one.ts\n---\n\nOnly directory a is documented.\n",
    );
    const cfg = testConfig(dir, { ODW_INIT_COVERAGE_MIN: "0.9" });

    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "init" });

    expect(res.ok).toBe(false);
    expect(res.failure).toBe("coverage");
    expect(res.coverage).toBeLessThan(0.9);
  });

  test("Coverage is not required of updates", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const cfg = testConfig(dir, { ODW_INIT_COVERAGE_MIN: "0.99" });

    // The same bundle judged as an update is not subject to the floor.
    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "update" });
    expect(res.ok).toBe(true);
    expect(res.coverage).toBeNull();
  });

  test("initCoverage counts directories a bundle actually cites", async () => {
    const { checkout } = await groundedCheckout("bundle-grounded");
    // The fixture cites src/auth.ts, src/cache.ts and README.md -> dirs "src" and ".".
    const cov = await initCoverage(bundleDir(checkout), [
      "src/auth.ts",
      "src/cache.ts",
      "README.md",
    ]);
    expect(cov).toBe(1);

    const partial = await initCoverage(bundleDir(checkout), [
      "src/auth.ts",
      "lib/other.ts",
      "docs/x.ts",
    ]);
    expect(partial).toBeCloseTo(1 / 3, 5);
  });
});

describe("Scoped updates preserve existing conventions (3.3)", () => {
  test("Unrelated pages untouched — an over-broad rewrite is rejected", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const before = await conceptPages(bundleDir(checkout));
    const shim = await claudeRewritesEverything();

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "update",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
      { changedPaths: ["src/auth.ts"] },
    );

    expect(res.ok).toBe(false);
    expect(res.acceptance?.failure).toBe("scope");
    // cache.md cites only src/cache.ts, so rewriting it is out of scope.
    expect(res.acceptance?.errors.join(" ")).toContain("cache.md");
    expect(before.size).toBeGreaterThan(0);
  });

  test("Existing page's type is not reassigned", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const typesBefore = await typeVocabulary(bundleDir(checkout));
    const shim = await claudeReassignsType("auth.md", "totally-new-type");

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "update",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
      { changedPaths: ["src/auth.ts"], typeVocabulary: typesBefore },
    );

    expect(res.ok).toBe(false);
    expect(res.acceptance?.failure).toBe("scope");
    expect(res.acceptance?.errors.join(" ")).toContain("totally-new-type");
  });

  test("a page deleted with the source it documented is in scope", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const before = await conceptPages(bundleDir(checkout));
    expect(before.has("auth.md")).toBe(true);

    // Upstream deleted src/auth.ts, so the producer deleted its page. A deleted
    // page has no post-run citations at all, so judging scope on those alone
    // made every legitimate deletion a violation — and the repair retry then
    // restored the page, leaving the bundle documenting deleted code forever.
    await rm(join(bundleDir(checkout), "auth.md"));
    await rm(join(checkout, "src", "auth.ts"));

    const res = await acceptBundle(testConfig(dir), bundleDir(checkout), checkout, {
      mode: "update",
      changedPaths: ["src/auth.ts"],
      pagesBefore: before,
    });

    expect(res.failure).toBeNull();
    expect(res.ok).toBe(true);
  });

  test("a page deleted for no reason is still out of scope", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const before = await conceptPages(bundleDir(checkout));

    // cache.md cites only src/cache.ts, which did not change.
    await rm(join(bundleDir(checkout), "cache.md"));

    const res = await acceptBundle(testConfig(dir), bundleDir(checkout), checkout, {
      mode: "update",
      changedPaths: ["src/auth.ts"],
      pagesBefore: before,
    });

    expect(res.ok).toBe(false);
    expect(res.failure).toBe("scope");
    expect(res.errors.join(" ")).toContain("cache.md");
  });

  test("churn is measured on every update, and gates once a ceiling is set", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const before = await conceptPages(bundleDir(checkout));
    const authPath = join(bundleDir(checkout), "auth.md");
    // A revision the change set justifies, so only the churn check can object.
    await Bun.write(authPath, `${await readFile(authPath, "utf8")}\nRevised.\n`);
    const input = {
      mode: "update" as const,
      changedPaths: ["src/auth.ts"],
      pagesBefore: before,
    };

    // No ceiling configured: measured and reported, never null. Nothing wired
    // the source count in before, so the ratio could not be computed at all.
    const measured = await acceptBundle(testConfig(dir), bundleDir(checkout), checkout, input);
    expect(measured.ok).toBe(true);
    expect(measured.churnRatio).not.toBeNull();
    expect(measured.churnRatio ?? 0).toBeGreaterThan(0);

    // The same run against a ceiling below the measurement is rejected.
    const gated = await acceptBundle(
      testConfig(dir, { ODW_UPDATE_MAX_CHURN_RATIO: String((measured.churnRatio ?? 1) / 2) }),
      bundleDir(checkout),
      checkout,
      input,
    );
    expect(gated.ok).toBe(false);
    expect(gated.failure).toBe("scope");
    expect(gated.errors.join(" ")).toContain("disproportionate");
  });

  test("index and log files are exempt from byte-identity", async () => {
    const { checkout } = await groundedCheckout("bundle-grounded");
    const pages = await conceptPages(bundleDir(checkout));
    // Structural files never appear in the byte-identity set.
    for (const key of pages.keys()) {
      expect(key.endsWith("index.md")).toBe(false);
      expect(key.endsWith("log.md")).toBe(false);
    }
  });
});

describe("Repair retry before failure (3.4)", () => {
  test("Repair fixes a malformed page", async () => {
    const { dir, checkout } = await work();
    const counter = join(dir, "count");
    const shim = await claudeFailsThenRepairs(bundleFixture("valid"), counter);

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "init",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
    );

    expect(res.repaired).toBe(true);
    expect(res.ok).toBe(true);
    // One repair, and only one.
    expect((await readFile(counter, "utf8")).trim()).toBe("1");
  });

  test("Repair exhausted — reported failed, no third attempt", async () => {
    const { dir, checkout } = await work();
    const shim = await claudeAlwaysUnacceptable();

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "init",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
    );

    expect(res.repaired).toBe(true);
    expect(res.ok).toBe(false);
  });

  test("No repair after a timeout", async () => {
    const { dir, checkout } = await work();
    const shim = await claudeHang();

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "init",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) }, timeoutMs: 300 },
    );

    expect(res.run.timedOut).toBe(true);
    // Nothing about a timeout is fixable by re-prompting.
    expect(res.repaired).toBe(false);
  });

  test("an over-broad rewrite is retried from the pre-run bundle, not its own output", async () => {
    const { dir, checkout } = await groundedCheckout("bundle-grounded");
    const before = await conceptPages(bundleDir(checkout));
    const shim = await claudeRewritesEverything();

    const res = await runIsolatedProducer(
      testConfig(dir),
      "claude",
      "update",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim) } },
      { changedPaths: ["src/auth.ts"] },
    );

    expect(res.repaired).toBe(true);
    expect(res.ok).toBe(false);
    // The retry started from a clean base: the shim appends once per run, so a
    // retry from its own output would show the marker twice.
    const authAfter = (await conceptPages(bundleDir(checkout))).get("auth.md") ?? "";
    const occurrences = authAfter.split("rewritten").length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
    expect(before.size).toBeGreaterThan(0);
  });
});

describe("Failure isolation covers every acceptance failure (3.5)", () => {
  test("a grounding failure restores the last verified bundle", async () => {
    const { dir, checkout } = await work();
    const snapshot = join(dir, "snapshot");
    const cfg = testConfig(dir, { ODW_GROUNDING_MIN: "0", ODW_GROUNDING_MIN_DENSITY: "0" });

    // First run succeeds and becomes the snapshot.
    const good = await claudeHappy(bundleFixture("valid"));
    const first = await runIsolatedProducer(cfg, "claude", "init", checkout, snapshot, {
      env: { PATH: pathWith(good) },
    });
    expect(first.ok).toBe(true);
    const kept = await conceptPages(bundleDir(checkout));

    // Second run is rejected for density; the published bundle must survive.
    const strict = testConfig(dir, { ODW_GROUNDING_MIN_DENSITY: "999" });
    const second = await runIsolatedProducer(strict, "claude", "init", checkout, snapshot, {
      env: { PATH: pathWith(good) },
    });

    expect(second.ok).toBe(false);
    expect(second.acceptance?.failure).toBe("grounding");
    expect(second.restored).toBe(true);
    expect(await conceptPages(bundleDir(checkout))).toEqual(kept);
  });

  test("a rate-limited run is not a failure and preserves the bundle", async () => {
    const { dir, checkout } = await work();
    const snapshot = join(dir, "snapshot");
    const cfg = testConfig(dir);

    const good = await claudeHappy(bundleFixture("valid"));
    expect(
      (
        await runIsolatedProducer(cfg, "claude", "init", checkout, snapshot, {
          env: { PATH: pathWith(good) },
        })
      ).ok,
    ).toBe(true);
    const kept = await conceptPages(bundleDir(checkout));

    const limited = await (await import("../../test/helpers/shim.ts")).claudeRateLimited();
    const res = await runIsolatedProducer(cfg, "claude", "update", checkout, snapshot, {
      env: { PATH: pathWith(limited) },
    });

    expect(res.run.outcome).toBe("rate_limited");
    expect(res.ok).toBe(false); // not accepted...
    expect(res.repaired).toBe(false); // ...but not retried either
    expect(await conceptPages(bundleDir(checkout))).toEqual(kept);
  });
});

const page = (type: string, body: string): string =>
  `---\ntype: ${type}\ntitle: ${type}\n---\n\n${body}\n`;

describe("Bundle link resolution scoring", () => {
  test("a page with only resolving links scores 1", async () => {
    const { checkout } = await work();
    const dir = bundleDir(checkout);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "a.md"), page("a", "See [B](./b.md)."));
    await Bun.write(join(dir, "b.md"), page("b", "See [A](/a.md)."));

    expect(await scoreLinks(dir)).toEqual({ resolved: 2, total: 2, ratio: 1 });
  });

  test("an unresolved link is reflected in the ratio", async () => {
    const { checkout } = await work();
    const dir = bundleDir(checkout);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "a.md"), page("a", "See [Nowhere](/missing.md)."));

    expect(await scoreLinks(dir)).toEqual({ resolved: 0, total: 1, ratio: 0 });
  });

  test("non-.md and external link targets are excluded from total", async () => {
    const { checkout } = await work();
    const dir = bundleDir(checkout);
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, "a.md"),
      page("a", "See [ext](https://example.com) and [src](repo://src/x.ts)."),
    );

    expect(await scoreLinks(dir)).toEqual({ resolved: 0, total: 0, ratio: 1 });
  });

  test("a bundle with no cross-links scores 1 — vacuously perfect, not broken", async () => {
    const { checkout } = await work();
    const dir = bundleDir(checkout);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "a.md"), page("a", "No links here."));

    expect(await scoreLinks(dir)).toEqual({ resolved: 0, total: 0, ratio: 1 });
  });

  test("test/fixtures/bundles/valid's deliberately unresolved link is measured, not an error", async () => {
    const score = await scoreLinks(bundleFixture("valid"));
    expect(score.total).toBeGreaterThan(score.resolved);
    expect(score.ratio).toBeLessThan(1);
  });

  test("scoring is producer-independent: identical content scores identically via either producer", async () => {
    const claudeRun = await work();
    const openwikiRun = await work();
    const cfg = testConfig(claudeRun.dir);

    const c = await claudeHappy(bundleFixture("valid"));
    await runIsolatedProducer(
      cfg,
      "claude",
      "init",
      claudeRun.checkout,
      join(claudeRun.dir, "snap"),
      {
        env: { PATH: pathWith(c) },
      },
    );
    const o = await openwikiHappy(bundleFixture("valid"));
    await runIsolatedProducer(
      cfg,
      "openwiki",
      "init",
      openwikiRun.checkout,
      join(openwikiRun.dir, "snap"),
      { env: { PATH: pathWith(o) } },
    );

    expect(await scoreLinks(bundleDir(claudeRun.checkout))).toEqual(
      await scoreLinks(bundleDir(openwikiRun.checkout)),
    );
  });
});

describe("Bundle link resolution scoring gates acceptance", () => {
  test("default floor accepts a bundle with an unresolved link", async () => {
    const { dir, checkout } = await work();
    await cp(bundleFixture("valid"), bundleDir(checkout), { recursive: true });
    const cfg = testConfig(dir); // ODW_LINK_MIN defaults to 0

    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "init" });

    expect(res.ok).toBe(true);
    expect(res.linkScore.ratio).toBeLessThan(1);
  });

  test("a configured floor rejects a below-floor bundle", async () => {
    const { dir, checkout } = await work();
    await cp(bundleFixture("valid"), bundleDir(checkout), { recursive: true });
    const cfg = testConfig(dir, { ODW_LINK_MIN: "0.99" });

    const res = await acceptBundle(cfg, bundleDir(checkout), checkout, { mode: "init" });

    expect(res.ok).toBe(false);
    expect(res.failure).toBe("link");
  });
});
