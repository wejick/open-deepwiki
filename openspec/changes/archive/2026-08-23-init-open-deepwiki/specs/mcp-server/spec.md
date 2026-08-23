## ADDED Requirements

### Requirement: MCP over HTTP transport with bearer-token auth
The system SHALL run an MCP server using Streamable HTTP transport on a configurable host/port (default `http://localhost:7245/mcp`), so MCP clients such as Claude Desktop can connect to a persistently running, shared LAN server. When the server is bound to an address beyond localhost, it SHALL require a bearer token (`Authorization: Bearer <token>`) on every request and reject unauthenticated requests with 401.

#### Scenario: Client connects
- **WHEN** an MCP client connects to the server endpoint with a valid token
- **THEN** the MCP initialize handshake succeeds and the server advertises its tools

#### Scenario: Unauthenticated request rejected on LAN bind
- **WHEN** the server is bound beyond localhost and a request arrives without a valid bearer token
- **THEN** the server responds 401 and no tools are accessible

### Requirement: list_repos tool
The server SHALL expose a `list_repos` tool returning all registered repos with repoId, source, last indexed sha, document count, and auto-derived concept terms.

#### Scenario: List repos via tool
- **WHEN** a client calls `list_repos`
- **THEN** the response contains an entry per registered repo with repoId, source, and index status

### Requirement: search_code tool
The server SHALL expose a `search_code(repoId?, query, mode?, limit?)` tool combining ripgrep lexical matches over the repo's files with vector similarity search, returning ranked, deduplicated results with kind, source path, snippet, score, and repo attribution. When `repoId` is omitted, the search SHALL route via repo centroids to the top-k relevant repos and attribute each result to its repo. The tool SHALL accept an optional `mode` parameter (`auto` default with identifier variant expansion, `literal` for fixed-string matching, `regex` to pass the query to rg as a pattern with fixed-string fallback on compile error); the tool description SHALL document these modes so clients can choose deliberately.

#### Scenario: Regex mode passthrough
- **WHEN** a client calls `search_code` with `mode: "regex"` and query `refresh(T|_t)oken`
- **THEN** rg receives that pattern and results reflect regex semantics

#### Scenario: Invalid regex falls back
- **WHEN** a client calls `search_code` with `mode: "regex"` and a pattern that fails to compile
- **THEN** the tool retries as a fixed string and notes the fallback in the response

#### Scenario: Search returns ranked results
- **WHEN** a client calls `search_code` with a valid repoId and query
- **THEN** the response contains up to `limit` results ordered by fused rank, each with `path`, a text snippet, and repo attribution

#### Scenario: Search unknown repo
- **WHEN** a client calls `search_code` with an unregistered repoId
- **THEN** the tool returns an error indicating the repo is not registered

### Requirement: get_wiki_page tool
The server SHALL expose a `get_wiki_page(repoId, path)` tool returning the full OKF concept document — YAML frontmatter fields (type, title, description, generated, sources) plus markdown body — for the given concept path, including the repo-level overview page.

#### Scenario: Fetch file wiki page
- **WHEN** a client calls `get_wiki_page` for an indexed concept path
- **THEN** the response contains the concept's frontmatter fields and markdown body

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
The server SHALL expose an `ask_repo(repoId?, question, keywords?, limit?)` tool that retrieves the top-k most relevant pages/chunks via hybrid search and returns **recall results only**: page identifiers (concept ids usable with `get_wiki_page`), kind (`wiki`/`source`), title, description, bounded snippet, score, and source citations (`repo://` paths with line ranges). When `repoId` is omitted, the question SHALL be routed via repo centroids to the top-k relevant repos, and every result SHALL carry its repoId so the client can follow up with scoped calls. The server SHALL NOT synthesize or generate answers — synthesis is the MCP client's responsibility. The tool SHALL accept an optional `keywords` array (1–5 entries, each a single term or a short multi-term group) of grep-friendly search terms; the tool description SHALL instruct clients to provide them and SHALL document the group semantics — terms within an entry are ANDed, entries are OR-combined, matching is order-insensitive, and exact phrases should use `search_code` with `mode: "literal"` (the question drives semantic recall, keywords drive lexical recall). The response MAY include titles and descriptions of concepts directly linked by the retrieved pages (one-hop neighbors) as navigational context.

#### Scenario: Question returns recall with page identifiers
- **WHEN** a client calls `ask_repo` with a question about an indexed repo
- **THEN** the response contains ranked recall results (page identifier, kind, title, snippet, citations, score) the client can follow up on with `get_wiki_page`/`list_related`, and no synthesized answer

#### Scenario: Unscoped question routed across repos
- **WHEN** a client calls `ask_repo` without a repoId and the question's embedding is nearest to two repos' centroids
- **THEN** results from those repos are returned, each carrying its repoId

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
