## 1. Scheduler applies schedule edits live

- [x] 1.1 `Scheduler.applySchedule(repoId)`: await the startup registry load, stop the repo's job, recreate it only for a valid override (cleared → default job covers it; invalid → ignored). Tests: `repo-manager › Live schedule updates` — edited override replaces the job (`getPattern()` shows the new expression, `getNextRun()` moves), cleared override removes the job, invalid override creates no job, untouched repos' jobs unchanged.

## 2. Status exposes the schedule

- [x] 2.1 Add `schedule: string | null` to `RepoStatus` in `src/monitor/status.ts`. Test: a status summary renders the override for a repo that has one and null for one that does not.

## 3. Admin schedule endpoints

- [x] 3.1 `GET /api/repos/:id/schedule` and `PUT /api/repos/:id/schedule` in `src/server/admin.ts`: 404 unknown repo, `{schedule: <string|null>}` shapes, `cron.validate` before save (400 with the parse error, nothing persisted), empty/null clears, `saveYaml` only, no run started. Tests: `admin-api › Schedule endpoints` — round-trip, clearing, invalid rejection leaves the prior override, save writes yaml without touching `state.json` or starting a run, unknown repo 404.
- [x] 3.2 Wire the live apply: `startServer` accepts `applySchedule(repoId)`, `handleAdminApi` calls it after a valid PUT, `serve` in `src/cli/main.ts` passes `scheduler.applySchedule`. Test: a PUT against a started server with the hook reschedules the running scheduler's job for that repo.

## 4. Dashboard schedule editing

- [x] 4.1 `renderRepoRows` shows the schedule cell — override expression, default marker when null — and a Schedule row action. Pure helpers (cell text, request body) unit-tested in Bun. Tests: `dashboard › Schedule editing` — row shows the effective schedule.
- [x] 4.2 Wire the Schedule action in the guarded DOM block: prefill from GET, Save sends PUT (empty input sends the clearing value), success notice "saved — applies immediately", server error text surfaced. Tests: pure helper for the saved/notice text; DOM-wired behavior covered by the endpoint tests plus a `dashboard.js` structure check that the action exists and no update request is issued by the save path.

## 5. Gates

- [x] 5.1 `bun test ./src ./test` green; `bun run lint`, `bun run format`, `bun run typecheck` clean; `openspec validate` passes for the change.
