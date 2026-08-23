import { describe, expect, test } from "bun:test";
import { loadConfig, paths } from "./config.ts";

describe("Config loader", () => {
  test("defaults apply with empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.dataDir).toBe("./data");
    expect(cfg.maxParallelIndexing).toBe(2);
    expect(cfg.nightlyTime).toEqual({ hour: 2, minute: 0 });
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.port).toBe(7245);
    expect(cfg.bearerToken).toBeUndefined();
    expect(cfg.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.llm.apiKey).toBeUndefined();
    expect(cfg.llm.model).toBeUndefined();
    expect(cfg.embedding.model).toBe("openai/text-embedding-3-small");
    expect(cfg.embedding.dim).toBe(512);
    expect(cfg.openwikiVersion).toBe("^0.3");
    expect(cfg.linkMin).toBe(0); // measure, don't gate
    expect(cfg.topKRepos).toBe(5);
    expect(cfg.fusion.ask.vector).toBeGreaterThan(cfg.fusion.ask.lexical); // vector-leaning
    expect(cfg.fusion.code.lexical).toBeGreaterThan(cfg.fusion.code.vector); // lexical-leaning
  });

  test("env var overrides are honored", () => {
    const cfg = loadConfig({
      ODW_DATA_DIR: "/tmp/dw",
      ODW_MAX_PARALLEL_INDEXING: "4",
      ODW_NIGHTLY_TIME: "03:30",
      ODW_BIND_HOST: "0.0.0.0",
      ODW_PORT: "9000",
      ODW_BEARER_TOKEN: "secret",
      ODW_LLM_BASE_URL: "http://ollama:11434/v1",
      ODW_LLM_API_KEY: "k",
      ODW_LLM_MODEL: "local-model",
      ODW_EMBEDDING_MODEL: "nomic-embed",
      ODW_EMBEDDING_DIM: "128",
      ODW_OPENWIKI_VERSION: "^0.4",
      ODW_TOP_K_REPOS: "3",
      ODW_EVENT_LOG_MAX_BYTES: "2048",
      ODW_OPENWIKI_TIMEOUT_SEC: "60",
      ODW_RG_TIMEOUT_MS: "5000",
      ODW_RG_MAX_COUNT: "100",
      ODW_MAX_FILE_SIZE_BYTES: "2048",
      ODW_INCLUDE_GLOBS: "src/**,docs/**",
      ODW_EXCLUDE_GLOBS: "vendor/**",
      ODW_FUSION_ASK_VECTOR_WEIGHT: "2",
      ODW_FUSION_ASK_LEXICAL_WEIGHT: "1",
    });
    expect(cfg.dataDir).toBe("/tmp/dw");
    expect(cfg.maxParallelIndexing).toBe(4);
    expect(cfg.nightlyTime).toEqual({ hour: 3, minute: 30 });
    expect(cfg.bindHost).toBe("0.0.0.0");
    expect(cfg.port).toBe(9000);
    expect(cfg.bearerToken).toBe("secret");
    expect(cfg.llm).toEqual({
      baseUrl: "http://ollama:11434/v1",
      apiKey: "k",
      model: "local-model",
    });
    expect(cfg.embedding).toEqual({ model: "nomic-embed", dim: 128 });
    expect(cfg.openwikiVersion).toBe("^0.4");
    expect(cfg.topKRepos).toBe(3);
    expect(cfg.includeGlobs).toEqual(["src/**", "docs/**"]);
    expect(cfg.excludeGlobs).toEqual(["vendor/**"]);
    expect(cfg.fusion.ask).toEqual({ vector: 2, lexical: 1 });
  });

  test("OPENROUTER_API_KEY is accepted as the LLM key", () => {
    const cfg = loadConfig({ OPENROUTER_API_KEY: "sk-or-123" });
    expect(cfg.llm.apiKey).toBe("sk-or-123");
  });

  test("invalid values are rejected", () => {
    expect(() => loadConfig({ ODW_PORT: "not-a-number" })).toThrow();
    expect(() => loadConfig({ ODW_PORT: "70000" })).toThrow();
    expect(() => loadConfig({ ODW_NIGHTLY_TIME: "25:00" })).toThrow();
    expect(() => loadConfig({ ODW_MAX_PARALLEL_INDEXING: "0" })).toThrow();
    expect(() => loadConfig({ ODW_EMBEDDING_DIM: "-5" })).toThrow();
  });

  test("paths.data resolves relative to cwd", () => {
    const cfg = loadConfig({ ODW_DATA_DIR: "./rel-data" });
    expect(paths.data(cfg)).toContain("rel-data");
    expect(paths.data(cfg).startsWith("/")).toBe(true);
  });
});

