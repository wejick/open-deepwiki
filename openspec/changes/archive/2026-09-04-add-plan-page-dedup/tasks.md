# Tasks: add-plan-page-dedup

## 1. Merge-time title fold

- [x] 1.1 Implement the fold in `mergeParts` (claudePlan.ts): two triggers — normalized titles (trim, casefold, collapse internal whitespace) and normalized filename stems naming a cross-cutting subject (the ownership-guidance list); keep the first entry in map order, union folded entries' `sourcePaths` and `relatedPages` (first-seen order, deduped); unit tests in `claudePlan.test.ts` named for the spec scenarios — "A title collision folds at merge", "A shared cross-cutting stem folds at merge" (three areas each planning `state-management.md` → one entry carrying all source paths), "A generic stem outside the subjects never folds" (two `overview.md` pages both survive), "The merged plan carries no collisions" (deterministic across two invocations; distinct titles and paths pass through untouched)

## 2. Area-session facts and ownership guidance

- [x] 2.1 Extend `areaDirectives` (claude.ts) to name the page titles already planned by the completed parts, plus the ownership line: plan only pages specific to the area's own paths, no page mirroring a cross-cutting subject for its slice; extend the `claude.test.ts` directive assertions named for "An area session sees the titles already planned" and "Area-session guidance forbids boilerplate mirrors" (directive lists prior parts' titles; contains the ownership line) — verify `bun test` passes
- [x] 2.2 Amend `MAP.md`'s overlap bullet so overlap governs exploration scopes, not page subjects; a cross-cutting subject (state management, constants/configuration, utilities/helpers, navigation/routing, analytics/logging, error handling) is planned as at most one page owned by the area hosting that code, and the mapper records that ownership in the owning area's `scope`; update the existing MAP.md content assertions and add ones named for "Guidance assigns cross-cutting subjects to one area" and the reworded "Guidance permits overlapping areas" — verify `bun test` passes

## 3. Measurement

- [x] 3.1 Report plan-quality metrics in the eval command — planned page count, titles folded at merge, boilerplate-stem hits — reported only, never gating; verify by running eval against a fixture bundle with a known plan and asserting the reported numbers

## 4. Whole-suite validation

- [x] 4.1 Run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, and `openspec validate --specs` after archiving prep — all green; confirm no fixture bundle or acceptance test changed behavior (the fold only affects split merges, and the valid fixture has no title collision)
