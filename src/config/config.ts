import { z } from "zod";
import { resolve } from "node:path";

/**
 * Config loader: `ODW_*` environment variables (auto-loaded from `.env` by Bun)
 * with baked-in defaults. Every knob is declared in the schema below — that is
 * the list. Per-repo overrides live in the registry, not here.
 */

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Every producer the system knows how to run. */
export const PRODUCER_IDS = ["openwiki", "claude"] as const;
export type ProducerId = (typeof PRODUCER_IDS)[number];

const EFFORT_SET = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof EFFORT_SET)[number];

/** The one membership check for a known producer id — shared by the CLI flag,
 *  the admin API body, and registry load. */
export function isProducerId(value: unknown): value is ProducerId {
  return typeof value === "string" && (PRODUCER_IDS as readonly string[]).includes(value);
}

const Env = z.object({
  ODW_DATA_DIR: z.string().default("./data"),
  ODW_MAX_PARALLEL_INDEXING: z.coerce.number().int().positive().default(2),
  ODW_NIGHTLY_TIME: z.string().regex(HHMM).default("02:00"),
  ODW_BIND_HOST: z.string().default("127.0.0.1"),
  ODW_PORT: z.coerce.number().int().min(1).max(65535).default(7245),
  ODW_BEARER_TOKEN: z.string().optional(),
  ODW_LLM_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  ODW_LLM_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  ODW_LLM_MODEL: z.string().optional(),
  ODW_EMBEDDING_MODEL: z.string().default("openai/text-embedding-3-small"),
  ODW_EMBEDDING_DIM: z.coerce.number().int().positive().default(512),
  ODW_OPENWIKI_VERSION: z.string().default("^0.3"),
  // An unknown id is rejected at parse time, naming the available ones, so a
  // typo fails loudly instead of falling back to the default.
  ODW_PRODUCER: z.enum(PRODUCER_IDS).default("openwiki"),
  ODW_CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
  // Per-step overrides, empty = the run-wide value. Map and planning output
  // is deterministically validated, so they tolerate a cheaper model.
  ODW_CLAUDE_MAP_MODEL: z.string().default(""),
  ODW_CLAUDE_PLAN_MODEL: z.string().default(""),
  ODW_CLAUDE_PAGE_MODEL: z.string().default(""),
  // A fixed default, so runs are comparable across machines and over time.
  ODW_CLAUDE_EFFORT: z.enum(EFFORT_SET).default("medium"),
  ODW_CLAUDE_MAP_EFFORT: z.union([z.literal(""), z.enum(EFFORT_SET)]).default(""),
  ODW_CLAUDE_PLAN_EFFORT: z.union([z.literal(""), z.enum(EFFORT_SET)]).default(""),
  ODW_CLAUDE_PAGE_EFFORT: z.union([z.literal(""), z.enum(EFFORT_SET)]).default(""),
  // Whole-run budget: a planning session plus every page session (concurrent
  // workers share this one wall clock) and the overview.
  ODW_CLAUDE_TIMEOUT_SEC: z.coerce.number().int().positive().default(3600),
  // Bounds one child session, so one stuck page can't eat the whole budget.
  ODW_CLAUDE_STEP_TIMEOUT_SEC: z.coerce.number().int().positive().default(1800),
  // Page sessions run concurrently up to this cap; 1 = strictly sequential.
  // They share one whole-run deadline — the knob buys wall-clock, not budget.
  ODW_CLAUDE_PAGE_WORKERS: z.coerce.number().int().positive().default(1),
  // Init runs above this many documentable files split planning into a map plus
  // one bounded session per area — one session's loss costs one area, not
  // the whole plan (checkpointed planning for large initial bundles).
  ODW_CLAUDE_SPLIT_PLAN_FILES: z.coerce.number().int().positive().default(2000),
  // Empty default: config-dir isolation breaks `claude` auth. Set it only to
  // a directory that has been authenticated once.
  ODW_CLAUDE_CONFIG_DIR: z.string().default(""),
  // Acceptance floors; 0 = measure but do not gate. An uncalibrated floor
  // rejects bundles from a producer that simply does not cite, and scores are
  // recorded either way — real openwiki output measures 0.9-1.0 grounding at
  // density 3.9-22.8/1000 words, so calibrate in there.
  ODW_GROUNDING_MIN: z.coerce.number().min(0).max(1).default(0),
  ODW_GROUNDING_MIN_DENSITY: z.coerce.number().min(0).default(0),
  ODW_INIT_COVERAGE_MIN: z.coerce.number().min(0).max(1).default(0),
  // Never gates uncalibrated: the canonical `valid` test fixture itself
  // carries one deliberately unresolved link.
  ODW_LINK_MIN: z.coerce.number().min(0).max(1).default(0),
  // Runs high by construction — a bundle has far fewer pages than a repo has
  // files (one page revised for one changed file out of 500 is already ~25x).
  ODW_UPDATE_MAX_CHURN_RATIO: z.coerce.number().min(0).default(0),
  // Otherwise a repo that always dies mid-build retries nightly forever.
  ODW_MAX_RESUME_ATTEMPTS: z.coerce.number().int().positive().default(3),
  ODW_TOP_K_REPOS: z.coerce.number().int().positive().default(5),
  ODW_EVENT_LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  ODW_OPENWIKI_TIMEOUT_SEC: z.coerce.number().int().positive().default(3600),
  ODW_RG_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ODW_RG_MAX_COUNT: z.coerce.number().int().positive().default(500),
  ODW_VECTOR_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.05),
  ODW_MAX_FILE_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  ODW_INCLUDE_GLOBS: z.string().default("**"),
  ODW_EXCLUDE_GLOBS: z
    .string()
    .default(
      "node_modules/**,.git/**,openwiki/**,dist/**,build/**,.env,.env.*,*.lock,package-lock.json,pnpm-lock.yaml,yarn.lock,*.min.js",
    ),
  ODW_FUSION_ASK_VECTOR_WEIGHT: z.coerce.number().positive().default(1.0),
  ODW_FUSION_ASK_LEXICAL_WEIGHT: z.coerce.number().positive().default(0.7),
  ODW_FUSION_CODE_VECTOR_WEIGHT: z.coerce.number().positive().default(0.7),
  ODW_FUSION_CODE_LEXICAL_WEIGHT: z.coerce.number().positive().default(1.0),
});

