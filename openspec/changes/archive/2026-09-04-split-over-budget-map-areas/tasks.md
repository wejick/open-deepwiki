# Tasks: split over-budget map areas

## 1. Deterministic split engine (`src/producer/claudePlan.ts` + `claudePlan.test.ts`)

- [x] 1.1 Extract the shared ownership count `areaOwned(paths, trackedFiles)` used by `validateMap`'s budget check and by the new splitter, so the split fires exactly when validation would have rejected, and verify the existing budget, root-exemption and off-count tests in `claudePlan.test.ts` still pass (`bun test src/producer/claudePlan.test.ts`)
- [x] 1.2 Implement `splitOverBudgetAreas(map, trackedFiles): RepairedMap`: a no-op (identity map, empty repairs) when no area owns more than `areaFileBudget(trackedFiles.length)` files; otherwise each over-budget area is replaced by parts named `{id}-part-{k}` (k from 1) that inherit its `title` and `scope`, drop descendant-of-another claimed paths, decompose each over-budget directory into its child directories (children ordered by descending owned count, ties by name), and pack the at-most-budget units greedily into consecutive at-most-budget parts; verify a unit test that a single over-budget directory area splits into `-part-1`/`-part-2` with owned counts at or under budget, the union of part-owned files equals the original area's owned files, and parts keep title/scope
- [x] 1.3 Verify determinism and the no-op: an under-budget map is returned unchanged with empty repairs, and splitting the same map twice yields deep-equal results (unit test)
- [x] 1.4 Verify the many-small-dirs case: an area owning several directories each at or under budget but over it in total is split into parts that group whole directories, each part at or under budget (unit test)
- [x] 1.5 Verify file-level descent: a single directory holding more documentable files than the budget directly (no subdirectory boundary) is split by grouping its files into at-most-budget parts, each part listing file scope paths (unit test)
- [x] 1.6 Verify the repository-root exemption: an area whose paths are only `.` is never split even when its file count exceeds the budget, and an area mixing `.` with over-budget directories splits the directories while `.` rides unchanged on part 1 (unit test)
- [x] 1.7 Verify the split repair note and end-to-end validity: `splitOverBudgetAreas` reports `split <id> into N parts` per split area, and a split map then passes `validateMap` including the area-count rule (unit test in the style of the existing root `.` case)

## 2. Orchestration wiring (`src/producer/claude.ts`, `claude.test.ts`, `src/repoManager/producerPipeline.test.ts`)

- [x] 2.1 Run the split at both map-validation sites in `claude.ts` (restored unvalidated map and fresh map session): `repairMap` → `splitOverBudgetAreas` → `validateMap`, joining path-form and split repairs under the existing `map repaired:` note; verify the existing "A repairable map is normalized instead of failing the run" test still passes unchanged and the existing orchestration suite is green
- [x] 2.2 Extend the `claudeSplit` shim with an option to plan any `AREA_ID` (a default part for ids the shim did not enumerate, so split `-part-<k>` areas get planned) and add a `claude.test.ts` orchestration test: a map session writes one area owning every file of the 4-file split fixture (over the 1-file budget) → the run succeeds, the session log shows one `area:a0-part-<k>` session per part followed by the pages, and stderr carries a `map repaired: split` note; verify with `bun test src/producer/claude.test.ts`
- [x] 2.3 Rework the `producerPipeline.test.ts` "A failed first build recovered by the batch is an init" scenario so the failing first map is *off-count* (an under-budget map too small to fit the accepted area range) rather than over-budget — the only rejection the new behavior leaves intact — and verify it still asserts `the map was rejected` and that the recovery run then succeeds as an init (`bun test src/repoManager/producerPipeline.test.ts`)

## 3. Authoring guidance (`MAP.md` + guidance tests)

- [x] 3.1 Update the `MAP.md` budget-verification bullet so an over-budget area is described as being split into `-part-<k>` siblings by the run (not "discards the whole map"), with the mapper still told to pre-split so the parts stay boundaries it designed; update the `claude.test.ts` "requires a pre-write budget check" guidance assertions to the new wording and verify they pass

## 4. Integration and spec validation

- [x] 4.1 Verify the whole producer surface: `bun test ./src/producer ./src/repoManager` green, `bun run lint`, `bun run format` (no diffs), and `bun run typecheck` clean
- [x] 4.2 Sync the delta spec into the main specs and verify consistency: `openspec validate --specs` passes and the main `openspec/specs/okf-producer/spec.md` reflects the two modified requirements
