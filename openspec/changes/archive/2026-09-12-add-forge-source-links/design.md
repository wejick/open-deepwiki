## Context

See proposal.md — Why. Two read surfaces already have everything they need at
request time: `RepoRecord` carries the clone `source` (scp-like, `ssh://`, or
`https://` forms — see `repoIdFromSource`, `src/repoManager/registry.ts:324`)
and `lastIndexedSha`; OKF frontmatter `sources` carry `repo://<path>#L<start>-L<end>`
resources whose path and range parsers already exist in `grounding.ts` and are
shared with acceptance. The viewer (`src/server/wiki.ts`) already parses
frontmatter with gray-matter but renders only `parsed.content`; MCP search
serialization happens in one place (`serializeHits`, `src/server/tools.ts:78`)
where the registry is already in scope. No new state is needed anywhere.

## Goals / Non-Goals

**Goals:**
- One derivation of forge web locations from registry data, shared by both
  surfaces, with a conservative no-link fallback.
- Citations in `/wiki` pages visible and clickable; source-kind MCP results
  clickable from Claude Desktop.

**Non-Goals:**
- Any new registry field, URL template, or provider beyond GitHub/GitLab.
- Changing what counts as a citation (acceptance's `repo://` parser stays the
  single definition).
- `get_wiki_page` output, body `repo://` links, or code-block provenance.

## Decisions

### Provider inferred from the source host
`webSourceUrl` parses the remote, and the web shape follows the host:
`/gitlab/i` → GitLab, `/github/i` → GitHub (this also covers the common
self-hosted names, `gitlab.corp` and `github.corp`), anything else → no link.
Alternatives considered: a per-repo `web` registry field (exact for neutral
hosts and SSH aliases, but adds a config knob and a repo-manager requirement
for a case this fleet does not have yet); a full per-repo URL template (maximal
flexibility, clearly over-engineered for two known forges).

### Permalinks pinned to `lastIndexedSha`
The forge revision is the commit the published bundle was built and indexed at,
so the page's own line ranges and the link agree. A repo with no indexed
revision (never succeeded, or `--no-wiki`) gets no link. Alternatives
considered: the default branch (never stale, but line numbers drift from the
text the page describes — the failure mode this feature should not create);
clone HEAD at request time (moves mid-run and can differ from what was indexed).

### Pure helper in `src/repoManager/webLinks.ts`
`webSourceUrl(source: string, sha: string | null, path: string, range: {start,end} | null): string | null`
builds the URL; the remote parser currently inline in `repoIdFromSource` is
extracted to a shared `parseRemote` export so both call it (path case preserved
— `repoIdFromSource` lowercases for ids, the URL must not). Construction
details: strip `.git` / trailing slashes, drop the port, lowercase the host,
percent-encode each path segment but keep `/`, fragment per provider
(`#L10-L20` GitHub, `#L10-20` GitLab, `#L8` single line, none without a range).
Alternatives considered: placing it in `registry.ts` (that file owns
persistence/merge, not URL derivation); placing it in `src/server/` (it is a
property of a repo source, and would either pull server code into index or
duplicate the parser); leaving the two parsers separate (drift).

### Viewer reuses the acceptance citation parsers
`renderConceptPage` maps `parsed.data.sources` through `citedPath()` and
`lineRangeOf()` from `src/producer/grounding.ts` — the same functions the
grounding check uses — so the viewer and acceptance agree on what a citation
is, including path normalization that rejects traversal. Entries render as a
trailing `Sources` section: link text `path` or `path:start-end`, an anchor
when `webSourceUrl` returns non-null, plain `<code>` text otherwise; nothing is
emitted when no entry parses. Alternatives considered: a fresh `repo://` parser
in the viewer (two definitions of a citation); moving the parsers to a new
shared module (churn with no second consumer requirement).

### MCP URLs built in `tools.ts`, not `search.ts`
`serializeHits` is the serialization boundary and the registry is already in
scope next to it (`repoExcludesFor` builds a repo map the same way), so the
result gains `url: string | null` there; `SearchHit` and `search.ts` stay
untouched. Alternatives considered: adding `url` to `SearchHit` (drags registry
knowledge into the index layer); one lookup per hit (the per-call map is
already the established shape).

## Risks / Trade-offs

- [SSH alias or neutral host yields no link] → conservative text fallback keeps
  the citation visible; add the deferred `web` field only when a real repo hits
  this, per the no-knob-without-a-scenario rule.
- [GitHub-style range fragments may be ignored on some GitLab versions] →
  formatted per provider anyway; if a fragment were ignored the link still opens
  the correct file.
- [A force-pushed `lastIndexedSha` 404s] → same exposure as any permalink; the
  next successful build re-pins the sha, and the index and bundle fail together.
- [Stale page cites lines past EOF] → grounded bundles reject this at acceptance
  time; forges no-op on out-of-range fragments otherwise.
- [TOON payload grows one field per result] → every row gains `url`, null when
  absent, which keeps tabular encoding uniform (matching `title`/`vectorSim`).

## Migration Plan

Read-time only: no database, registry, or config change, so no migration and no
rollback steps beyond reverting the change and restarting `serve`.
