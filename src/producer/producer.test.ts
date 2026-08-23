import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkOpenwikiVersion, runOpenwiki } from "./openwiki.ts";
import { runIsolatedProducer } from "./run.ts";
import { openwikiProviderEnv, seedOpenwikiConfig } from "./openwiki.ts";
import { bundleDir, verifyBundle } from "./verify.ts";
import { loadConfig, paths } from "../config/config.ts";
import {
  openwikiExit1,
  openwikiHappy,
  openwikiHang,
  pathWith,
  writeShim,
} from "../../test/helpers/shim.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

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

describe("Non-interactive openwiki invocation", () => {
  test("Initial run produces a bundle", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const cfg = testConfig(dir);

    const res = await runIsolatedProducer(
      cfg,
      "openwiki",
      "init",
      checkout,
      join(dir, "snapshot"),
      {
        env: { PATH: pathWith(shimDir) },
      },
    );

    expect(res.ok).toBe(true);
    expect(res.run.exitCode).toBe(0);
    expect(res.verification?.ok).toBe(true);
    expect(res.verification?.concepts).toBe(5);
    const bundled = await readFile(join(bundleDir(checkout), "token-validation.md"), "utf8");
    expect(bundled).toContain("authenticating users via bearer tokens");
  });

  test("Update run on unchanged repo", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const shimDir = await openwikiHappy(bundleFixture("valid"));
    const cfg = testConfig(dir);
    const snapshot = join(dir, "snapshot");

    const init = await runIsolatedProducer(cfg, "openwiki", "init", checkout, snapshot, {
      env: { PATH: pathWith(shimDir) },
    });
    expect(init.ok).toBe(true);

    const update = await runIsolatedProducer(cfg, "openwiki", "update", checkout, snapshot, {
      env: { PATH: pathWith(shimDir) },
    });
    expect(update.ok).toBe(true);
    expect(update.verification?.concepts).toBe(5);
  });

  test("Non-zero exit is reported", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const shimDir = await openwikiExit1();
    const cfg = testConfig(dir);

    const res = await runIsolatedProducer(
      cfg,
      "openwiki",
      "init",
      checkout,
      join(dir, "snapshot"),
      {
        env: { PATH: pathWith(shimDir) },
      },
    );

    expect(res.ok).toBe(false);
    expect(res.run.exitCode).toBe(1);
    expect(res.run.stderr).toContain("exploded");
    expect(res.restored).toBe(false); // no previous snapshot on first run
  });

  test("Timeout kills the run", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const shimDir = await openwikiHang();
    const cfg = testConfig(dir);

    const res = await runOpenwiki(cfg, "init", checkout, {
      env: { PATH: pathWith(shimDir) },
      timeoutMs: 500,
    });

    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
  });
});

describe("Version pinning", () => {
  test("Version mismatch warning", async () => {
    const dir = await tmp();
    const shimDir = await writeShim("openwiki", 'echo "OpenWiki v1.2.3"');
    const cfg = testConfig(dir, { ODW_OPENWIKI_VERSION: "^0.3" });

    const v = await checkOpenwikiVersion(cfg, { env: { PATH: pathWith(shimDir) } });
    expect(v.installed).toBe("1.2.3");
    expect(v.mismatch).toBe(true);
    expect(v.missing).toBe(false);
  });

  test("Pinned version match", async () => {
    const dir = await tmp();
    const shimDir = await writeShim("openwiki", 'echo "OpenWiki v0.3.4"');
    const cfg = testConfig(dir);

    const v = await checkOpenwikiVersion(cfg, { env: { PATH: pathWith(shimDir) } });
    expect(v.mismatch).toBe(false);
  });

  test("Missing openwiki reported", async () => {
    const dir = await tmp();
    const emptyDir = join(dir, "empty-bin");
    await mkdir(emptyDir);
    const cfg = testConfig(dir);

    const v = await checkOpenwikiVersion(cfg, { env: { PATH: emptyDir } });
    expect(v.missing).toBe(true);
    expect(v.installed).toBeNull();
  });

  test("Missing LLM model or key fails fast with a clear error", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const noModel = testConfig(dir, { ODW_LLM_MODEL: "" });
    const noKey = loadConfig({ ODW_DATA_DIR: dir, ODW_LLM_MODEL: "test-model" });

    const res = await runOpenwiki(noModel, "init", checkout, {});
    expect(res.ok).toBe(false);
    expect(res.spawnError).toContain("ODW_LLM_MODEL");

    const res2 = await runOpenwiki(noKey, "init", checkout, {});
    expect(res2.ok).toBe(false);
    expect(res2.spawnError).toContain("API key");
  });
});

