## Why

The sidebar now exposes the full page tree, but the bare repo URL still renders the `index.md` listing while the conventional entry point of an OKF bundle is its top-level `overview` concept. DeepWiki's root URL serves the overview page; ours should too, so `/wiki/<repoId>` lands on the page a reader is meant to start from.

## What Changes

- `GET /wiki/<repoId>` renders the repository's top-level `overview` concept when one exists, at the same URL (no redirect), with its outline, sources, and sidebar current-marking.
- When no top-level `overview` concept exists — or it is indexed but missing on disk — the root renders the `index.md` listing exactly as today.
- Directory URLs (`/wiki/<repoId>/<dir>`) are unchanged.
- The root listing is no longer separately reachable when an overview exists; it is a fallback, not a second route, and the sidebar already exposes every page and directory.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wiki-viewer`: `Wiki page routing` gains the root-overview default and its fallback; `Wiki navigation sidebar` gains the root-overview current-marking scenario.

## Non-goals

- Redirects, or any second route/entry for the root listing.
- Applying the overview default to directory URLs.
- Changes to `/wiki` (repo list), the dashboard, MCP tools, or the database.

## Impact

- `src/server/wiki.ts` — `handleWiki`'s root branch and the sidebar's current path.
- `src/server/wiki.test.ts` — root routing scenarios for both fixtures.
- Spec: `openspec/specs/wiki-viewer/spec.md` (via delta).
