# Tasks: add-producer-run-events

## 1. Event vocabulary

- [x] 1.1 Extend the `Event` union in `src/monitor/events.ts` with `producer` on run lifecycle events (`run_started`, `run_succeeded`, `run_failed`, `run_rate_limited`) and the new `producer_progress` type (`repoId`, `producer`, `stage: "map" | "area" | "plan" | "page"`, `note`). Verify: typecheck passes; unit test in `monitor.test.ts` asserts a progress line round-trips through `appendEvent`/`readEvents`.

## 2. Producer attribution on lifecycle events

- [x] 2.1 Pass `producerId` to the four lifecycle `appendEvent` call sites in `src/repoManager/pipeline.ts` (not `queue_enqueued` in the scheduler). Verify: `producerPipeline.test.ts` — a claude-failed run's `run_started`/`run_failed` events carry `producer: "claude"`; `repoManager.test.ts` openwiki-path events carry `producer: "openwiki"`.

## 3. Progress emission from the claude producer

- [x] 3.1 Add optional `repoId` to `RunOptions` (`src/producer/contract.ts`), thread it from `runIsolatedProducer` (`src/producer/run.ts`), and call `appendEvent` from `src/producer/claude.ts` at each unit completion: map validated (`stage: "map"`, note with area count), area part completed (`stage: "area"`, note `"<id>: <done>/<total>"`), plan merged (`stage: "plan"`, note with page count), page produced (`stage: "page"`, note with path and `done/total`). No events when `repoId` is absent. Verify: `claude.test.ts` split-planning test asserts the ordered `producer_progress` sequence for map → areas → plan → pages, and that a run without `repoId` writes none.

## 4. End-to-end and contract invariants

- [x] 4.1 Verify the terminal-sequence invariant across producers at the pipeline level: for a claude run that emits progress and then fails mid-pages, `run_started` is first, exactly one terminal event is last, and no lifecycle event is missing. Test lives in `producerPipeline.test.ts` ("Run cycle is unchanged by producer choice", "Progress never replaces the terminal event" scenarios).
- [x] 4.2 Run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, `openspec validate --specs`; all green.

## 5. Review fixes

- [x] 5.1 Emit a `plan` beat for the undecomposed planner too (`src/producer/claude.ts`, after the unapplied plan validates; no `unitsCompleted` change). Verify: `claude.test.ts` "Small init" test asserts the `plan → page` beat sequence and the no-repoId run writes none.
- [x] 5.2 `logs` hides `producer_progress` by default, shows it with `--progress` (`src/cli/main.ts`): filter before applying the 200-line tail. Verify: `cli.test.ts` logs test — beats hidden without the flag, present with it, lifecycle events visible both ways.
- [x] 5.3 Re-run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, `openspec validate --specs`; all green.
