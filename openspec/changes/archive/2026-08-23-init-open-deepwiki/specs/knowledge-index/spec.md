## ADDED Requirements

### Requirement: Shared index database without body duplication
The system SHALL store all index metadata in a single shared libSQL database (`<dataDir>/index.db`): chunks registry (id, repo_id, kind `wiki`|`source`, path, line range, content hash), wiki frontmatter fields (type, title, description, generated, sources), embeddings, concept edges, and per-repo centroids — every table scoped by `repo_id` with indexes. The system SHALL NOT copy document body text into the database; bodies are read from the on-disk OKF bundle / checkout on demand. The database SHALL run in WAL mode (single writer, concurrent readers).

#### Scenario: Index created on first use
- **WHEN** documents are indexed for the first time and no database exists
- **THEN** the database file and schema (tables, repo_id indexes, vector columns) are created automatically

#### Scenario: Repos are isolated by query scoping
- **WHEN** two repos are indexed and a scoped search runs against one of them
- **THEN** only that repo's rows participate in lexical, vector, and edge results

#### Scenario: Body text read from disk
- **WHEN** a snippet or full body is needed at query time
- **THEN** it is read from the corresponding file on disk using the stored path and line range, not from the database

### Requirement: OKF bundle metadata ingestion
The system SHALL parse OKF concept files (YAML frontmatter + markdown body) from the repo's verified bundle, registering each as a `wiki` chunk with id derived from the concept id (bundle-relative path without `.md`), preserving frontmatter fields, and computing line ranges for embedding chunks.

#### Scenario: Wiki concept indexed
- **WHEN** the bundle contains `wiki/auth.md` with frontmatter `type: Code Wiki Page`
- **THEN** a `wiki` chunk is registered with id `wiki/auth`, its frontmatter fields, and a line range covering its body

#### Scenario: Removed concept deleted
- **WHEN** a concept file registered in the index no longer exists in the bundle after a re-run
- **THEN** its chunks and embeddings are removed from the index

### Requirement: Concept graph derivation
During OKF bundle ingestion, the system SHALL derive concept edges from markdown links between concepts, resolving both bundle-absolute (`/path.md`) and relative link forms, and SHALL store them in an `edges` table (`from_id`, `to_id`). Self-links, duplicate edges, and links that do not resolve to an indexed concept SHALL be silently dropped; edges are advisory.

#### Scenario: Defensive link resolution
- **WHEN** a concept body links both `[a](/wiki/auth.md)` (bundle-absolute) and `[b](./db.md)` (relative) and both targets exist in the bundle
- **THEN** two edges are stored from that concept to the resolved concept ids

#### Scenario: Broken link dropped
- **WHEN** a concept links to a page that does not exist in the bundle
- **THEN** no edge is stored and ingestion succeeds

#### Scenario: Backlinks queryable
- **WHEN** `wiki/auth.md` links to `wiki/db.md`
- **THEN** querying edges for `wiki/db` returns an incoming edge from `wiki/auth`

#### Scenario: Edges removed with deleted concept
- **WHEN** a concept is removed from the bundle
- **THEN** its outgoing and incoming edges are deleted in the same transaction

### Requirement: Raw source ingestion
The system SHALL walk the repo checkout respecting configurable include/exclude globs, skipping binary files, files over a configurable max size, secret files (e.g., `.env`), and the openwiki bundle directory itself, and SHALL register the remaining files as `source` chunks (path, line ranges, content hash; no body copy).

#### Scenario: Excluded files are skipped
- **WHEN** the checkout contains files matching exclude globs (e.g., `node_modules/**`, `*.lock`, `openwiki/**`)
- **THEN** no `source` chunks are registered for those files

#### Scenario: Deleted source file removed
- **WHEN** a previously indexed source file is deleted from the checkout
- **THEN** its chunks no longer participate in search results

### Requirement: Vector search with quantization
When an embedding provider is configured, the system SHALL compute embeddings for chunks and store them as libSQL vector columns (`F32_BLOB` + `vector_distance_cos` — built into libSQL, no extension), defaulting to quantized (int8) or ≤512-dimensional embeddings so vector storage stays within ~1x the raw text size. If the embedding provider is unavailable, the system SHALL index without vectors (metadata + lexical search remain functional) and log a warning.

#### Scenario: Semantic query finds related document
- **WHEN** a query like "how is authentication handled" is embedded and searched
- **THEN** chunks semantically related to authentication are returned even if the exact words do not appear

#### Scenario: Embedding provider unavailable
- **WHEN** the embedding API is unreachable during indexing
- **THEN** indexing completes without vectors, a warning is logged, and lexical search still works

