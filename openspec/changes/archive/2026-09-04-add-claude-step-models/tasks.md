# Tasks: add-claude-step-models

## 1. Knobs and threading

- [x] 1.1 Add `ODW_CLAUDE_{MAP,PLAN,PAGE}_{MODEL,EFFORT}` (empty defaults; efforts accept the closed set or empty) to `src/config/config.ts` as `cfg.claude.{mapModel,mapEffort,planModel,planEffort,pageModel,pageEffort}`, `""` → `undefined` at load; assert defaults and overrides (and a rejected bad effort) in `config.test.ts`.
- [x] 1.2 Thread `{model?, effort?}` through `session()` → `runSession` in `src/producer/claude.ts`; map → `("map")`, planner + area → `("plan")`, page + repair → `("page")`. Extend the `claudeSplit` shim's `modelLog` to record `<kind> <model> <effort>` per session. Verify: `claude.test.ts` — one split run with all six set asserts map/area/page lines carry their pairs and nothing else changes; the existing map-only test updated for the effort token.
- [x] 1.3 Document the six knobs in `.env.template` and `AGENTS.md`'s ini block (empty = run-wide value). Run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, `openspec validate --specs`; all green.

## 2. Deployment values (user's .env, not committed)

- [x] 2.1 Set in the operator's `.env`: map = `claude-haiku-4-5-20251001` / `medium`, plan = `claude-haiku-4-5-20251001` / `high`, page = `claude-sonnet-5` / `high`.
