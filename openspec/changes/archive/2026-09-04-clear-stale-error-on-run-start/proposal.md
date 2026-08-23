# Proposal: clear-stale-error-on-run-start

## Why

`lastRun.error` is written only by `recordRun`, when a run *finishes*. Every path that
starts a single-repo run (web Update/Reinit, `repo update`, `repo reinit`) marks the run
in-flight (`startedAt` set, `finishedAt` null) but leaves the previous run's error in
place — so a repo that failed once keeps showing that error on the dashboard for the
whole duration of every subsequent run, red error text beside "running…" and planning
progress. Observed live: a repo rebuilding after a map-rejection failure showed the old
rejection error while its replacement run was mid-planning.

## What Changes

- The run-start mark becomes one shared marker used by every single-repo path (CLI
  `repo add` single and batch, `repo update`, `repo reinit`; admin add/update/reinit):
  set the start time, clear the finish time, and clear any previously recorded error.
- The marker touches nothing else: outcome, duration, reset time, grounding score, last
  indexed sha, and last-success timestamp stand until the run records — health color and
  last-success state cannot flip mid-run.
- The nightly batch is unchanged: it marks no start, and its runs clear the error only
  when they record, per the existing spec sentence.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `repo-manager`: Run observability — one start marker clears the superseded run's
  error; the outcome recorder stays the only writer of outcome fields.

## Impact

- `src/repoManager/pipeline.ts` (new `markRunStarted` beside `recordRun`),
  `src/repoManager/add.ts`, `src/server/admin.ts`, `src/cli/main.ts` (call the marker
  instead of hand-setting `startedAt`), plus tests in the repo-manager and admin scopes.
- No new dependencies, no config knobs, no read-surface changes: `/status`, the
  dashboard, and CLI `status` already display whatever error the state holds.

## Non-goals

- Clearing `outcome` (or the health color) when a run starts — red during a rebuild is
  honest ("the last completed run failed"), and monitoring pins health to run outcomes.
- Marking run starts in the nightly batch; its in-flight state stays visible through
  scheduler queue state, per the existing spec sentence.
- Suppressing the error at read time — the state would keep lying between runs, and the
  CLI's registry-only `status` view would still show the stale error.
