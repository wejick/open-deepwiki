# Tasks — Salvage stray claude planning artifacts

Spec: `specs/okf-producer/spec.md` — added requirement *Stray planning
artifacts are recovered*. Design: `design.md`. Work in order; check a task only
when its stated verification passes.

## 1. Adoption primitive

- [ ] 1.1 In `src/producer/claudePlan.ts`, add `adoptStray(bundleDir, checkoutDir, fileName): Promise<boolean>` that moves `<checkoutDir>/<fileName>` into `<bundleDir>/<fileName>` only when the bundle location is empty, returning whether it moved; unit-test the helper directly (no move when the bundle already has the file, no move when no stray exists, move when a stray exists and the bundle is empty)
- [ ] 1.2 Add a planSplit/`readPart`-level test that the primitive never overwrites an in-bundle artifact by a same-named stray and verify it passes

## 2. Area-loop adoption (`planSplit`)

- [ ] 2.1 In `src/producer/claudeSplit.ts`, when the area loop's `readPart` returns `absent` (both at the top-of-loop resume check and after the just-returned session's re-read), call `adoptStray(..., partFileName(area.id))`, re-read, and fall through to the existing branches; push a `part recovered from the checkout root` note on adoption
- [ ] 2.2 Extend `claudeSplit` in `test/helpers/shim.ts` with a `strayPartArea` option whose area session writes its part to `./$(basename "$PART_FILE")` in the cwd instead of `$PART_FILE`
- [ ] 2.3 Add test "Stray planning artifacts are recovered › An area part written to the checkout root is recovered": with `strayPartArea`, the run outcome is `ok`, the part lands in the bundle, no `not planned` note appears, and page sessions for the area's pages run
- [ ] 2.4 Add test "Stray planning artifacts are recovered › A recovered part is not zero progress": a `runIsolatedProducer` run whose only completed unit is the adopted part reports `unitsCompleted > 0`, so a preserved WIP's `attempts` does not advance
- [ ] 2.5 Add test "Stray planning artifacts are recovered › A misdirected part survives an interrupted run": a first run with a `strayPartArea` that is then killed before the part is counted leaves the stray at the checkout root; the resumed run adopts it without spawning that area's session and the merge completes (assert session log shows the area ran once across both runs)

## 3. Map adoption (`planSplit`)

- [ ] 3.1 In `src/producer/claudeSplit.ts`, when `loadMap` returns `absent`, adopt `.odw-map.json` from the checkout root and reload before spawning a map session
- [ ] 3.2 Extend the `claudeSplit` shim with a `strayMap` option writing the map to `./.odw-map.json` in the cwd
- [ ] 3.3 Add test "Stray planning artifacts are recovered › A map written to the checkout root is recovered": with `strayMap`, the run reaches the area sessions (outcome `ok`, parts written), and a stale map is not adopted

## 4. Plan adoption (`ensurePlan`, undecomposed planner)

- [ ] 4.1 In `src/producer/claudeRun.ts`, after the planner session returns and `loadPlan` is not `unapplied`, adopt `.odw-plan.json` from the checkout root, reload, and classify the adopted plan normally — same-session only, never a file left by an earlier run
- [ ] 4.2 Extend the undecomposed planner test shim (`claudeSessions`/recording shim) with a stray-plan variant writing to `./.odw-plan.json` in the cwd
- [ ] 4.3 Add test "Stray planning artifacts are recovered › A plan written to the checkout root is recovered": the stray plan is adopted and processed (page sessions run from it), and a plan that does not validate is discarded with the unit not done
- [ ] 4.4 Add a regression test that an earlier run's stray plan file is NOT adopted by a later run (adoption is same-session for the plan file)

## 5. Full-suite validation

- [ ] 5.1 Run `bun test ./src/producer ./test` and confirm all tests pass
- [ ] 5.2 Run `bun run lint`, `bun run format`, `bun run typecheck` and confirm clean
- [ ] 5.3 Run `openspec validate --specs` and `openspec validate --change salvage-stray-claude-artifacts` and confirm the change validates
