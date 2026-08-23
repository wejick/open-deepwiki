# Proposal: stale-run-liveness

## Why

A run that never finishes lies. If the serve process (or a CLI run) dies mid-update, three
things go wrong and none self-heal:

1. The dashboard shows "running…" forever — the display is derived from
   `runStartedAt != null && runFinishedAt == null` in `state.json`, and no process is left
   to write the finish.
2. The per-repo lock file is orphaned, blocking every later update for that repo.
3. The documented 12h stale-lock takeover (`STALE_MS` in `src/repoManager/lock.ts`) is
   broken: the stale path falls through to `writeFile` with flag `wx`, which always fails
   with `EEXIST` on the file it just stat'd, so `acquireRepoLock` returns null
   indefinitely. Only manual lock deletion recovers.

The lock already records the holder's `{pid, startedAt}`; liveness of that pid is a
definitive death signal that neither the takeover nor the status read currently uses.

## What Changes

- `acquireRepoLock` SHALL take a lock over immediately when the recorded holder pid is
  dead (and SHALL genuinely take it over — fix the `wx`-on-existing-file bug by removing
  the stale file first). A live pid keeps blocking; an unreadable lock body falls back to
  the 12h mtime rule, which stays as the guard against pid reuse after a reboot.
- `/status` (and `server_status`, same summary) SHALL classify a run with a start and no
  finish at read time: `running` when the repo's lock is held by a live pid,
  `interrupted` only on positive evidence of death (a lock whose holder pid is dead),
  and today's behavior otherwise. No new state is stored.
- The dashboard SHALL render `interrupted` distinctly from `running…`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `repo-manager`: Update concurrency safety — dead-holder lock takeover; the 12h window
  becomes the fallback instead of the only (and broken) recovery.
- `monitoring`: Health and status endpoints — per-repo run-state classification
  (`running` / `interrupted`) computed at read time from lock liveness; health colors are
  unchanged.
- `dashboard`: Repo status table — interrupted runs render as interrupted, not running.

## Impact

- `src/repoManager/lock.ts` (pid liveness, takeover fix), `src/monitor/status.ts` (run
  state), `src/server/dashboard.js` + `dashboard.d.ts` (rendering), plus tests in each
  scope. CLI `status` shows the same field through the shared summary.
- No new dependencies, no new config knobs, no health-color changes.

## Non-goals

- Clearing or rewriting `lastRun` on startup or at read time — the field is only written
  by `recordRun`; a subsequent run overwrites it. Classification is display-only.
- A fleet-level watchdog or auto-restart of interrupted runs.
- Cross-host liveness (pid namespaces, remote status checks) — single-machine tool.
