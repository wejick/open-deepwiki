# Proposal: efficient-mcp-tools

## Why

Two measured inefficiencies in the MCP server:

1. **Output size** — every tool result is sent to the client twice
   (pretty-printed JSON in `content[0].text` plus the same data in
   `structuredContent`), and pretty-printing alone inflates the text by
   24–33%. Measured on a fixture repo, ~45% of every wire result is duplicate
   or whitespace. The consumers are LLMs with bounded context windows. No tool
   declares an `outputSchema`, so `structuredContent` serves no purpose.
2. **Query latency** — an unscoped search embeds the query **twice** (once in
   centroid routing, once for vector ranking; confirmed: 2 embeddings API
   calls per unscoped `search_code`), routing loads repo metadata with one
   serial query per repo, fusion loads **every** chunk row of each target repo
   to resolve a ≤50-id candidate set, and neighbor/listing lookups run
   serially (N+1).

## What Changes

**Output (tool responses):**

- Return the payload **once**, as compact JSON text; drop
  `structuredContent`. **BREAKING** for clients reading `structuredContent`
  instead of `content` (none in-repo; opencode/Claude read `content`).
- Round numeric scores (`score`, `vectorSim`) to 3 decimal places.
- On repo-scoped queries, hoist repo attribution to a top-level `repoId`
  field instead of repeating it per result; unscoped results keep per-result
  `repoId`.
- Payload field set otherwise unchanged: kind, path, title, description,
  snippet, citations with line ranges, warnings.

**Latency (query path, behavior-preserving):**

- Embed the query exactly once per search; pass the vector to centroid
  routing.
- Load repo centroids with a single query instead of one per repo.
- Load chunk metadata only for the fusion candidate set (vector top-k chunk
  ids ∪ lexical-hit paths) instead of the repo's full chunk table.
- Batch neighbor lookups (`list_related`, `ask_repo` one-hop) into one query
  per id set; run independent per-repo queries concurrently.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-server`: response shape for all tools — compact single-copy JSON,
  rounded scores, hoisted scoped repo attribution; plus new response-encoding
  requirement.
- `knowledge-index`: query-time cost bounds — single embedding request per
  search, candidate-set chunk loading, batched/concurrent metadata reads.

## Non-goals

- No change to tool names, input schemas, descriptions, ranking/fusion
  semantics, or snippet content — results stay byte-identical in substance.
- No `outputSchema` adoption; text content remains the single payload channel.
- No caching layer, no index-time changes, no new config knobs.

## Impact

- `src/server/tools.ts` — response construction (`ok()` helper, per-tool
  payloads, batched neighbor lookups).
- `src/index/search.ts` — single embedding, targeted chunk loading,
  concurrent per-repo vector queries.
- `src/index/db.ts` — batched read helpers (centroids, chunks by ids/paths).
- `src/server/server.test.ts`, `src/index/search.test.ts` — updated/new
  assertions.
