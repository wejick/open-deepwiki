## 1. Foundations

- [x] 1.1 Add `ODW_CLAUDE_SPLIT_PLAN_FILES` (default 2000) to `src/config/config.ts` with a config test asserting default, parsing, and type; verify `bun test src/config` passes
- [x] 1.2 Create `src/producer/claudeDigest.ts`: pure git-derived digest (tracked file tree grouped per directory with sizes, size-capped) from a checkout path; test against a fixture repo on disk asserting determinism, per-directory grouping, and the output cap; verify `bun test src/producer/claudeDigest.test.ts` passes

## 2. Plan-artifact mechanics (`claudePlan.ts`)

- [x] 2.1 Add map/part schemas and validation: `AreaMap` (`{targetSha, areas:[{id,title,scope}]}`, non-empty areas, area ids safe for filenames) plus sizing validation — per-area scope at most min(5%·N, 100) tracked files and area count within half–double ceil(N / min(5%·N, 100)) — and part files (`{pages: PlanPage[]}`, empty allowed); validators return the same ok/error shape as `parsePlan`; unit tests covering valid, unparseable, empty-areas, bad-area-id, and off-sizing maps (too few areas, too many, oversized area scopes); verify tests pass
- [x] 2.2 Add load/save/merge helpers: `loadMap`/`saveMap` (stamped with targetSha, drift → discard), `loadParts`/`savePart` (per-area, drift → discard), and `mergeParts` (concat → existing `normalizePlan` → existing `stampPlan`); tests assert a kill between units resumes (map + k parts → only remaining areas re-planned) and drift discards; verify tests pass
- [x] 2.3 Add `readPlanProgress(bundleDir, wipDir, inFlight)` returning `{phase: "planning"|"pages", split, done, total, lastUnitAt} | null` — planning units from map+parts, page units from a validated plan's pages present and conformant, the undecomposed marker for in-flight planning with no map or plan yet, WIP fallback, null when idle or nothing legible, null on any read error; tests cover each phase, the marker, the fallback, the idle null, and a corrupt-file null; verify tests pass

## 3. Producer orchestration (`claude.ts`)

- [x] 3.1 Route planning by the gate: init runs above `cfg.claude.splitPlanFiles` take the map→areas loop (per-area directives reusing the planner phase prompt; per-session timeout; invalid artifact deleted, unit not done, run continues; deadline checked before each session), at-or-below keep the single planning session; a rate-limited area session stops the loop and ends the run rate-limited, as the page loop does; test with shell shims that write map/parts across successive invocations (happy, exit-1 area, hang, absent, rate-limited mid-areas) against a fixture checkout; verify tests pass
- [x] 3.2 Merge when the last part lands: all areas have valid parts → `mergeParts` writes the stamped plan and the ordinary page loop takes over; shim test asserts no page session launches before the merged plan validates; verify tests pass
- [x] 3.3 Preserve a usable plan on a failed planning ending: in the planning-failure paths, `loadPlan` decides — usable unapplied/resumable plan finishes with `partial: true` (outcome unchanged), none leaves today's behavior; shim tests cover timeout-after-write (partial, plan in WIP via `runIsolatedProducer`), rate-limit-after-write, and die-before-write (no preservation); verify `bun test src/producer` passes and `contract.test.ts` still enforces producer-id confinement
- [x] 3.4 Reset the attempt counter on forward progress: add `unitsCompleted` to `ProducerRun` (`contract.ts`), set it in `claude.ts` (validated map/parts/merged plan/pages this run; `openwiki` leaves it unset), and have `saveWip` reset `attempts` when the preserving run completed at least one unit; tests cover a progressing run resetting the counter and a zero-progress run still advancing it; verify tests pass

## 4. Status surface (`monitoring`)

- [x] 4.1 Add nullable `progress` to `RepoStatus` in `src/monitor/status.ts`, computed via `readPlanProgress` over the repo's staged bundle, WIP dir, and in-flight state; monitor tests cover in-flight planning, in-flight pages, the undecomposed marker, preserved-WIP legibility, idle null, and health invariance; verify `bun test src/monitor` passes

## 5. Dashboard rendering

- [x] 5.1 Add pure `fmtProgress(progress, now)` to `src/server/dashboard.js` (`planning 3/8 · 4m ago`; undecomposed planning → `below threshold`; null → empty) with bun tests importing it without a DOM; verify `bun test src/server/dashboard.test.ts` passes
- [x] 5.2 Render the progress column in the table wiring for entries with progress and leave null rows unchanged; verify by the existing dashboard test harness snapshot/unit assertions and a manual `bun run serve` + Refresh check

## 6. Docs and validation

- [x] 6.1 Document `ODW_CLAUDE_SPLIT_PLAN_FILES` in AGENTS.md's env-var list next to the other producer knobs; verify the doc names its scenario (large-init split gate)
- [x] 6.2 Run the full gate: `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, `openspec validate --specs` — all green
