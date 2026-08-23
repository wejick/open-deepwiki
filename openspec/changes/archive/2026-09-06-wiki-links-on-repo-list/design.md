## Context

The wiki viewer (`/wiki`, src/server/wiki.ts) and the dashboard (src/server/dashboard.js) are served by the same HTTP server but sit in different auth domains by invariant: the dashboard shell is untokened, `/wiki` authenticates via a session cookie set once by visiting `/wiki?token=<token>` (the same shared bearer token). On a localhost bind `requiresToken` is false and no cookie is needed; on a LAN bind the cookie is required and is a session cookie, so it re-asks every fresh browser session. `renderRepoRows` renders the repo cell as plain text; nothing on the dashboard points into the wiki.

## Goals / Non-Goals

**Goals:**
- One-click path from each dashboard repo row to its wiki (`/wiki/<repoId>`).
- The link works on LAN binds on the first click when the token is typed in the dashboard header.
- No dead links: rows whose wiki has no indexed pages render plain text.

**Non-Goals:**
- CLI `repo list` URLs (see proposal Non-goals).
- Any change to cookie lifetime, token storage, or the bearer-token model.
- Linking other cells or auto-discovering the server's public base URL.

## Decisions

1. **Anchor = repo name cell, gated on `docs.wiki > 0`.** The name is the DeepWiki-conventional link point and the one element users read first. Alternatives considered: linking the wiki-docs count (semantically tidy, less discoverable); a distinct "wiki" action button (clutters an actions cell that already holds seven buttons); linking unconditionally and letting `/wiki` 404 (a dead link for `--no-wiki` repos is a rendering bug, not a routing one).

2. **Deep-link bootstrap in `handleWiki`: accept `?token=` on any `/wiki*` path.** Validate (only when `requiresToken`), set the identical cookie, 302 to the same pathname with the token stripped; the bare `/wiki` case keeps its exact current behavior. This makes deep links work from anywhere, not just the dashboard. Alternatives considered: a dashboard-side pre-flight request to `/wiki?token=` before navigating (two round trips, breaks ⌘-click, dashboard-specific fix for a general deep-link gap); shipping plain links only (LAN users hit a 401 dead end once per browser session).

3. **Href composition as a pure exported helper** (e.g. `wikiHref(repoId, wikiCount, token)` → string), called by `renderRepoRows` and by a rewrite pass, unit-tested in Bun without a DOM per the dashboard's structure rule. Alternative considered: inline string building in `renderRepoRows` (untestable without a DOM, contradicts the established `fmtProgress`/`summarizeAsk` pattern).

4. **Token typed after render: rewrite rendered hrefs on the token input's `change` event.** The input already has a `change` listener (localStorage persistence) and renders links from localStorage on load, so a rewrite pass there plus initial render covers the timeline with no new state. Alternatives considered: an `input` (per-keystroke) listener (same behavior, duplicates the existing listener's role); a delegated click handler computing the href at click time (simplest staleness story, but it breaks middle-click/⌘-click new-tab gestures because navigation happens in JS).

5. **No new dependency or config knob.** The link is same-origin relative (`/wiki/<repoId>`), so the dashboard needs no base-URL knowledge and this decision adds nothing requiring a requirement.

## Risks / Trade-offs

- [Token transits a URL] → One redirect hop, immediately stripped, landing on a clean path; identical exposure to the existing `/wiki?token=` bootstrap. The cookie remains HttpOnly.
- [A repo with a bundle but zero *indexed* wiki pages renders unlinked despite a servable bundle] → Accepted: `docs.wiki > 0` is the honest "something to read" signal the row already carries; a bundle that fails indexing should not advertise pages.
- [Redirect drops query params other than `token`] → `/wiki` routes read no other query parameters today; the redirect preserves the pathname only, which is lossless for every current URL.

## Migration Plan

Deploy with the server restart as usual; no data, config, or index changes. Rollback is a revert — both behaviors (plain text rows, bare-`/wiki`-only bootstrap) are the pre-change state. The `wiki-viewer` capability this deltas against was archived from `add-wiki-viewer` immediately before this change, so main specs are the source of truth.

## Open Questions

None — navigation is same-tab (a plain anchor), settled during exploration; new-tab gestures still work for users who prefer them.
