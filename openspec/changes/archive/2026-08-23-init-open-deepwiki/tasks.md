## 1. Project Scaffold

- [x] 1.1 Initialize Bun (≥1.4) + TypeScript project (package.json, tsconfig strict, ESM + NodeNext) with CLI entry point `open-deepwiki` — flat `src/<capability>/` layout (config, producer, index, repoManager, server, monitor, cli), no layering/abstraction scaffolding; Bun runs TS natively, no ts-node/build step
- [x] 1.2 Add dependencies: `@modelcontextprotocol/sdk`, `@libsql/client` (embedded file: mode, built-in vectors), `simple-git`, `node-cron`, `zod`, `gray-matter`/`yaml` (OKF frontmatter); document `openwiki` CLI (pinned) and `rg` as external prerequisites
- [x] 1.3 Add config loader (dataDir; nightly schedule + per-repo overrides; maxParallelIndexing default 2; bind host + bearer token; single OpenAI-compatible LLM endpoint baseUrl/key/model via OpenRouter SDK seeding both openwiki `.env` and embeddings) with env var overrides
- [x] 1.4 Set up bun:test (in-source fixtures layout) + oxlint (with strict TS rules) + oxfmt + `tsc --noEmit` typecheck scripts
- [x] 1.5 Build test infrastructure + conventions: shim-binary helper (3-line executables on a tmpdir PATH prepended to child spawns — used for `openwiki`/`rg` fakes incl. exit-1 and hang variants); `globalThis.fetch` stub with deterministic `fakeVec(text)` embedding (hash → vector, no network); golden fixtures under `test/fixtures/` (valid OKF bundle, malformed bundle — missing frontmatter/empty type, mini-git-repo generator); per-test tmpdir libSQL `file:` DB; real rg + real git against fixtures; test naming `"<Requirement> › <Scenario>"` mapping every spec scenario to a test; no sleeps (await promises, counter-based concurrency assertions); suite must run offline in seconds

## 2. OKF Producer (openwiki Adapter)

- [x] 2.1 Spike (LIVE, `.env` key) — DONE against openwiki v0.3.3: headless `--init` on a fixture repo works with seeded isolated config. Findings: (a) openwiki hardcodes `~/.openwiki` — no `OPENWIKI_CONFIG_DIR` env override; isolate via `HOME=<dataDir>/openwiki-config`; (b) wizard gate = `onboarding.json` {`completedAt`, `modeId: "code"`, `version: 1`} + non-empty `INSTRUCTIONS.md` + provider `.env`; (c) provider env keys = `OPENWIKI_PROVIDER` (`openrouter` | `openai-compatible`), `OPENROUTER_API_KEY` or `OPENAI_COMPATIBLE_API_KEY`/`BASE_URL`, `OPENWIKI_MODEL_ID` (no `--version` flag — version parsed from `--help` banner); (d) install openwiki under **Node via npm** (`npm i -g openwiki`) — it ships native better-sqlite3 bindings that bun's global install does not build; (e) real bundle = flat concepts + section `index.md` TOCs without frontmatter (reserved at any depth) + `_skeleton.md`/`INSTRUCTIONS.md` concepts + `.last-update.json`; empty `ODW_LLM_MODEL` fails fast with clear error
- [x] 2.2 Implement config seeding: write isolated openwiki home (`<dataDir>/openwiki-config/.openwiki`, spawned via `HOME` override — openwiki hardcodes `~/.openwiki`) with `onboarding.json` (`completedAt`, `modeId: "code"`, `version: 1`), non-empty `INSTRUCTIONS.md`, and provider `.env` (`OPENWIKI_PROVIDER`, key, `OPENWIKI_MODEL_ID`) before first run
- [x] 2.3 Implement adapter: spawn `openwiki --init` / `openwiki --update` non-interactively (stdio capture, timeout), version pin check with warning on mismatch
- [x] 2.4 Implement bundle locator + OKF v0.2 conformance verification (frontmatter parses, non-empty `type`, root `index.md` present)
- [x] 2.5 Implement failure isolation: non-zero exit/timeout/verification failure → report error, keep last verified bundle and index untouched
- [x] 2.6 Tests (openwiki shim on PATH): invocation argv/stdio/timeout (happy, exit-1, hang→timeout), conformance verification (valid + malformed fixtures), failure isolation keeps last verified bundle; assert the three seeded files (onboarding.json, INSTRUCTIONS.md, .env)

