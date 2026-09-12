## Context

See proposal.md — Why. Current state that shapes the approach:

- `handleWiki` (`src/server/wiki.ts`) resolves a repo, renders one page, and wraps it with `renderShell` (topbar breadcrumb + content). Two page kinds exist: concept pages (chunks in the DB) and directory listings (on-disk `index.md`, excluded from indexing).
- `buildBreadcrumb`, `renderRepoListBody`, and `resolveWikiPath` are pure helpers, unit-tested directly; the server tests exercise the real HTTP surface.
- Markdown rendering lives in `src/server/wikiRender.ts` (markdown-it + Shiki); `index.md` ordering (`# Files` / `# Directories` lists) is authored by the producer and is the only in-bundle navigation signal.
- `RepoRecord` already carries `source`, `lastIndexedSha`, and `lastSuccessAt`; `webLinks.ts` derives GitHub/GitLab web URLs from `source`.
- No client script ships except the conditional Mermaid bootstrap; the `/wiki` surface has no framework and no build step.

## Goals / Non-Goals

**Goals**

- Server-rendered left page tree and right heading outline, derived from data the pages already read, with zero new dependencies and zero client JS.
- Pure, directly unit-testable helpers for tree building and heading slugs.

**Non-Goals**

- Numbering, search, per-node collapse, mobile drawer (proposal Non-goals).
- Caching the tree or the rendered shell; each request rebuilds from disk/DB.
- Changes to the bundle format or producer behavior.

## Decisions

### Tree structure from paths, ordering from `index.md`

Concepts and titles come from `listChunks(db, repoId, "wiki")` — the same set the indexer maintains and `conceptIdSet` already reads. Nesting comes from concept ids. Order comes from walking each directory's on-disk `index.md` and taking its Markdown link destinations in document order, keeping only destinations that resolve to a direct child of that directory: a trailing-slash directory reference or a concept id after `joinBundlePath`. Directory labels use the link text when the `index.md` supplies one, otherwise the basename. Concepts/directories absent from `index.md` still appear, appended after the listed ones in path order.

- Alternatives considered: filesystem `walkMd` for the concept set (diverges from the index when a run is mid-update, and `walkMd` has no titles); alphabetical-only ordering (discards the authored outline); indexing `index.md` (violates the "no body text in the database" invariant and the bundle's read-only status).
- The tree build is a pure function over `{path, title}[]` + per-directory ordered child ids, so it is unit-tested without HTTP or disk.

### Heading anchors and outline collected during Markdown rendering

`buildWikiMarkdown` overrides markdown-it's `heading_open` renderer: for h1–h3 it derives a slug from the heading's inline text (lowercase, punctuation removed, spaces to hyphens), appends `-1`, `-2` … for repeated slugs within the page, sets the `id`, and pushes `{level, text, id}` onto an array carried on the per-request render env. `renderShell` receives that array and renders the outline, indented by `level - base` (12px per step, matching DeepWiki).

- Alternatives considered: post-processing rendered HTML with a regex (breaks on inline markup and code spans); adding `markdown-it-anchor` (a dependency for a 20-line slugger); using `env`-free global state (per-process renderer is shared, so state must stay per-request).
- Slug uniqueness state is per render, so two pages never interfere.

### Three-region CSS grid; rails sticky, collapsed by media query

`renderShell` emits `<header class="topbar">` then a `.layout` grid: sidebar, `.content`, outline. The topbar gets a fixed height so the sticky rails can use a constant `top` offset and `max-height: calc(100vh - <topbar>)` with their own scroll. Breakpoints: outline hidden at ≤1200px, sidebar hidden at ≤900px; the content column takes the freed width. `renderShell`'s new sidebar/outline parameters are optional so the `/wiki` repo list (and its tests) render exactly as today.

- Alternatives considered: a mobile drawer or collapse toggles (needs script; explicitly out of scope); `position: fixed` rails (overlays content at narrow widths); flexbox with `order` (grid expresses the three named regions and their collapse more directly).
- No new dependency and no config knob: breakpoints are presentation constants, not user-configurable.

### Revision header uses a new `webCommitUrl` helper

`RepoRecord.lastIndexedSha` + `source` drive a `Last indexed: <YYYY-MM-DD> (<short sha>)` caption at the top of the sidebar. The revision links to the forge commit page via a new `webCommitUrl(source, sha)` in `webLinks.ts` (GitHub `/commit/<sha>`, GitLab `/-/commit/<sha>`, null otherwise), reusing the existing `parseRemote` + host detection from `webSourceUrl`.

- Alternatives considered: building the URL inline in `wiki.ts` (duplicates forge detection already unit-tested in `webLinks`); linking to the latest blob URL (wrong target — a commit page is what DeepWiki links and what readers expect); human-formatted dates (locale/time-dependent output is not deterministic in tests — ISO date comes straight from `lastSuccessAt`).

## Risks / Trade-offs

- [Malformed or missing `index.md` yields a flat or alphabetical subtree] → The fallback keeps every concept and directory visible; ordering is best-effort by design, and scenarios cover the unlisted-page case.
- [Long wikis produce a tall sidebar] → It scrolls inside the sticky rail exactly like DeepWiki; no virtualization until measured to be a problem.
- [Fixed topbar height can clip a long breadcrumb on narrow screens] → Breadcrumbs wrap inside the content column; if that proves cramped, the collapse rules can hide the breadcrumb while keeping the rails' offset constant.
- [Heading text changes alter anchor ids] → Anchors are generated per render and only consumed by the same page's outline; nothing persists them.

## Migration Plan

None: UI-only change, no schema, bundle, or API changes. Rollback is reverting the code.

## Open Questions

None.
