## Context

Greenfield TypeScript project on **Bun ≥1.4** (native TS runtime, package manager, and test runner in one — no ts-node/tsx, no eslint/prettier: oxlint + oxfmt). The goal is an org-scale (~100 repos), open-source DeepWiki clone: register git repos (GitLab-hosted, accessed as **pure git** — no provider APIs), produce structured knowledge (OKF v0.2 bundles) for their code, index it locally (ripgrep lexical + libSQL vector semantic), and serve it over HTTP to MCP clients (e.g., Claude Desktop) across the organization from one shared LAN server.

Prior art: **langchain-ai/openwiki** (MIT) — a DeepAgents-based CLI that writes and maintains an OKF v0.2 wiki bundle for a repository, with incremental updates and Grounded Claims staleness tracking. It is CLI-only (no published programmatic API per its `package.json`) and brings a large dependency tree (langchain, deepagents, provider SDKs).

Pipeline: `git repo → openwiki CLI (OKF v0.2 bundle) ┐
                                             ├→ sqlite index → MCP server → MCP client
             raw source files (crawler)      ┘`

## Goals / Non-Goals

**Goals:**
- Produce/consume **OKF v0.2** bundles (Google's Open Knowledge Format: markdown concepts + YAML frontmatter, reserved `index.md`/`log.md`, provenance `sources`/`generated` fields) — same format openwiki emits, so bundles stay interoperable.
- Zero self-built LLM wiki pipeline in v1: wrap `openwiki` CLI as the producer.
- One shared libSQL database (repo_id-scoped) with hybrid retrieval (ripgrep lexical + vector semantic via built-in `F32_BLOB`/`vector_distance_cos`, reciprocal-rank fusion) over wiki concepts and raw source chunks — no body-text duplication, no full-text index, no native extensions.
- Repo manager with add/remove/list, **batch import** (`--from-file`), and **nightly batch updates** (staggered queue, per-repo schedule overrides) — pull → `openwiki --update` → re-index.
- **Auto-derived repo categorization**: per-repo concept terms + centroid embedding computed at index time; unscoped searches route to the top-k most relevant repos.
- MCP HTTP server on the LAN with **bearer-token auth**; tools: `list_repos`, `search_code`, `get_wiki_page`, `list_related`, `ask_repo`; clients need only Claude Desktop + URL + token.
- Single CLI binary (`open-deepwiki`) with subcommands: `repo add|remove|list|update`, `index`, `serve`.

**Non-Goals:**
- No self-built wiki/agent generation in v1 (openwiki owns that seam; swapping producers later is possible behind the adapter).
- No web UI / wiki visualizer (openwiki ships one; out of scope for us).
- No openwiki "personal mode", connectors (Notion/Slack/etc.), or coding-agent integrations.
- No per-user accounts/authorization — one shared bearer token on a trusted LAN (multi-reader, single-writer); not internet-exposed.
- No git-hosting provider API integration (GitHub/GitLab listing, webhooks) — pure git clone/pull via the server's own credentials.
- No AST-level code intelligence — chunking is file/section based in v1.
- No layered architecture (clean/onion/hexagonal, use-case/service/repository layers, DI) — the codebase is flat capability modules calling concrete dependencies directly; see config.yaml engineering principles.

## Decisions

### D1: Wrap openwiki CLI as the OKF producer (adapter pattern)
The producer is an adapter that spawns `openwiki --init` (first run) / `openwiki --update` (subsequent runs) as a child process with cwd = the managed clone, non-interactively (stdin closed, stdout/stderr captured), with an isolated openwiki home under our dataDir (openwiki v0.3 hardcodes `~/.openwiki`, so the child runs with `HOME=<dataDir>/openwiki-config` — verified in the 2.1 spike) and provider credentials pre-seeded so no interactive onboarding blocks runs. The openwiki version is pinned (with a config override; parsed from the `--help` banner — the CLI has no `--version` flag). The OKF v0.2 spec is the contract between openwiki's output and our index. Note: openwiki must be installed under Node (npm), not bun — it ships native better-sqlite3 bindings.
- *Alternatives considered*: import openwiki as a library (rejected: publishes no `exports`/API; would drag the entire langchain stack into our process); build our own wiki agent (rejected for v1 scope: duplicates a mature 15k-star tool's core value); fork openwiki (rejected: we'd own agent internals we don't need to change).

### D2: OKF v0.2 bundle on disk, per repo
openwiki writes its bundle to `<clone>/openwiki/` (concepts + root `index.md` declaring `okf_version: "0.2"` + `log.md` + `.claims/`). We treat that directory as the producer artifact: human-readable, diffable, and consumable by any OKF-aware tool. Our index reads it; we never rewrite it.
- *Alternatives considered*: our own JSONL doc format (rejected: reinvents an existing open spec); copying concepts into our own bundle layout (rejected: would fight openwiki's updater).

### D3: One shared libSQL database, all repos, scoped by `repo_id`
`<dataDir>/index.db` (embedded `file:` mode; `DB_URL` config allows a `libsql://` URL later). Every table (chunks, vectors, edges, concept metadata, repo centroids) carries `repo_id` with indexes, so scoped searches stay repo-isolated by query, not by file. Rationale: routing, fan-out search, and status aggregates are inherently cross-repo — per-repo files forced a hidden second global store for centroids and N-connection fan-outs. WAL mode: single-writer (nightly batch, serialized by the queue), many readers. Repo removal = one transactional purge + periodic VACUUM for space reuse.
- *Alternatives considered*: one DB per repo (original design — rationale died: FTS-noise isolation is moot since rg searches files not the DB, and delete-file convenience vs a transaction is negligible; kept a split-brain global store alive); dynamic per-repo vector tables (partitioning libSQL brute-force KNN — unnecessary at ~500k total rows with a repo_id filter, revisit only with measured slowness).

### D4: Index two document kinds — wiki concepts + raw source chunks; no body duplication
openwiki produces docs, not raw code search. The indexer ingests (a) OKF concepts from the bundle (`kind: wiki`), and (b) raw source files walked from the checkout (`kind: source`). Chunks record only path, line ranges, and content hash — **text is never copied into the database**; it is read from disk (bundle/checkout are stable, versioned artifacts) at query time. This keeps `search_code` useful for exact code lookup while `get_wiki_page`/`ask_repo` lean on wiki concepts.
- *Alternatives considered*: wiki-only index (weak for exact identifier lookup); only raw sources (loses the docs value openwiki adds); storing bodies in sqlite (1.08x text duplication for no query-time benefit).

### D5: Hybrid search — ripgrep + libSQL vectors, no full-text index
Measured FTS5 overhead on an openwiki-style corpus: **2.1x** text size (unicode61) / **5.1x** (trigram) — duplicating text that is already plain markdown on disk (OKF's core premise: diffable, greppable). Lexical search therefore spawns `rg` over the OKF bundle + checkout (zero index maintenance, regex-capable, ~GB/s scan). The shared libSQL DB stores only metadata, chunk offsets, hashes, and **quantized embeddings** (`F32_BLOB` vectors with `vector_distance_cos` — built into libSQL, no extension, no node-gyp; int8 or ≤512-dim default, since f32/1536-d vectors alone would cost ~4x the raw text). Query = rg matches (pseudo-ranked by hit density × distinct-term coverage — no BM25; rg supplies evidence, not scores) + top-k vectors, merged by weighted reciprocal-rank fusion at path level (best chunk rank per path), snippets read from disk on demand. Result: index ≈ 0.25–1x raw text instead of 2–5x.
- *Alternatives considered*: FTS5 (2.1–5.1x size cost to duplicate on-disk text; buys BM25 ranking we don't need when the client agent iterates with follow-up tool calls); external vector DB (violates local-single-binary goal); sqlite-vec (works, but adds a native extension build when libSQL ships vectors natively with the same engine behind hosted Turso).

### D6: One OpenAI-compatible LLM config via OpenRouter SDK — cloud or local
A single provider config (`baseUrl`, `apiKey`, `model`) using the OpenRouter SDK against any OpenAI-compatible endpoint — OpenRouter/cloud or a local server (Ollama, LiteLLM). It seeds openwiki's isolated `.env` for wiki generation and powers our embeddings call site; both ride the same configurable endpoint, so the whole stack can run cloud or fully local.
- *Alternatives considered*: vendor SDKs per provider (lock-in, more deps).

### D7: Incremental updates via openwiki + git diff
Cron updater: `git fetch && git pull`; if head moved → run `openwiki --update` (openwiki itself regenerates only stale/changed pages via Grounded Claims) → re-index the bundle (detect changed concept files by path+hash) → re-chunk only source files changed/deleted per `git diff --name-only <oldSha>..<newSha>`.
- *Alternatives considered*: full re-index every run (wasteful); mtime watching (unreliable across pulls).

### D8: MCP server over Streamable HTTP on the LAN; `ask_repo` as retrieval, not agent
`@modelcontextprotocol/sdk` server on HTTP (default `http://localhost:7245/mcp`; configurable bind for LAN), stateless per-request tool handlers reading the shared index DB read-only in **WAL mode** so nightly writer runs never block concurrent org readers. When bound beyond localhost the server **requires a bearer token** (`Authorization: Bearer …`; 401 otherwise) — teammates connect with just URL + token (older Claude Desktop via `mcp-remote --header`, documented in README). Tools are **recall-only; no server-side synthesis or agent loop** — `ask_repo(repoId, question)` returns ranked recall results (page identifiers + bounded snippets + citations, optionally one-hop neighbor titles) and the client LLM synthesizes, following up with `get_wiki_page`/`list_related` as needed. **Tool schemas are the prompting surface**: `ask_repo` takes an optional `keywords` array (1–5 entries; each entry a single term or multi-term group — terms within an entry ANDed, entries OR-combined, order-insensitive; Claude picks the grep terms — question drives the vector query, keywords drive rg) and `search_code` takes a `mode` hint (`auto`/`literal`/`regex`), pushing query understanding to the client LLM; the server keeps only a deterministic term-extraction fallback (stopword drop, ≤4 longest tokens) so it stays LLM-free. The server's only model dependency is the embeddings call site; no chat-model config exists server-side.
- *Alternatives considered*: server-side synthesis/agent loop (latency + cost, and it duplicates the client's own LLM — the client can synthesize better with full conversation context); stdio transport (requires client to spawn process — untenable for a shared LAN server); per-user auth keys (v1 scope; one shared token on a trusted LAN is enough).

### D9: Derived concept graph (advisory edges)
Ingestion derives an `edges` table from inter-concept markdown links, defensively resolving openwiki's mix of bundle-absolute and relative link forms (audited openwiki wikis have had ~90% unresolvable body links, so resolution must tolerate both and drop what doesn't resolve — OKF §6 requires broken-link tolerance anyway). Powers: `list_related` MCP tool (backlinks included), optional one-hop neighbor context in `ask_repo`, and a per-repo `link_health` diagnostic. No tag or hierarchy edges, no graph export or visualizer (openwiki ships one) — untyped link edges are the 80/20.
- *Alternatives considered*: first-class graph store (overkill for Q&A); no graph (loses cheap navigation/context expansion that the bundle already encodes).

### D10: Auto-derived repo categorization + centroid routing (compartmentalized search at org scale)
No manual tagging. At index time each repo gets (a) **concept terms** — aggregated from its wiki bundle's `tags`, `type` values, and frequent title/description terms — and (b) a **centroid embedding** (mean of concept chunk vectors, plus the overview page). Search tools accept `repoId` for scoped search; when omitted, the query embedding is compared against repo centroids and the search fans out to the top-k relevant repos (configurable, default ~5), with results attributed per repo. This gives org-wide "compartmentalized" search with zero curation and stays LLM-free.
- *Alternatives considered*: manual tags/categories (curation burden at 100 repos; repos span domains); provider-API-derived metadata (violates pure-git); embedding every repo fully per query (cost/latency explodes at 100 repos — centroids are O(repos), not O(chunks)).

### D11: Nightly batch scheduler + bounded concurrency queue + observable cost
Default schedule is a **nightly batch** (e.g. 02:00) processed as a staggered queue with a **configurable max parallelism** (default 2) for the expensive openwiki runs; per-repo schedule overrides allow more-frequent updates for active repos. Each run logs duration and (when reported by the CLI) token usage to the registry for cost visibility. `repoId` = normalized `host/group/name` slug (GitLab-subgroup-safe, collision-suffixed). The scheduler runs in-process with `serve`; `open-deepwiki update --all` is also a plain CLI command so system cron/launchd can drive it instead.
- *Alternatives considered*: hourly polling (100 repos × agent churn for marginal freshness); webhook-driven updates (violates no-provider-API non-goal); unbounded parallelism (API rate limits + one box).

### D12: Builtin monitoring — read surface over existing state, no new stores
Monitoring is a **read surface**, not a subsystem: the registry already records runs and the scheduler owns queue state, so health is computed at read time (red = last run failed; yellow = `now − last_success > 2× interval`; green otherwise) and never stored. Surfaces: `GET /healthz` (untokened liveness probe, minimal payload), `GET /status` (token-protected full JSON: scheduler/queue + per-repo health/cost), `open-deepwiki status [--failing|--json|--server <url>]` CLI table (live queue merged from the running server when `--server` given; registry-only otherwise), `open-deepwiki logs` over an append-only `<dataDir>/events.jsonl` (JSONL run/queue events, truncate-rotate at 10MB, forensic only), and a `server_status` MCP tool so org users can ask Claude "is the index healthy?". Deliberately excluded: Prometheus, dashboards, alerting — `/status` JSON covers scripted checks, and a metrics endpoint can be added later behind the same middleware.
- *Alternatives considered*: sqlite metrics tables + history (query power nobody asked for; registry already holds last-run facts); Prometheus now (nice but adds surface; deferred); storing health flags (stale-by-definition the moment they're written — computed-on-read can't lie).

## Risks / Trade-offs

- [openwiki CLI flags/output change across versions] → Pin exact version in config (default `^0.3`), adapter is the single seam, conformance check (D1) fails loudly on format drift.
- [openwiki interactive onboarding blocks headless runs] → **Retired by source inspection + live spike (2.1, v0.3.3)**: the wizard gate is `~/.openwiki/onboarding.json` (`completedAt` + `modeId: "code"`) + a non-empty `INSTRUCTIONS.md` + provider `.env` — seeding those three files under an isolated `HOME` bypasses onboarding deterministically.
- [Agent runs are slow/expensive across ~100 repos] → Nightly batch (D11), head-moved check before invoking openwiki, bounded concurrency, per-repo opt-out of wiki (`--no-wiki` source-index-only mode), per-run cost logging; cheap local model via OpenAI-compatible endpoint for bulk indexing.
- [rg unavailable (notably Windows default installs)] → Startup prerequisite check with clear error; search degrades to vector-only with a warning until installed.
- [Embedding API unavailability] → Index still builds with metadata + chunks; lexical (rg) search keeps working; vectors backfill on next update.
- [Embeddings dominate storage if left at f32/1536-d (~4x raw text)] → Default to int8-quantized or ≤512-dim embeddings (0.25–1x raw text); dimension is config-driven.
- [Single-DB write contention during nightly batch] → Queue serializes writers; WAL keeps readers unblocked; indexing is embedding-bound, not DB-bound.
- [Cron drift / overlapping runs] → Per-repo lock file; skip run if previous update in progress.
- [openwiki writes into the clone (`openwiki/`, `AGENTS.md`/`CLAUDE.md` blocks)] → Managed clones are ours; source crawler excludes the bundle dir to avoid double-indexing wiki content as source.
- [LAN token is shared, not per-user] → Trusted-network scope documented; token rotates via config; no TLS inside LAN v1 (bind to the management VLAN).
- [Centroid routing picks wrong repos for a query] → Routing is advisory recall widening, not filtering — top-k fan-out with per-repo attribution; client can always scope explicitly by repoId; centroids recompute on index updates.
- [Monorepos / huge repos] → Configurable include/exclude globs, max file size, binary-file skipping.

## Migration Plan

Greenfield — no migration. Rollout: scaffold → openwiki adapter spike → index → repo manager → MCP server. Rollback = delete repo directory; all state lives under `<dataDir>`. openwiki is an external prerequisite (`npm i -g openwiki`); version surfaced in diagnostics.

## Open Questions

- Default embedding model/dimensions (pick during implementation; must be reachable through the configured OpenAI-compatible endpoint; int8/≤512-d default per D5).
