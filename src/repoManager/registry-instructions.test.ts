import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { openDb } from "../index/db.ts";
import { runPipeline, recordRun, seedWikiInstructions } from "./pipeline.ts";
import { loadRegistry, saveRegistry, getRepo, type RepoRecord } from "./registry.ts";
import { openContext } from "./context.ts";
import { addRepo, instructionsCommand, listRepos } from "../cli/main.ts";
import { classifyHealth } from "../monitor/health.ts";
import { createGitRepo } from "../../test/helpers/gitFixture.ts";
import { writeShim, pathWith } from "../../test/helpers/shim.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { paths } from "../config/config.ts";

let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: Client[] = [];

async function tmp(): Promise<string> {
  const d = await makeTmp();
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  for (const c of cleanups) c();
  cleanups = [];
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs = [];
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

function makeRecord(dir: string, overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    repoId: "repoA",
    source: "git@gitlab.corp:team/repo.git",
    clonePath: join(dir, "repos", "repoA", "checkout"),
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
    ...overrides,
  };
}

describe("Registry: YAML + state split", () => {
  test("YAML round-trip: human fields in registry.yaml, run state in state.json", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const record = makeRecord(dir, {
      instructions: "Focus on the public API.\n",
      lastRun: {
        startedAt: null,
        finishedAt: "now",
        outcome: "success",
        durationMs: 42,
        tokens: null,
        error: null,
      },
      lastIndexedSha: "abc",
    });
    await saveRegistry(cfg, { repos: [record] });

    const yaml = await readFile(paths.registryYaml(cfg), "utf8");
    expect(yaml).toContain("repoId: repoA");
    expect(yaml).toContain("instructions: |");
    expect(yaml).toContain("Focus on the public API.");
    expect(yaml).not.toContain("lastIndexedSha");
    expect(yaml).not.toContain("lastRun");

    const state = JSON.parse(await readFile(paths.state(cfg), "utf8")) as Record<string, unknown>;
    expect(state["repoA"]).toBeDefined();
    expect((state["repoA"] as { lastIndexedSha: string }).lastIndexedSha).toBe("abc");

    const reloaded = await loadRegistry(cfg);
    expect(reloaded.repos[0]?.instructions).toBe("Focus on the public API.\n");
    expect(reloaded.repos[0]?.lastIndexedSha).toBe("abc");
  });

  test("Comments survive machine saves", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    // Operator hand-edits: comments + a schedule override.
    const file = paths.registryYaml(cfg);
    const hand = `# repos — hand-edited, comments must survive\nrepos:\n  - repoId: repoA   # my repo\n    source: git@gitlab.corp:team/repo.git\n    schedule: "0 * * * *"\n`;
    await writeFile(file, hand);

    const registry = await loadRegistry(cfg);
    expect(registry.repos[0]?.schedule).toBe("0 * * * *");
    registry.repos.push(makeRecord(dir, { repoId: "repoB", source: "git@gitlab.corp:team/b.git" }));
    await saveRegistry(cfg, registry);

    const after = await readFile(file, "utf8");
    expect(after).toContain("# repos — hand-edited, comments must survive");
    expect(after).toContain("# my repo");
    expect(after).toContain("repoId: repoB");
  });

  test("Legacy registry.json migrated once, left in place", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const legacy = makeRecord(dir, {
      lastIndexedSha: "deadbeef",
      lastSuccessAt: "2026-08-01T00:00:00Z",
    });
    await writeFile(paths.registryLegacy(cfg), `${JSON.stringify({ repos: [legacy] }, null, 2)}\n`);

    const migrated = await loadRegistry(cfg);
    expect(migrated.repos).toHaveLength(1);
    expect(migrated.repos[0]?.repoId).toBe("repoA");
    expect(migrated.repos[0]?.lastIndexedSha).toBe("deadbeef");

    // New files written; legacy untouched.
    const yaml = await readFile(paths.registryYaml(cfg), "utf8");
    expect(yaml).toContain("repoA");
    const state = JSON.parse(await readFile(paths.state(cfg), "utf8")) as Record<
      string,
      { lastIndexedSha: string }
    >;
    expect(state["repoA"]?.lastIndexedSha).toBe("deadbeef");
    const legacyRaw = JSON.parse(await readFile(paths.registryLegacy(cfg), "utf8")) as {
      repos: unknown[];
    };
    expect(legacyRaw.repos).toHaveLength(1);

    // Second load uses the YAML (idempotent): mutate legacy, reload, unaffected.
    await writeFile(paths.registryLegacy(cfg), `{"repos": []}`);
    const again = await loadRegistry(cfg);
    expect(again.repos).toHaveLength(1);
  });

  test("Orphan state entries are ignored and purged with the repo", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await saveRegistry(cfg, { repos: [makeRecord(dir)] });
    // State for an unregistered repoId.
    const stateFile = paths.state(cfg);
    const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    state["ghost"] = {
      clonePath: "/x",
      addedAt: "t",
      lastRun: {},
      lastIndexedSha: null,
      lastSuccessAt: null,
    };
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const registry = await loadRegistry(cfg);
    expect(registry.repos.map((r) => r.repoId)).toEqual(["repoA"]); // ghost ignored

    registry.repos = registry.repos.filter((r) => r.repoId !== "repoA");
    await saveRegistry(cfg, registry);
    const after = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    expect(after["repoA"]).toBeUndefined(); // removed with the repo
    expect(after["ghost"]).toBeUndefined(); // dropped as orphan on save
  });

  test("Invalid YAML fails with a clear error", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await writeFile(paths.registryYaml(cfg), "repos: [unclosed\n");
    await expect(loadRegistry(cfg)).rejects.toThrow(/not valid YAML/);
  });

  test("Malformed repo entries fail with clear errors", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const file = paths.registryYaml(cfg);

    await writeFile(file, "repos:\n  - just-a-scalar\n");
    await expect(loadRegistry(cfg)).rejects.toThrow(/entry #1 is not a repo mapping/);

    await writeFile(file, "repos:\n  - source: git@gitlab.corp:team/repo.git\n");
    await expect(loadRegistry(cfg)).rejects.toThrow(/entry #1 is missing repoId/);

    await writeFile(file, "repos:\n  - repoId: a\n    source: s1\n  - repoId: a\n    source: s2\n");
    await expect(loadRegistry(cfg)).rejects.toThrow(/duplicate repoId "a"/);
  });

  test("Corrupt legacy registry.json fails with a friendly error", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    await writeFile(paths.registryLegacy(cfg), "{not json");
    await expect(loadRegistry(cfg)).rejects.toThrow(/registry\.json is not valid JSON/);
  });
});