type FusionWeights = { vector: number; lexical: number };
type FusionConfig = { ask: FusionWeights; code: FusionWeights };
type NightlyTime = { hour: number; minute: number };
type LlmConfig = { baseUrl: string; apiKey: string | undefined; model: string | undefined };
type EmbeddingConfig = { model: string; dim: number };

export type Config = {
  dataDir: string;
  maxParallelIndexing: number;
  nightlyTime: NightlyTime;
  bindHost: string;
  port: number;
  bearerToken: string | undefined;
  llm: LlmConfig;
  embedding: EmbeddingConfig;
  /** Cosine similarity floor for "relevant" vector results (no-results honesty). */
  vectorMinSimilarity: number;
  openwikiVersion: string;
  producer: ProducerId;
  claude: {
    model: string;
    /** Per-step overrides; undefined = use `model`. */
    mapModel: string | undefined;
    planModel: string | undefined;
    pageModel: string | undefined;
    effort: ClaudeEffort;
    mapEffort: ClaudeEffort | undefined;
    planEffort: ClaudeEffort | undefined;
    pageEffort: ClaudeEffort | undefined;
    timeoutSec: number;
    stepTimeoutSec: number;
    /** Concurrent page sessions (1 = sequential). */
    pageWorkers: number;
    /** Tracked files above which init planning splits (map → areas). */
    splitPlanFiles: number;
    /** Empty means "inherit the ambient config" — see ODW_CLAUDE_CONFIG_DIR. */
    configDir: string | undefined;
  };
  grounding: { min: number; minDensity: number };
  linkMin: number;
  initCoverageMin: number;
  updateMaxChurnRatio: number;
  maxResumeAttempts: number;
  topKRepos: number;
  eventLogMaxBytes: number;
  openwikiTimeoutSec: number;
  rgTimeoutMs: number;
  rgMaxCountPerFile: number;
  maxFileSizeBytes: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  fusion: FusionConfig;
};

function parseHHMM(raw: string): NightlyTime {
  const [h, m] = raw.split(":");
  return { hour: Number(h ?? 0), minute: Number(m ?? 0) };
}

