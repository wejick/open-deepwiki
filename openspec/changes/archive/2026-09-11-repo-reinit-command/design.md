## Context

A repo whose wiki build cannot move forward has no mid-weight recovery. The
per-repo wiki state lives in four places — the published bundle at
`<clone>/openwiki/`, the verified snapshot at `<dataDir>/repos/snapshots/<id>`
(+ `.prerun`), and the work-in-progress area at `<dataDir>/repos/wip/<id>` — and
the states that wedge (exhausted resume attempts, a map that is rejected every
run, a first build that never published) all sit in those places. `updateRepo`
can restart some of them (a bundle-less repo reruns init), but an exhausted WIP
aborts every subsequent run inside `planResume` before any producer is touched,
and a bundle-less repo only rebuilds as an init once mode is derived from
published state. The only escape today is `repo remove` + `repo add`, which also
deletes the clone and registration — the expensive parts. The gap is a command
that resets exactly the wiki build state and reruns the init build in place.

`runPipeline` already has init semantics that do everything a rebuild needs:
whole-repository planning, initial-coverage acceptance, and — because init passes
no `changedSourcePaths` — a full `indexRepo` pass whose `ingestBundle` purges
removed concepts and whose source crawl reconciles deleted paths. So reinit needs
no new producer or indexing code, only a reset of the four state locations plus
the existing init pipeline run.

## Goals / Non-Goals

**Goals:**

- One operator command that discards wiki build state and reruns the init build
  from the existing clone, without re-cloning or re-registering.
- The same operation reachable from the admin API and the dashboard, so an
  operator does not need shell access to rescue a wedged repo.
- A failed reinit leaves the repo honestly in the initial-build state, so the
  rebuild is retried rather than silently abandoned for an incremental update.
- Reinit respects the per-repo lock and the existing run-recording discipline.

**Non-Goals:**

- No change to what init means for producers, acceptance, or indexing.
- No index purge or registry reset: the retained source index stays queryable,
  and the retained `lastIndexedSha` moves only through the ordinary recorder on
  success.

## Decisions

### D1 — Reinit is a hard reset of the wiki build state

`reinitRepo` removes the published bundle (`<clone>/openwiki/`), the snapshot and
pre-run snapshot dirs, and the WIP area, then runs the init pipeline. The clone,
registration, and index rows are untouched. Because the snapshot is removed with
the bundle, a failed reinit restores nothing: `runIsolatedProducer`'s restore
path finds no snapshot, removes the unaccepted output, and the checkout is left
without a published wiki — exactly the state a first build is in, so any later
run (scheduled batch, `repo update`) rebuilds it as an init.

*Alternatives considered:* keep the snapshot so a failed reinit rolls back to the
previous published bundle — rejected: the restore would re-create published
presence, and once mode is derived from published-bundle presence the operator's
explicit "rebuild from scratch" would silently become an incremental update of
the very wiki they discarded, on the next scheduled run. Purge the repo's index
rows too — rejected: source rows still point at files in the retained clone and
remain valid; wiki rows that reference a discarded bundle are reconciled by the
next successful init's re-ingest, and a dangling bundle read degrades to a miss,
never a crash. `lastIndexedSha` is left alone for the same reason, and because
`recordRun` is the only permitted writer of it.

### D2 — Reinit calls the init pipeline directly, with a pull

`reinitRepo` fetches+pulls the existing clone (when one exists) and then calls
`runPipeline(cfg, db, repo, "init")`, mirroring `repo add`'s run rather than
`updateRepo`'s. Passing `"init"` explicitly means the command does not depend on
run-mode derivation from published state — it rebuilds whole-repo even before
that behavior exists — and it also skips `updateRepo`'s no-op check, which is not
what an operator forcing a rebuild wants. The pull runs before the destructive
clears: a fetch that fails aborts the command with the old wiki still published,
so reinit is never the thing that takes a working wiki down.

*Alternatives considered:* implement reinit as "clear wiki state, then
`updateRepo`" — rejected: until run mode is derived from published presence,
`updateRepo` would run update semantics on the bundle-less repo, and depending on
an unrelated change for correctness is fragile. Skip the pull — rejected: a
reinit that rebuilt an outdated head would immediately re-derive work on the next
update; pulling matches `updateRepo`'s behavior and keeps the fresh build at the
current head.

### D3 — One lock, one recorder, existing conventions

`reinitRepo` acquires the per-repo lock itself (busy → a skipped result, exactly
`updateRepo`'s shape), so the CLI command has nothing to orchestrate beyond
marking the run started, calling it, and recording through `recordRun` +
`saveState` — the same sequence `repo update` already uses. No new config knob
and no new dependency; there is no requirement that consumes either.

### D4 — Admin and dashboard mirror the update route, not a new surface

The admin API exposes `POST /api/repos/:id/reinit` with the exact shape of the
existing `POST /api/repos/:id/update`: 404 for an unknown repo, a lock probe
returning 409 while a run is in flight, otherwise a background run tracked in
`adminRuns` and a 202 — so progress stays observable through `/status` and the
run records through the ordinary recorder. The dashboard adds a per-row Reinit
button beside Update, guarded by a confirm dialog like Remove's, because the
action discards the repo's current wiki. The CLI, the admin route, and the
button all call the same `reinitRepo`; there is no second implementation.

*Alternatives considered:* a synchronous reinit endpoint — rejected, it would
hang an HTTP request on a build that can run for minutes to hours and diverge
from every other run endpoint. Reusing `requestUpdate` with a flag — rejected,
the two run different pipelines (reinit forces init and skips the no-op check);
a separate route keeps each endpoint's contract explicit. A dashboard button
without a confirm — rejected, mirroring Remove, because the click discards
publishable content.

## Risks / Trade-offs

- **A failed reinit on a repo that had a working wiki leaves it without one.**
  Intended: the operator asked to discard it. The repo is red until a rebuild
  succeeds, which is the honest signal the wedged repo was already producing;
  dispatch keeps retrying it as a first build.
- **Index rows dangle during a failed/long rebuild.** Wiki chunks reference
  bundle paths that no longer exist until the init run re-ingests. Reads miss
  rather than error, and the retained source chunks keep the repo searchable.
- **`git pull` can fail on a wedged/offline remote.** The pull runs *before*
  anything is cleared, so a failed fetch aborts the reinit with the published
  wiki and snapshot intact — the same exposure `updateRepo` already has, minus
  the destruction. The operator retries once the remote answers, or resolves the
  remote first.
- **Reinit on a busy repo is refused**, not queued — matching `repo remove` and
  `repo update`; an operator can retry once the in-flight run finishes.

## Migration Plan

No stored-state migration. Reinit is additive; rollback is a revert of the
change. The command touches only the four wiki-state locations and the registry's
machine-owned run state through the ordinary recorder.
