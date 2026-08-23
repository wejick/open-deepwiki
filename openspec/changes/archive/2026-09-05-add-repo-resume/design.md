## Context

`updateRepo` (src/repoManager/pipeline.ts) already contains the resume
mechanics: when `readWipMeta` finds a preserved build, it skips the pull,
targets the pinned sha, and `runIsolatedProducer` stages the WIP, enforcing
`planResume`'s resume/discard/exhaust rules (src/producer/run.ts:114). The
nightly batch uses this implicitly. What's missing is an operator-facing way
to trigger it now, without pulling. Status already exposes the build
(`build: { pinnedSha, attempts }`, src/monitor/status.ts:42), and the
dashboard's row actions all follow the same POST-and-notice shape.

## Goals / Non-goals

Non-goals as in the proposal: no CLI command, no producer changes, no new
config, no change to nightly resume behavior.

## Decisions

### D1. `resumeRepo` in pipeline.ts, sharing the pinned-run body with `updateRepo`
A new exported `resumeRepo(cfg, db, repo): Promise<PipelineResult>` takes the
per-repo lock (returning the same contention result shape as
update/reinit), then runs the pinned-target path. The body both entry points
share — pin-or-head sha, published-mode derivation, change-set diff, the
`runPipeline` call — moves to one private helper in the same file; `updateRepo`
keeps its pull + skip + `headMoved` extras, `resumeRepo` has neither. Not a
`pull?: boolean` flag on `updateRepo`: resume's defining precondition (a
preserved build must exist) would then live in every caller, and the flag
would silently allow the expensive-mistake path below.

### D2. The nothing-to-resume gate is checked twice, cheaply, before any run
`planResume` treats an absent WIP as `"none"` and falls through to an ordinary
full run — a "resume" click on a healthy repo would silently start a whole
fresh production. So both `resumeRepo` and the admin endpoint (which must
answer synchronously, like its lock probe) read `readWipMeta` and refuse with
a clear "nothing to resume" result/409 before queuing. A file read, no new
state; the run path's own rules stay untouched.

### D3. Outcome recording via the existing `recordRun` only
`resumeRepo` is run by the admin runner exactly like `runUpdate`/`runReinit`
(`markRunStarted` → run → `recordRun` → `saveState`). No second outcome
writer; `rate_limited` keeps its resetAt and yellow health.

### D4. Dashboard: Resume button conditional on `build != null`
Rendered next to Update/Reinit only for rows whose status entry reports a
build; the handler mirrors update/reinit (async POST, notice with the
response). No confirmation prompt: resume is non-destructive — the published
wiki stays live and a failure restores it.

## Risks / Trade-offs

- The endpoint's WIP probe can race a concurrently-finishing run (WIP
  disappears between probe and queue): `resumeRepo` re-checks and no-ops with
  a clear error; worst case the operator re-checks status.
- An operator can resume a build whose attempts are exhausted: `planResume`
  refuses with its "needs attention" error and clears the WIP — the existing
  surfacing, unchanged.

## Open Questions

None — semantics confirmed with the operator (resume keeps the published wiki;
admin API + web only).
