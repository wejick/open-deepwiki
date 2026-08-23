## Context

The scheduler (`src/repoManager/scheduler.ts`) builds one `node-cron` job per
repo override plus a default nightly job, once, at `createScheduler` time. The
override lives in `registry.yaml` under `repos[].schedule` (human-owned).
Admin endpoints (`src/server/admin.ts`) own every dashboard write; the
instructions GET/PUT pair is the closest precedent. `serve` wires the
scheduler and the admin API as siblings with no connection between them
(`src/cli/main.ts`), so a schedule edit today waits for the next restart.

## Goals / Non-Goals

**Goals:**

- Read and write the per-repo cron override over the admin API.
- Reject invalid expressions before anything is persisted.
- A saved schedule governs the running scheduler immediately.
- The dashboard can view and edit the schedule per repo, like instructions.

**Non-Goals:**

- Dashboard editing of the global nightly time (env config, not registry).
- A schedule field on repo add.
- Timezone handling beyond node-cron's server-local default.

## Decisions

- **Endpoints mirror the instructions pair** — `GET/PUT
  /api/repos/:id/schedule`, PUT body `{ "schedule": <string|null> }`, empty or
  null clears. Same routing shape, same `saveYaml`-only write discipline
  (admin-api › Schedule endpoints).
  - Alternatives considered: a generic `/api/repos/:id/config` endpoint —
    rejected, it would invite field-by-field registry mutation with per-field
    validation rules in one handler; and reusing the instructions PUT body —
    rejected, one resource per endpoint keeps validation local.

- **Validation with `cron.validate` before save.** An invalid expression
  returns 400 with node-cron's own complaint, persists nothing, reschedules
  nothing. No new dependency (already in the stack, serving repo-manager's
  scheduler).
  - Alternatives considered: a hand-rolled field-count check — rejected,
    node-cron's parser is the authority the scheduler itself defers to, so a
    second parser can only disagree with it; save-then-let-the-scheduler-ignore
    — rejected, the operator gets no error and the edit silently does nothing.

- **The scheduler exposes `applySchedule(repoId)`** and serve passes it into
  `startServer` as an `applySchedule` option on `AdminDeps` — the same
  process-boundary wiring `adminDb` already uses. `applySchedule` re-reads the
  registry (the just-saved yaml is the source of truth), stops that repo's job,
  and creates a new one only when a valid override exists; invalid overrides
  are ignored exactly like invalid overrides read at startup.
  - Alternatives considered: rebuilding all cron jobs on every save —
    rejected, it needlessly drops and recreates untouched jobs; a file watcher
    on registry.yaml — rejected, only the admin API writes schedules and the
    watcher would also fire on hand edits the spec does not cover.

- **`RepoStatus.schedule`** — the status payload already merges registry
  config per repo (`producer` is precedent); one pass-through field lets the
  dashboard show the effective override without an extra request per row.
  - Alternatives considered: dashboard fetches schedules per row on render —
    rejected, N requests to display what the status payload can carry for one
    field; omitting display entirely — rejected, an editor whose current value
    is invisible off-open hides the fact a repo runs hourly at 03:00 while
    everything else runs nightly.

- **Dashboard reuses the instructions interaction**: a per-row action expanding
  into the row's output area, prefilled by GET, saved by PUT. The notice says
  the change applies immediately (instructions apply on the next run).
  - Alternatives considered: a cron-builder widget (pick hour/day) — rejected,
    the registry stores a cron expression and the CLI/registry hand-editing
    path already speaks cron; a modal — rejected, no modal precedent in the
    dashboard.

## Risks / Trade-offs

- [Cron firing is wall-clock bound, so a test cannot wait for a fire without
  sleeping] → assert on node-cron's own `getPattern()`/`getNextRun()` of the
  replacement job, which observes the reschedule without waiting for a tick.
- [An edit mid-batch re-reads the registry and could race the batch's
  state-only save] → the write discipline already makes this safe: the edit
  writes yaml only, the batch writes state only, neither clobbers the other
  (repo-manager › Registry write discipline).
- [`applySchedule` before the scheduler's initial async registry load finishes
  would double-register a repo] → `applySchedule` awaits the same init promise
  the startup load uses.

## Migration Plan

Additive: new endpoints, one status field, one scheduler method. No stored
format changes. Rollback is a revert; a registry edited in the meantime keeps
loading exactly as before (invalid or absent overrides were always ignored).

## Open Questions

None.
