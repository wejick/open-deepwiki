import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { exportedNames, measureBundle, scorePlanQuality, type BundleMetrics } from "./metrics.ts";
import { row, stable } from "./run.ts";
import { testConfig } from "../helpers/config.ts";
import { makeTmp, rmTmp } from "../helpers/tmp.ts";

/**
 * Verifies the parity harness itself (1.2). The harness is not part of the
 * suite — this only checks that it measures correctly, offline, and reports
 * stably.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/grounding", import.meta.url));
const checkout = join(FIXTURES, "checkout");
const bundle = (name: string): string => join(FIXTURES, name);

let tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await makeTmp();
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

describe("plan quality", () => {
  test("reports folded count and boilerplate stems from a plan file", async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, ".odw-plan.json"),
      JSON.stringify({
        pages: [
          {
            path: "architecture/state-management.md",
            type: "architecture",
            title: "State",
            brief: "",
            sourcePaths: [],
            relatedPages: [],
          },
          {
            path: "inventory/state-management.md",
            type: "architecture",
            title: "Inventory state",
            brief: "",
            sourcePaths: [],
            relatedPages: [],
          },
          {
            path: "modules/auth/overview.md",
            type: "overview",
            title: "Auth",
            brief: "",
            sourcePaths: [],
            relatedPages: [],
          },
        ],
        deletePages: [],
      }),
    );
    const q = await scorePlanQuality(dir, [
      "architecture/state-management.md",
      "modules/auth/overview.md",
    ]);
    expect(q.plannedPages).toBe(3);
    expect(q.foldedAtMerge).toBe(1);
    expect(q.boilerplateStems).toBe(1);
  });

  test("a bundle without a plan file reports nulls", async () => {
    const q = await scorePlanQuality(bundle("bundle-grounded"), ["a.md"]);
    expect(q.plannedPages).toBeNull();
    expect(q.foldedAtMerge).toBeNull();
    expect(q.boilerplateStems).toBe(0);
  });
});

describe("exportedNames", () => {
  test("declarations", () => {
    expect(
      exportedNames(
        "export function a() {}\nexport const b = 1;\nexport class C {}\n" +
          "export type T = string;\nexport interface I {}\nexport async function d() {}",
      ),
    ).toEqual(["C", "I", "T", "a", "b", "d"]);
  });

  test("export lists, including aliases", () => {
    expect(exportedNames("const x = 1;\nexport { x, y as z };")).toEqual(["x", "z"]);
  });

  test("non-exported symbols are not counted", () => {
    expect(exportedNames("function hidden() {}\nconst internal = 2;")).toEqual([]);
  });
});

describe("bundle parity harness", () => {
  test("measures a grounded bundle across every dimension", async () => {
    const cfg = testConfig(await tmp());
    const m = await measureBundle(bundle("bundle-grounded"), checkout, cfg);

    expect(m.conformant).toBe(true);
    expect(m.concepts).toBe(2);
    // One resolving cross-link and one deliberately broken link.
    expect(m.linkResolved).toBe(1);
    expect(m.linkTotal).toBe(2);
    expect(m.grounding.score).toBe(1);
    expect(m.coverage.dirRatio).toBe(1);
    expect(m.coverage.fileRatio).toBe(1);
    // Both exports (validateToken, CACHE_TTL) are named in page bodies.
    expect(m.coverage.exportRatio).toBe(1);
    // Plan granularity: no plan dot-file on a published bundle, so shipped
    // pages over documentable files — 2 pages over the checkout's files.
    expect(m.planQuality.pagesPerDocFile).toBeCloseTo(2 / m.coverage.filesTotal, 6);
  });

  test("discriminates a fabricated bundle from a grounded one", async () => {
    const cfg = testConfig(await tmp());
    const good = await measureBundle(bundle("bundle-grounded"), checkout, cfg);
    const bad = await measureBundle(bundle("bundle-fabricated"), checkout, cfg);

    expect(bad.grounding.score).toBeLessThan(good.grounding.score);
    // A fabricated path must not count as covering the directory it names.
    expect(bad.coverage.dirRatio).toBeLessThan(good.coverage.dirRatio);
    expect(bad.coverage.filesCited).toBe(1);
    expect(bad.coverage.fileRatio).toBeCloseTo(1 / 3, 10);
    expect(bad.coverage.exportRatio).toBe(0);
  });

  test("runs offline — no network access at all", async () => {
    const cfg = testConfig(await tmp());
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = ((): never => {
      called = true;
      throw new Error("harness must not touch the network");
    }) as unknown as typeof fetch;
    try {
      const m = await measureBundle(bundle("bundle-grounded"), checkout, cfg);
      expect(m.conformant).toBe(true);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("emits a stable report — same inputs, byte-identical JSON", async () => {
    const cfg = testConfig(await tmp());
    const first = await measureBundle(bundle("bundle-grounded"), checkout, cfg);
    const second = await measureBundle(bundle("bundle-grounded"), checkout, cfg);

    expect(JSON.stringify(stable(first))).toBe(JSON.stringify(stable(second)));
  });

  test("stable() sorts keys at every depth", () => {
    const out = JSON.stringify(stable({ b: 1, a: { d: 2, c: 3 } }));
    expect(out).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("stable() rounds floats so a last-bit difference is not a diff", () => {
    expect(JSON.stringify(stable({ x: 1 / 3 }))).toBe('{"x":0.333333}');
  });
});

const granularityMetrics = (pagesPerDocFile: number | null): BundleMetrics =>
  ({
    conformant: true,
    concepts: 1,
    conformanceErrors: 0,
    linkResolved: 1,
    linkTotal: 1,
    linkRatio: 1,
    grounding: { score: 1, resolved: 1, cited: 1, density: 1, uncitedPages: 0, pages: 1 },
    coverage: {
      dirsCovered: 1,
      dirsTotal: 1,
      dirRatio: 1,
      filesCited: 1,
      filesTotal: 1,
      fileRatio: 1,
      exportsMentioned: 1,
      exportsTotal: 1,
      exportRatio: 1,
    },
    planQuality: {
      plannedPages: 383,
      foldedAtMerge: 0,
      boilerplateStems: 0,
      pagesPerDocFile,
    },
  }) as unknown as BundleMetrics;

describe("report: plan granularity", () => {
  test("the granularity row prints for one bundle and in an A/B comparison", () => {
    const a = granularityMetrics(0.028);
    const line = row("pages/doc-file", a, null);
    expect(line).toContain("0.028");
    const compared = row("pages/doc-file", a, granularityMetrics(0.031));
    expect(compared).toContain("0.028");
    expect(compared).toContain("0.031");
  });

  test("a bundle with no measurable granularity reports n/a", () => {
    expect(row("pages/doc-file", granularityMetrics(null), null)).toContain("n/a");
  });
});
