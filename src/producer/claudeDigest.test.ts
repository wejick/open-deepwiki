import { afterEach, describe, expect, test } from "bun:test";
import { createGitRepo } from "../../test/helpers/gitFixture.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import {
  DIGEST_MAX_FILES_PER_DIR,
  buildDigestTree,
  listDocumentableFiles,
  listTrackedFiles,
  nonDocumentableKind,
  renderDigest,
  renderDigestSubset,
  repoDigest,
  type ExcludedKind,
} from "./claudeDigest.ts";

let tmpDirs: string[] = [];
const sized = (n: number): string => "x".repeat(n);

afterEach(async () => {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

describe("Checkpointed planning for large initial bundles › digest", () => {
  test("groups the tracked tree per directory, deterministically", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/a.ts": "a",
      "src/b.ts": "bb",
      "src/inner/c.ts": "ccc",
      "README.md": "readme",
    });

    const first = await repoDigest(repo);
    const second = await repoDigest(repo);

    expect(first).toBe(second); // same checkout, same bytes — deterministic
    expect(first).toContain("Documentable files: 4");
    expect(first).toContain("src/  2 files"); // per-directory grouping
    expect(first).toContain("src/inner/  1 files");
    expect(first).toContain("(root)  1 files");
  });

  test("caps its own size at maxDirs, largest directories first", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`d${i}/f.txt`] = "x";
    files["big/one.txt"] = "x";
    files["big/two.txt"] = "x";
    files["big/three.txt"] = "x";
    const repo = await createGitRepo(dir, files);

    const digest = await repoDigest(repo, 5);

    expect(digest).toContain("showing 5, 8 smaller omitted"); // 13 dirs, 5 shown
    expect(digest).toContain("big/  3 files"); // largest first
    // Path order on the tie, so d10/d11 sort before d2: the tail (d2..d9) is dropped.
    expect(digest).not.toContain("d5/");
  });

  test("an empty repository digests to zero files", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, { ".keep": "" });

    const digest = await repoDigest(repo);
    expect(digest).toContain("Documentable files: 1");
    expect(await listTrackedFiles(repo)).toEqual([".keep"]);
    expect(await listDocumentableFiles(repo)).toEqual([".keep"]);
  });

  test("a non-repository directory rejects, so callers can degrade", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await expect(repoDigest(dir)).rejects.toThrow();
  });
});

describe("Structure-seeded planning on init › the handout names a directory's load-bearing files", () => {
  test("names each directory's largest files first, up to the bound, then a marker", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const files: Record<string, string> = {};
    for (let i = 0; i <= 11; i++) files[`src/f${String(i).padStart(2, "0")}.ts`] = sized(i);
    const repo = await createGitRepo(dir, files);

    const digest = await repoDigest(repo);

    // 12 files, 10 named (DIGEST_MAX_FILES_PER_DIR), 2 in the marker.
    expect(digest).toContain("src/  12 files");
    // Largest first: f11 … f02 named, in that order.
    const at = (needle: string): number => digest.indexOf(needle);
    expect(at("  - f11.ts (11 bytes)")).toBeGreaterThan(0);
    expect(at("  - f10.ts (10 bytes)")).toBeGreaterThan(at("  - f11.ts (11 bytes)"));
    expect(at("  - f02.ts (2 bytes)")).toBeGreaterThan(at("  - f03.ts (3 bytes)"));
    expect(digest).toContain("  - … and 2 more files");
    expect(digest).not.toContain("  - f01.ts");
    expect(digest).not.toContain("  - f00.ts");
  });

  test("equal-sized files name in path order, so the digest is deterministic", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/b.ts": sized(3),
      "src/a.ts": sized(3),
      "src/c.ts": sized(3),
    });

    const first = await repoDigest(repo);
    const second = await repoDigest(repo);

    expect(first).toBe(second);
    const at = (needle: string): number => first.indexOf(needle);
    expect(at("  - a.ts")).toBeGreaterThan(0);
    expect(at("  - b.ts")).toBeGreaterThan(at("  - a.ts"));
    expect(at("  - c.ts")).toBeGreaterThan(at("  - b.ts"));
  });

  test("the per-directory count and size line is unchanged by the name listing", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/a.ts": "a",
      "src/b.ts": "bbb",
      "src/inner/c.ts": "ccccc",
      "README.md": "readme",
    });

    const digest = await repoDigest(repo);

    expect(digest).toContain("src/  2 files  4 bytes");
    expect(digest).toContain("  - b.ts (3 bytes)");
    expect(digest).toContain("  - a.ts (1 bytes)");
    expect(digest).toContain("(root)  1 files  6 bytes");
  });
});