describe("Wiki instructions", () => {
  test("Custom prompt reaches openwiki before it starts", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    // Shim snapshots the seeded INSTRUCTIONS.md before "generating" the bundle.
    const shimDir = await writeShim(
      "openwiki",
      [
        'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
        "if [ -f ./openwiki/INSTRUCTIONS.md ]; then cp ./openwiki/INSTRUCTIONS.md ./instructions-seen.txt; fi",
        "mkdir -p ./openwiki",
        `cp -r '${bundleFixture("valid")}/.' ./openwiki/`,
        "exit 0",
      ].join("\n"),
    );
    const record = makeRecord(dir, {
      source: remote,
      instructions: "Focus on the public API surface and auth flows.\n",
    });
    const result = await runPipeline(cfg, db, record, "init", { env: { PATH: pathWith(shimDir) } });
    expect(result.ok).toBe(true);
    expect(await readFile(join(record.clonePath, "instructions-seen.txt"), "utf8")).toBe(
      "---\ntype: instructions\n---\n\nFocus on the public API surface and auth flows.\n",
    );
  });

  test("Seeded instructions pass bundle verification", async () => {
    const dir = await tmp();
    const record = makeRecord(dir, { instructions: "Custom goal.\n" });
    await seedWikiInstructions(record, record.clonePath);
    const bundle = join(record.clonePath, "openwiki");
    await Bun.write(join(bundle, "index.md"), '---\nokf_version: "0.1"\n---\n');
    const { verifyBundle } = await import("../producer/verify.ts");
    const result = await verifyBundle(bundle);
    expect(result.ok).toBe(true);
    // INSTRUCTIONS.md is a RESERVED structural file, so it is exempt from the
    // frontmatter check and not counted as a concept — openwiki's own docs
    // classify it alongside index.md/log.md.
    expect(result.concepts).toBe(0);
  });

  test("Update re-applies configured instructions", async () => {
    const dir = await tmp();
    const record = makeRecord(dir, { instructions: "Custom goal.\n" });
    await mkdir(join(record.clonePath, "openwiki"), { recursive: true });
    await writeFile(join(record.clonePath, "openwiki", "INSTRUCTIONS.md"), "agent rewrote me\n");

    expect(await seedWikiInstructions(record, record.clonePath)).toBe(true);
    expect(await readFile(join(record.clonePath, "openwiki", "INSTRUCTIONS.md"), "utf8")).toBe(
      "---\ntype: instructions\n---\n\nCustom goal.\n",
    );
  });

  test("No instructions leaves the file untouched", async () => {
    const dir = await tmp();
    const record = makeRecord(dir); // no instructions
    await mkdir(join(record.clonePath, "openwiki"), { recursive: true });
    await writeFile(join(record.clonePath, "openwiki", "INSTRUCTIONS.md"), "agent content\n");

    expect(await seedWikiInstructions(record, record.clonePath)).toBe(false);
    expect(await readFile(join(record.clonePath, "openwiki", "INSTRUCTIONS.md"), "utf8")).toBe(
      "agent content\n",
    );
  });

  test("repo add --instructions stores the prompt; instructions command shows it", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    const remote = await createGitRepo(join(dir, "remote"), { "src/a.ts": "a\n" });
    const ctx = await openContext(cfg);
    dbs.push(ctx.db);

    const promptFile = join(dir, "prompt.md");
    await writeFile(promptFile, "Focus on auth flows.\n");
    const code = await addRepo(ctx, remote, true, await readFile(promptFile, "utf8"));
    expect(code).toBe(0);

    const yaml = await readFile(paths.registryYaml(cfg), "utf8");
    expect(yaml).toContain("instructions: |");
    expect(yaml).toContain("Focus on auth flows.");

    const reloaded = await loadRegistry(cfg);
    expect(getRepo(reloaded, "local/remote")?.instructions).toBe("Focus on auth flows.\n");

    // instructions command: unknown repo errors; configured repo prints.
    const unknown = await instructionsCommand(ctx, ["nope/nope"]);
    expect(unknown).toBe(1);
    const shown = await instructionsCommand(ctx, ["local/remote", "--show"]);
    expect(shown).toBe(0);
  });

  test("repo list flags custom instructions", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);
    await saveRegistry(cfg, {
      repos: [makeRecord(dir, { instructions: "custom\n" }), makeRecord(dir, { repoId: "repoB" })],
    });
    const ctx = await openContext(cfg);
    dbs.push(ctx.db);

    const out: string[] = [];
    const originalLog = console.log;
    const spy = { log: originalLog };
    console.log = (...args: unknown[]) => {
      out.push(args.join(" "));
    };
    try {
      await listRepos(ctx, false);
    } finally {
      console.log = spy.log;
    }
    const repoALine = out.find((l) => l.includes("repoA"));
    const repoBLine = out.find((l) => l.includes("repoB"));
    expect(repoALine?.includes("+instructions")).toBe(true);
    expect(repoBLine?.includes("+instructions")).toBe(false);
  });
});
describe("Monitoring from the state store", () => {
  test("Run state recorded via state.json drives health classification", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir);
    const record = makeRecord(dir);
    await saveRegistry(cfg, { repos: [record] });

    // A failed run recorded through the normal save path.
    record.lastRun = {
      startedAt: null,
      finishedAt: new Date().toISOString(),
      outcome: "failed",
      durationMs: 5,
      tokens: null,
      error: "openwiki exited 1",
    };
    await saveRegistry(cfg, { repos: [record] });

    const reloaded = await loadRegistry(cfg);
    const repo = reloaded.repos[0];
    expect(repo?.lastRun.error).toBe("openwiki exited 1");
    expect(classifyHealth(repo as RepoRecord, cfg)).toBe("red");
    void recordRun; // exercised at pipeline level elsewhere
  });
});
