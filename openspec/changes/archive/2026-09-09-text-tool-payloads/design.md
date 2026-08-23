# Design: text-tool-payloads

## Context

See proposal.md — Why. Current state: every handler ends in
`ok(JSON.stringify(payload))`; the encoding is pinned by the mcp-server
"Tool response encoding" requirement and asserted by a JSON re-serialization
round-trip test (server.test.ts). Consumers of the text channel are LLMs
only — the dashboard reads `/status` HTTP, the `/wiki` viewer reads the DB
and disk directly, and no programmatic consumer parses MCP tool output.

## Goals / Non-Goals

**Goals:**

- One structured non-JSON text encoding for record payloads across all six
  tools, with a real decoder available for tests.
- `get_wiki_page` body ships with zero escaping; documents ship as documents.
- Serving-time composition only: no bundle, index, or DB writes anywhere.

**Non-Goals:**

- No `outputSchema` / `structuredContent` adoption, no protocol changes.
- No changes to `/status`, `/api/*`, `/wiki`, or the dashboard surfaces.
- No producer, indexer, or storage changes; no reindex or data migration.

## Decisions

### D1: TOON for record payloads

Dep `@toon-format/toon` (pure TS, MIT, spec'd with ABNF + conformance
fixtures), serving the mcp-server "Tool response encoding" requirement.
`encode(payload)` replaces `JSON.stringify(payload)` in every handler.
Alternatives considered: a hand-rolled labeled-line grammar (zero deps, but
we would own quoting, delimiting, and schema-visibility conventions — a
private format with none of TOON's `{fields}` headers, `[N]` length
declarations, or conformance suite); `structuredContent` + `outputSchema`
(the machine channel — rejected: no programmatic consumer exists, and the
client-facing surface is text); keeping JSON (rejected — see proposal).

### D2: `get_wiki_page` = identity header + verbatim file

Response is `encode({repoId, path})` + blank line + the raw file contents.
TOON has no block scalars, so a TOON envelope would `\n`-escape the entire
markdown body — the exact tax this change removes. The identity header comes
from `encode()` (quoting stays correct if an id ever contains `:` or `,`);
the document is plain concatenation. Frontmatter passes through unsplit, so
the gray-matter parse in the handler goes away entirely. Alternatives
considered: splicing identity into the file's own frontmatter (rejected —
mutates the producer artifact and risks key collisions); body-only without
frontmatter (rejected — drops type/title/tags the spec requires); a
JSON/TOON envelope for the whole document (rejected — escapes the body).

### D3: Payload shapes — reshape only `conceptTerms`

Search hits stay unreshaped: TOON falls back to list form because
`lineRanges` (variable-length object arrays) and multi-line `snippet`
strings break tabular eligibility, and list form's labeled fields are
readable as-is. Multi-line snippets keep their newlines (TOON quotes and
`\n`-escapes them) — fidelity over cosmetics; the escape tax is bounded to
one field, unlike the whole-document tax being removed. `list_repos`
joins `conceptTerms` into a space-delimited string cell so the repo array
stays tabular — at ~100 repos the difference is ~8 lines per repo.
Alternatives considered: flattening snippets to single lines (loses line
structure that matters for code); reshaping `lineRanges` to a
`path:start-end` string (saves little in list form and moves formatting
into the payload layer).

### D4: Rounding stays at the payload boundary

`round3` applies to `score`/`vectorSim` before `encode()`, exactly where it
applies today; ranking, filtering, and the below-threshold check keep full
precision. Carried over unchanged from efficient-mcp-tools D2.
Alternatives considered: rounding inside search internals (rejected — same
reason it was rejected there).

### D5: Below-threshold message keeps its prose, TOONs its list

The `ask_repo` below-threshold path keeps the human-readable caveat sentence
and replaces the inline `JSON.stringify(serializeHits(...))` with
`encode(...)` of the same slice. Alternatives considered: folding the
caveat into the payload as a `warning` field (rejected — buries the honesty
signal the prose carries).

### D6: One format-hint line per tool description

Each data-bearing tool's description appends one line stating the response
shape (TOON; identity header + verbatim markdown for `get_wiki_page`).
TOON's headers are self-documenting, but clients have not seen the format in
training. Alternatives considered: no hint (relies entirely on header
self-documentation); a full syntax example per description (token cost on
every tools/list for marginal gain).

### D7: Pin within v4

`@toon-format/toon` at `^4.1.1`. The format has shipped breaking majors;
the caret keeps upgrades within v4 where the encoder's form selection is
stable. No config knob for delimiter or format options — no scenario
consumes one; defaults (comma delimiter, 2-space indent) ship.
Alternatives considered: a delimiter config knob (cut — guardrail 5).

## Risks / Trade-offs

- [TOON is young; form selection could shift across majors] → caret-pinned
  within v4; tests assert via strict `decode()` equality, not string
  comparison, so minor encoder refinements don't break them.
- [Clients misread an unfamiliar format] → `{fields}` headers and `[N]`
  lengths self-document; D6 hint line; reading-direction benchmarks show
  comprehension comparable to or better than JSON.
- [Snippet cells carry `\n` escapes] → accepted (D3): bounded to one field,
  removes the temptation to silently flatten code context.
- [Round-trip tests depend on the dep's decoder] → the decoder is the
  conformance-tested reference implementation; a decoder bug is a TOON bug,
  not a silent wire-format drift in our tools.

## Migration Plan

None. Composition is per-request in memory; deploying is restarting
`serve`, rolling back is reverting. No bundle, index, or state migration;
existing repos serve in the new shape immediately with no reindex.