describe("Structure-seeded planning on init › an area session sees the structure it owns", () => {
  test("a slice over a directory names that subtree only, never a sibling's", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/a/one.ts": "one",
      "src/a/two.ts": "two",
      "src/a/sub/x.ts": "xxx",
      "src/b/other.ts": "other",
      "README.md": "readme",
    });
    const tree = await buildDigestTree(repo);

    const slice = renderDigestSubset(tree, ["src/a/"]);

    expect(slice).toContain("src/a/  2 files");
    expect(slice).toContain("  - one.ts");
    expect(slice).toContain("src/a/sub/  1 files");
    expect(slice).toContain("  - x.ts");
    expect(slice).not.toContain("src/b/");
    expect(slice).not.toContain("README.md");
  });

  test("a slice over one owned file names it alone", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/a/one.ts": "one",
      "src/a/two.ts": "two",
      "src/b/other.ts": "other",
    });
    const tree = await buildDigestTree(repo);

    const slice = renderDigestSubset(tree, ["src/a/two.ts"]);

    expect(slice).toContain("src/a/  1 files");
    expect(slice).toContain("  - two.ts");
    expect(slice).not.toContain("one.ts");
    expect(slice).not.toContain("src/b/");
  });

  test("a slice over the repo root names only the root's own files", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "README.md": "readme",
      LICENSE: "mit",
      "src/a/one.ts": "one",
    });
    const tree = await buildDigestTree(repo);

    const slice = renderDigestSubset(tree, ["."]);

    expect(slice).toContain("(root)  2 files");
    expect(slice).toContain("  - README.md");
    expect(slice).toContain("  - LICENSE");
    expect(slice).not.toContain("src/");
  });

  test("a slice never names a non-documentable file", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/code.ts": "code",
      "src/assets/icon.png": "x",
      "package-lock.json": "{}",
    });
    const tree = await buildDigestTree(repo);

    const slice = renderDigestSubset(tree, ["src/"]);

    expect(slice).toContain("  - code.ts");
    expect(slice).not.toContain("icon.png");
  });

  test("whole and slice rendering share the bounded name listing", async () => {
    expect(DIGEST_MAX_FILES_PER_DIR).toBeGreaterThan(0);
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) files[`pkg/f${i}.ts`] = sized(i);
    const repo = await createGitRepo(dir, files);
    const tree = await buildDigestTree(repo);

    const whole = renderDigest(tree);
    const slice = renderDigestSubset(tree, ["pkg/"]);

    for (const text of [whole, slice]) {
      expect(text).toContain("  - f14.ts");
      expect(text).toContain("… and 5 more files");
    }
  });
});

describe("Checkpointed planning for large initial bundles › non-documentable kinds", () => {
  test("classifies one file of every excluded kind, and keeps plain source", () => {
    const excluded: [string, ExcludedKind][] = [
      ["src/assets/icons/a.png", "media"],
      ["src/assets/icon.svg", "media"],
      ["fonts/Inter.ttf", "media"],
      ["res/intro.mp4", "media"],
      ["docs/report.pdf", "media"],
      ["package-lock.json", "lockfile"],
      ["ios/Podfile.lock", "lockfile"],
      ["yarn.lock", "lockfile"],
      ["Localizable.strings", "string catalog"],
      ["po/fr.po", "string catalog"],
      ["src/ui/scenes/RootScene/strings/en-GB.json", "string catalog"],
      ["strings/values.xml", "string catalog"],
      ["node_modules/pkg/x.js", "generated"],
      ["ios/Pods/RCT/z.m", "generated"],
      [".gradle/caches/x.bin", "generated"],
      ["DerivedData/App/Build/x", "generated"],
      ["src/assets/animations/intro.json", "animation"],
      ["res/loader.lottie", "animation"],
    ];
    for (const [path, kind] of excluded) {
      expect(nonDocumentableKind(path)).toBe(kind);
    }
    const kept = [
      "src/code.ts",
      "package.json",
      "tsconfig.json",
      "src/features/hooks/useX.ts",
      "strings.md",
      "assets.ts",
    ];
    for (const path of kept) {
      expect(nonDocumentableKind(path)).toBeNull();
    }
  });

  test("the digest omits excluded files and reports them by kind", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/code.ts": "code",
      "src/assets/icon.png": "x",
      "src/assets/animations/intro.json": "{}",
      "src/i18n/strings/en.json": "{}",
      "package-lock.json": "{}",
      "README.md": "readme",
    });

    const digest = await repoDigest(repo);

    expect(digest).toContain(
      "Documentable files: 2 (4 excluded: 1 animation, 1 lockfile, 1 media, 1 string catalog)",
    );
    expect(digest).toContain("src/  1 files");
    expect(digest).toContain("(root)  1 files");
    expect(digest).not.toContain("icon.png");
    expect(digest).not.toContain("intro.json");
    expect(digest).not.toContain("strings/");
    expect(await listDocumentableFiles(repo)).toEqual(["README.md", "src/code.ts"]);
  });

  test("an assets-heavy directory shows only its documentable files", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "assets/g1/a.png": "x",
      "assets/g1/b.png": "x",
      "assets/g1/main.ts": "code",
      "assets/g1/readme.md": "docs",
      "README.md": "readme",
    });

    const digest = await repoDigest(repo);

    // a.png, b.png excluded; main.ts + readme.md remain.
    expect(digest).toContain("assets/g1/  2 files");
    expect(digest).toContain("Documentable files: 3 (2 excluded: 2 media)");
    expect(await listDocumentableFiles(repo)).toEqual([
      "README.md",
      "assets/g1/main.ts",
      "assets/g1/readme.md",
    ]);
  });
});

describe("Claude producer planning honors the merged exclude set", () => {
  test("Glob-excluded tracked files are not planned", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "src/code.ts": "code",
      "README.md": "readme",
      "dist/bundle.js": "minified",
      "assets/icon.png": "x",
    });

    const digest = await repoDigest(repo, 400, ["dist/**"]);

    // dist/bundle.js is documentable by kind, so only the exclude set removes
    // it — the count and the report both say so.
    expect(digest).toContain("Documentable files: 2 (2 excluded: 1 media, 1 by exclude globs)");
    expect(digest).not.toContain("bundle.js");
    expect(await listDocumentableFiles(repo, ["dist/**"])).toEqual(["README.md", "src/code.ts"]);
  });

  test("An area slice never names a glob-excluded file", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const repo = await createGitRepo(dir, {
      "app/main.ts": "code",
      "app/dist/gen.js": "generated",
    });

    const tree = await buildDigestTree(repo, ["app/dist/**"]);

    const slice = renderDigestSubset(tree, ["app/"]);
    expect(slice).toContain("app/  1 files");
    expect(slice).toContain("main.ts");
    expect(slice).not.toContain("gen.js");
  });
});