## 3. Knowledge Index

- [x] 3.1 Implement shared libSQL store at `<dataDir>/index.db` (DB_URL-configurable): schema with repo_id-scoped tables (chunks, vectors F32_BLOB, edges, concept metadata, centroids) + repo_id indexes — no body text stored, WAL mode
- [x] 3.2 Implement OKF bundle ingestion: parse frontmatter (gray-matter), id = concept path sans `.md`, compute chunk line ranges for embedding; derive concept edges from markdown links (defensive absolute/relative resolution, drop broken/self/duplicates)
- [x] 3.3 Implement raw source crawler + chunker: include/exclude globs, skip binary/oversized/secrets and `openwiki/` bundle dir; register path + line ranges + content hash
- [x] 3.4 Implement embeddings client (OpenAI-compatible) + libSQL vector store (F32_BLOB columns, vector_distance_cos queries) with int8/≤512-dim quantization default; graceful metadata-only fallback when the provider is unavailable
- [x] 3.5 Implement rg integration: single invocation per query with term alternation + JSON match attribution; keyword group semantics (terms ANDed within an entry, entries OR-combined, coverage = satisfied entries fraction); term source precedence = tool `keywords` param > deterministic fallback extraction (stopwords, ≤4 longest tokens); identifier variant expansion (auto mode); caps (--max-count, --max-filesize, process timeout) + startup detection with vector-only degradation
- [x] 3.6 Implement `search(repoId | unscoped, query, limit)`: weighted RRF of rg + vector results, path dedup, snippet extraction from disk; unscoped mode = centroid routing to top-k repos with per-repo attribution
- [x] 3.7 Implement repo concept derivation: aggregate wiki tags/types/frequent terms + centroid embedding per repo, recomputed on updates
- [x] 3.8 Implement transactional incremental updates: bundle concepts by path+hash; source files by git diff changed/deleted lists; re-embed only changed chunks; sync edges with changed/removed concepts
- [x] 3.9 Tests (real libSQL tmp DB + real rg on fixtures + stubbed fetch/fakeVec): ingestion (wiki + source), deletions, edge derivation (absolute/relative/broken links, backlinks), rg invocation incl. absent-rg tmpdir PATH, vector search + RRF merge ordering + centroid routing (unscoped vs scoped), incremental transactions

## 4. Repo Manager

