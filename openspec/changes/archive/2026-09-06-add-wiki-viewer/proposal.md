## Why

Wiki bundles (Markdown + frontmatter + Mermaid + a link graph) are only reachable through MCP tools consumed by an LLM client. Nobody can open a repo's wiki in a browser and read it — the only HTTP surface today is the admin dashboard, which manages repos, not content.

## What Changes

- New `/wiki` HTTP surface, separate from the dashboard: `/wiki` lists registered repos, `/wiki/<repoId>/<path>` serves a page, resolved by longest-prefix match against the registry (repoIds and concept paths both contain slashes).
- Server-side rendering: `markdown-it` + `shiki` turn bundle Markdown into fully rendered HTML per request — no client-side Markdown parsing.
- Mermaid fences render client-side via a vendored, lazy-loaded ESM module, loaded only on pages that contain one — the only client JS this feature ships.
- In-body cross-page links are rewritten to real `/wiki/...` URLs at render time, reusing the existing `resolveLink` concept-id resolver ([ingest.ts](src/index/ingest.ts)).
- A top-bar breadcrumb (repoId, then each path segment) replaces a sidebar; directory segments resolve to that directory's `index.md`, read off disk since `index.md` files aren't DB-indexed.
- Self-contained cookie auth for `/wiki/*`: a one-time `/wiki?token=` link sets a cookie carrying the existing shared bearer token, so plain navigation and bookmarks work with no header. `/api/*` and `/mcp` auth is untouched.

## Capabilities

### New Capabilities
- `wiki-viewer`: routing, rendering, cookie auth, and navigation for the browsable `/wiki` surface.

### Modified Capabilities
(none — `/api/*` and `/mcp` authentication behavior does not change)

## Non-goals

- Sidebar navigation — rejected; breadcrumb + in-body links + the repo list carry it.
- Citation/source-line hover panels — the `sources: repo://...` data exists, but the UI is a fast-follow, not v1.
- Cross-repo or full-text search on `/wiki` — `ask_repo` stays MCP-only.
- Editing wiki content, or any write path under `/wiki/*`.
- Reusing or extending `dashboard.html`/`dashboard.js` — this is a separate file and route tree.
- Live reload or file-watching — pages render fresh per request.

## Impact

- New: `src/server/wiki.ts` (routes, rendering, breadcrumb, prefix-match), `src/server/wikiRender.ts` (Markdown/Shiki/link rendering).
- Modified: `src/server/server.ts` (mount `/wiki/*` routes).
- New dependencies: `markdown-it`, `shiki` (server-side only, no client bundle cost) and `mermaid` (never imported in code — its published `dist/` directory, entry plus per-diagram-type chunks, is served as a client-side asset under `/wiki/assets/mermaid/`, which does carry its own bundle weight on any page with a diagram).
- No DB schema change — reads existing chunks/edges through the functions `tools.ts` already uses.
