## Why

The `claude` producer produces pages strictly one at a time — one `claude -p` session per planned page, fully sequential. For a large init a page session is the bulk of run wall-clock, so a many-page plan can take hours and routinely hits the whole-run budget with pages still unproduced. Page sessions are already independent: each writes one distinct file, completion is file presence, and resume skips what exists. Running a bounded number concurrently is the natural lever on wall-clock throughput.

## What Changes

- A new config knob `ODW_CLAUDE_PAGE_WORKERS` (default 1) caps how many page sessions the `claude` producer runs concurrently. Default 1 keeps today's exact sequential behavior.
- Page production becomes a bounded pool: up to N in-flight page sessions, all sharing the **same** whole-run deadline (a wall clock, not divided among workers). A session that would start after the deadline is not launched; the per-session timeout still bounds one session independently.
- The overview page stays **out of the pool**: it is produced last, after the pool drains, with the finished page list, exactly as today.
- A `rate_limited` page session aborts the run: in-flight peers are terminated and awaited, no new page session launches, and the run reports `rate_limited` with `partial` — carrying the rate-limited session's own `resetAt`. Resume semantics are unchanged: the plan file is the checkpoint, a completed page is a conformant file, and a terminated worker's half-written file fails conformance and is simply reproduced.
- Failure reporting stays deterministic: the run's headline session for a `failed` outcome is the first failing page by launch order; per-page notes keep their stable ordering.
- Cost is unchanged — total page tokens are the same; the knob buys wall-clock only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `okf-producer`: the "Non-interactive Claude Code producer invocation" requirement changes — page sessions may run concurrently up to a configured cap rather than strictly one at a time; the whole-run deadline and rate-limit/partial semantics are restated for concurrent execution.

## Impact

- `src/producer/claudeRun.ts`: `producePages` rewritten as a bounded pool; shared deadline and rate-limit abort handled there. `openRun`/`run` surface unchanged.
- `src/config/config.ts`: new `claude.pageWorkers` field + `ODW_CLAUDE_PAGE_WORKERS` parse/validation.
- `src/producer/contract.ts`: unchanged — `ProducerRun` and outcomes are untouched.
- Tests: `src/producer/claude.test.ts` and `continuation.test.ts` gain worker-pool scenarios; the test shim gains an in-flight/blocking variant to prove overlap and a killable variant for the rate-limit abort.
- `AGENTS.md` env-knob list, `CONTRACT.md`. No skill-file changes (`PAGE.md` already assumes sibling pages belong to other sessions).
- No repo-manager, monitoring, WIP, or acceptance changes.

## Non-goals

- No division of the whole-run budget among workers — it stays one shared wall clock.
- No parallel planning/map/area sessions, no cross-repo parallelism.
- No change to rate-limit classification, `resetAt` recording, resume, or WIP-preservation rules.
- No change to the overview's produce-last contract.
- No cost reduction and no change to per-page prompts.
