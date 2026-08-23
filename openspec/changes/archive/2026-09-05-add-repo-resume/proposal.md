## Why

A build interrupted by a rate limit (or reported partial) preserves its
work-in-progress area, and the nightly batch resumes it — but the operator has
no way to trigger that resume now, from the web. Today's dashboard actions
don't fit: Update pulls (moving the head off the pinned target) and skips when
the head hasn't moved; Reinit pulls and discards the accumulated work.

## What Changes

- New pipeline entry `resumeRepo`: continues a repo's preserved build at the
  WIP's pinned target sha — never `git pull`, never the head-moved skip. The
  published bundle stays queryable throughout; a failed resume restores the
  last good bundle exactly like any other run.
- New admin endpoint `POST /api/repos/:id/resume` (202 queued, 404 unknown
  repo, 409 while the repo's lock is held or when no preserved build exists).
- Dashboard rows whose status reports a build in progress (`build != null`)
  render a Resume action submitting to the new endpoint; errors surface like
  the other actions.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `repo-manager`: new requirement — resume a preserved build at its pinned
  commit without pulling.
- `admin-api`: new requirement — `POST /api/repos/:id/resume` endpoint.
- `dashboard`: new requirement — per-row Resume action for repos with a build
  in progress.

## Impact

- `src/repoManager/pipeline.ts` — `resumeRepo` (shares the pinned-target run
  body with `updateRepo`; no new seam).
- `src/server/admin.ts` — one route + one runner, mirroring update/reinit.
- `src/server/dashboard.js` — one button + notice, mirroring update/reinit.
- No CLI change, no producer change, no schema/state change: the run reuses
  `updateRepo`'s existing WIP pinning, `planResume`, and `recordRun` paths.

## Non-goals

- No CLI `repo resume` command (admin API + web only, per operator decision).
- No change to how the nightly batch resumes builds — it already skips the
  pull when a WIP is pinned.
- No new config knobs, no changes to `planResume`'s discard/exhaust rules, no
  producer code touched.
