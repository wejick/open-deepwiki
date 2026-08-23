import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML, { YAMLMap, YAMLSeq } from "yaml";
import { isProducerId, paths, type Config, type ProducerId } from "../config/config.ts";

/**
 * Repo registry — two stores:
 *
 * - `<dataDir>/registry.yaml` — HUMAN-owned (repoId, source, schedule,
 *   options, instructions). Hand-editable; comments and formatting survive
 *   machine saves (we mutate a parsed yaml Document, never re-stringify
 *   plain objects).
 * - `<dataDir>/state.json` — MACHINE-owned run state per repoId (clonePath,
 *   addedAt, lastRun, lastIndexedSha, lastSuccessAt), atomic tmp+rename.
 *
 * `loadRegistry` merges both into the runtime RepoRecord. A legacy
 * `registry.json` (pre-split format) is migrated once on first load.
 */

export type RepoOptions = {
  /** Skip openwiki wiki generation — source-index-only. */
  noWiki?: boolean;
};

/** Human-owned registry fields (persisted in registry.yaml). */
export type RepoConfig = {
  repoId: string;
  source: string;
  /** Per-repo cron override (null = default nightly schedule). */
  schedule: string | null;
  options: RepoOptions;
  /** Custom wiki generation prompt — seeded into the bundle INSTRUCTIONS.md. */
  instructions: string | undefined;
  /** Per-repo override; undefined means the global default. Changing it is a
   *  config edit only, which is what makes migration reversible. */
  producer: ProducerId | undefined;
  /** Repo-specific exclude globs, merged additively with the global
   *  ODW_EXCLUDE_GLOBS (narrowing only); absent = global list alone. Optional
   *  so existing RepoRecord literals (state builders, tests) need no churn. */
  excludeGlobs?: string[] | undefined;
};

/** Machine-owned run state (persisted in state.json). */
export type RunState = {
  clonePath: string;
  addedAt: string;
  lastRun: {
    startedAt: string | null;
    finishedAt: string | null;
    outcome: "success" | "failed" | "skipped" | "rate_limited" | null;
    durationMs: number | null;
    tokens: number | null;
    error: string | null;
    /** For rate_limited: when the provider says the limit resets. */
    resetAt?: string | undefined;
    /** Recorded so grounding regressions are observable. */
    groundingScore?: number | undefined;
  };
  lastIndexedSha: string | null;
  lastSuccessAt: string | null;
};

/** Merged runtime record (config + state). */
export type RepoRecord = RepoConfig & RunState;

export type Registry = { repos: RepoRecord[] };

export function emptyRegistry(): Registry {
  return { repos: [] };
}

/**
 * Registry globs from any input (YAML entry, CLI flag, API field): trimmed,
 * empties dropped, deduplicated preserving first occurrence. `undefined` for
 * absent/empty/not-an-array — hand-edited YAML falls back to the global list
 * rather than failing the load, matching the `producer` field's tolerance.
 */
export function normalizeGlobs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const glob = entry.trim();
    if (glob !== "" && !out.includes(glob)) out.push(glob);
  }
  return out.length > 0 ? out : undefined;
}

function defaultState(repoId: string, cfg: Config): RunState {
  return {
    clonePath: paths.checkout(cfg, repoId),
    addedAt: new Date().toISOString(),
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
  };
}