describe("Producer selection", () => {
  test("Default producer", () => {
    const cfg = loadConfig({ ODW_DATA_DIR: "/tmp/x" });
    expect(cfg.producer).toBe("openwiki");
  });

  test("override is honored", () => {
    const cfg = loadConfig({ ODW_DATA_DIR: "/tmp/x", ODW_PRODUCER: "claude" });
    expect(cfg.producer).toBe("claude");
  });

  test("Unknown producer id rejected, naming the available ids", () => {
    let message = "";
    try {
      loadConfig({ ODW_DATA_DIR: "/tmp/x", ODW_PRODUCER: "gpt" });
    } catch (err) {
      message = String(err);
    }
    expect(message).not.toBe("");
    // The error must name what IS available, or a typo is a guessing game.
    expect(message).toContain("openwiki");
    expect(message).toContain("claude");
  });

  test("claude knobs default, and effort is a closed set", () => {
    const cfg = loadConfig({ ODW_DATA_DIR: "/tmp/x" });
    expect(cfg.claude.model).toBe("claude-sonnet-5");
    expect(cfg.claude.effort).toBe("medium");
    expect(cfg.claude.timeoutSec).toBe(3600);
    expect(cfg.claude.stepTimeoutSec).toBe(1800);
    expect(cfg.claude.splitPlanFiles).toBe(2000);
    expect(cfg.claude.pageWorkers).toBe(1); // sequential by default
    // Per-step overrides stay unset: every session uses the run's pair.
    expect(cfg.claude.mapModel).toBeUndefined();
    expect(cfg.claude.planModel).toBeUndefined();
    expect(cfg.claude.pageModel).toBeUndefined();
    expect(cfg.claude.mapEffort).toBeUndefined();
    expect(cfg.claude.planEffort).toBeUndefined();
    expect(cfg.claude.pageEffort).toBeUndefined();
    // Isolation breaks auth (1.7), so no config dir unless explicitly set.
    expect(cfg.claude.configDir).toBeUndefined();

    const over = loadConfig({
      ODW_DATA_DIR: "/tmp/x",
      ODW_CLAUDE_MODEL: "claude-opus-5",
      ODW_CLAUDE_MAP_MODEL: "claude-haiku-4",
      ODW_CLAUDE_PLAN_MODEL: "claude-haiku-4",
      ODW_CLAUDE_PAGE_MODEL: "claude-sonnet-5",
      ODW_CLAUDE_PAGE_EFFORT: "high",
      ODW_CLAUDE_STEP_TIMEOUT_SEC: "120",
      ODW_CLAUDE_SPLIT_PLAN_FILES: "500",
      ODW_CLAUDE_PAGE_WORKERS: "4",
      ODW_CLAUDE_EFFORT: "high",
      ODW_CLAUDE_CONFIG_DIR: "/tmp/cfg",
    });
    expect(over.claude.model).toBe("claude-opus-5");
    expect(over.claude.mapModel).toBe("claude-haiku-4");
    expect(over.claude.planModel).toBe("claude-haiku-4");
    expect(over.claude.pageModel).toBe("claude-sonnet-5");
    expect(over.claude.pageEffort).toBe("high");
    expect(over.claude.mapEffort).toBeUndefined();
    expect(over.claude.effort).toBe("high");
    expect(over.claude.configDir).toBe("/tmp/cfg");
    expect(over.claude.stepTimeoutSec).toBe(120);
    expect(over.claude.splitPlanFiles).toBe(500);
    expect(over.claude.pageWorkers).toBe(4);

    expect(() => loadConfig({ ODW_DATA_DIR: "/tmp/x", ODW_CLAUDE_EFFORT: "turbo" })).toThrow();
    expect(() => loadConfig({ ODW_DATA_DIR: "/tmp/x", ODW_CLAUDE_PAGE_EFFORT: "turbo" })).toThrow();
    // A worker cap below 1 is as meaningless as a negative timeout.
    expect(() => loadConfig({ ODW_DATA_DIR: "/tmp/x", ODW_CLAUDE_PAGE_WORKERS: "0" })).toThrow();
    expect(() =>
      loadConfig({ ODW_DATA_DIR: "/tmp/x", ODW_CLAUDE_PAGE_WORKERS: "not-a-number" }),
    ).toThrow();
  });
});
