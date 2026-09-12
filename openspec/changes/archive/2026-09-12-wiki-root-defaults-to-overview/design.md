## Context

See proposal.md — Why. Current state that shapes the approach:

- `handleWiki` (`src/server/wiki.ts`) branches only on `resolved.rest`: empty means `renderIndexPage(db, repo, "")`, non-empty means concept-first then index fallback.
- `renderConceptPage` returns `null` when the concept is not indexed or its file is absent, and the caller already falls through to the directory/404 path on `null`.
- The sidebar's current path is `resolved.rest`, and `buildBreadcrumb(repoId, "", title)` yields a single unlinked repoId crumb.
- The `valid` fixture has a top-level `overview.md`; `openwiki-authored` (the default test bundle) has none, so both branches stay covered by existing fixtures.

## Goals / Non-Goals

**Goals**

- `/wiki/<repoId>` renders the top-level `overview` concept in place, with outline, sources, and sidebar current-marking, when it exists.
- Every no-overview situation (no concept, stale index, missing file) keeps rendering the root listing.

**Non-Goals**

- Redirects, new routes, or a sidebar entry for the root listing.
- Directory URLs defaulting to an overview child.
- Any producer, bundle, or index change.

## Decisions

### Render in place rather than redirect

The root URL keeps rendering at `/wiki/<repoId>`; the page served is the overview concept. Chosen over a 302 to `/wiki/<repoId>/overview` because the root URL is already the canonical repository entry point, and an extra hop buys nothing when the sidebar and outline render identically.

- Alternatives considered: 302 redirect (deep links change meaning after deploy, no user-visible gain); symlink-style duplicate route (two URLs for one page).

### The default is the exact concept id `overview`

The lookup is `renderConceptPage(db, repo, "overview")`; only a top-level concept with that id triggers the default. This matches the producer contract's guaranteed entry point and keeps behavior independent of authoring order.

- Alternatives considered: the first `# Files` entry of the root `index.md` (openwiki bundles list `quickstart` first, which is not the intended landing page); title-matching (fuzzy, unstable).

### Root rendering marks the overview entry current; breadcrumb stays root-only

When the root renders the concept, the sidebar's current path is `"overview"`, so its entry carries `aria-current="page"` — the sidebar marks the page being viewed, not the URL. The breadcrumb stays the single repoId crumb because the URL is the repository root and there is no overview path segment to name.

- Alternatives considered: no current entry at root (contradicts what the user is looking at); a synthetic breadcrumb with the overview title (names a path segment absent from the URL).

### No-overview fallback reuses the existing null path

`renderConceptPage` already returns `null` for an unindexed concept or a file missing from disk; the root branch falls back to `renderIndexPage` on `null`, preserving the stale-index leniency and adding no error path.

- Alternatives considered: 404 on a stale overview (regresses the leniency every other page has); checking chunk existence separately from file read (duplicates the same logic).

## Risks / Trade-offs

- [Bookmarks to `/wiki/<repoId>` change content once an overview exists] → Intended: the root becomes the entry point; the listing remains reachable for bundles without one.
- [`<title>` names the overview concept while the breadcrumb names the repo root] → Accepted: the breadcrumb describes the URL (root), the title describes the page.
- [A bundle whose top-level `overview` is a directory rather than a page] → `renderConceptPage` finds no chunk and the listing renders; no special case needed.

## Migration Plan

None: routing-only change. Rollback is reverting the code.

## Open Questions

None.
