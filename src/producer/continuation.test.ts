import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runIsolatedProducer } from "./run.ts";
import { readContinuity, typeVocabulary, writeContinuity } from "./anchor.ts";
import { RESERVED_NAMES, bundleDir, verifyBundle, walkMd } from "./verify.ts";
import { scoreGrounding } from "./grounding.ts";
import {
  claudeScopedUpdate,
  openwikiContinues,
  openwikiHappy,
  pathWith,
} from "../../test/helpers/shim.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

/**
 * openwiki <-> claude interoperability, starting from REAL openwiki 0.3.3
 * output — pages, frontmatter, `/openwiki/…` links and `.last-update.json`
 * copied verbatim from its own self-hosted wiki — so this tests the actual
 * format rather than our model of it.
 *
 * Producers are shims, deliberately: what is under test is our machinery
 * (anchors, type vocabulary, byte-identity, acceptance), not a model's prose.
 */

const SHA_A = "ca52dbc3c5cc1e14146059bdb9817bf76be15b85"; // the fixture's recorded head
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

let tmpDirs: string[] = [];

/** A checkout carrying the real openwiki-authored bundle plus a little source. */
async function openwikiAuthoredCheckout(): Promise<{ dir: string; checkout: string }> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const checkout = join(dir, "checkout");
  // The files the fixture's pages actually cite, so a change set can
  // legitimately affect a page.
  for (const rel of [
    "src/agent/utils.ts",
    "src/agent/prompt.ts",
    "src/cli/commands.ts",
    "src/cli/run-mode.ts",
    "src/agent/wiki-finalizer.ts",
    "src/mermaid/validate.ts",
  ]) {
    await mkdir(join(checkout, rel, ".."), { recursive: true });
    await Bun.write(join(checkout, rel), `export const x = "${rel}";\n`);
  }
  await Bun.write(join(checkout, "README.md"), "# fixture\n");
  await cp(bundleFixture("openwiki-authored"), bundleDir(checkout), { recursive: true });
  return { dir, checkout };
}

/** Every concept page's bytes, keyed by bundle-relative path. */
async function pageBytes(bundle: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await walkMd(bundle)) {
    if (RESERVED_NAMES.has(rel.split("/").at(-1) ?? "")) continue;
    out.set(rel, await readFile(join(bundle, rel), "utf8"));
  }
  return out;
}

afterEach(async () => {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

describe("Claude producer continues an openwiki bundle (7.1)", () => {
  test("the real openwiki bundle is readable by our acceptance path unchanged", async () => {
    const { checkout } = await openwikiAuthoredCheckout();

    // Conformance: real openwiki output must pass our verifier as-is.
    const v = await verifyBundle(bundleDir(checkout));
    expect(v.ok).toBe(true);
    expect(v.indexPresent).toBe(true);

    // The anchor is readable in openwiki's own format.
    expect((await readContinuity(checkout))?.gitHead).toBe(SHA_A);

    // `sources[].resource` is the grounding signal. These point at openwiki's
    // own tree so most will not resolve — what matters is that they exist.
    const g = await scoreGrounding(bundleDir(checkout), checkout);
    expect(g.cited).toBeGreaterThan(0);
  });

  test("update to sha B: anchor advances, unrelated pages byte-identical, no new types", async () => {
    const { dir, checkout } = await openwikiAuthoredCheckout();
    const bundle = bundleDir(checkout);
    const before = await pageBytes(bundle);
    const typesBefore = await typeVocabulary(bundle);
    expect(typesBefore.length).toBeGreaterThan(0);

    const shim = await claudeScopedUpdate("concepts/two-modes.md", SHA_B);
    const argvOut = join(dir, "argv.txt");
    const cfg = testConfig(dir, { ODW_PRODUCER: "claude" });

    const res = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim), ODW_ARGV_OUT: argvOut } },
      {
        fromSha: SHA_A,
        changedPaths: ["src/agent/utils.ts"],
        typeVocabulary: typesBefore,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.run.outcome).toBe("ok");

    // The change set and vocabulary actually reached the child.
    const argv = await readFile(argvOut, "utf8");
    expect(argv).toContain("src/agent/utils.ts");
    expect(argv).toContain(SHA_A);
    for (const t of typesBefore) expect(argv).toContain(t);

    // Anchor advanced to B, in openwiki's format, with its fields intact.
    const after = await readContinuity(checkout);
    expect(after?.gitHead).toBe(SHA_B);
    expect(after?.language).toBe("en");
    expect(after?.model).toBe("claude-opus-4-8"); // openwiki's field, not repurposed

    // Only the revised page changed; every other concept page is byte-identical.
    const now = await pageBytes(bundle);
    const changed = [...before.keys()].filter((k) => before.get(k) !== now.get(k));
    expect(changed).toEqual(["concepts/two-modes.md"]);

    // The type vocabulary did not grow.
    expect(await typeVocabulary(bundle)).toEqual(typesBefore);
  });
});

