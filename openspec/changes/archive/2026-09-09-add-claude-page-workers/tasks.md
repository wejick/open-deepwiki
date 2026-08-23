# Tasks

## 1. Config knob

- [x] 1.1 Add `claude.pageWorkers` to the config type and parse `ODW_CLAUDE_PAGE_WORKERS` beside the other `ODW_CLAUDE_*` knobs, defaulting to 1 — verify: a config test asserts the parsed default is 1, an explicit env value is honored, and a non-positive value is rejected exactly like the other producer knobs.
- [x] 1.2 Wire `cfg.claude.pageWorkers` through `runClaude`/`openRun` so the page stage can read it — verify: existing claude producer tests still pass untouched (the field is inert until the pool exists).

## 2. Early-abort seam on the session runner

- [x] 2.1 Extend the `run.session` boundary and `runSession` with an optional abort signal so an in-flight child can be SIGKILLed early by the caller, reusing the existing timeout kill path — verify: a unit test spawns a shim that sleeps, aborts mid-flight, and asserts the child exits via SIGKILL and the returned session reports the kill without a stray timeout.
- [x] 2.2 Keep the default (no signal) behavior byte-identical — verify: the full existing claude/continuation suite passes unmodified.

## 3. Page-stage pool (default 1 = today's behavior)

- [x] 3.1 Rewrite `producePages` as a bounded dispatcher over `plan.pages` minus `OVERVIEW_PAGE`: launch in plan order while in-flight < cap and `Date.now() < deadline`; treat a conformant file's presence as done before launch; delete a failed page's file and record its note; produce the overview in its own final session only after the pool drains with every page present — verify: every pre-existing page-stage scenario (`claudeRun.test`/`continuation.test`) passes with the knob at its default 1, with no assertion changes.
- [x] 3.2 Preserve the shared-deadline semantics: no session launches after the deadline, each spawn still computes its own `stepMs()`, and the post-settle "missing pages" check reports `partial` + `timedOut` exactly as the sequential loop's deadline re-read does — verify: the existing "out of budget" scenario keeps passing at workers 1 and at workers N (N ≥ 2, short whole-run budget).
- [x] 3.3 Preserve deterministic failure reporting: collect per-page results, flush `run.notes` in launch order, and report the first failure by launch order — verify: the existing first-failure and notes-ordering assertions pass unchanged at default 1, and a new workers-N test where an early-launched page fails slowly while a later one fails fast asserts the report still names the early one.

## 4. Concurrency behavior tests

- [x] 4.1 Add a shim variant that signals start (appends `PAGE_PATH` to a marker file), sleeps a fixed short interval, then writes the page — verify: a workers-N test with several pages asserts peak in-flight (concurrent marker entries) reaches N, never exceeds N, and every page is produced.
- [x] 4.2 Assert the overview never joins the pool: with several pages + the overview and workers=N, verify the overview session starts only after every other page file exists, and its prompt lists the pages that shipped.
- [x] 4.3 Assert default-1 runs strictly sequentially — verify: the same marker-file shim at workers 1 shows peak in-flight of exactly 1 across the same page set.

## 5. Rate-limit abort and resume

- [x] 5.1 Add a shim variant where one page session emits the rate-limit JSON payload while the others sleep — verify: a workers-N test asserts in-flight peers are terminated (their marker entries never complete / their pages are absent), no overview session runs, and the run reports `rate_limited` with `partial: true` and the rate-limited session's `resetAt`.
- [x] 5.2 Prove resume is clean after the abort — verify: a two-run test resumes the preserved WIP (plan present, completed pages skipped) and finishes the remaining pages, including treating a peer's half-written file as unproduced and rewriting it.
- [x] 5.3 Pin the `resetAt` propagation — verify: the finished report carries the rate-limited session's reset time and not a peer's (the peer session that becomes the report session would silently drop it).

## 6. Docs and runtime notes

- [x] 6.1 Update `AGENTS.md` (env-knob list, producer runtime notes) and `src/producer/CONTRACT.md` for `ODW_CLAUDE_PAGE_WORKERS` and the pool/rate-limit semantics — verify: `openspec validate --specs` passes and the docs mention the knob exactly once each.
- [ ] 6.2 Optional live spike (manual, `.env`-backed, not in CI): run one real init at workers 2 to measure concurrent-`claude` behavior on a shared config dir and any subscription-limit surfacing; record findings in `test/spike/` — verify: spike notes state a recommendation for a safe default/ceiling.

## 7. Final gates

- [x] 7.1 Run the whole suite and static checks — verify: `bun test ./src ./test`, `bun run lint`, `bun run format --check`, `bun run typecheck`, and `openspec validate --specs` all pass.