function runStateOf(repo: RepoRecord): RunState {
  return {
    clonePath: repo.clonePath,
    addedAt: repo.addedAt,
    lastRun: repo.lastRun,
    lastIndexedSha: repo.lastIndexedSha,
    lastSuccessAt: repo.lastSuccessAt,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// ---- load ----

type YamlRegistry = { repos?: unknown };

export async function loadRegistry(cfg: Config): Promise<Registry> {
  const yamlFile = paths.registryYaml(cfg);

  if (!(await exists(yamlFile))) {
    // One-time migration from the pre-split JSON registry.
    if (await exists(paths.registryLegacy(cfg))) {
      return migrateLegacyJson(cfg);
    }
    return emptyRegistry();
  }

  const doc = YAML.parseDocument(await readFile(yamlFile, "utf8"));
  if (doc.errors.length > 0) {
    throw new Error(
      `${yamlFile} is not valid YAML: ${doc.errors[0]?.message ?? "parse error"} — fix or remove the file`,
    );
  }
  const parsed = doc.toJS({ mapAsMap: false }) as YamlRegistry;
  if (!Array.isArray(parsed?.repos)) {
    return { repos: [] };
  }
  const seen = new Set<string>();
  const configs: RepoConfig[] = [];
  (parsed.repos as unknown[]).forEach((entry, i) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(
        `${yamlFile}: repos entry #${i + 1} is not a repo mapping — fix or remove it`,
      );
    }
    const r = entry as Record<string, unknown>;
    const repoId = String(r.repoId ?? "");
    if (repoId === "") {
      throw new Error(`${yamlFile}: repos entry #${i + 1} is missing repoId — fix or remove it`);
    }
    if (seen.has(repoId)) {
      throw new Error(`${yamlFile}: duplicate repoId "${repoId}" — fix or remove it`);
    }
    seen.add(repoId);
    configs.push({
      repoId,
      source: String(r.source ?? ""),
      schedule: typeof r.schedule === "string" && r.schedule !== "" ? r.schedule : null,
      options:
        r.options && typeof r.options === "object" && (r.options as RepoOptions).noWiki === true
          ? { noWiki: true }
          : {},
      instructions:
        typeof r.instructions === "string" && r.instructions.trim() !== ""
          ? r.instructions
          : undefined,
      // Hand-edited YAML can name anything; fall back rather than fail the load.
      producer: isProducerId(r.producer) ? r.producer : undefined,
      excludeGlobs: normalizeGlobs(r.excludeGlobs),
    });
  });

  const state = await loadState(cfg);
  return {
    repos: configs.map((c) => ({ ...c, ...(state[c.repoId] ?? defaultState(c.repoId, cfg)) })),
  };
}

async function loadState(cfg: Config): Promise<Record<string, RunState>> {
  try {
    const raw = JSON.parse(await readFile(paths.state(cfg), "utf8")) as Record<string, RunState>;
    return raw;
  } catch {
    return {};
  }
}

async function migrateLegacyJson(cfg: Config): Promise<Registry> {
  let legacy: { repos?: RepoRecord[] };
  try {
    legacy = JSON.parse(await readFile(paths.registryLegacy(cfg), "utf8")) as {
      repos?: RepoRecord[];
    };
  } catch (e) {
    throw new Error(
      `${paths.registryLegacy(cfg)} is not valid JSON: ${e instanceof Error ? e.message : String(e)} — fix or remove it`,
      { cause: e },
    );
  }
  const repos = Array.isArray(legacy.repos) ? legacy.repos : [];
  await saveRegistry(cfg, { repos }); // writes registry.yaml + state.json
  return { repos }; // legacy registry.json left in place, untouched
}

// ---- save ----

/**
 * Write discipline (spec: repo-manager › Registry write discipline): every
 * writer persists only the store it owns.
 * - Run-outcome writers (scheduler batch, repo update, index, pipeline runs)
 *   call `saveState` ONLY — they must never rewrite human-owned registry.yaml,
 *   or a long batch would clobber concurrent human edits from its stale copy.
 * - Human-config edits (instructions) call `saveYaml` ONLY.
 * - Registration/removal call `saveRegistry` (both stores change).
 */
export async function saveRegistry(cfg: Config, registry: Registry): Promise<void> {
  await saveState(cfg, registry);
  await saveYaml(cfg, registry);
}

export async function saveState(cfg: Config, registry: Registry): Promise<void> {
  const state: Record<string, RunState> = {};
  for (const repo of registry.repos) state[repo.repoId] = runStateOf(repo);
  const file = paths.state(cfg);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, file);
}

