# Tasks: add-producer-session-beats

## 1. Beats

- [x] 1.1 Widen the `stage` union in `src/monitor/events.ts` to `planning | session | map | area | plan | page`. In `src/producer/claude.ts`: emit `planning` when the plan-needed block is entered (note: mode and tracked-file count), and emit `session` before every child spawn in the `session()` closure (job from the prompt's directive line: map, area id, plan, page path, repair). Verify: `claude.test.ts` split test asserts the full ordered sequence (planning → per-session spawn beats interleaved before each completion beat) and the small-init test does the same for the undecomposed path.
- [x] 1.2 Update `producerPipeline.test.ts` interleave expectations for the new beats, then run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, `openspec validate --specs`; all green.