- [x] 4.1 Implement repo registry (JSON under dataDir): add via pure git (remote URL using server git credentials / local path), duplicate detection, repoId = `host/group/name` slug (GitLab-subgroup-safe, collision-suffixed)
- [x] 4.1b Implement batch import: `repo add --from-file <file>` through the bounded-concurrency queue (configurable maxParallelIndexing, default 2) with progress output
- [x] 4.2 Implement remove (delete registration + clone, transactionally purge repo rows from the shared DB, schedule VACUUM) and list (status: last indexed sha, updated_at, doc counts by kind, link health, auto concept terms, last run duration/cost)
- [x] 4.3 Wire `repo add` to run the full pipeline: clone → openwiki adapter init → index (wiki + source), recording run duration/tokens in the registry and appending events (`run_started`/`run_succeeded`/`run_failed`, `queue_enqueued`) to `<dataDir>/events.jsonl
- [x] 4.4 Implement updater: fetch/pull; if head moved → openwiki `--update` → re-index bundle + git-diff changed/deleted sources; update last indexed sha
- [x] 4.5 Add per-repo lock file to skip overlapping updates; nightly batch scheduler (default 02:00, staggered queue, per-repo overrides; in-process with `serve` AND standalone `update --all` for system cron)
- [x] 4.6 CLI subcommands: `repo add|remove|list|update` (add `--no-wiki` source-index-only option)
- [x] 4.7 Tests (real git tmp repos + real libSQL): registry CRUD + slug ids, batch import queue concurrency (in-flight counter ≤ cap), updater flow (fixture repos + openwiki shim), lock behavior (overlapping run skipped)

## 5. MCP Server

- [x] 5.1 Implement MCP server with Streamable HTTP transport (configurable bind host/port, default `localhost:7245/mcp`), opening the shared index DB read-only in WAL mode; bearer-token middleware (required when bound beyond localhost, 401 on invalid/missing)
- [x] 5.2 Implement `list_repos` tool (with doc counts by kind, last indexed sha, auto-derived concept terms)
- [x] 5.3 Implement `search_code(repoId?, query, mode?, limit?)` tool combining rg lexical matches + vector similarity; optional repoId = centroid routing with repo attribution; modes auto (variant expansion) / literal / regex (fixed-string fallback); unknown-repo error
- [x] 5.4 Implement `get_wiki_page(repoId, path)` tool returning OKF concept (frontmatter + body) incl. repo overview; not-found error
- [x] 5.5 Implement `list_related(repoId, path)` tool: outgoing + backlink edges with neighbor id/title/description; not-found error
- [x] 5.6 Implement `ask_repo(repoId?, question, keywords?, limit?)` tool: recall-only — ranked page identifiers + kind + title + bounded snippet + citations; optional repoId = centroid routing with repo attribution; keywords (1–5 entries, single- or multi-term groups) drive lexical recall (question drives vectors), one-hop neighbor context when edges exist, honest no-results response (no synthesis); register the full tool description text (group semantics, literal-mode pointer) from design D8
- [x] 5.7 CLI `serve` subcommand; graceful handling of missing index DBs
- [x] 5.8 Implement `server_status` MCP tool returning the `/status` summary (scheduler/queue, aggregate counts, per-repo health with last errors)
- [x] 5.9 Tests (server on ephemeral port, real loopback fetch + MCP client): all six tool handlers incl. `list_related` + `server_status` against fixture index DB, 401 without token on non-localhost bind, unknown-repo/not-found errors, end-to-end smoke over Streamable HTTP

## 6. Monitoring

- [x] 6.1 Implement health classification (red = last run failed / yellow = stale > 2× interval / green) computed at read time from registry state
- [x] 6.2 Implement `GET /healthz` (no token, minimal payload) and `GET /status` (token middleware, scheduler/queue + per-repo entries + aggregate counts)
- [x] 6.3 Implement `open-deepwiki status` CLI: per-repo table with `--failing`, `--json`, `--server <url>` live-queue merge (token from config); `open-deepwiki logs [--repo]` tailing events.jsonl
- [x] 6.4 Implement events.jsonl writer (JSONL append, truncate-rotate at configurable 10MB) used by indexer + scheduler
- [x] 6.5 Tests: classification states, endpoint auth (401 without token), `--failing` filter, live-merge fallback when server unreachable, rotation

## 7. Integration & Docs

- [x] 7.1 End-to-end test (composition only, no new fakes): openwiki shim → real clone+index (tmpdir) → real server on ephemeral port → MCP client queries all six tools
- [x] 7.2 Write README: install (incl. `openwiki` pinned + `rg` server-side prerequisites), config (OpenAI-compatible endpoint via OpenRouter SDK incl. local models), LAN deployment + bearer token, Claude Desktop native remote MCP + `mcp-remote --header` fallback, git credentials for private GitLab, batch import, CLI usage, monitoring (`/healthz`, `/status`, `status`/`logs` CLI, `server_status` tool)
- [x] 7.3 Verify all spec scenarios pass; run `openspec validate` for the change
