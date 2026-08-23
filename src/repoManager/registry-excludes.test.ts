import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveExcludes, loadRegistry, normalizeGlobs, saveYaml } from "./registry.ts";
import { crawlSourcePaths } from "../index/crawl.ts";
import { createGitRepo } from "../../test/helpers/gitFixture.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { paths } from "../config/config.ts";
import type { Config } from "../config/config.ts";

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

async function cfgWithRegistryYaml(dir: string, yaml: string): Promise<Config> {
  const cfg = testConfig(dir);
  await writeFile(paths.registryYaml(cfg), yaml);
  return cfg;
}

describe("Per-repo exclude globs", () => {
  test("Repo without excludes is unchanged", async () => {
    const dir = await tmp();
    const cfg = await cfgWithRegistryYaml(
      dir,
      `repos:\n  - repoId: gitlab.corp/team/repo\n    source: git@gitlab.corp:team/repo.git\n`,
    );
    const registry = await loadRegistry(cfg);
    const repo = registry.repos[0];
    expect(repo).toBeDefined();
    expect(repo?.excludeGlobs).toBeUndefined();
    // No field means the global list alone — identical to before this feature.
    expect(effectiveExcludes(cfg, repo!)).toEqual(cfg.excludeGlobs);
  });

  test("Registry round-trips exclude globs", async () => {
    const dir = await tmp();
    const cfg = await cfgWithRegistryYaml(
      dir,
      `repos:\n  - repoId: gitlab.corp/team/repo\n    source: git@gitlab.corp:team/repo.git\n    excludeGlobs: ["**/__snapshots__/**", "**/*.a"]\n`,
    );
    const registry = await loadRegistry(cfg);
    expect(registry.repos[0]?.excludeGlobs).toEqual(["**/__snapshots__/**", "**/*.a"]);

    // A save (state-only writers trigger the yaml sync too via saveRegistry;
    // here the human-config edit path) must preserve the field.
    await saveYaml(cfg, registry);
    const text = await readFile(paths.registryYaml(cfg), "utf8");
    expect(text).toContain("excludeGlobs");
    const reloaded = await loadRegistry(cfg);
    expect(reloaded.repos[0]?.excludeGlobs).toEqual(["**/__snapshots__/**", "**/*.a"]);
  });

  test("Hand-edited globs are trimmed, deduplicated, and empty values dropped", async () => {
    const dir = await tmp();
    const cfg = await cfgWithRegistryYaml(
      dir,
      `repos:\n  - repoId: r\n    source: x\n    excludeGlobs: [" ci/** ", "**/*.a", "ci/**", ""]\n`,
    );
    const registry = await loadRegistry(cfg);
    expect(registry.repos[0]?.excludeGlobs).toEqual(["ci/**", "**/*.a"]);
  });

  test("Malformed hand-edited globs fall back to the global list", async () => {
    const dir = await tmp();
    const cfg = await cfgWithRegistryYaml(
      dir,
      `repos:\n  - repoId: r\n    source: x\n    excludeGlobs: "ci/**"\n`,
    );
    const registry = await loadRegistry(cfg);
    expect(registry.repos[0]?.excludeGlobs).toBeUndefined();
    expect(effectiveExcludes(cfg, registry.repos[0]!)).toEqual(cfg.excludeGlobs);
  });

  test("Repo globs extend, not replace, the global list", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, { ODW_EXCLUDE_GLOBS: "node_modules/**,*.lock" });
    const repo = { excludeGlobs: ["ci/**"] };
    const merged = effectiveExcludes(cfg, repo);
    expect(merged).toContain("*.lock"); // global still applies
    expect(merged).toContain("ci/**"); // repo glob added
    expect(merged).toEqual(["node_modules/**", "*.lock", "ci/**"]);

    // A file matching either list is excluded by the crawl.
    const checkout = join(dir, "checkout");
    await createGitRepo(checkout, {
      "src/keep.ts": "export const k = 1;\n",
      "yarn.lock": "lockfile\n", // global glob
      "ci/build.yml": "stages: [build]\n", // repo glob
    });
    const crawled = await crawlSourcePaths(checkout, { ...cfg, excludeGlobs: merged });
    expect(crawled).toEqual(["src/keep.ts"]);
  });
});

describe("normalizeGlobs", () => {
  test("absent, null, empty, and non-array inputs yield undefined", () => {
    expect(normalizeGlobs(undefined)).toBeUndefined();
    expect(normalizeGlobs(null)).toBeUndefined();
    expect(normalizeGlobs([])).toBeUndefined();
    expect(normalizeGlobs(["", "  "])).toBeUndefined();
    expect(normalizeGlobs("ci/**")).toBeUndefined();
  });

  test("non-string entries are dropped, order preserved", () => {
    expect(normalizeGlobs(["a/**", 42, "b/**"])).toEqual(["a/**", "b/**"]);
  });
});
