# Delta: knowledge-index

## ADDED Requirements

### Requirement: Bounded query-time I/O
Per-query index reads SHALL be bounded by the candidate set, not by repo size: fusion SHALL fetch chunk metadata by candidate keys — vector top-k chunk ids (for id→path rank mapping) and the surviving result paths (for output materialization) — instead of scanning a repo's full chunk table; snippet file reads SHALL happen only for results that will be returned to the caller, after ranking and truncation to `limit`; neighbor/title lookups for link traversal and per-repo listing metadata SHALL be batched (one query per id set) or run concurrently.

#### Scenario: Chunks fetched by candidate keys
- **WHEN** chunk metadata is read to resolve fusion candidates in a repo with many indexed chunks
- **THEN** only the rows matching the candidate chunk ids / candidate paths are read, not the repo's full chunk table

#### Scenario: Neighbor metadata fetched as a set
- **WHEN** titles and descriptions are resolved for a set of neighbor concept ids
- **THEN** they are fetched with a single query over the id set, preserving per-id values

## MODIFIED Requirements

### Requirement: Cross-repo routing for unscoped search
When a search is issued without a repoId, the system SHALL embed the query, compare it against repo centroids, fan out the search to the top-k most relevant repos (configurable, default 5), and return merged results attributed per repo. Scoped searches (with repoId) SHALL search only that repo. The query text SHALL be embedded exactly once per search call — the same query vector SHALL drive both centroid routing and per-repo vector ranking. Repo centroids for routing SHALL be loaded with a single database query.

#### Scenario: Unscoped question routed to relevant repos
- **WHEN** a search is issued without repoId and three repos' centroids are nearest the query
- **THEN** only those repos (within the top-k bound) are searched and each result carries its repoId

#### Scenario: Scoped search stays in one repo
- **WHEN** a search is issued with a repoId
- **THEN** no other repo's results are returned

#### Scenario: Query embedded once per search
- **WHEN** an unscoped search runs with the embedding provider available
- **THEN** exactly one embeddings API request is issued for the query text
