# Tasks: extract runClaude's lifecycle phases

Behavior-preserving refactor per `design.md`. The acceptance check for every
extraction task is identical and is the point of the change: the existing suite
passes **unmodified** (`bun test ./src ./test`, `bun run lint`,
`bun run typecheck`). One task per commit so any regression bisects to one diff.
No logic edits ride along in an extraction commit.

## 1. Baseline

- [x] 1.1 Record a green baseline: `bun test ./src ./test`, `bun run lint`, `bun run typecheck` all pass on a clean tree. Acceptance: all three green; no code changes in this commit.

## 2. Run context extraction

- [x] 2.1 Create `src/producer/claudeRun.ts` with the `Run` context type, the `isProducerRun` guard, `openRun` (STAGE prompt staging, env, `supportsSettingSources`, `stepMs`/`session`/`progress`/`finish` helpers), and `runClaude` moved wholesale from `claude.ts` with its phases still inline — the ~15 closure locals rewired to `run.*` as a pure rename. `claude.ts` keeps the session substrate and prompt builders; `run.ts` and `claude.test.ts` update their `runClaude` import line. Acceptance: suite + lint + typecheck green; diff contains no logic changes.

## 3. Phase extractions

- [x] 3.1 Extract REPAIR as `repairBundle(run, errors)` in `claudeRun.ts`. Acceptance: suite green — the repair-retry tests in `acceptance.test.ts` exercise this path through `runIsolatedProducer`.
- [x] 3.2 Extract the split-planning subtree (map / gate / areas / merge) as `planSplit` in a new `src/producer/claudeSplit.ts`, taking `run` (its `session` helper included); the ~15 `claudePlan.ts` imports it owns move with it; prompt builders stay in and are imported from `claude.ts`. Acceptance: suite green — the split tests in `claude.test.ts` and `claudePlan.test.ts` cover this subtree.
- [x] 3.3 Extract the rest of PLAN as `ensurePlan(run, input)` — `loadPlan` classification, the undecomposed planner path, and the `planSplit` delegation — returning `ProducerRun | { loaded; planned; viaSplit }`. Acceptance: suite green.
- [x] 3.4 Extract APPLY as `applyPlan(run, ensured)` — normalize, delete named pages, stamp, conditional artifact clear. Acceptance: suite green.
- [x] 3.5 Extract PAGES and FINISH as `producePages(run, plan, input)` and `completeRun(run, last)`; `runClaude` is now the linear script from design.md D3 (~40 lines). Acceptance: suite green, and `runClaude`'s body matches the design sketch on review.

## 4. Flagged simplification (separate commit)

- [x] 4.1 Make `clearPlanningArtifacts` unconditional after the plan stamp and drop `viaSplit` from `Run` and `ensurePlan`'s return (design.md D5: a no-op when no split artifacts exist; resumed runs skip APPLY either way). Acceptance: suite green. Independently revertible; drop this task if review rejects it.

## 5. Comments and final gates

- [x] 5.1 Rewrite the module headers of `claude.ts`, `claudeRun.ts`, and `claudeSplit.ts` so each names its topic (one session / the run lifecycle / split planning), and tighten comments that narrated the old single-function structure. Keep the 13–19% `src/` comment-line baseline. Acceptance: headers describe reasons, not mechanism; `bun run lint` green.
- [x] 5.2 Final gates: `bun test ./src ./test`, `bun run lint`, `bun run format` (check), `bun run typecheck`, `openspec validate --specs`. Acceptance: all green; specs untouched.
