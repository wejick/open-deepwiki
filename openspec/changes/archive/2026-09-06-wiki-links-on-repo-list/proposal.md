## Why

The wiki viewer and the dashboard shipped without referencing each other: the dashboard's repo table renders repo ids as plain text, so the operator's home page gives no path into the wiki pages the pipeline produces. The gap is most painful on LAN binds, where `/wiki` needs its own cookie and nothing on the dashboard helps start that session.

## What Changes

- Dashboard repo table: a repo's name becomes a link to `/wiki/<repoId>` when its wiki document count is positive, and stays plain text otherwise (no dead links for `--no-wiki` or not-yet-produced repos).
- The link carries the shared token from the dashboard's header token input as `?token=` when one is typed, and links already rendered update when the token is typed afterward (no refresh needed).
- Wiki bootstrap: `/wiki/<any path>?token=<token>` now sets the session cookie and redirects to the same path without the query — previously only the bare `/wiki?token=` URL bootstrapped, so dashboard deep links dead-ended on LAN binds.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard`: Repo status table requirement — repo name renders as a wiki link gated on positive wiki document count, carrying the header token when present, updating without refresh when the token is typed after render.
- `wiki-viewer`: Wiki authentication requirement — token bootstrap accepted on any `/wiki/<path>` with a redirect to the same path sans query, not only on bare `/wiki`.

## Impact

- `src/server/dashboard.js` (+ `dashboard.test.ts`): link rendering in `renderRepoRows`, a pure href helper, a token-input listener.
- `src/server/wiki.ts` (+ `wiki.test.ts`): bootstrap branch widened from `pathname === "/wiki"` to any `/wiki*` path with `?token=`.
- No DB, config, CLI, or MCP changes. Token-in-URL exposure is one redirect hop, identical to the existing `/wiki?token=` flow.

## Non-goals

- No wiki URL on CLI `repo list` output — the CLI cannot reliably know a public base URL (bind may be `0.0.0.0`, server may be down).
- No change to cookie lifetime or the bearer-token model; the cookie remains the same shared token set once per session.
- No auto-linking of other dashboard cells (wiki-docs count, sha, actions) — the repo name is the single link point.
