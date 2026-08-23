## Why

Per-repo schedule overrides exist in `registry.yaml` (`schedule`), but the only
way to set one is hand-editing the file on the server. The dashboard is already
the admin surface for the other human-config field (instructions); schedule is
the remaining registry field an operator must shell in for. Worse, a schedule
edit only reaches the running scheduler after a restart, because per-repo cron
jobs are built once at startup.

## What Changes

- New admin endpoints `GET /api/repos/:id/schedule` and
  `PUT /api/repos/:id/schedule` (read for prefill; write to change or clear the
  per-repo cron override).
- Invalid cron expressions are rejected with 400 before anything is persisted;
  an empty value clears the override (repo falls back to the nightly default).
- The running scheduler applies a schedule edit immediately — the repo's cron
  job is replaced without restarting `serve`.
- `GET /status` reports each repo's `schedule` so the dashboard can show the
  effective override at a glance.
- Dashboard: per-row Schedule action (like Instructions) — an input prefilled
  from the GET endpoint, saved via PUT, with a notice that the change applies
  immediately.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `admin-api`: new requirement — schedule read/write endpoints with cron
  validation, yaml-only persistence, and no run started.
- `dashboard`: new requirement — per-row schedule viewing and editing.
- `repo-manager`: new requirement — the running scheduler applies registry
  schedule edits without a restart.

## Non-goals

- The global nightly batch time (`ODW_NIGHTLY_TIME`) stays environment config;
  it is not editable from the dashboard.
- No schedule field on `POST /api/repos` — a new repo runs on the default and
  gets an override afterwards if wanted.
- No per-repo timezone support; node-cron evaluates in server-local time as
  today.

## Impact

- `src/server/admin.ts` (endpoints), `src/server/server.ts` (wire the
  scheduler hook), `src/cli/main.ts` (pass the hook), `src/repoManager/
  scheduler.ts` (live reschedule), `src/monitor/status.ts` (`schedule` field).
- No new dependencies — validation uses `node-cron`'s `validate`, already a
  dependency.