function csv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  return {
    dataDir: parsed.ODW_DATA_DIR,
    maxParallelIndexing: parsed.ODW_MAX_PARALLEL_INDEXING,
    nightlyTime: parseHHMM(parsed.ODW_NIGHTLY_TIME),
    bindHost: parsed.ODW_BIND_HOST,
    port: parsed.ODW_PORT,
    bearerToken: parsed.ODW_BEARER_TOKEN,
    llm: {
      baseUrl: parsed.ODW_LLM_BASE_URL,
      apiKey: parsed.ODW_LLM_API_KEY ?? parsed.OPENROUTER_API_KEY,
      model: parsed.ODW_LLM_MODEL,
    },
    embedding: {
      model: parsed.ODW_EMBEDDING_MODEL,
      dim: parsed.ODW_EMBEDDING_DIM,
    },
    vectorMinSimilarity: parsed.ODW_VECTOR_MIN_SIMILARITY,
    openwikiVersion: parsed.ODW_OPENWIKI_VERSION,
    producer: parsed.ODW_PRODUCER,
    claude: {
      model: parsed.ODW_CLAUDE_MODEL,
      mapModel: parsed.ODW_CLAUDE_MAP_MODEL === "" ? undefined : parsed.ODW_CLAUDE_MAP_MODEL,
      planModel: parsed.ODW_CLAUDE_PLAN_MODEL === "" ? undefined : parsed.ODW_CLAUDE_PLAN_MODEL,
      pageModel: parsed.ODW_CLAUDE_PAGE_MODEL === "" ? undefined : parsed.ODW_CLAUDE_PAGE_MODEL,
      effort: parsed.ODW_CLAUDE_EFFORT,
      mapEffort: parsed.ODW_CLAUDE_MAP_EFFORT === "" ? undefined : parsed.ODW_CLAUDE_MAP_EFFORT,
      planEffort: parsed.ODW_CLAUDE_PLAN_EFFORT === "" ? undefined : parsed.ODW_CLAUDE_PLAN_EFFORT,
      pageEffort: parsed.ODW_CLAUDE_PAGE_EFFORT === "" ? undefined : parsed.ODW_CLAUDE_PAGE_EFFORT,
      timeoutSec: parsed.ODW_CLAUDE_TIMEOUT_SEC,
      stepTimeoutSec: parsed.ODW_CLAUDE_STEP_TIMEOUT_SEC,
      pageWorkers: parsed.ODW_CLAUDE_PAGE_WORKERS,
      splitPlanFiles: parsed.ODW_CLAUDE_SPLIT_PLAN_FILES,
      configDir: parsed.ODW_CLAUDE_CONFIG_DIR === "" ? undefined : parsed.ODW_CLAUDE_CONFIG_DIR,
    },
    grounding: {
      min: parsed.ODW_GROUNDING_MIN,
      minDensity: parsed.ODW_GROUNDING_MIN_DENSITY,
    },
    linkMin: parsed.ODW_LINK_MIN,
    initCoverageMin: parsed.ODW_INIT_COVERAGE_MIN,
    updateMaxChurnRatio: parsed.ODW_UPDATE_MAX_CHURN_RATIO,
    maxResumeAttempts: parsed.ODW_MAX_RESUME_ATTEMPTS,
    topKRepos: parsed.ODW_TOP_K_REPOS,
    eventLogMaxBytes: parsed.ODW_EVENT_LOG_MAX_BYTES,
    openwikiTimeoutSec: parsed.ODW_OPENWIKI_TIMEOUT_SEC,
    rgTimeoutMs: parsed.ODW_RG_TIMEOUT_MS,
    rgMaxCountPerFile: parsed.ODW_RG_MAX_COUNT,
    maxFileSizeBytes: parsed.ODW_MAX_FILE_SIZE_BYTES,
    includeGlobs: csv(parsed.ODW_INCLUDE_GLOBS),
    excludeGlobs: csv(parsed.ODW_EXCLUDE_GLOBS),
    fusion: {
      ask: {
        vector: parsed.ODW_FUSION_ASK_VECTOR_WEIGHT,
        lexical: parsed.ODW_FUSION_ASK_LEXICAL_WEIGHT,
      },
      code: {
        vector: parsed.ODW_FUSION_CODE_VECTOR_WEIGHT,
        lexical: parsed.ODW_FUSION_CODE_LEXICAL_WEIGHT,
      },
    },
  };
}

/** Absolute paths under the data directory, resolved against cwd when relative. */
export const paths = {
  /** The data directory itself. */
  data: (cfg: Config) => resolve(cfg.dataDir),
  indexDb: (cfg: Config) => `${paths.data(cfg)}/index.db`,
  registryYaml: (cfg: Config) => `${paths.data(cfg)}/registry.yaml`,
  registryLegacy: (cfg: Config) => `${paths.data(cfg)}/registry.json`,
  state: (cfg: Config) => `${paths.data(cfg)}/state.json`,
  repos: (cfg: Config) => `${paths.data(cfg)}/repos`,
  events: (cfg: Config) => `${paths.data(cfg)}/events.jsonl`,
  locks: (cfg: Config) => `${paths.data(cfg)}/locks`,
  openwikiConfig: (cfg: Config) => `${paths.data(cfg)}/openwiki-config`,
  /** openwiki hardcodes `~/.openwiki` (no env override in v0.3) — isolation via HOME. */
  openwikiHome: (cfg: Config) => `${paths.openwikiConfig(cfg)}/.openwiki`,
  checkout: (cfg: Config, repoId: string) => `${paths.repos(cfg)}/${repoId}/checkout`,
  lock: (cfg: Config, repoId: string) => `${paths.locks(cfg)}/${repoId}.lock`,
};