describe("Isolated and pre-seeded openwiki configuration", () => {
  test("First run without wizard", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, {
      OPENROUTER_API_KEY: "sk-test",
      ODW_LLM_MODEL: "test-model",
    });

    const seeded = await seedOpenwikiConfig(cfg);
    expect(seeded.dir).toBe(paths.openwikiHome(cfg));
    await expect(stat(seeded.onboarding)).resolves.toBeTruthy();
    await expect(stat(seeded.instructions)).resolves.toBeTruthy();
    await expect(stat(seeded.env)).resolves.toBeTruthy();

    const onboarding = JSON.parse(await readFile(seeded.onboarding, "utf8"));
    expect(typeof onboarding.completedAt).toBe("string");
    expect(onboarding.modeId).toBe("code");
    expect(onboarding.version).toBe(1);
    expect((await readFile(seeded.instructions, "utf8")).trim().length).toBeGreaterThan(0);
    const envContent = await readFile(seeded.env, "utf8");
    expect(envContent).toContain("OPENWIKI_PROVIDER=openrouter");
    expect(envContent).toContain("OPENROUTER_API_KEY=sk-test");
    expect(envContent).toContain("OPENWIKI_MODEL_ID=test-model");
    expect(envContent).toContain("OPENWIKI_TELEMETRY_DISABLED=1");
  });

  test("Custom OpenAI-compatible endpoint seeds openai-compatible provider", async () => {
    const dir = await tmp();
    const cfg = testConfig(dir, {
      ODW_LLM_BASE_URL: "http://localhost:11434/v1",
      ODW_LLM_API_KEY: "ollama",
      ODW_LLM_MODEL: "qwen3:8b",
    });

    const env = openwikiProviderEnv(cfg);
    expect(env.OPENWIKI_PROVIDER).toBe("openai-compatible");
    expect(env.OPENAI_COMPATIBLE_API_KEY).toBe("ollama");
    expect(env.OPENAI_COMPATIBLE_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.OPENWIKI_MODEL_ID).toBe("qwen3:8b");

    const seeded = await seedOpenwikiConfig(cfg);
    const envContent = await readFile(seeded.env, "utf8");
    expect(envContent).toContain("OPENWIKI_PROVIDER=openai-compatible");
    expect(envContent).toContain("OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1");
  });

  test("Isolated HOME reaches the child process", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const cfg = testConfig(dir);

    const shimDir = await writeShim(
      "openwiki",
      [
        'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
        'echo "$HOME" > ./cfghome.txt',
        "mkdir -p ./openwiki",
        `cp -r '${bundleFixture("valid")}/.' ./openwiki/`,
        "exit 0",
      ].join("\n"),
    );

    const res = await runIsolatedProducer(
      cfg,
      "openwiki",
      "init",
      checkout,
      join(dir, "snapshot"),
      {
        env: { PATH: pathWith(shimDir) },
      },
    );
    expect(res.ok).toBe(true);
    expect((await readFile(join(checkout, "cfghome.txt"), "utf8")).trim()).toBe(
      paths.openwikiConfig(cfg),
    );
  });
});

