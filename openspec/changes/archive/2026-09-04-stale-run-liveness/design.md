## Context

See proposal.md for the failure being fixed. Three facts shape the design:

- The lock file (`<dataDir>/locks/<repoId>.lock`) already records
  `{pid, startedAt}` as JSON — the liveness signal exists, nothing reads it.
- `buildStatusSummary` (`src/monitor/status.ts`) is the single read surface behind
  `/status`, `server_status`, and CLI `status --json`; a field added there reaches all
  three consumers with no per-consumer work.
- The run lifecycle has two legitimate windows where a run holds no lock: between the
  start record and `acquireRepoLock` (admin.ts `runUpdate` sets `startedAt` and saves
  state before the pipeline acquires the lock), and between the lock's release in
  `updateRepo`'s `finally` and the outcome save. Any classification that treats
  "no lock" as death flashes `interrupted` on every healthy run passing through those
  windows.

## Goals / Non-Goals

**Goals:**

- A crashed lock holder recovers on the next attempt, not after 12h, not never.
- `running` vs `interrupted` is computed at read time, stored nowhere, and changes no
  health color.

**Non-Goals:**

- Clearing or rewriting the recorded run on boot or at read time — `recordRun` stays the
  only writer; the display self-heals when the next run records an outcome.
- A CLI table annotation for `interrupted` — the shared summary carries the field, so
  `status --json` exposes it; a table column would need its own monitoring-spec delta and
  has no scenario asking for it.
- Any new config knob.

## Decisions

**Liveness via `process.kill(pid, 0)`.** ESRCH means the pid is dead; success or EPERM
means alive (EPERM = exists under another uid). A tiny `isPidAlive(pid: number): boolean`
in `lock.ts` — the one place both the takeover and the status read need it.
Alternatives considered: reading `/proc/<pid>` (not portable to the macOS hosts this runs
on); mtime-only heuristics (already the fallback, and the broken one being fixed).

**Takeover = remove, then re-attempt the exclusive create.** The stale path keeps the
`wx` write but first removes the file. The takeover race stays correct: two concurrent
takeovers both remove (force), exactly one wins the `wx`, the loser reads busy.
Alternatives considered: truncating/overwriting in place (loses the exclusivity that
makes a lost race detectable).

**Unreadable lock body falls back to the 12h age rule; a live pid blocks regardless of
age until the window passes.** A recycled pid after a reboot is indistinguishable from a
wedged holder, so alive-but-ancient is eventually taken over by age, never by liveness.
Alternatives considered: trusting liveness absolutely and dropping the age rule (a
recycled pid would then block the repo forever — strictly worse than today).

**Classification lives in `buildStatusSummary`, driven by a lock read.** New
`RepoStatus.runState: "running" | "interrupted" | null` — null when there is no
started-without-finish run; `interrupted` only when a lock exists, parses, and its pid is
dead; `running` otherwise (live lock, no lock, or unparseable lock — the windows above
force this conservatism). The lock reader (`readLockHolder`) is exported from `lock.ts`
next to the writer, so the format has one owner. `server_status` and CLI `--json`
inherit the field through the shared summary; the dashboard renders it.
Alternatives considered: classifying in the dashboard from a new locks endpoint (an
endpoint with one consumer, and the wrong layer — the summary already merges live
process state such as scheduler locks).

**Dashboard renders the classification, falling back to the old derivation.** The row
helper prefers `runState` when present and otherwise derives from
`runStartedAt`/`runFinishedAt` exactly as today, so an older payload renders unchanged.
`interrupted` shows as `interrupted since <time>` — same layout, distinct wording, no
spinner-like implication of progress.

## Risks / Trade-offs

- [A recycled pid makes a dead holder look alive] → the 12h age takeover still applies;
  worst case equals today's intended behavior, never worse.
- [Lock removed by a takeover races a still-alive holder misjudged as dead] → not
  possible on one host: a pid is dead only when its process is gone; the lock holder is
  the process that runs the pipeline, not a forked child.
- [Status reads one more file per started-not-finished repo] → bounded by in-flight runs
  (typically 0–2), and only for that subset.

## Migration Plan

None. The lock body format is unchanged, the classification is read-time, and rollout is
a restart. Rollback is reverting the commit — orphaned locks revert to the (broken) age
rule, i.e. today's status quo.
