## Why

A wedged wiki build is a dead end. When a `claude` map is rejected, a first build
fails with nothing ever published, or resume attempts exhaust and the repo is
surfaced for a human, the only forward path is `repo remove` + `repo add` — full
re-registration and a re-clone of (often) a very large repo, to force what is
really just "run the init build again". There is no lighter command that discards
the wiki state and rebuilds from the clone that already exists.

## What Changes

- A `repo reinit <repoId>` command. Under the per-repo lock it discards the
  published bundle, the last-good and pre-run snapshots, and any work-in-progress
  state, pulls the existing clone, then runs the repo through the init pipeline —
  whole-repository planning, initial-coverage acceptance, full re-index.
  Registration, the clone, and the index rows are retained: no re-clone, no
  re-register, no purge.
- A failed re-init restores nothing. The snapshot is discarded along with the
  bundle, so a failed rebuild leaves the checkout without a published wiki and
  later runs rebuild it as an init — the operator's request is not silently
  converted back into incremental updates of the wiki they just discarded.
- The admin API gains `POST /api/repos/:id/reinit` — the same asynchronous,
  lock-probing shape as the existing update endpoint — and the dashboard gains a
  confirm-guarded per-row Reinit button beside Update and Remove.
- CLI help and the bare-`repo` hint name `reinit` beside the other subcommands.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `repo-manager`: one new requirement — *Repository re-initialization* — and the
  *Bare repo command defaults to listing* requirement's subcommand enumeration
  gains `reinit`.
- `admin-api`: one new requirement — *Re-initialize repository endpoint*.
- `dashboard`: the *Repo management actions* requirement gains the per-row
  Reinit action.

## Non-goals

- No index purge and no `lastIndexedSha` reset: source rows stay valid (the clone
  is kept), and the init run's own re-ingest reconciles wiki rows.
- No change to producer logic, map planning, acceptance, or the scheduler.
- No automatic retry policy: reinit is an on-demand command, not a policy change.

## Impact

- Code: `src/repoManager/pipeline.ts` (`reinitRepo`), `src/cli/main.ts`
  (subcommand + usage strings).
- Tests: `producerPipeline.test.ts`, `cli.test.ts`.
- Spec: `openspec/specs/repo-manager/spec.md`.
