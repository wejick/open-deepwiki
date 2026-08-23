## Context

See proposal.md — Why. The page stage (`producePages` in `src/producer/claudeRun.ts`) runs one `claude -p` child session per planned page in a strict `for` loop. Page sessions are already embarrassingly parallel by construction: each owns exactly one bundle path (`PAGE_PATH`), writes nothing else, completion is a conformant file's presence, and the stamped plan is the resume checkpoint. The overview page is always sorted last in a normalized plan (`claudePlan.ts` sort) and its session needs the finished page list. `run.session` already spawns each child with `timeoutMs: stepMs() = min(step, deadline − now)` computed at spawn time, so per-session budget is already derived from one shared whole-run wall clock.

Specs to satisfy: `openspec/changes/add-claude-page-workers/specs/okf-producer/spec.md` — the modified "Non-interactive Claude Code producer invocation" requirement (worker cap, shared deadline, rate-limit abort, first-failure-by-launch-order).

## Goals / Non-Goals

**Goals:**
- A configurable cap on concurrently in-flight page sessions, defaulting to 1 (byte-for-byte current behavior at the default).
- Preserve the single whole-run deadline as a shared wall clock; preserve per-session timeout semantics.
- Deterministic reporting (first failure by launch order; stable per-page notes) despite out-of-order completion.
- Rate-limit semantics that keep resume clean: abort in-flight peers, report the rate-limited session's own payload (`resetAt`), preserve the WIP.

**Non-Goals:**
- Parallelism anywhere but the page stage (planning/map/area/repair sessions stay sequential).
- Any change to `ProducerRun`, checkpoint format, WIP rules, acceptance, or the overview's produce-last contract.
- A generic worker-pool abstraction or third-party concurrency library (guardrail: flat, concrete code).
- Changing what a page session is told or how much each costs.

## Decisions

### D1. `ODW_CLAUDE_PAGE_WORKERS`, default 1, lives in the existing `claude` config block
`cfg.claude.pageWorkers`, parsed from `ODW_CLAUDE_PAGE_WORKERS` beside the other `ODW_CLAUDE_*` knobs (`src/config/config.ts`), validated as a positive integer.
Serves: the "Page workers cap concurrency" and "Page workers default to one" scenarios.
Alternatives considered: a generic `ODW_CLAUDE_CONCURRENCY` covering planning sessions too — rejected: only the page stage is independent by construction, and planning parallelism is out of scope.

### D2. The pool is an inline dispatcher in `producePages`, not a new module or class
`producePages` keeps its module-level phase-function shape and becomes: (1) drain the plan's non-overview pages through a cap-N dispatcher; (2) if any is missing after settling, fail `partial` as today; (3) otherwise run the overview session exactly as today. The dispatcher walks `plan.pages` in plan order, launching a session whenever `in-flight < cap` and `Date.now() < deadline`, keyed off `Promise` settlement — no queue type, no library. Launch order == plan order, which is what makes failure ordering deterministic.
Serves: "One session per planned page", "Page workers cap concurrency", "Per-session timeout bounds one page, not the run".
Alternatives considered: a `p-limit`-style dependency, or a self-regulating queue object — rejected: one `while` loop over settlement is the smallest thing that satisfies the scenarios, and new deps need a named requirement.

### D3. The overview is excluded from the pool by path, not by position
Robust to future plan-ordering changes: pool over `plan.pages.filter(p => p.path !== OVERVIEW_PAGE)`, then produce the overview after the pool drains and only when every other page is present and conformant. A failed or `rate_limited` pool therefore never runs the overview, matching "the overview session SHALL NOT run" and the existing produce-last contract.
Serves: the existing "Overview is produced last with the finished page list" requirement and the new rate-limit scenarios.
Alternatives considered: trusting the normalizePlan sort to make overview last — rejected: cheap and fragile.

