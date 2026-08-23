import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CONTINUITY_FILE,
  continuityPath,
  readAnchor,
  readContinuity,
  typeVocabulary,
  writeContinuity,
} from "./anchor.ts";
import { bundleDir } from "./verify.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";

/**
 * Continuity metadata (2.5). The fixture is a REAL file written by openwiki
 * 0.3.3, so "openwiki can continue our bundle" is tested against the actual
 * format rather than our idea of it.
 */

const REAL = fileURLToPath(
  new URL("../../test/fixtures/continuity/openwiki-0.3.3.json", import.meta.url),
);

let tmpDirs: string[] = [];
async function checkoutWithContinuity(file?: string): Promise<string> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const checkout = join(dir, "checkout");
  await mkdir(bundleDir(checkout), { recursive: true });
  if (file !== undefined) await cp(file, continuityPath(checkout));
  return checkout;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

describe("Wiki continuity metadata", () => {
  test("reads a real openwiki-written file", async () => {
    const checkout = await checkoutWithContinuity(REAL);
    const c = await readContinuity(checkout);

    expect(c).not.toBeNull();
    expect(c?.gitHead).toBe("ca52dbc3c5cc1e14146059bdb9817bf76be15b85");
    expect(c?.command).toBe("update");
    expect(c?.model).toBe("claude-opus-4-8");
    expect(c?.status).toBe("complete");
    expect(c?.language).toBe("en");
    expect(await readAnchor(checkout)).toBe("ca52dbc3c5cc1e14146059bdb9817bf76be15b85");
  });

  test("round-trips openwiki's six fields without dropping or repurposing any", async () => {
    const checkout = await checkoutWithContinuity(REAL);
    const before = JSON.parse(await readFile(REAL, "utf8")) as Record<string, unknown>;

    await writeContinuity(checkout, { gitHead: "b".repeat(40), producer: "claude" });
    const after = JSON.parse(await readFile(continuityPath(checkout), "utf8")) as Record<
      string,
      unknown
    >;

    // Only gitHead changed among the known fields; nothing was lost.
    for (const key of ["command", "model", "status", "language", "updatedAt"]) {
      expect(after[key]).toBe(before[key]);
    }
    expect(after.gitHead).toBe("b".repeat(40));
    // Producer identity is its own field — `model` is openwiki's, untouched.
    expect(after.producer).toBe("claude");
    expect(after.model).toBe("claude-opus-4-8");
  });

  test("preserves unknown fields a newer producer may have written", async () => {
    const checkout = await checkoutWithContinuity();
    await writeFile(
      continuityPath(checkout),
      JSON.stringify({
        updatedAt: "2026-01-01T00:00:00.000Z",
        command: "init",
        gitHead: "a".repeat(40),
        model: "m",
        status: "complete",
        language: "en",
        someFutureField: { nested: true },
      }),
    );

    await writeContinuity(checkout, { gitHead: "c".repeat(40) });
    const after = JSON.parse(await readFile(continuityPath(checkout), "utf8")) as Record<
      string,
      unknown
    >;

    expect(after.someFutureField).toEqual({ nested: true });
    expect(after.gitHead).toBe("c".repeat(40));
  });

  test("a missing file is no anchor, not an error", async () => {
    const checkout = await checkoutWithContinuity();
    expect(await readContinuity(checkout)).toBeNull();
    expect(await readAnchor(checkout)).toBeNull();
  });

  test("a corrupt file is tolerated as no anchor", async () => {
    const checkout = await checkoutWithContinuity();
    await writeFile(continuityPath(checkout), "{ not json at all");
    expect(await readContinuity(checkout)).toBeNull();
    expect(await readAnchor(checkout)).toBeNull();
  });

  test("a file without a usable gitHead is no anchor", async () => {
    const checkout = await checkoutWithContinuity();
    await writeFile(continuityPath(checkout), JSON.stringify({ command: "init", gitHead: "" }));
    expect(await readAnchor(checkout)).toBeNull();
  });

  test("writing is idempotent for the same values", async () => {
    const checkout = await checkoutWithContinuity(REAL);
    await writeContinuity(checkout, {
      gitHead: "d".repeat(40),
      updatedAt: "2026-05-05T00:00:00.000Z",
      producer: "claude",
    });
    const first = await readFile(continuityPath(checkout), "utf8");
    await writeContinuity(checkout, {
      gitHead: "d".repeat(40),
      updatedAt: "2026-05-05T00:00:00.000Z",
      producer: "claude",
    });
    expect(await readFile(continuityPath(checkout), "utf8")).toBe(first);
  });

  test("the file is named exactly what openwiki looks for", () => {
    expect(CONTINUITY_FILE).toBe(".last-update.json");
    expect(continuityPath("/x")).toBe("/x/openwiki/.last-update.json");
  });
});

describe("Type vocabulary extraction", () => {
  test("collects the types a bundle already uses, sorted and deduplicated", async () => {
    // INSTRUCTIONS.md is structural, so its `instructions` type is absent.
    expect(await typeVocabulary(bundleFixture("valid"))).toEqual([
      "guide",
      "overview",
      "token-refresh",
      "token-validation",
      "wiki-skeleton",
    ]);
  });

  test("a malformed page does not break extraction", async () => {
    expect(await typeVocabulary(bundleFixture("malformed-yaml"))).toEqual([]);
  });

  test("an absent bundle yields an empty vocabulary", async () => {
    expect(await typeVocabulary("/nope/does/not/exist")).toEqual([]);
  });
});