describe("OKF v0.2 bundle verification", () => {
  test("Valid bundle accepted", async () => {
    const res = await verifyBundle(bundleFixture("valid"));
    expect(res.ok).toBe(true);
    expect(res.concepts).toBe(5);
    expect(res.indexPresent).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("Malformed bundle rejected", async () => {
    const missing = await verifyBundle(bundleFixture("malformed"));
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContainEqual({ file: "wiki/bad.md", reason: "missing frontmatter" });

    const emptyType = await verifyBundle(bundleFixture("malformed-empty-type"));
    expect(emptyType.ok).toBe(false);
    expect(emptyType.errors).toContainEqual({ file: "wiki/bad.md", reason: "empty type" });

    // A frontmatter block that is present but unparseable: the `---` check
    // passes and the YAML parser throws. That must be reported as a
    // verification failure, not raised out of verifyBundle.
    const badYaml = await verifyBundle(bundleFixture("malformed-yaml"));
    expect(badYaml.ok).toBe(false);
    expect(badYaml.errors).toHaveLength(1);
    expect(badYaml.errors[0]?.file).toBe("wiki/bad.md");
    expect(badYaml.errors[0]?.reason).toStartWith("unparseable frontmatter:");
  });

  test("verification is not poisoned by an earlier parse of the same bytes", async () => {
    // gray-matter caches by content string when called with no options, and a
    // parse that threw leaves a poisoned `{}` entry — so a prior consumer that
    // swallowed the throw (grounding, typeVocabulary) could make verifyBundle
    // silently see empty frontmatter instead of failing. Parse the same bundle
    // through a swallowing path FIRST, then verify: the reason must still be
    // the unparseable-frontmatter one.
    const { typeVocabulary } = await import("./anchor.ts");
    await typeVocabulary(bundleFixture("malformed-yaml"));

    const res = await verifyBundle(bundleFixture("malformed-yaml"));
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.reason).toStartWith("unparseable frontmatter:");
  });

  test("Missing bundle rejected", async () => {
    const dir = await tmp();
    const res = await verifyBundle(join(dir, "nonexistent"));
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.reason).toContain("missing");
  });
});

describe("Failure isolation", () => {
  test("Failed update keeps last good bundle", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const snapshot = join(dir, "snapshot");
    const cfg = testConfig(dir);
    const happy = await openwikiHappy(bundleFixture("valid"));
    const failing = await openwikiExit1();

    const init = await runIsolatedProducer(cfg, "openwiki", "init", checkout, snapshot, {
      env: { PATH: pathWith(happy) },
    });
    expect(init.ok).toBe(true);
    expect(await verifyBundle(bundleDir(checkout))).toHaveProperty("ok", true);

    const update = await runIsolatedProducer(cfg, "openwiki", "update", checkout, snapshot, {
      env: { PATH: pathWith(failing) },
    });
    expect(update.ok).toBe(false);
    expect(update.restored).toBe(true);

    // Previous verified bundle remains in place and queryable (conforms).
    const after = await verifyBundle(bundleDir(checkout));
    expect(after.ok).toBe(true);
    expect(after.concepts).toBe(5);
    const bundled = await readFile(join(bundleDir(checkout), "token-validation.md"), "utf8");
    expect(bundled).toContain("authenticating users via bearer tokens");
  });

  test("Verification failure restores last good bundle", async () => {
    const dir = await tmp();
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    const snapshot = join(dir, "snapshot");
    const cfg = testConfig(dir);

    const happy = await openwikiHappy(bundleFixture("valid"));
    const init = await runIsolatedProducer(cfg, "openwiki", "init", checkout, snapshot, {
      env: { PATH: pathWith(happy) },
    });
    expect(init.ok).toBe(true);

    // Next run "produces" a malformed bundle.
    const malformed = await openwikiHappy(bundleFixture("malformed"));
    const update = await runIsolatedProducer(cfg, "openwiki", "update", checkout, snapshot, {
      env: { PATH: pathWith(malformed) },
    });

    expect(update.ok).toBe(false);
    expect(update.restored).toBe(true);
    expect(update.verification?.errors[0]).toEqual({
      file: "wiki/bad.md",
      reason: "missing frontmatter",
    });
    const after = await verifyBundle(bundleDir(checkout));
    expect(after.ok).toBe(true);
    expect(after.concepts).toBe(5);
  });
});
