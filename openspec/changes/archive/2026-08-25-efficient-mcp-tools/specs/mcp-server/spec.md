# Delta: mcp-server

## ADDED Requirements

### Requirement: Tool response encoding
The server SHALL return every tool payload exactly once, as compact JSON (no pretty-print indentation) in the result's text content. While no tool declares an `outputSchema`, the response SHALL NOT duplicate the payload in `structuredContent`. Numeric scores (`score`, `vectorSim`) in tool responses SHALL be rounded to at most 3 decimal places; rounding SHALL apply only to serialization — ranking, filtering, and threshold logic SHALL continue to operate on full precision.

#### Scenario: Single compact payload
- **WHEN** a client calls a tool and the response carries a data payload (for example `list_repos`, `search_code` with results, `get_wiki_page`, `list_related`, `ask_repo` with results, or `server_status`)
- **THEN** the payload appears once, as compact JSON text in the result (re-serializing the parsed value yields the identical string), and the result carries no `structuredContent`; message-only responses (errors, "no relevant content") remain human-readable text

#### Scenario: Scores rounded to 3 decimals
- **WHEN** a search response includes `score` or `vectorSim` values
- **THEN** every such value has at most 3 decimal places

## MODIFIED Requirements

### Requirement: search_code tool
The server SHALL expose a `search_code(repoId?, query, mode?, limit?)` tool combining ripgrep lexical matches over the repo's files with vector similarity search, returning ranked, deduplicated results with kind, source path, snippet, score, and repo attribution. When `repoId` is given, repo attribution SHALL appear once as a top-level `repoId` field on the response instead of being repeated on every result. When `repoId` is omitted, the search SHALL route via repo centroids to the top-k relevant repos and every result SHALL carry its own `repoId`. The tool SHALL accept an optional `mode` parameter (`auto` default with identifier variant expansion, `literal` for fixed-string matching, `regex` to pass the query to rg as a pattern with fixed-string fallback on compile error); the tool description SHALL document these modes so clients can choose deliberately.

#### Scenario: Regex mode passthrough
- **WHEN** a client calls `search_code` with `mode: "regex"` and query `refresh(T|_t)oken`
- **THEN** rg receives that pattern and results reflect regex semantics

#### Scenario: Invalid regex falls back
- **WHEN** a client calls `search_code` with `mode: "regex"` and a pattern that fails to compile
- **THEN** the tool retries as a fixed string and notes the fallback in the response

#### Scenario: Search returns ranked results
- **WHEN** a client calls `search_code` with a valid repoId and query
- **THEN** the response contains up to `limit` results ordered by fused rank, each with `path`, a text snippet, and repo attribution

#### Scenario: Scoped search hoists repo attribution
- **WHEN** a client calls `search_code` with a `repoId`
- **THEN** the response carries a single top-level `repoId` field and no result repeats it

#### Scenario: Search unknown repo
- **WHEN** a client calls `search_code` with an unregistered repoId
- **THEN** the tool returns an error indicating the repo is not registered

### Requirement: ask_repo tool
The server SHALL expose an `ask_repo(repoId?, question, keywords?, limit?)` tool that retrieves the top-k most relevant pages/chunks via hybrid search and returns **recall results only**: page identifiers (concept ids usable with `get_wiki_page`), kind (`wiki`/`source`), title, description, bounded snippet, score, and source citations (`repo://` paths with line ranges). When `repoId` is given, repo attribution SHALL appear once as a top-level `repoId` field on the response instead of being repeated on every result. When `repoId` is omitted, the question SHALL be routed via repo centroids to the top-k relevant repos, and every result SHALL carry its repoId so the client can follow up with scoped calls. The server SHALL NOT synthesize or generate answers — synthesis is the MCP client's responsibility. The tool SHALL accept an optional `keywords` array (1–5 entries, each a single term or a short multi-term group) of grep-friendly search terms; the tool description SHALL instruct clients to provide them and SHALL document the group semantics — terms within an entry are ANDed, entries are OR-combined, matching is order-insensitive, and exact phrases should use `search_code` with `mode: "literal"` (the question drives semantic recall, keywords drive lexical recall). The response MAY include titles and descriptions of concepts directly linked by the retrieved pages (one-hop neighbors) as navigational context.

#### Scenario: Question returns recall with page identifiers
- **WHEN** a client calls `ask_repo` with a question about an indexed repo
- **THEN** the response contains ranked recall results (page identifier, kind, title, snippet, citations, score) the client can follow up on with `get_wiki_page`/`list_related`, and no synthesized answer

#### Scenario: Unscoped question routed across repos
- **WHEN** a client calls `ask_repo` without a repoId and the question's embedding is nearest to two repos' centroids
- **THEN** results from those repos are returned, each carrying its repoId

#### Scenario: Scoped question hoists repo attribution
- **WHEN** a client calls `ask_repo` with a `repoId`
- **THEN** the response carries a single top-level `repoId` field and no result repeats it

#### Scenario: Keywords drive lexical recall
- **WHEN** a client calls `ask_repo` with `question: "how does token refresh work?"` and `keywords: ["token refresh", "middleware"]`
- **THEN** the lexical side of the hybrid search uses exactly those keyword groups (ANDed within, OR-combined across) while the question drives the vector query

#### Scenario: No relevant content
- **WHEN** a client calls `ask_repo` with a question unrelated to the repo's content
- **THEN** the response indicates no relevant content was found rather than fabricating an answer
