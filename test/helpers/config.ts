import { loadConfig, type Config } from "../../src/config/config.ts";

/** Test config: tmpdir dataDir + small embedding dim for fast deterministic vectors. */
export function testConfig(dataDir: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    ODW_DATA_DIR: dataDir,
    ODW_EMBEDDING_DIM: "1024",
    ODW_VECTOR_MIN_SIMILARITY: "0.08",
    ODW_LLM_MODEL: "test-model",
    OPENROUTER_API_KEY: "sk-test",
    // Capped low so a stray real CLI on PATH fails fast, not after an hour.
    ODW_OPENWIKI_TIMEOUT_SEC: "30",
    ODW_CLAUDE_TIMEOUT_SEC: "30",
    ODW_CLAUDE_STEP_TIMEOUT_SEC: "20",
    ...overrides,
  });
}
