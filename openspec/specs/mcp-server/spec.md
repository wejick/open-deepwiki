# MCP Server Specification

## Purpose

TBD — synced from change init-open-deepwiki (archived 2026-08-23).

## Requirements

### Requirement: MCP over HTTP transport with bearer-token auth
The system SHALL run an MCP server using Streamable HTTP transport on a configurable host/port (default `http://localhost:7245/mcp`), so MCP clients such as Claude Desktop can connect to a persistently running, shared LAN server. When the server is bound to an address beyond localhost, it SHALL require a bearer token (`Authorization: Bearer <token>`) on every request and reject unauthenticated requests with 401 — with exactly two exceptions that carry no data: `GET /healthz` and `GET /` (the static dashboard shell) SHALL be served without a token. All data-bearing endpoints (`/mcp`, `/status`, `/api/*`) SHALL remain tokened.

#### Scenario: Client connects
- **WHEN** an MCP client connects to the server endpoint with a valid token
- **THEN** the MCP initialize handshake succeeds and the server advertises its tools

#### Scenario: Unauthenticated request rejected on LAN bind
- **WHEN** the server is bound beyond localhost and a request to a data-bearing endpoint arrives without a valid bearer token
- **THEN** the server responds 401 and no tools are accessible

#### Scenario: Dashboard shell untokened on LAN bind
- **WHEN** the server is bound beyond localhost and a browser requests `GET /` without a token
- **THEN** the dashboard HTML is served with 200, while `/status` and `/api/*` requests without a token still return 401

### Requirement: list_repos tool
The server SHALL expose a `list_repos` tool returning all registered repos with repoId, source, last indexed sha, document count, and auto-derived concept terms.

#### Scenario: List repos via tool
- **WHEN** a client calls `list_repos`
- **THEN** the response contains an entry per registered repo with repoId, source, and index status

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

### Requirement: get_wiki_page tool
The server SHALL expose a `get_wiki_page(repoId, path)` tool returning the full OKF concept document for the given concept path, including the repo-level overview page. The response SHALL begin with an identity header — `repoId: <id>` and `path: <path>` on separate lines — followed by one blank line and the bundle file's contents verbatim: the file's YAML frontmatter fields (type, title, description, generated, sources) and markdown body pass through unmodified and unescaped. The identity header and document SHALL be composed at serving time only; the tool SHALL NOT write to or modify the on-disk bundle.

#### Scenario: Fetch file wiki page
- **WHEN** a client calls `get_wiki_page` for an indexed concept path
- **THEN** the response begins with the `repoId` and `path` identity lines, followed by a blank line and the concept's frontmatter fields and markdown body exactly as they appear in the bundle file

#### Scenario: Wiki page missing
- **WHEN** a client calls `get_wiki_page` for a path with no wiki document
- **THEN** the tool returns a not-found error

### Requirement: list_related tool
The server SHALL expose a `list_related(repoId, path)` tool returning the outgoing and incoming (backlink) edges of a concept, with each neighbor's id, title, and description.

#### Scenario: Backlinks and outgoing links returned
- **WHEN** a client calls `list_related` for an indexed concept that links to two others and is linked by one
- **THEN** the response lists two outgoing and one incoming neighbor with titles and descriptions

#### Scenario: Unknown concept path
- **WHEN** a client calls `list_related` for a path that is not indexed
- **THEN** the tool returns a not-found error

### Requirement: ask_repo tool
The server SHALL expose an `ask_repo(repoId?, question, keywords?, limit?)` tool that retrieves the top-k most relevant pages/chunks via hybrid search and returns **recall results only**: page identifiers (concept ids usable with `get_wiki_page`), kind (`wiki`/`source`), title, description, bounded snippet, score, and source citations — each result's `path` plus `lineRanges` (and `repoId` on cross-repo results), together sufficient to locate the cited lines and follow up with `get_wiki_page`/`search_code`. When `repoId` is given, repo attribution SHALL appear once as a top-level `repoId` field on the response instead of being repeated on every result. When `repoId` is omitted, the question SHALL be routed via repo centroids to the top-k relevant repos, and every result SHALL carry its repoId so the client can follow up with scoped calls. The server SHALL NOT synthesize or generate answers — synthesis is the MCP client's responsibility. The tool SHALL accept an optional `keywords` array (1–5 entries, each a single term or a short multi-term group) of grep-friendly search terms; the tool description SHALL instruct clients to provide them and SHALL document the group semantics — terms within an entry are ANDed, entries are OR-combined, matching is order-insensitive, and exact phrases should use `search_code` with `mode: "literal"` (the question drives semantic recall, keywords drive lexical recall). The response MAY include titles and descriptions of concepts directly linked by the retrieved pages (one-hop neighbors) as navigational context.

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

### Requirement: Read-only index access
The server SHALL open repo index databases in read-only mode and SHALL NOT modify index data in response to client tool calls.

#### Scenario: Server survives missing index
- **WHEN** a client queries a repo whose index database does not exist yet
- **THEN** the tool returns a clear error and the server continues serving other repos

### Requirement: Tool response encoding
The server SHALL return every tool payload exactly once as structured non-JSON text in the result's text content. Record-bearing payloads (`list_repos`, `search_code`, `ask_repo`, `list_related`, `server_status`, and the closest-matches list embedded in `ask_repo`'s below-threshold message) SHALL be encoded as TOON (Token-Oriented Object Notation) text — key/value lines for objects, length-declared arrays, and tabular form for arrays of uniform records. While no tool declares an `outputSchema`, the response SHALL NOT duplicate the payload in `structuredContent`. Numeric scores (`score`, `vectorSim`) in tool responses SHALL be rounded to at most 3 decimal places before encoding; rounding SHALL apply only to serialization — ranking, filtering, and threshold logic SHALL continue to operate on full precision. Message-only responses (errors, "no relevant content") SHALL remain human-readable plain text.

#### Scenario: Single compact payload
- **WHEN** a client calls a tool and the response carries a data payload (for example `list_repos`, `search_code` with results, `list_related`, `ask_repo` with results, or `server_status`)
- **THEN** the payload appears once, as TOON text that strictly decodes back to the payload value, and the result carries no `structuredContent`; message-only responses (errors, "no relevant content") remain human-readable text

#### Scenario: Repo list renders tabular
- **WHEN** a client calls `list_repos` and at least two registered repos share the same record fields
- **THEN** the response carries a tabular `repos[N]{fields}` header with exactly one row per repo, concept terms joined into a single string cell

#### Scenario: Scores rounded to 3 decimals
- **WHEN** a search response includes `score` or `vectorSim` values
- **THEN** every such value has at most 3 decimal places

#### Scenario: Below-threshold closest matches encoded as TOON
- **WHEN** a client calls `ask_repo` and every result is below the similarity threshold
- **THEN** the human-readable caveat prose is retained and the closest-matches list that follows it is TOON text