### Requirement: Lexical search via ripgrep
The system SHALL execute lexical searches by spawning `rg` constrained to the repo's checkout and OKF bundle directory, honoring the configured include/exclude globs, returning file path, line number, and match context. Query terms SHALL be taken from the calling tool's optional `keywords` parameter when provided by the client; otherwise the system SHALL derive terms deterministically (tokenize the query, drop stopwords, keep the ≤4 longest tokens). Each keyword entry MAY contain multiple whitespace-separated terms: within an entry, terms are ANDed (all must be present in a file for the entry to count as satisfied); across entries, terms are combined in a single alternation pattern. Distinct-term coverage SHALL be computed as the fraction of satisfied keyword entries. Identifier-style queries in `auto` mode SHALL be expanded to camelCase/snake_case/kebab-case variants in a single alternation pattern. Lexical matching SHALL use a single `rg` invocation per query (term alternation, JSON match output) with per-file × per-term counts derived from match events, and SHALL be capped (per-file match limit, file-size limit, process timeout with vector-only degradation on timeout). Match lines SHALL be mapped to chunks via the chunks registry for fusion and snippet extraction. The system SHALL derive a per-file lexical ranking from match results — ordering by hit density multiplied by distinct-term coverage — rather than using BM25 or term-frequency scoring. The system SHALL detect ripgrep absence at startup and degrade to vector-only search with a warning.

#### Scenario: Client-provided keywords used directly
- **WHEN** a tool call provides `keywords: ["token", "refresh"]`
- **THEN** the rg pattern is built from exactly those terms with no further extraction

#### Scenario: Multi-term keyword requires all its terms
- **WHEN** a tool call provides `keywords: ["token refresh", "middleware"]` and file A contains both `token` and `refresh` while file B contains only `token` many times
- **THEN** file A satisfies the first entry (full coverage credit), file B does not, and file A ranks above file B

#### Scenario: Fallback extraction when keywords absent
- **WHEN** a question is passed with no keywords
- **THEN** terms are derived deterministically — "how does the token refresh work" yields a pattern over `token` and `refresh` (stopwords `how`, `does`, `the`, `work` dropped)

#### Scenario: Identifier variants matched in one invocation
- **WHEN** `search_code` receives `validateToken` in `auto` mode
- **THEN** the rg pattern includes its camel/snake/kebab variants (e.g., `validateToken|validate_token|ValidateToken`) in a single alternation

#### Scenario: Identifier query returns file and line matches
- **WHEN** a lexical query contains the identifier `validateToken` present in a source file
- **THEN** the results include the file path and line number(s) of each match

#### Scenario: Distinct-term coverage outranks raw hit count
- **WHEN** file A matches both query terms once each and file B matches one term many times
- **THEN** file A ranks above file B in the lexical ranking

#### Scenario: ripgrep unavailable
- **WHEN** `rg` is not found on the system at query time
- **THEN** the search runs vector-only and the response carries a warning that lexical search is disabled

### Requirement: Hybrid search API
The system SHALL expose a search function `search(repoId, query, limit)` that merges lexical and vector results using weighted reciprocal-rank fusion (`score = Σ w_i / (60 + rank_i)`), fusing at path level — a path contributes its best chunk rank per list, never a sum across its chunks. The search SHALL deduplicate by path and return ranked results with kind, source path, snippet (read from disk), and score. List weights SHALL be configurable, defaulting vector-leaning for question-style queries (`ask_repo`) and lexical-leaning for identifier-style queries (`search_code`). The ranking stage SHALL be pluggable via config, with weighted RRF as the default and no reranker enabled by default.

#### Scenario: Hybrid merge ordering
- **WHEN** a query matches documents via both ripgrep and vector search
- **THEN** the returned list is ordered by fused rank, deduplicated by path, and limited to `limit`

#### Scenario: Multiple chunks do not inflate rank
- **WHEN** one file has five matched chunks and another has one
- **THEN** each file contributes only its best chunk rank per list to the fused score

### Requirement: Repo concept derivation and centroid
At index time the system SHALL derive per-repo metadata from the wiki bundle: concept terms (aggregated `tags`, `type` values, and frequent title/description terms) and a centroid embedding (mean of concept chunk vectors, including the overview page). This metadata SHALL be recomputed incrementally on index updates and SHALL be exposed via the registry/listing.

#### Scenario: Concept terms derived from wiki frontmatter
- **WHEN** a repo's wiki concepts predominantly carry `tags: [caching, retry]`
- **THEN** the repo's derived concept terms include `caching` and `retry` and appear in `repo list` output

#### Scenario: Centroid updated on incremental re-index
- **WHEN** a repo's wiki bundle changes and chunks are re-embedded
- **THEN** the repo centroid is recomputed from current vectors

### Requirement: Cross-repo routing for unscoped search
When a search is issued without a repoId, the system SHALL embed the query, compare it against repo centroids, fan out the search to the top-k most relevant repos (configurable, default 5), and return merged results attributed per repo. Scoped searches (with repoId) SHALL search only that repo.

#### Scenario: Unscoped question routed to relevant repos
- **WHEN** a search is issued without repoId and three repos' centroids are nearest the query
- **THEN** only those repos (within the top-k bound) are searched and each result carries its repoId

#### Scenario: Scoped search stays in one repo
- **WHEN** a search is issued with a repoId
- **THEN** no other repo's results are returned

### Requirement: Incremental index updates
The system SHALL apply updates incrementally and transactionally: re-registering only bundle concept files whose path+hash changed, re-embedding only changed chunks, and processing only source files reported changed or deleted (via git diff between last indexed sha and new head).

#### Scenario: Changed source file re-indexed
- **WHEN** an update reports `src/a.ts` as changed
- **THEN** only `src/a.ts` chunks are re-registered and re-embedded, in a transaction

#### Scenario: Updated concept content searchable
- **WHEN** a wiki concept's body changed and is re-ingested
- **THEN** subsequent searches reflect the new content
