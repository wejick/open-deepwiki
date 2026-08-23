## Why

Every MCP tool payload is returned as compact JSON inside the result's text
content. The only consumers of that text are LLMs (the server is recall-only;
the client synthesizes), so escaped JSON is a double-decode tax — worst on
`get_wiki_page`, where an already-markdown body ships with every newline as
`\n`. The intent behind the text channel was structured non-JSON text an LLM
reads directly; the encoding requirement codified a misreading of it instead.

## What Changes

- Record-bearing tools (`list_repos`, `search_code`, `ask_repo`,
  `list_related`, `server_status`) encode their payloads as **TOON**
  (Token-Oriented Object Notation) text instead of compact JSON.
- `get_wiki_page` returns a two-line identity header (`repoId:`, `path:`)
  followed by a blank line and the **verbatim** bundle file — no frontmatter
  splitting, no body escaping.
- The `ask_repo` below-threshold message's embedded JSON becomes TOON.
- Tool descriptions gain a one-line response-format hint.
- Numeric scores stay rounded to ≤3 decimals at serialization; ranking keeps
  full precision internally (unchanged semantics).
- Message-only responses (errors, "no relevant content") stay plain text.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-server`: the "Tool response encoding" requirement changes from compact
  JSON-in-text to TOON for record payloads and identity-header + verbatim
  markdown for `get_wiki_page`; the `get_wiki_page` requirement gains the
  identity-header wording.

## Impact

- Code: `src/server/tools.ts` (all handlers), `src/server/server.test.ts`
  (encoding assertions). No producer, index, repoManager, or storage changes;
  composition is at serving time only — no bundle or DB writes.
- Dependency: adds `@toon-format/toon` (pure TS, pinned within v4), named
  against the response-encoding requirement; AGENTS.md allowed-deps list gains
  the entry.
- Clients: Claude Desktop / opencode see a new text shape on every data-bearing
  tool response. `structuredContent` remains absent (unchanged).
- Non-goals: `/status`, `/api/*`, `/wiki`, and the dashboard keep their current
  JSON/HTML surfaces; no `outputSchema`/`structuredContent` adoption; no
  snippet or payload reshaping beyond `conceptTerms` (see design).
