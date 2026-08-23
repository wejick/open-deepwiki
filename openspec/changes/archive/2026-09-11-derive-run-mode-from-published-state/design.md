## Context

See proposal.md — Why. Two facts compose the gap: `updateRepo` passes `"update"`
unconditionally (`src/repoManager/pipeline.ts:380`), and its no-op skip check
(`pipeline.ts:362`) compares only `lastIndexedSha` to the head. Every downstream
behavior that went wrong in the incident — no map session, the "a bundle exists"
planner framing, vacuous scoped-update checks, no init-coverage gate — keys off the
mode argument and is correct when the mode is.

## Goals / Non-Goals

**Goals:**
- One presence check in `updateRepo` choosing `init` vs `update`.
- The skip check respects the same presence check.

**Non-Goals:**
- No producer-side changes: the split gate stays keyed to init mode — which now fires
  on first-build recoveries, so the map reruns there.
- No map persistence, digest keying, or decomposed updates (discussed and dropped —
  see proposal Non-goals).
- No scheduler-ordering changes.

## Decisions

**D1 — Derive at the `updateRepo` call site, keyed to bundle-directory presence.**
`pipeline.ts:380` becomes `mode = (await exists(<clone>/openwiki/)) ? "update" :
"init"`, and `changedSourcePaths` is omitted in the init case (whole-repo planning).
`runPipeline`'s existing mode-keyed behavior — clone-vs-pull, PRE capture, producer
framing, acceptance selection — then needs no edits.
*Alternatives considered:* deriving inside `runPipeline` — rejected: `addRepo` already
passes `"init"` correctly for a fresh clone, so only this one call site needs the
branch; keying to a parsed anchor instead of directory presence — rejected: same
signal for more code, and a published bundle always carries the anchor (failure
paths remove never-published bundles), so presence is not weaker in practice.

**D2 — The skip check requires a published bundle.** `pipeline.ts:362`'s
`lastIndexedSha === newSha` skip becomes "skip only when the bundle also exists".
Index truth already defers to wiki truth elsewhere (`pipeline.ts:100-101`, the anchor
precedence), and a repo whose wiki was removed must be rebuilt, not skipped.
*Alternatives considered:* leaving the skip check alone — rejected: it would keep a
bundle-less repo wiki-less forever, the same mode bug viewed from the scheduler.

## Risks / Trade-offs

- [A repo whose bundle was deleted deliberately gets a full rebuild] → intended; the
  way to keep a repo wiki-less is `--no-wiki`, which bypasses the rebuild: the skip
  check exempts a repo configured without a wiki, whose bundle is absent by
  configuration rather than by loss.
- [First rebuild of a big repo through the nightly batch is heavy] → the repo has no
  wiki; the alternative is staying unqueryable. Batch ordering already dispatches
  updates ahead of full builds, so the fleet is not stalled.
- [Scheduler staleness classification may call a bundle-less repo an "update"] →
  harmless: it only affects dispatch order, and the run itself is correct.

## Migration Plan

Code-only; no stored-state migration. Rollback is revert.

## Open Questions

(none)
