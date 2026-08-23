# Proposal: add-dashboard

## Why

Managing repos and exercising the MCP surface today requires CLI access to the
server host. A barebone web dashboard served by the existing HTTP server makes
the three daily workflows — manage repos, watch wiki generation status, and
try MCP tools — available to anyone on the LAN with just a browser and the
bearer token.

## What Changes

- **Dashboard page** (`GET /`): static HTML + vanilla JS served as local files
  (`/dashboard.js`), minimal styling (layout/readability only), manual refresh
  — no polling, no framework, no build step. JS helpers are importable so CI
  can execute them. Sections: repos table (health, wiki/src counts, sha, last
  run outcome/duration/tokens, error), per-row actions (Test retrieval,
  Update, Instructions view/edit, Remove with confirm), single-URL add form,
  and an MCP playground (tools/list → inputSchema-driven form → tools/call).
- **Admin write API** on the serve process: `POST /api/repos` (pre-flight
  source validation — `git ls-remote` for URLs, path+git check for local —
  then register and run in the background, 202), `POST /api/repos/:id/update`,
  `DELETE /api/repos/:id` (409 while the repo lock is held),
  `GET/PUT /api/repos/:id/instructions`.
- **Registry write discipline**: run-outcome writers (scheduler, update)
  write only `state.json`; human-config writers (instructions edit) write
  only `registry.yaml`; add/remove write both. Fixes silent loss of
  mid-batch edits.
- **Test-on-add**: pre-flight fails bad sources in seconds; the per-row Test
  button proves retrievability by calling `ask_repo` through `/mcp` from the
  browser (zero server code — the dashboard is an MCP client).
- Bearer-token handling in the page: token field persisted in localStorage,
  attached to every API/MCP call; the page shell itself is untokened.

## Capabilities

### New Capabilities
- `dashboard`: the HTML page, its client-side behavior (manual refresh,
  per-row actions, MCP playground, token field), and how it composes the
  admin API + `/status` + `/mcp`.
- `admin-api`: the write endpoints (add/update/remove/instructions),
  pre-flight validation, background-run semantics, lock conflicts, auth.

### Modified Capabilities
- `mcp-server`: carve the static dashboard shell (`GET /`) out of the
  "bearer token on every request" requirement when LAN-bound (same
  treatment as `/healthz`); all data endpoints stay tokened.
- `repo-manager`: add the registry write-discipline requirement (state-only
  saves for run outcomes; yaml-only saves for config edits) so mid-batch
  edits are never clobbered.
- `monitoring`: extend the `/status` per-repo entry with the last run's
  start/finish times so in-flight runs are observable (the dashboard's
  "running" indicator and the admin API's observability requirement both
  read this).

## Impact

- `src/server/server.ts` (new routes), new `src/server/dashboard.html`,
  new admin route module, `src/repoManager/registry.ts` (export the save
  halves), `src/repoManager/scheduler.ts` + `src/cli/main.ts` (call the
  right save half; addRepo logic moves to repoManager for reuse).
- No new dependencies, no new MCP tools, no schema changes.
- Accepted blind spot: embedding-degraded runs show green; signal is only
  `vectorSim: null` in Test results.

## Non-goals

- Auto-refresh/polling, run-history/event feeds, batch add UI,
  schedule-override editing, `--no-wiki` in the add form.
- Any styling beyond layout/readability; no SPA framework, no bundler.
- Answer synthesis — the recall-only invariant is untouched.