### D4. Per-session budget is unchanged: each spawn computes `stepMs()` against the shared deadline
No budget-division logic is added. A session launched at time T gets `min(step, deadline − T)` as today; the dispatcher simply stops launching once `Date.now() >= deadline`. In-flight workers are not killed by the deadline — their own per-session timer handles a hung session, and the existing post-settle "missing pages" check decides `partial` + `timedOut`, exactly as the current loop's post-loop deadline re-read does.
Serves: "Concurrent page sessions share one whole-run deadline" and the existing "Timeout kills the run".
Alternatives considered: dividing the remaining budget by the cap at launch time, or a shared "fair-share" deadline — rejected: the user's requirement is that the deadline is a wall clock, not a pool budget.

### D5. Rate-limit abort kills in-flight peers through an abort signal threaded on the existing session seam
`runSession` owns the spawn and its kill-on-timeout timer; today nothing can kill a session early because nothing is ever in flight when a session returns. The seam `run.session(...)` gains an optional abort (an `AbortController` per in-flight page session, wired so `runSession`'s existing SIGKILL path fires on abort, same as its timeout path). When a page session classifies `rate_limited`, `producePages` aborts every outstanding controller, `await`s all settled sessions, and finishes with the **rate-limited session as the report session** — `finishRun` copies `resetAt` and the outcome fields off the session it is given, so aborting with a peer as the headline would silently drop `resetAt` and defeat the scheduler's wait.
Serves: "A rate-limited page session aborts in-flight peers".
Alternatives considered: (a) exposing raw child handles to `producePages` for direct kills — rejected, duplicates timeout handling and widens the seam; (b) letting peers finish before reporting — rejected: a limit is a fleet-level signal and preserving the reset time matters more than the last page.

### D6. Failure/notes determinism: collect per-page results, flush notes in launch order, report first failure by launch index
Completions are out of order, so `producePages` keeps per-page results and, once the pool settles, appends the per-page failure notes and picks the headline session in **launch order** (the plan order the dispatcher used). Incremental `progress` beats for the event log still fire on completion (they are a diagnostic trail, not a contract — monitoring spec); only `run.notes`, which land last in `stderr`, are ordered.
Serves: "The first failing page leads the failure report".
Alternatives considered: reporting the first *completing* failure — rejected: with N workers the first to fail is scheduling luck, not root cause; launch order preserves the documented invariant at `workers = 1` exactly.

## Risks / Trade-offs

- [Higher N trips subscription usage limits more often, turning `rate_limited` from corner case into common end state] → the abort path is already designed to preserve WIP and honor `resetAt`, so a limit costs at most one drained batch; default stays 1 and raising it is an operator decision backed by the live-spike measurement below.
- [Concurrent `claude -p` processes share one credential/config dir; transcript-file or state contention is unmeasured] → measure in a live spike (2 workers, one real repo) before any default change; document findings like the existing spike notes. Not a correctness risk: page files are distinct and resume re-derives state.
- [SIGKILL of a peer can leave a half-written page file] → already tolerated by design: resume treats presence-without-conformance as unproduced. No new risk beyond what a per-session timeout already imposes.
- [Pool bookkeeping regresses the sequential path] → default-1 behavior is pinned by the existing suite (unchanged scenarios at `workers = 1`) plus an overlap-asserting shim test that peak in-flight never exceeds the cap at both 1 and N.

## Migration Plan

- Ships with default 1 → no behavioral change until an operator sets the knob; rollback is unsetting it.
- Order: config knob + validation → pool rewrite at `workers = 1` (suite must pass unchanged) → concurrency/rate-limit/order tests at `workers = N` → live spike (measure subscription behavior at 2) → AGENTS.md/CONTRACT.md knob and runtime notes.
- Not deployed per-repo: it is a process-wide env knob like the other `ODW_CLAUDE_*` settings.

## Open Questions

None — the semantics the specs pin (shared deadline, rate-limit abort, launch-order reporting) were confirmed in conversation before this proposal.
