import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { citedPath, citedPaths, lineRangeOf, scoreGrounding } from "./grounding.ts";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/grounding", import.meta.url));
const checkout = join(FIXTURES, "checkout");
const bundle = (name: string): string => join(FIXTURES, name);

describe("citedPath", () => {
  test("plain repo:// resource", () => {
    expect(citedPath("repo://src/auth.ts")).toBe("src/auth.ts");
  });

  test("line-range fragment is stripped", () => {
    expect(citedPath("repo://src/auth.ts#L1-L3")).toBe("src/auth.ts");
    expect(citedPath("repo://src/auth.ts#L8")).toBe("src/auth.ts");
  });

  test("non-repo resources are not citations", () => {
    expect(citedPath("https://example.invalid/docs")).toBeNull();
    expect(citedPath("some scope descriptor")).toBeNull();
    expect(citedPath(undefined)).toBeNull();
    expect(citedPath(42)).toBeNull();
  });

  test("paths escaping the checkout are refused", () => {
    expect(citedPath("repo://../../etc/passwd")).toBeNull();
    expect(citedPath("repo:///etc/passwd")).toBeNull();
  });

  test("interior traversal normalizes rather than escaping", () => {
    expect(citedPath("repo://src/nested/../auth.ts")).toBe("src/auth.ts");
  });
});

describe("citedPaths", () => {
  test("skips entries with no resource", () => {
    expect(
      citedPaths({
        sources: [
          { id: "a", resource: "repo://src/auth.ts" },
          { id: "b", title: "no resource" },
        ],
      }),
    ).toEqual(["src/auth.ts"]);
  });

  test("tolerates a missing or malformed sources field", () => {
    expect(citedPaths({})).toEqual([]);
    expect(citedPaths({ sources: "not a list" })).toEqual([]);
    expect(citedPaths({ sources: [null, 7] })).toEqual([]);
  });
});

describe("Bundle grounding verification", () => {
  test("Grounded bundle accepted and scored", async () => {
    const res = await scoreGrounding(bundle("bundle-grounded"), checkout);

    // 3 repo:// citations across two pages; the external URL and the entry
    // with no resource are ignored rather than counted as unresolved.
    expect(res.cited).toBe(3);
    expect(res.resolved).toBe(3);
    expect(res.score).toBe(1);
    expect(res.unresolved).toEqual([]);
    expect(res.uniqueFiles).toBe(3);
    expect(res.pages).toBe(2);
    expect(res.density).toBeGreaterThan(0);
  });

  test("Fabricated citation fails the run", async () => {
    const res = await scoreGrounding(bundle("bundle-fabricated"), checkout);

    // Only src/auth.ts exists. The traversal-escaping entry is refused at
    // parse time, so it is not counted as a citation at all.
    expect(res.cited).toBe(3);
    expect(res.resolved).toBe(1);
    expect(res.score).toBeCloseTo(1 / 3, 10);
    expect(res.unresolved).toEqual(["lib/imaginary/module.ts", "src/does-not-exist.ts"]);
  });

  test("Bundle that cites nothing is rejected", async () => {
    const res = await scoreGrounding(bundle("bundle-nocites"), checkout);

    expect(res.cited).toBe(0);
    expect(res.density).toBe(0);
    // The whole point: a vacuous resolved fraction must not read as perfect.
    expect(res.score).not.toBe(1);
    expect(res.score).toBe(0);
    expect(res.uncitedPages).toBe(1);
  });

  test("a malformed page is skipped, not thrown out of the whole scoring pass", async () => {
    const res = await scoreGrounding(bundle("bundle-malformed"), checkout);

    // broken.md has unparseable YAML — gray-matter throws on it. Scoring must
    // survive and still report the parseable page's citation.
    expect(res.cited).toBe(1);
    expect(res.resolved).toBe(1);
    expect(res.score).toBe(1);
  });

  test("repeated citations of one file do not inflate the count", async () => {
    const res = await scoreGrounding(bundle("bundle-inflated"), checkout);

    // src/auth.ts is listed three times (once with a line range) — those
    // collapse to one citation instead of inflating the count to four. `src`
    // stays a distinct citation so its failure to resolve is visible.
    expect(res.cited).toBe(2);
    expect(res.resolved).toBe(1);
    expect(res.uniqueFiles).toBe(2);
  });

  test("a directory is not a resolvable citation", async () => {
    const res = await scoreGrounding(bundle("bundle-inflated"), checkout);

    expect(res.unresolved).toEqual(["src"]);
  });

  test("uncitedPages counts pages carrying no citation at all", async () => {
    const res = await scoreGrounding(bundle("bundle-grounded"), checkout);

    // Both concept pages in this fixture cite something.
    expect(res.uncitedPages).toBe(0);
  });

  test("density is citations per 1000 body words, from returned components", async () => {
    const res = await scoreGrounding(bundle("bundle-grounded"), checkout);

    expect(res.bodyWords).toBeGreaterThan(0);
    expect(res.density).toBeCloseTo((res.cited / res.bodyWords) * 1000, 10);
  });

  test("a missing bundle directory scores zero rather than throwing", async () => {
    const res = await scoreGrounding(bundle("does-not-exist"), checkout);

    expect(res).toMatchObject({ cited: 0, resolved: 0, score: 0, density: 0, pages: 0 });
  });
});

