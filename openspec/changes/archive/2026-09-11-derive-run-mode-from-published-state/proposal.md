## Why

A beyond-threshold repo (~16k tracked files, 8x the split threshold) had its first
build routed through the update path after a failed `repo add`: the log shows
`"planning", note: "update"`, no map session was considered, the planner was told a
bundle existed when none did, and init-coverage acceptance never ran. Run mode is a
property of the entry-point command (`repo add` vs `update`), not of the repo's
published state — so the repo that most needed init semantics was the one that didn't
get them.

## What Changes

- The update flow derives a run's mode from published-bundle presence instead of the
  command that triggered it: a checkout with no published bundle at `<clone>/openwiki/`
  runs as an init — whole-repository planning (the existing split threshold applies,
  so first-build recoveries rerun the map), init-coverage acceptance, and no false
  "a bundle exists" planner framing.
- The update flow's no-op skip check respects wiki truth: a repo whose bundle is gone
  is rebuilt as an init even when the head equals the recorded last indexed sha.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `repo-manager`: new requirement — the update flow derives the run mode from
  published-bundle state, whatever entry point reached it (scheduled batch, standalone
  update command).

## Impact

- `src/repoManager/pipeline.ts` — `updateRepo`: one presence check choosing the mode,
  and the skip check gaining the same condition.
- No producer-side changes: every downstream behavior (split planning, prompts,
  acceptance) already keys off mode and becomes correct when mode is right.

## Non-goals

- No mode-independent split gate: genuine updates (bundle exists) keep single-session,
  change-set-scoped planning.
- No map persistence or digest keying; planning artifacts remain spent at publish.
- No `openwiki` producer, acceptance-floor, or scheduling changes.