export async function saveYaml(cfg: Config, registry: Registry): Promise<void> {
  const file = paths.registryYaml(cfg);
  await mkdir(dirname(file), { recursive: true });

  let doc: YAML.Document;
  if (await exists(file)) {
    doc = YAML.parseDocument(await readFile(file, "utf8"));
    if (doc.errors.length > 0) {
      throw new Error(
        `${file} is not valid YAML: ${doc.errors[0]?.message ?? "parse error"} — fix or remove the file`,
      );
    }
  } else {
    doc = new YAML.Document({});
  }

  let seq = doc.get("repos") as YAMLSeq<YAMLMap> | undefined;
  if (!seq || !YAML.isSeq(seq)) {
    seq = new YAMLSeq<YAMLMap>();
    doc.set("repos", seq);
  }

  // Keep only repos present in the in-memory registry (preserves their nodes,
  // hence their comments); update human fields in place.
  const keep = new Set(registry.repos.map((r) => r.repoId));
  seq.items = seq.items.filter((item) => {
    const id = YAML.isMap(item) ? item.get("repoId") : null;
    return typeof id === "string" && keep.has(id);
  });
  const byId = new Map<string, YAMLMap>();
  for (const item of seq.items) {
    const id = item.get("repoId");
    if (typeof id === "string") byId.set(id, item);
  }
  for (const repo of registry.repos) {
    let item = byId.get(repo.repoId);
    if (!item) {
      item = new YAMLMap();
      seq.items.push(item);
    }
    item.set("repoId", repo.repoId);
    item.set("source", repo.source);
    item.set("schedule", repo.schedule);
    if (repo.options.noWiki === true) {
      item.set("options", { noWiki: true });
    } else {
      item.delete("options");
    }
    if (repo.instructions !== undefined && repo.instructions.trim() !== "") {
      item.set("instructions", repo.instructions); // multiline renders as a block literal
    } else {
      item.delete("instructions");
    }
    if (repo.producer !== undefined) {
      item.set("producer", repo.producer);
    } else {
      item.delete("producer");
    }
    if (repo.excludeGlobs !== undefined) {
      item.set("excludeGlobs", repo.excludeGlobs);
    } else {
      item.delete("excludeGlobs");
    }
  }

  const tmp = `${file}.tmp`;
  await writeFile(tmp, doc.toString());
  await rename(tmp, file);
}

// ---- lookups ----

export function getRepo(registry: Registry, repoId: string): RepoRecord | undefined {
  return registry.repos.find((r) => r.repoId === repoId);
}

/**
 * Stable unique repoId as a `host/group/name` slug: remote URLs normalize to
 * `<host>/<group-path>` (GitLab-subgroup-safe); local paths become
 * `local/<basename>`. Collisions are suffixed (-2, -3, ...).
 */
export function repoIdFromSource(source: string): string {
  const s = source
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const scp = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@]+@)?([^/:]+)(?::\d+)?[:/](.+)$/i.exec(s);
  if (scp) {
    const host = (scp[1] ?? "").toLowerCase();
    const path = (scp[2] ?? "").replace(/^\/+/, "").toLowerCase();
    return `${host}/${path}`;
  }
  const name = s.split("/").findLast(Boolean) ?? "repo";
  return `local/${name}`;
}

export function uniqueRepoId(registry: Registry, base: string): string {
  if (!registry.repos.some((r) => r.repoId === base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!registry.repos.some((r) => r.repoId === candidate)) return candidate;
  }
}

/** Which producer a repo runs under — its override, else the global default.
 *  The ONLY place selection is resolved; a second one means the contract has
 *  leaked. See `src/producer/contract.test.ts`. */
export function producerFor(cfg: Config, repo: Pick<RepoRecord, "producer">): ProducerId {
  return repo.producer ?? cfg.producer;
}

/** Effective exclude set: global globs plus the repo's, additively — a repo
 *  list narrows what is indexed, it can never re-include a globally excluded
 *  path (spec: repo-manager › Per-repo exclude globs). */
export function effectiveExcludes(
  cfg: Pick<Config, "excludeGlobs">,
  repo: Pick<RepoRecord, "excludeGlobs">,
): string[] {
  return [...cfg.excludeGlobs, ...(repo.excludeGlobs ?? [])];
}
