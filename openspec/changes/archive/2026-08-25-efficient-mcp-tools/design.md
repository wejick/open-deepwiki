# Design: efficient-mcp-tools

## Context

The MCP server returns tool payloads twice (pretty-printed text + a duplicate
`structuredContent`) with no `outputSchema`, and per-query index work scales
with repo size instead of the candidate set: unscoped searches embed the query
twice, routing loads centroids one query per repo, fusion scans each repo's
full chunk table, and snippets are read from disk for every fused candidate
before truncation to `limit`. All consumers are LLMs with bounded context, so
both output size and query latency are paid in tokens and wall-clock per call.

## Goals / Non-Goals

**Goals:**

- Return each payload once, as compact JSON text, with rounded scores.
- Attribute scoped results via a single top-level `repoId`.
- Preserve ranking, fusion, snippet content, and tool semantics exactly.
- Bound per-query I/O by the candidate set (embedding calls, SQL rows, file
  reads) and batch metadata reads.

**Non-Goals:**

- No `outputSchema` adoption, no caching, no config knobs, no ranking changes.
- No index-time or ingestion changes.

## Decisions

### D1: Single compact JSON text payload; drop `structuredContent`

The `ok()` helper emits `content[0].text = JSON.stringify(payload)` and omits
`structuredContent` entirely. Rationale: with no `outputSchema` on any tool,
`structuredContent` has no validation or machine-contract role — measured ~45%
of every wire result is the duplicate. Text content is the channel every
in-repo consumer (opencode config, tests, Claude Desktop) reads. Breaking for
external clients reading `structuredContent`; documented in the proposal.

### D2: Round scores at serialization only

`score`/`vectorSim` → `Math.round(v * 1000) / 1000` in the tool payload layer,
never in `SearchHit` or search internals. The `ask_repo` below-threshold check
keeps comparing full-precision `vectorSim` against
`vectorMinSimilarity` — rounding is a presentation concern.

### D3: Hoist repo attribution for scoped queries

For `search_code`/`ask_repo` with `repoId` given, the payload gets a top-level
`repoId` and results omit the per-hit field. `SearchHit.repoId` is retained
internally (needed by unscoped attribution, neighbor enrichment, and
cross-repo callers); the transformation happens in the tool payload layer.
Unscoped responses keep per-result `repoId` exactly as today.

### D4: Embed the query exactly once

`hybridSearch` embeds `[query]` first, passes `queryVec[0] ?? null` into
`routeRepos`, which uses it for centroid ranking; the same vector then drives
per-repo vector queries. On provider failure the existing dual warnings
(`centroid routing unavailable…` + `embedding provider unavailable…`) and the
lexical fallback are preserved — only the duplicate HTTP call disappears.
Current code embeds in `routeRepos` (search.ts:261) and again in
`hybridSearch` (search.ts:147); verified 2 API calls per unscoped search.

### D5: Single-query centroid load

New `listRepoCentroids(db)` helper: one `SELECT repo_id, centroid FROM
repos_meta WHERE centroid IS NOT NULL`, replacing per-repo `getRepoMeta`
calls in `routeRepos` (N queries at ~100 repos).

### D6: Two-phase fusion with candidate-key chunk loading

Phase 1 (no chunk-table reads): build `lexByPath` from rg output and
`vecByPath` from the vector top-k — the ≤50 vector-hit chunk ids per repo are
resolved to paths via one `getChunksByIds` query (id → path mapping only).
Score every path, sort globally (score desc, path asc), and pre-slice to
`limit`.

Phase 2 (materialize only survivors): process the ranked candidate list in
batches of `limit`; per batch, fetch chunk rows with `listChunksByPaths`
(`path IN (…)`, both kinds, all chunk indices) and build pre-results
(wiki/source selection, title/description, line ranges) without reading files.
Stop as soon as `limit` valid pre-results are collected; only then read
snippets from disk — once per result, exactly for the returned set.

Why batching rather than a single survivor-set fetch: today a lexical hit in a
file that is not a chunk (unindexed file) yields an empty `chunksOf` and the
path is silently skipped, so the final result count can fall short of `limit`.
Fetching only the first `limit` paths would change output; lazy batching
preserves the skip semantics while keeping SQL reads bounded by `limit` in the
common case and snippet reads exactly equal to the returned set. Output is
provably identical: score and sort key depend only on ranks (no chunk data),
and each result's content depends only on its own path's chunks. Verified by
the existing search suite plus a SQL-recorder assertion that no full-table
`chunks` scan is issued during `hybridSearch`.

### D7: Concurrent per-repo vector queries

`Promise.all` over the ≤`topKRepos` (default 5) per-repo
`vector_distance_cos` queries. libSQL WAL mode supports concurrent readers;
this only overlaps latency.

### D8: Batched metadata lookups in tools

- `list_related` and `ask_repo` one-hop neighbors: new
  `listChunkSummaries(db, repoId, paths)` — one query returning
  `{path, title, description}` for `path IN (…)`, replacing serial per-neighbor
  `getChunk` calls. Edge order is preserved by rebuilding arrays from the
  returned map in `listEdges` order.
- `list_repos`: two aggregate queries (`listAllDocCounts`, `listRepoSummaries`
  — meta without the centroid column) merged in JS, replacing 2×N serial
  queries. Repos lacking meta rows still render `{resolved: 0, total: 0}` and
  empty concept terms, matching today's `meta === null` handling.

## Risks / Trade-offs

- [IN-clause variable count] → bounded: ≤50 vector ids, ≤`limit` (max 50)
  paths per batch, ≤8 neighbor ids — far below SQLite's variable limit.
- [Fusion refactor silently changes results] → the existing search suite
  (search.test.ts, server.test.ts scenarios) asserts ranking, dedup, snippet
  content, and routing; any drift fails those tests. D6 is designed for
  output equivalence, including the empty-chunks skip case.
- [Removing `structuredContent` breaks external clients] → breaking change is
  deliberate and documented in the proposal; in-repo consumers all read text
  content.
- [Rounding erodes precision for downstream scoring] → rounding is confined
  to the serialized payload; internal values and thresholds stay full
  precision.

## Migration Plan

Single change: implement tasks in order (db helpers → search refactor → tool
payloads → tests), run `bun test ./src ./test`, `bun run lint`,
`bun run format`, `bun run typecheck`, `openspec validate --specs`, then
archive the change. Rollback: revert the change directory plus the code diff;
no data or schema migration involved.