describe("lineRangeOf", () => {
  test("extracts a start-end range", () => {
    expect(lineRangeOf("repo://src/auth.ts#L40-L82")).toEqual({ start: 40, end: 82 });
  });

  test("a single line is treated as a one-line range", () => {
    expect(lineRangeOf("repo://src/auth.ts#L8")).toEqual({ start: 8, end: 8 });
  });

  test("no fragment means no range", () => {
    expect(lineRangeOf("repo://src/auth.ts")).toBeNull();
    expect(lineRangeOf(undefined)).toBeNull();
  });
});

describe("Bundle grounding verification › line-range validation", () => {
  test("an in-range fragment still resolves", async () => {
    const res = await scoreGrounding(bundle("bundle-line-range"), checkout);

    // in-range.md's citation is valid; only out-of-range.md's is not.
    expect(res.unresolved).toEqual(["src/cache.ts"]);
    expect(res.resolved).toBe(1);
    expect(res.cited).toBe(2);
  });

  test("an out-of-range Lend is counted unresolved even though the path exists", async () => {
    const res = await scoreGrounding(bundle("bundle-line-range"), checkout);

    expect(res.unresolved).toContain("src/cache.ts");
  });

  test("existing single-line and no-fragment citations behave unchanged", async () => {
    // bundle-inflated already covers a plain path and a `#L1-L2` in-range
    // fragment on a real file — both still resolve.
    const res = await scoreGrounding(bundle("bundle-inflated"), checkout);
    expect(res.resolved).toBe(1);
  });

  test("a reversed range (start after end) is counted unresolved even though both bounds are individually in-range", async () => {
    const res = await scoreGrounding(bundle("bundle-reversed-range"), checkout);

    expect(res.unresolved).toEqual(["src/auth.ts"]);
    expect(res.resolved).toBe(0);
  });
});

/** A checkout and a one-page bundle built on disk, so the symlinks are real. */
async function scene(
  cite: string,
  build: (checkout: string, outside: string) => Promise<void>,
): Promise<{ result: Awaited<ReturnType<typeof scoreGrounding>>; secret: string }> {
  const root = await makeTmp("odw-symlink-");
  try {
    const checkoutDir = join(root, "checkout");
    const outside = join(root, "outside");
    await mkdir(join(checkoutDir, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "token=hunter2\n");
    await writeFile(join(checkoutDir, "src", "real.ts"), "export const real = 1;\n");
    await build(checkoutDir, outside);

    const bundleDir = join(root, "bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "index.md"), '---\nokf_version: "0.2"\n---\n\n# Index\n');
    await writeFile(
      join(bundleDir, "page.md"),
      `---\ntype: module\nsources:\n  - id: a\n    resource: ${cite}\n  - id: b\n    resource: repo://src/real.ts\n---\n\nSome body prose about the module.\n`,
    );
    return { result: await scoreGrounding(bundleDir, checkoutDir), secret };
  } finally {
    await rmTmp(root);
  }
}

describe("Bundle grounding verification › symlinked evidence", () => {
  test("Symlinked citation counted as unresolved and never read", async () => {
    const { result } = await scene("repo://src/evil.ts", async (checkoutDir, outside) => {
      await symlink(join(outside, "secret.txt"), join(checkoutDir, "src", "evil.ts"));
    });

    expect(result.unresolved).toEqual(["src/evil.ts"]);
    // One hostile path degrades the score rather than aborting the pass.
    expect(result.cited).toBe(2);
    expect(result.resolved).toBe(1);
  });

  test("a symlink to a file inside the checkout is refused too", async () => {
    const { result } = await scene("repo://src/alias.ts", async (checkoutDir) => {
      await symlink(join(checkoutDir, "src", "real.ts"), join(checkoutDir, "src", "alias.ts"));
    });

    expect(result.unresolved).toEqual(["src/alias.ts"]);
  });

  test("A regular file reached through an aliased parent is not trusted", async () => {
    const { result } = await scene("repo://src/vendor/planted.ts", async (checkoutDir, outside) => {
      await mkdir(join(outside, "vendor"), { recursive: true });
      await writeFile(join(outside, "vendor", "planted.ts"), "export const planted = 1;\n");
      await symlink(join(outside, "vendor"), join(checkoutDir, "src", "vendor"));
    });

    expect(result.unresolved).toEqual(["src/vendor/planted.ts"]);
  });

  test("an ordinary file in a checkout reached through a symlinked root still resolves", async () => {
    // macOS's own /tmp -> /private/tmp symlink is the case this pins.
    const { result } = await scene("repo://src/real.ts", async () => {});

    expect(result.unresolved).toEqual([]);
    expect(result.resolved).toBe(1);
    expect(result.cited).toBe(1);
  });
});
