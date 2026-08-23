## MODIFIED Requirements

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

### Requirement: get_wiki_page tool
The server SHALL expose a `get_wiki_page(repoId, path)` tool returning the full OKF concept document for the given concept path, including the repo-level overview page. The response SHALL begin with an identity header — `repoId: <id>` and `path: <path>` on separate lines — followed by one blank line and the bundle file's contents verbatim: the file's YAML frontmatter fields (type, title, description, generated, sources) and markdown body pass through unmodified and unescaped. The identity header and document SHALL be composed at serving time only; the tool SHALL NOT write to or modify the on-disk bundle.

#### Scenario: Fetch file wiki page
- **WHEN** a client calls `get_wiki_page` for an indexed concept path
- **THEN** the response begins with the `repoId` and `path` identity lines, followed by a blank line and the concept's frontmatter fields and markdown body exactly as they appear in the bundle file

#### Scenario: Wiki page missing
- **WHEN** a client calls `get_wiki_page` for a path with no wiki document
- **THEN** the tool returns a not-found error
