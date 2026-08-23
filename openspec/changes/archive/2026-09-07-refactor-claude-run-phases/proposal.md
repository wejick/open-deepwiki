## Why

`runClaude` (src/producer/claude.ts) is a ~600-line function whose lifecycle — STAGE / REPAIR / PLAN / APPLY / PAGES / FINISH — exists only as block comments. Each phase closes over ~15 shared locals (`notes`, `units`, `planned`, `last`, `firstFailure`, `outOfTime`, `tracked`, `tree`, `viaSplit`, `deadline`, `session`, …), so no phase can be read, reviewed, or changed in isolation. The split-planning subtree (map / gate / areas / merge) is ~250 of those lines inline. Every recent requirement (split planning, exclusion gate, page budget) added another inline section; the structure has become the main obstacle to changing the producer safely.

## What Changes

Internal restructuring of the `claude` producer only. **No externally observable behavior changes**: run outcomes, checkpoint file formats, event beats, notes ordering, and `ProducerRun` fields are identical; the existing suite passes unmodified (except import-path updates).

- Coverage audit (done while scoping, verified against the suite): every behavior the move could break is already pinned — exact event-beat sequences, run-level timeout incl. the FINISH deadline re-read ("even when the budget kills the last session"), first-failure precedence ("the failing session is reported, not whichever session happened to be last"), notes-last-in-`stderr`, `promptDir` leak, artifact hygiene on success, `unitsCompleted` semantics, repair retry at the `runIsolatedProducer` level. **No new tests are required**; the only unpinned surface is one diagnostic note's text, whose outcome is covered (see design.md).
- STAGE + env + flag detection become `openRun`, constructing an explicit run-context value (the shared closure made visible).
- The split-planning subtree (map / gate / areas / merge) moves to a new producer-prefixed module `claudeSplit.ts`, receiving the session runner as a plain parameter (also keeps the module graph acyclic).
- REPAIR / PLAN / APPLY / PAGES / FINISH become module-level phase functions (`repairBundle`, `ensurePlan`, `applyPlan`, `producePages`, `completeRun`) in `claude.ts`; `runClaude` stays the producer's entry point and becomes a short linear script over them.
- One behavior-equivalent simplification, as a separate flagged commit: `clearPlanningArtifacts` after the plan stamp becomes unconditional, dropping the `viaSplit` flag (a no-op when no artifacts exist).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None — no requirement in `openspec/specs/okf-producer` (or any other spec) changes. This change restructures implementation; every existing scenario must keep passing.

## Impact

- `src/producer/claude.ts`: restructured; `runClaude`'s signature and exports kept.
- `src/producer/claudeSplit.ts`: new module (follows the producer-prefix naming convention).
- `src/producer/claude.test.ts`: unchanged — all imported helpers (`runClaude`, directive builders, session vocabulary) stay exported from `claude.ts`.
- Untouched: `run.ts`, `wip.ts`, `anchor.ts`, `claudePlan.ts` mechanics, `CONTRACT.md`, skill files, all specs, all config knobs, all other test files.

## Non-goals

- No state-machine library, workflow engine, or lifecycle abstraction — banned by the repo's guardrails and not needed.
- No changes to checkpoint formats, WIP semantics, or the plan/map/part schemas.
- No behavior changes of any kind beyond the flagged `viaSplit` no-op simplification.
- No cuts to split planning, the exclusion gate, or the deterministic repairs (a separate, spec-first decision).
