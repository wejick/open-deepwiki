# Tasks: efficient-mcp-tools

## 1. Batched index read helpers

- [x] 1.1 Add `getChunksByIds(db, repoId, ids)` to `src/index/db.ts` (id→path mapping for vector top-k)
- [x] 1.2 Add `listChunksByPaths(db, repoId, paths)` to `src/index/db.ts` (both kinds, all chunk indices)
- [x] 1.3 Add `listChunkSummaries(db, repoId, paths)` to `src/index/db.ts` (wiki, chunk_index 0: path/title/description)
- [x] 1.4 Add `listRepoCentroids(db)` to `src/index/db.ts` (single query, `centroid IS NOT NULL`)
- [x] 1.5 Add `listAllDocCounts(db)` and `listRepoSummaries(db)` to `src/index/db.ts` (aggregate listing queries, no centroid column)
- [x] 1.6 Unit-test the new helpers against a fixture index DB (candidate-key selection, missing rows skipped, summaries keyed by path)

## 2. Hybrid search refactor (candidate-set I/O)

- [x] 2.1 Embed the query once in `hybridSearch`; `routeRepos` takes the query vector and uses `listRepoCentroids`; provider-failure warnings and lexical fallback preserved
- [x] 2.2 Two-phase fusion: score all candidate paths from rg output + `getChunksByIds` mapping, global sort + slice to `limit`, then materialize survivors in batches of `limit` via `listChunksByPaths` (lazy batch keeps the empty-chunks skip semantics)
- [x] 2.3 Run per-repo vector queries concurrently (`Promise.all`)
- [x] 2.4 Add scenario test "Query embedded once per search": unscoped search issues exactly one embeddings API request (fetch-stub call count)
- [x] 2.5 Verify existing `search.test.ts` scenarios stay green (ranking, dedup, snippets, routing identical)

## 3. Tool output encoding + batched tool reads

- [x] 3.1 `ok()` returns a single compact JSON text payload; drop `structuredContent` from every tool
- [x] 3.2 Round `score`/`vectorSim` to 3 decimals at serialization (incl. the ask_repo below-threshold message); internal precision unchanged
- [x] 3.3 Hoist `repoId` to a top-level field on scoped `search_code`/`ask_repo` responses; unscoped responses keep per-result `repoId`
- [x] 3.4 `list_repos` uses the aggregate queries (2 queries total, meta without centroids)
- [x] 3.5 `list_related` and `ask_repo` one-hop neighbors use `listChunkSummaries` (single query per id set, edge order preserved)
- [x] 3.6 Server tests for the new scenarios: "Single compact payload", "Scores rounded to 3 decimals", "Scoped search hoists repo attribution", "Scoped question hoists repo attribution"; existing tool tests stay green

## 4. Validation

- [x] 4.1 `bun test ./src ./test`, `bun run lint`, `bun run format`, `bun run typecheck` all pass
- [x] 4.2 `openspec validate --specs` passes; archive the change
