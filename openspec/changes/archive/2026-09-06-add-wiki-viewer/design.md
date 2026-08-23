## Context

See [proposal.md](proposal.md) for motivation. Relevant existing shape:

- Wiki bundles live on disk at `<clonePath>/openwiki/`, one Markdown file per
  concept plus `index.md` per directory. `index.md` files are excluded from
  indexing ([verify.ts](../../../src/producer/verify.ts) `RESERVED_NAMES`) —
  they exist only as navigation, never as a DB chunk.
- `repoId` is derived as `<host>/<full-group-path>` and is unique by
  suffixing (`-2`, `-3`, ...), never nested
  ([registry.ts](../../../src/repoManager/registry.ts) `repoIdFromSource`).
- Concept ids are bundle-relative paths sans `.md`
  ([ingest.ts](../../../src/index/ingest.ts)), which already exports
  `resolveLink` to turn a Markdown link target into a concept id.
- `server.ts` gates every route except `/healthz` behind
  `cfg.bearerToken`, exempting localhost binds
  ([server.ts](../../../src/server/server.ts):186-188). The dashboard
  attaches the token as an `Authorization` header on every fetch — a pattern
  that only works for JS-driven requests, not plain navigation.

## Goals / Non-Goals

**Goals:**
- Real, bookmarkable `/wiki/<repoId>/<path>` URLs rendered fully server-side.
- Reuse existing resolution/parsing code (`resolveLink`, `gray-matter`
  frontmatter parsing already used by `tools.ts`) rather than duplicating it.
- Keep client JS to exactly one lazy-loaded module, used only when a page
  contains a Mermaid diagram.

**Non-Goals:**
- See proposal.md's Non-goals section (sidebar, search, editing, live
  reload) — not repeated here.
- A new auth tier or per-user credentials — this reuses the single existing
  shared token.

## Decisions

**Server-side rendering, not a client-fetch SPA.** Real path URLs
(`/wiki/repo-name`) must work as plain navigation and bookmarks, and the
project wants minimal client JS — both point away from a client-side router
that fetches JSON and renders in the browser. Bun reads the bundle,
renders Markdown to HTML, and returns a complete page per request, the same
way `server.ts` already serves `dashboard.html` as static text.
*Alternative considered*: client-side SPA with hash routing (my initial
proposal) — rejected once real URLs were required, since a bearer header
can't ride a plain navigation.

**repoId/path split by longest registry-prefix match.** `repoId` values are
variable-length (`host/group/subgroup/.../repo`) and concept paths also
contain slashes, so there's no fixed delimiter to split on. Because a repo
name and a namespace can't collide at the same path on GitHub/GitLab, a
registered `repoId` can never be a literal prefix of another registered
`repoId` — so matching the longest registered `repoId` that prefixes the
request path is unambiguous. *Alternatives considered*: a fixed two-segment
scheme like GitHub's `org/repo` (rejected — this project's repoIds aren't
bounded to two segments); a query-string page parameter (rejected — the
whole point was real hierarchical paths, not `?page=`).

**Markdown rendering: `markdown-it` + `shiki`, both server-side only.**
Serves the "modern, full-featured, code-highlighted" rendering requirement
from the wiki-viewer spec's "Rendered page content" requirement. Both run
once per request in Bun and never reach the browser, so their size doesn't
count against the minimal-client-JS goal. *Alternatives considered*:
`micromark` (more minimal, but no first-party highlighting story, more glue
code to reach the same result); rendering Markdown client-side with a
browser-bundled parser (rejected — the entire reason to render server-side
is to avoid shipping a parser to the client).

**Mermaid: a real `mermaid` dependency, but never imported — its published
`dist/` is served as static assets, lazy-loaded client-side.** Diagram
rendering needs a real DOM/SVG target, which Bun doesn't have; a
headless-browser renderer (e.g. `mermaid-cli`, which bundles Chromium) is
disproportionate to one feature and conflicts with no-over-engineering.
`mermaid` is added to `package.json` (its direct consumer is the static-file
route below, not a TypeScript `import`) solely so `bun install` populates
`node_modules/mermaid/dist/` — no bundler, no build step, no hand-copied
file. That directory is served under `/wiki/assets/mermaid/`, read per
request rather than preloaded, and `import()`ed client-side only when a
rendered page contains a `mermaid` block, per the spec's "Mermaid block
rendered as a diagram" scenario. This turned out to require more than the
entry file: Mermaid's ESM entry dynamically imports 200+ per-diagram-type
chunk files from beside itself at runtime, so a single vendored file 404s on
every real diagram — caught in the browser verification pass, not in review.
*Alternative considered*: server-side rendering via `mermaid-cli`/Puppeteer —
rejected, no direct requirement justifies a Chromium-sized dependency for one
diagram type.

**Auth: cookie carries the existing `ODW_BEARER_TOKEN`, scoped to
`/wiki/*` only — no new config, no new token.** `/wiki?token=<token>` sets a
cookie; subsequent `/wiki/*` requests check the cookie the same way
`/api/*` checks the `Authorization` header today. This is additive: the
existing header-only check for `/api/*` and `/mcp` is untouched, so those
capabilities' specs don't change (see proposal.md's empty Modified
Capabilities). *Alternatives considered*: making `/wiki/*` unauthenticated
(rejected — user decision, wiki content is as sensitive as the rest of a
LAN-shared server); extending the shared token-check function to accept a
cookie everywhere, including `/api/*` and `/mcp` (rejected — widens two
existing capabilities' authentication behavior for no requirement this
change needs, and would require delta specs for them).

**`index.md` read from disk, not indexed.** Repo-root and directory listings
read `index.md` directly from the bundle checkout, the same file the
producer already writes and the same exclusion `RESERVED_NAMES` already
encodes. *Alternative considered*: index `index.md` files as DB chunks so
directory listings could be fetched like concept pages — rejected, it would
change the producer/ingest contract's reserved-names behavior for a need
this change doesn't have (a plain disk read is enough).

## Risks / Trade-offs

- **Shared-token trust tier**: anyone who receives a `/wiki?token=` link
  holds the same token that grants full admin write access (add/remove
  repos). → Accepted: this matches the project's existing single-shared-
  secret model (one `ODW_BEARER_TOKEN` already gates all admin writes);
  introducing a separate read-only token would be a new credential tier
  with no requirement driving it. Document the risk where the bootstrap
  link is generated/shared, rather than building a second auth mechanism.
- **Shiki grammar-load cost per request** → Mitigation: reuse one
  highlighter instance across requests instead of constructing it per call.
- **Registry read races** (registry changes between the prefix match and
  the page read) → Mitigation: read the registry once per request, matching
  the existing `getRegistry()` pattern other routes already use.

## Migration Plan

Purely additive: new routes mounted under `/wiki/*`, three new dependencies
(`markdown-it`, `shiki`, `mermaid` — the last read from disk, not imported),
no DB schema change. No migration or backfill; rollback is removing the
route mount and the three `package.json` entries.

## Open Questions

- Exact cookie lifetime/expiry for the `/wiki` session — any reasonable
  default (e.g. long-lived, no rotation, matching that the underlying token
  itself doesn't rotate) satisfies the spec; doesn't change the approach.
- Which `markdown-it` plugins beyond fenced code + the `mermaid`-fence
  override are worth enabling (tables, footnotes) — decide during
  implementation from what real bundles actually use; doesn't change the
  spec or task breakdown.
