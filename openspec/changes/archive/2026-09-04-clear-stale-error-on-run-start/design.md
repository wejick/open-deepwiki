## Context

`recordRun` is the single writer of a run's outcome, but nothing owns the run *start*
mark: `admin.ts` `runUpdate`/`runReinit`, the CLI `update`/`reinit` commands, `add.ts`
`runAddPipeline`, and the CLI batch add each hand-set `lastRun.startedAt` (the admin
paths also clear `finishedAt`; the CLI paths don't). The previous run's `error` is left
standing everywhere — that is the stale error the dashboard keeps showing.

## Goals / Non-Goals

**Goals:**

- One start marker, beside `recordRun`, used by every path that marks a run started.
- The superseded run's error is gone the moment its replacement starts; outcome fields
  and last-success state are untouched until the run records.

**Non-Goals:**

- Clearing `outcome` at start — health must not flip mid-run, and the monitoring spec
  pins the color to run outcomes and staleness alone.
- Scheduler/batch start marks; read-time suppression in `buildStatusSummary`.

## Decisions

**Clear in state, not at read time.** The registry is the one writer of the fact; a
read-time suppression would leave the CLI's registry-only `status` view showing the
stale error and keep the state conflating two runs.
Alternatives considered: hiding the error cell in the dashboard when `runState` is
`running` (a second account of the same fact, invisible to CLI status).

**Marker scope: `startedAt`, `finishedAt`, `error`.** `finishedAt` is cleared for every
caller so in-flight detection (`startedAt != null && finishedAt == null`) is uniform —
the CLI paths previously left the old finish time standing in memory until `recordRun`,
which only worked because the CLI never publishes state mid-run.
Alternatives considered: clearing only `error` (leaves two start-mark shapes in the
codebase).

## Risks / Trade-offs

- [An interrupted run loses the previous failure's error text] → the event log keeps
  the forensic `run_failed` line and the `interrupted` classification surfaces the
  break; the state stops conflating two runs.

## Migration Plan

None — the marker is behavior-identical for add paths (fresh records carry no error)
and only changes what update/reinit paths show while a run is in flight. Rollback is
reverting the commit.
