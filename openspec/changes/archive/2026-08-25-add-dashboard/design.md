# Design: add-dashboard

## Context

The HTTP server today is read-only: `/mcp` (recall-only tools, JSON responses
via `enableJsonResponse`), `/healthz`, `/status`. Repo management is CLI-only,
yet the `serve` process already holds everything a management API needs: a
writable DB handle (opened for the scheduler), the per-repo lock machinery,
and the pipeline functions. The registry is split into human-owned
`registry.yaml` (source, schedule, options, instructions) and machine-owned
`state.json` (run outcomes), but `saveRegistry()` always writes both — and
the nightly batch holds one in-memory copy for its entire run, so a mid-batch
edit to `registry.yaml` is silently reverted by the batch's final save.

## Goals / Non-Goals

**Goals:**
- One HTML file with vanilla embedded JS: repos table (manual refresh),
  per-row Test/Update/Instructions/Remove, single-URL add form, MCP playground.
- Admin write endpoints with pre-flight source validation and background runs.
- Registry writes that cannot clobber concurrent edits.

**Non-Goals:** auto-refresh, batch add, schedule editing, `--no-wiki` in the
form, event feeds, any styling beyond layout/readability, answer synthesis.

## Decisions

**D1 — Admin endpoints live in-process with `serve`.** The writable DB,
scheduler, and locks are already there; routes hang off the existing router.
*Alternatives considered:* a separate `dashboard` process — rejected, two
writers contend on the same WAL database for no benefit.

**D2 — Static files served from memory: `dashboard.html` + `dashboard.js`.**
Both imported via Bun text import, served at `GET /` and `GET /dashboard.js`.
The JS is plain vanilla with exported pure helpers (payload builders, row
rendering, hit summarizers) and DOM wiring behind a `document` guard, so
`bun:test` imports and executes the helpers directly — no DOM dependency.
*Alternatives considered:* a single self-contained HTML file with inline JS —
rejected after the testing review: inline JS is unexecutable in CI (no DOM in
`bun:test`), leaving rendering bugs invisible; read from disk per request
(hot-edit is worthless with instant restarts); inline template string
(a 400-line HTML blob inside TypeScript is unmaintainable).

**D3 — The dashboard is an MCP client.** The browser POSTs JSON-RPC
(`tools/list`, `tools/call`) straight to `/mcp`; JSON responses are already
enabled. Tool forms are generated from each tool's `inputSchema`, so new
tools appear in the playground with zero dashboard changes. *Alternatives
considered:* dedicated `/api/test` proxy endpoints — rejected, duplicates
what `/mcp` already speaks and would drift from the real surface.

**D4 — Test-on-add composes existing surfaces.** Pre-flight in
`POST /api/repos`: `git ls-remote` for URLs, exists+is-git for local paths —
bad sources fail in seconds with 400. Post-run, the per-row Test button
calls `ask_repo` (question = first conceptTerm, fallback `"overview"`) and
prints hit count + top hit. *Alternatives considered:* a synthetic `/verify`
endpoint — rejected, the recall surface IS the honest end-to-end check;
auto-firing the test on refresh — rejected as magic in a manual-refresh UI.

**D5 — Background runs + manual refresh (202).** Add/update register the
intent, kick an in-process async run (per-repo lock; reuses the CLI's
pipeline path), and return 202 immediately; the user clicks Refresh and
reads `startedAt`-without-`finishedAt` as "running". *Alternatives
considered:* holding the HTTP request open for a multi-minute run —
rejected, fragile; polling timers — rejected per user direction.

**D6 — Registry write discipline via the existing save halves.** Export the
private `saveState`/`saveYaml` from `registry.ts`; run-outcome writers
(scheduler batch end, `repo update`, admin-triggered runs) call
`saveState` only; the instructions PUT calls a yaml-only save; add/remove
keep both. *Alternatives considered:* re-read-and-merge before every save —
rejected, more machinery than splitting the call; whole-file locking —
rejected, the ownership split already exists, we just honor it.

**D7 — Untokened shell, tokened data.** `GET /` serves the HTML without a
token (browsers can't set `Authorization` on navigation; the shell holds no
secrets — same carve-out as `/healthz`). Every `/api/*` and `/mcp` call
from the page carries the token from a localStorage-backed field.
*Alternatives considered:* tokening the shell too — impossible without
breaking navigation; cookies — rejected, more machinery than a header.

**D8 — Flat module layout.** Admin handlers in `src/server/admin.ts`
(`handleAdminApi(req, res, deps)` returns false for non-matching paths,
called from the existing router); `registerRepo`/`addRepo` move from
`cli/main.ts` to `src/repoManager/` so CLI and server call the same code.
*Alternatives considered:* duplicating the add logic — rejected;
server importing from `cli/` — rejected, wrong dependency direction.

## Risks / Trade-offs

- [Bare `tools/list` POST may need an `initialize` handshake first] →
  first implementation task is a 2-minute spike; the JS handles either
  answer (send initialize → tools/list in sequence if required).
- [Process death mid-run leaves `startedAt` without `finishedAt` — the row
  looks "running" forever] → acceptable: any later run overwrites the state;
  the row's Update button is the recovery path. No watchdog machinery.
- [Token in localStorage is readable by any JS on the page] → acceptable on
  a self-hosted LAN tool; the dashboard loads no third-party scripts.
- [Embedding-degraded runs render green; only `vectorSim: null` in Test
  results hints at it] → accepted blind spot; persisting warnings would add
  state against the minimal-read-surface invariant.
- [State-only save changes scheduler behavior] → covered by the
  write-discipline tests: a mid-batch yaml edit must survive the batch end.

## Migration Plan

None — new routes and a new file; existing endpoints and CLI behavior are
unchanged (the save-split preserves on-disk formats).
