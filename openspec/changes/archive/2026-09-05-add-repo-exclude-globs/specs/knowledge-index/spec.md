## MODIFIED Requirements

### Requirement: Raw source ingestion
The system SHALL walk the repo checkout respecting configurable include/exclude globs — the exclude set being the configured global globs merged additively with the repo's registry `excludeGlobs` — skipping binary files, files over a configurable max size, secret files (e.g., `.env`), and the openwiki bundle directory itself, and SHALL register the remaining files as `source` chunks (path, line ranges, content hash; no body copy).

#### Scenario: Excluded files are skipped
- **WHEN** the checkout contains files matching exclude globs (e.g., `node_modules/**`, `*.lock`, `openwiki/**`)
- **THEN** no `source` chunks are registered for those files

#### Scenario: Repo-excluded files are skipped
- **WHEN** a repo's registry `excludeGlobs` contains `**/*.snap` and the checkout contains a matching snapshot file not covered by the global globs
- **THEN** no `source` chunk is registered for that file

#### Scenario: Deleted source file removed
- **WHEN** a previously indexed source file is deleted from the checkout
- **THEN** its chunks no longer participate in search results

### Requirement: Lexical search via ripgrep
The system SHALL execute lexical searches by spawning `rg` constrained to the repo's checkout and OKF bundle directory, honoring the configured include/exclude globs — the exclude set being the configured global globs merged additively with the repo's registry `excludeGlobs` — returning file path, line number, and match context. Query terms SHALL be taken from the calling tool's optional `keywords` parameter when provided by the client; otherwise the system SHALL derive terms deterministically (tokenize the query, drop stopwords, keep the ≤4 longest tokens). Each keyword entry MAY contain multiple whitespace-separated terms: within an entry, terms are ANDed (all must be present in a file for the entry to count as satisfied); across entries, terms are combined in a single alternation pattern. Distinct-term coverage SHALL be computed as the fraction of satisfied keyword entries. Identifier-style queries in `auto` mode SHALL be expanded to camelCase/snake_case/kebab-case variants in a single alternation pattern. Lexical matching SHALL use one `rg` invocation per query per distinct effective exclude glob set (repos whose merged globs are identical share an invocation), with term alternation, JSON match output, per-file × per-term counts derived from match events, and SHALL be capped (per-file match limit, file-size limit, process timeout with vector-only degradation on timeout). Match lines SHALL be mapped to chunks via the chunks registry for fusion and snippet extraction. The system SHALL derive a per-file lexical ranking from match results — ordering by hit density multiplied by distinct-term coverage — rather than using BM25 or term-frequency scoring. The system SHALL detect ripgrep absence at startup and degrade to vector-only search with a warning.

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

#### Scenario: Repo-excluded files are not searched
- **WHEN** a repo's registry `excludeGlobs` contains `automation_tests/**` and a lexical query matches only files under that path
- **THEN** no result from those files is returned

#### Scenario: ripgrep unavailable
- **WHEN** `rg` is not found on the system at query time
- **THEN** the search runs vector-only and the response carries a warning that lexical search is disabled
