# Tasks: add-claude-map-model

## 1. Knob and threading

- [x] 1.1 Add `ODW_CLAUDE_MAP_MODEL` (empty default) to `src/config/config.ts` as `cfg.claude.mapModel`, with a `config.test.ts` assertion on the default and an override. Thread an optional model through `session()` → `runSession` in `src/producer/claude.ts`, passed only by the map call site. Verify: `claude.test.ts` split test with `ODW_CLAUDE_MAP_MODEL` set asserts the map session's argv carries `--model <override>` while the first area session's argv keeps the default model.
- [x] 1.2 Document the knob in `.env.template` and `AGENTS.md`'s ini block; run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, `openspec validate --specs`; all green.
