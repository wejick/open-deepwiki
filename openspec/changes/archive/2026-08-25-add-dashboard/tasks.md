# Tasks: add-dashboard

## 1. Foundations

- [x] 1.1 Spike the MCP handshake: POST a bare `tools/list` (no `initialize`) to `/mcp` on a fixture server and record whether it succeeds — pin the result as a test so the dashboard JS wiring (D3) matches reality
- [x] 1.2 Registry write discipline: export the `saveState`/`saveYaml` halves from `registry.ts`; switch pure run-outcome saves (scheduler batch end, `repo update`, `index`) to state-only; registration/removal keep writing both
- [x] 1.3 Tests for 1.2: "Batch end leaves human config untouched" (registry.yaml byte-identical after batch save) and "Mid-batch edit survives" (instructions edit during batch persists after batch end)
- [x] 1.4 Move `registerRepo`/`addRepo` from `cli/main.ts` into `src/repoManager/` so CLI and server share one implementation; CLI tests stay green, no behavior change

## 2. Admin API

- [x] 2.1 Pre-flight `validateSource(source)`: `git ls-remote` for remote URLs (shim `git` on PATH in tests), exists + is-git-worktree for local paths (fixture repos); tests for unreachable URL, non-git path, and valid sources
- [x] 2.2 `src/server/admin.ts` skeleton + router wiring in `server.ts`: `handleAdminApi(req, res, deps)` returns false for non-`/api/*` paths; in-flight run tracker (module-level map of repoId → run promise, exported for tests); auth — `/api/*` requires the bearer token on LAN bind (401), untokened on localhost; test both auth scenarios
- [x] 2.3 `POST /api/repos`: 400 on pre-flight failure (nothing registered), 409 on duplicate source, 202 + repoId on success with the init pipeline running in the background; tests for all three scenarios using shimmed `git`/`openwiki` and stubbed `fetch`
- [x] 2.4 `POST /api/repos/:id/update`: 404 unknown repo, 409 lock held, 202 + background update run; tests per scenario (await the run tracker — no sleeps)
- [x] 2.5 `DELETE /api/repos/:id`: 404 unknown repo, 409 lock held, 200 with registration + clone + index rows purged (same removal as CLI); tests per scenario, asserting the repo vanishes from `/status`
- [x] 2.6 `GET`/`PUT /api/repos/:id/instructions`: 404 unknown repo, round-trip returns exactly the stored text, empty/whitespace-only clears, PUT writes registry.yaml only (state.json untouched), no run started; tests per scenario

## 3. Dashboard page

- [x] 3.1 Static assets: `src/server/dashboard.html` + `src/server/dashboard.js` (plain vanilla JS) served at `GET /` and `GET /dashboard.js` via Bun text imports; untokened shell on LAN bind while `/status` + `/api/*` stay 401; tests: both return 200, neither references external scripts/styles/fonts/images, auth carve-out holds
- [x] 3.2 `dashboard.js` structure: exported pure helpers (JSON-RPC payload builders, status-row renderer, hit summarizer, inputSchema→field descriptors) with all DOM wiring behind a `typeof document !== "undefined"` guard so `bun:test` can import the module; unit test: importing the module in Bun does not throw
- [x] 3.3 Status table + Refresh + token field: helpers build rows from a status fixture (health, wiki/src counts, short sha, last run time/outcome/duration/tokens, last error; `startedAt`-without-`finishedAt` renders as running) and the authorized-fetch wrapper attaches the localStorage token; unit tests for the row renderer and header wiring; source assertions for no polling timers and required element ids
- [x] 3.4 Repo actions: add form, per-row Update, Remove behind a confirm guard, Instructions textarea (GET on expand, Save-only via PUT, "applies on next run" notice); unit tests for the request-builder helpers (paths, methods, bodies); source assertion for the confirm guard and that Save issues no update request
- [x] 3.5 Test button + MCP playground: per-row Test calls `ask_repo` via `POST /mcp` (question = first conceptTerm, fallback `"overview"`) and prints hit count + top hit or the verbatim "no relevant content" message; playground lists tools via `tools/list`, builds the arg form from `inputSchema`, calls `tools/call`, renders raw JSON; unit tests for the payload builders, summarizer, and schema-form descriptors against a fixture `tools/list`; source assertion for no hardcoded tool list; handshake sequence per 1.1

## 4. Finish

- [x] 4.1 `bun test ./src ./test` green, `bun run lint`, `bun run typecheck`, `openspec validate add-dashboard --strict`
- [x] 4.2 Manual browser pass: `serve` a fixture registry and click through the real page — add a repo, watch it flip running → done on Refresh, run Test, one playground call — confirming the wiring the unit tests can't execute
- [x] 4.3 Update `AGENTS.md`: document the dashboard + admin API as the server's only write surface and the registry write discipline alongside the existing invariants
