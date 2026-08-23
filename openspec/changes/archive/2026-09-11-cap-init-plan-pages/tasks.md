## 1. Budget constant + formula

- [x] 1.1 Add the page-budget helper (formula `max(12, ceil(N/100))`, N =
      documentable files) next to the area-sizing code in `claudePlan.ts`,
      with unit tests pinning the clamps: 12 below 1200 files, ceil for the
      general case (14,000 → 140). Verify: `bun test src/producer/claudePlan.test.ts`.

## 2. Deterministic budget repair at merge

- [x] 2.1 Implement `mergeOverBudgetPages` in `claudePlan.ts`: group plan
      entries by (`type`, common parent of source paths), merge groups
      greedily (size desc, then map order), survivor = earliest in map order,
      title from the common parent directory, source paths + related pages
      unioned; repeat until within budget or no eligible group remains.
      Verify: unit tests — within-budget plan untouched (byte-identical);
      over-budget plan merges deterministically; different `type` / different
      area / cross-cutting stems never merge; repaired plan is within budget
      or the pass reports irreducible.
- [x] 2.2 Wire the pass into the plan-merge path before plan validation, and
      into the single-session plan path before validation; on irreducible,
      fail the run with a note naming budget, post-repair count, and
      unmergeable areas. Verify: tests — over-budget merged plan passes
      validation after repair; irreducible plan produces the failure note and
      the ordinary plan-failure outcome; planning-dot artifacts untouched.

## 3. Guidance

- [x] 3.1 Add the ratio target and the one-page-per-screen/dialog/leaf
      anti-pattern to the init planning guidance (`PLANNER.md`, area
      directives in `claude.ts`); phrased as subject-merging, no arithmetic.
      Update-planner and page guidance unchanged. Verify: tests asserting the
      guidance text appears in init planner/area prompts and not in
      update-planner/page prompts (mirror the existing guidance tests).
- [x] 3.2 Fixtures: extend a golden part fixture to name enough pages to
      breach the budget so the merge path exercises end-to-end at merge time.
      Verify: `bun test ./src/producer`. (Done as in-test part fixtures in
      `claudePlan.test.ts` and shim-driven 14-page parts in
      `claude.test.ts` — the same coverage without mutating the golden
      bundle, which most of the suite shares.)

## 4. Eval reporting

- [x] 4.1 Report pages-per-documentable-file in `bun run eval` output
      (bundle's page count / documentable files; plan file when present).
      Verify: eval unit test against the valid fixture bundle reports the
      expected ratio; `--a/--b` comparison prints it for both sides.

## 5. Spec validation + full suite

- [x] 5.1 `openspec validate --specs` clean; every new Scenario has a test
      named `"<Requirement> › <Scenario>"`. Verify: grep test names against
      the delta's scenario list.
- [x] 5.2 Full suite green, offline: `bun test ./src ./test`, then
      `bun run lint`, `bun run typecheck`, `bun run format`.
