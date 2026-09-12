## Why

`/wiki` pages are reachable only through links embedded in `index.md` bodies and a topbar breadcrumb: readers cannot see the wiki's structure, jump across sibling sections, or navigate within a long page. DeepWiki's layout — a persistent left page tree plus a right "On this page" heading outline — is the established solution and the design we adopt.

## What Changes

- Add a sticky left sidebar to every repository wiki page: the complete concept tree nested by directory, ordered by each `index.md`'s Files/Directories order, directories as links to their listing, the current entry marked, headed by `Last indexed: <date> (<short sha>)` linked to the forge commit when derivable.
- Add a right "On this page" outline of the rendered page's headings (h1–h3) as anchor links; rendered headings gain stable `id`s, with duplicates disambiguated.
- Collapse both rails below breakpoints with CSS only — no client script, no framework, no new dependency. The existing breadcrumb topbar remains.
- Both rails are server-rendered per request from the same bundle files and DB chunks the pages already read; no new endpoints and no schema change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wiki-viewer`: new requirements for the sidebar page tree, the on-page heading outline with anchored headings, and the responsive rail layout.

## Non-goals

- Outline numbering (1, 1.1) — DeepWiki's numbering comes from its generated page ids; our entries show authored titles only.
- Client-side search, filtering, or per-node collapse/expand toggles.
- A mobile drawer or any client script for the rails.
- Changes to MCP tools, the index schema, or the dashboard.

## Impact

- `src/server/wiki.ts` — shell/layout and page rendering.
- `src/server/wikiRender.ts` — heading anchors and outline collection.
- `src/repoManager/webLinks.ts` — forge commit URL for the sidebar header.
- `src/server/wiki.test.ts`, `src/server/wikiRender.test.ts` — new scenarios.
- Spec: `openspec/specs/wiki-viewer/spec.md` (via delta).
