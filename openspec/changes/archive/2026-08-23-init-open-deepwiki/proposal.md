## Why

Devin's DeepWiki gives developers AI-generated, queryable documentation for any codebase, but it is a hosted black box. We want an org-scale (~100 repos), open-source equivalent served from one shared LAN box: register git repos (pure git — no provider APIs), let it build a searchable knowledge index, and expose it over MCP so everyone's Claude Desktop can answer code-specific questions with repo-grounded context.

Rather than building a wiki-generation agent from scratch, we **leverage langchain-ai/openwiki** (MIT, CLI) as the OKF producer: it already generates and incrementally maintains OKF v0.2 knowledge bundles with grounded evidence tracking. Our value-add is everything around it: multi-repo management, a local hybrid search index, and an MCP serving layer.

## What Changes

- **OKF producer (openwiki adapter)**: wrap the `openwiki` CLI (pinned version) to produce/update an **Open Knowledge Format v0.2** bundle (markdown concepts with YAML frontmatter, per Google's OKF spec) inside each managed repo clone. Includes isolated config seeding, non-interactive invocation, bundle verification, and failure isolation (keep last good bundle).
- **Local libSQL index**: one shared database (all repos scoped by `repo_id`) storing **only metadata, chunk line ranges, hashes, and quantized embedding vectors** (built-in `F32_BLOB` vectors — no extensions, no native builds) — body text stays on disk. Lexical search via **ripgrep** over the on-disk OKF bundle and checkout; semantic via vectors; merged hybrid retrieval without duplicating text (~0.25–1x raw text vs 2.1–5.1x with FTS5, per benchmark). Includes **auto-derived repo categorization** (concept terms + centroid embeddings) so unscoped searches route to the relevant subset of ~100 repos. `DB_URL` config keeps a hosted-Turso upgrade path.
- **Git repo manager**: CRUD for registered repos (add/remove/list by git URL or local path, batch import via `--from-file`), plus a **nightly batch updater** (staggered queue, configurable parallelism, per-repo schedule overrides) that pulls changes, runs `openwiki --update`, and incrementally re-indexes.
- **MCP HTTP server**: a shared-LAN, bearer-token-authenticated MCP server exposing tools (`list_repos`, `search_code`, `get_wiki_page`, `list_related`, `ask_repo`, `server_status`) plus `/healthz`//`status` monitoring endpoints; teammates need only the URL and token.
- CLI entry point to run producer/manager/server operations.

## Capabilities

### New Capabilities

- `okf-producer`: openwiki CLI adapter — config seeding (onboarding.json + INSTRUCTIONS.md + provider `.env`), non-interactive init/update runs, OKF v0.2 bundle verification, version pinning, failure isolation.
- `knowledge-index`: shared libSQL persistence (metadata + chunk offsets + quantized vectors, no body duplication), ripgrep lexical search, vector semantic search, advisory concept-link edges (derived knowledge graph with backlinks), auto-derived repo concepts + centroid routing, incremental updates, and fused hybrid search API.
- `repo-manager`: Git repository CRUD with batch import (pure git, provider-API-free), clone/pull lifecycle, nightly batch updates with bounded-concurrency queue and per-repo overrides, run cost observability.
- `mcp-server`: LAN-served MCP-over-HTTP with bearer-token auth exposing search/ask/wiki tools backed by the knowledge index, with centroid-routed cross-repo search.
- `monitoring`: health/status read surface — `/healthz` liveness, token-protected `/status` (scheduler/queue + per-repo health), `status`/`logs` CLI, append-only events.jsonl, and a `server_status` MCP tool; no new data stores, health computed at read time.

### Modified Capabilities

<!-- None - greenfield project, no existing specs -->

## Impact

- **New codebase**: TypeScript on Bun (≥1.4 — runtime, package manager, test runner; oxlint + oxfmt for lint/format); no existing source affected (greenfield repo containing only `openspec/`).
- **External tool dependencies**: `openwiki` CLI (MIT, pinned) for OKF production — invoked as a child process, not imported (it publishes no programmatic API); `rg` (ripgrep) for lexical search.
- **Key dependencies**: `@modelcontextprotocol/sdk` (MCP server), `@libsql/client` (shared embedded index with built-in vectors), `simple-git` (git ops), `node-cron` (scheduling), `gray-matter`/`yaml` (OKF frontmatter), `zod`, an embeddings provider (OpenAI-compatible via OpenRouter SDK); wiki generation uses openwiki's own provider config.
- **External systems**: shared LAN server (bearer token, WAL-mode sqlite for concurrent org readers); local git clones under a data directory; private GitLab over the server's git credentials (pure git, no provider APIs); MCP clients (Claude Desktop) connect over HTTP with URL + token.
- **Config**: data dir, repo registry, nightly schedule + per-repo overrides, max parallel indexing (default 2), bearer token + bind host, one OpenAI-compatible LLM endpoint (baseUrl/key/model via OpenRouter SDK — cloud or local) seeding openwiki's `.env` and powering embeddings.