describe("openwiki resumes a Claude-authored bundle (7.2)", () => {
  test("openwiki reads the recorded gitHead and updates incrementally", async () => {
    const { dir, checkout } = await openwikiAuthoredCheckout();

    // Pretend the claude producer wrote this bundle last, at sha B.
    await writeContinuity(checkout, { gitHead: SHA_B, producer: "claude", command: "update" });

    const shim = await openwikiContinues();
    const anchorOut = join(dir, "anchor.txt");
    const cfg = testConfig(dir);
    const before = await pageBytes(bundleDir(checkout));

    const res = await runIsolatedProducer(
      cfg,
      "openwiki",
      "update",
      checkout,
      join(dir, "snapshot"),
      { env: { PATH: pathWith(shim), ODW_ANCHOR_OUT: anchorOut } },
    );

    expect(res.ok).toBe(true);
    // openwiki read the anchor a *different* producer wrote — the round trip.
    expect((await readFile(anchorOut, "utf8")).trim()).toBe(SHA_B);
    // Incremental: it did not regenerate the concept pages.
    const now = await pageBytes(bundleDir(checkout));
    expect([...before.keys()].filter((k) => before.get(k) !== now.get(k))).toEqual([]);
  });

  test("the producer extension field does not confuse openwiki's own fields", async () => {
    const { checkout } = await openwikiAuthoredCheckout();
    await writeContinuity(checkout, { gitHead: SHA_C, producer: "claude" });

    const raw = JSON.parse(await readFile(join(bundleDir(checkout), ".last-update.json"), "utf8"));
    // All six openwiki fields still present and correctly typed.
    for (const key of ["updatedAt", "command", "gitHead", "model", "status", "language"]) {
      expect(typeof raw[key]).toBe("string");
    }
    expect(raw.producer).toBe("claude");
    expect(raw.gitHead).toBe(SHA_C);
  });

  test("a full round trip A -> claude -> B -> openwiki -> C keeps the bundle usable", async () => {
    const { dir, checkout } = await openwikiAuthoredCheckout();
    const snapshot = join(dir, "snapshot");
    const cfg = testConfig(dir);

    // A -> B by claude
    const claudeShim = await claudeScopedUpdate("concepts/okf-output.md", SHA_B);
    const first = await runIsolatedProducer(
      cfg,
      "claude",
      "update",
      checkout,
      snapshot,
      { env: { PATH: pathWith(claudeShim) } },
      { fromSha: SHA_A, changedPaths: ["src/agent/wiki-finalizer.ts"] },
    );
    expect(first.ok).toBe(true);
    expect((await readContinuity(checkout))?.gitHead).toBe(SHA_B);

    // B -> C by openwiki, reading what claude left behind
    const owShim = await openwikiContinues();
    const anchorOut = join(dir, "anchor2.txt");
    const second = await runIsolatedProducer(cfg, "openwiki", "update", checkout, snapshot, {
      env: { PATH: pathWith(owShim), ODW_ANCHOR_OUT: anchorOut },
    });
    expect(second.ok).toBe(true);
    expect((await readFile(anchorOut, "utf8")).trim()).toBe(SHA_B);

    // Still conformant after both producers have written to it.
    expect((await verifyBundle(bundleDir(checkout))).ok).toBe(true);
  });
});

describe("Acceptance is identical across producers (3.6)", () => {
  test("byte-identical bundle content from either producer accepts identically", async () => {
    const results: { producer: string; ok: boolean; concepts: number; errors: number }[] = [];

    for (const producer of ["openwiki", "claude"] as const) {
      const dir = await makeTmp();
      tmpDirs.push(dir);
      const checkout = join(dir, "checkout");
      await mkdir(checkout, { recursive: true });
      // Both shims copy the SAME fixture, so only the producer differs.
      const shim =
        producer === "openwiki"
          ? await openwikiHappy(bundleFixture("valid"))
          : await (await import("../../test/helpers/shim.ts")).claudeHappy(bundleFixture("valid"));

      const res = await runIsolatedProducer(
        testConfig(dir),
        producer,
        "init",
        checkout,
        join(dir, "snapshot"),
        { env: { PATH: pathWith(shim) } },
      );
      results.push({
        producer,
        ok: res.ok,
        concepts: res.verification?.concepts ?? -1,
        errors: res.verification?.errors.length ?? -1,
      });
    }

    const [ow, cl] = results;
    expect(ow?.ok).toBe(cl?.ok);
    expect(ow?.concepts).toBe(cl?.concepts);
    expect(ow?.errors).toBe(cl?.errors);
    expect(ow?.ok).toBe(true);
  });

  test("a malformed bundle is rejected identically whichever producer wrote it", async () => {
    const outcomes: boolean[] = [];
    for (const producer of ["openwiki", "claude"] as const) {
      const dir = await makeTmp();
      tmpDirs.push(dir);
      const checkout = join(dir, "checkout");
      await mkdir(checkout, { recursive: true });
      const shim =
        producer === "openwiki"
          ? await openwikiHappy(bundleFixture("malformed"))
          : await (
              await import("../../test/helpers/shim.ts")
            ).claudeHappy(bundleFixture("malformed"));

      const res = await runIsolatedProducer(
        testConfig(dir),
        producer,
        "init",
        checkout,
        join(dir, "snapshot"),
        { env: { PATH: pathWith(shim) } },
      );
      outcomes.push(res.ok);
    }
    expect(outcomes).toEqual([false, false]);
  });
});
