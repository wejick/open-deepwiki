# Design: extract runClaude's lifecycle phases

## Context

`runClaude` in `src/producer/claude.ts` is a ~600-line function (lines 472–1080) whose
lifecycle — STAGE / REPAIR / PLAN / APPLY / PAGES / FINISH — exists only as block
comments. Each phase closes over ~15 shared locals declared in earlier phases and
consumed in later ones. The split-planning subtree (map / gate / areas / merge) is
~250 of those lines inline, and `claude.ts` imports 25 symbols from `claudePlan.ts`
to serve it.

Constraints that shape the design:

- Repo guardrails ban multi-layer abstraction, DI containers, port/adapter seams,
  and barrel re-exports. The solution must stay flat and concrete.
- Module naming: each producer is `<producerId>.ts`; producer-private modules carry
  its prefix (`claudePlan.ts`, `claudeFinalize.ts`). `run.ts` is the only file that
  branches on producer id.
- Tests pin behavior at `runClaude`'s boundary via shim binaries and fixture
  checkouts — they do not depend on internal structure.

**Coverage audit (verified while scoping)** — every behavior the move could break is
already pinned by `claude.test.ts` / `wip.test.ts` / `acceptance.test.ts`:

- exact ordered event-beat sequences (`toEqual` on `stage note` pairs)
- `partial` on every resumable exit (20 assertions)
- run-level timeout, incl. the FINISH deadline re-read ("even when the budget kills
  the last session")
- first-failure precedence ("the failing session is reported, not whichever session
  happened to be last")
- notes-last-in-`stderr` ("incidental warnings never crowd the notes out of the tail")
- `promptDir` leak check, artifact hygiene on success, `unitsCompleted` both ways
  (present on progress, absent on zero-progress), repair retry via
  `runIsolatedProducer`

The only unpinned surface is the *text* of the "out of budget with N pages
unproduced" diagnostic note (between-sessions deadline path); its outcome
(`timedOut` + `partial` + `failed`, no further sessions) is covered by the two
timeout tests.

## Goals / Non-Goals

**Goals:**

- Each lifecycle phase is a named module-level function with explicit inputs/outputs.
- `runClaude` reads as a short linear script over the phases.
- Split-planning orchestration lives in its own module next to its vocabulary.
- Zero externally observable behavior change; the suite passes unmodified.

**Non-Goals:**

- No state-machine library, workflow engine, or lifecycle abstraction.
- No changes to checkpoint formats, WIP semantics, or `claudePlan.ts` mechanics.
- No new tests (audit found the pinning complete); no spec deltas.
- No cuts to split planning, the gate, or the deterministic repairs.

## Decisions

### D1 — Three modules in an acyclic graph, not one big file

```
run.ts ──► claudeRun.ts ──► claudeSplit.ts ──► claude.ts
        (Run, openRun,        (split planning:   (one session: spawn,
         phases, runClaude)    map/gate/areas/    classify, describe,
                               merge)             prompts, checkClaude)
```

- `claude.ts` keeps the session substrate and prompt builders — the "one session"
  topic — and every symbol tests currently import except `runClaude`.
- `claudeSplit.ts` takes the split-planning subtree and with it ~15 of the 25
  `claudePlan.ts` imports `claude.ts` currently carries.
- `claudeRun.ts` holds the `Run` context, `openRun`, the five phase functions, and
  `runClaude`. `run.ts` and `claude.test.ts` update one import line each.

*Alternatives considered:* (a) keep everything in `claude.ts`, extract only
`claudeSplit.ts` — leaves `claude.ts` ⇄ `claudeSplit.ts` in a runtime import cycle
(split needs `describeSession` and the prompt builders; the run needs the split);
(b) pass `describeSession`/builders as parameters to break the cycle — works but
disguises module topology as function signatures; (c) a two-module cycle tolerated
by ESM — a smell every later reader must untangle. The DAG names the dependency
direction honestly and matches the existing producer-prefix module family.

### D2 — The run context is the closure, made explicit

`openRun` (STAGE + env + flag detection) constructs one concrete `Run` value:
`cfg`, `mode`, `checkoutDir`, `bundle`, `targetSha`, `promptDir`/`prompts`, `env`,
`extraArgs`, `deadline`/`stepMs()`, the `notes`/`units`/`appliedGlobs` accumulators,
and the `session()`/`progress()`/`finish()` helpers. This is not a layer or a DI
container: one implementation, constructed once, consumed directly — it exists so
the phases can be module-level functions at all.

*Alternative considered:* per-phase parameter objects — the accumulators are
genuinely shared mutable state, so they would be threaded identically either way;
one named value is the smaller lie.

### D3 — Phase boundary protocol: `ProducerRun | <next value>`

Each phase returns either a terminal `ProducerRun` or the next phase's input;
a one-line `isProducerRun` guard (`"outcome" in x`) discriminates. No wrapper
types. Signatures:

```ts
openRun(cfg, mode, checkoutDir, opts, input): Promise<Run | ProducerRun>
repairBundle(run, errors): Promise<ProducerRun>
ensurePlan(run, input): Promise<ProducerRun | { loaded; planned; viaSplit }>
applyPlan(run, loaded, planned): Promise<ProducerRun | { plan: NormalizedPlan }>
producePages(run, plan, input): Promise<ProducerRun | { last: Session | null }>
completeRun(run, last): Promise<ProducerRun>
```

`planned` flows through `ensurePlan` because APPLY's failure report and FINISH use
it; `viaSplit` exists only until D5. `runClaude` keeps `promptDir` cleanup in
`finally` (it owns the context's lifetime).

### D4 — Extraction order: context first, then split, then phases

1. Baseline: full suite + lint + typecheck green.
2. `openRun` + `Run`: move the body wholesale into `claudeRun.ts`, rewiring the
   ~15 closure locals to `run.*` — a pure rename, no logic edits.
3. `repairBundle` (smallest phase — proves the pattern).
4. `claudeSplit.ts` (the largest single move, now cleanly bounded by `Run`).
5. `ensurePlan`, 6. `applyPlan`, 7. `producePages` + `completeRun` — one per commit.

Every commit leaves the suite green; any regression bisects to one diff.

### D5 — Last commit, flagged: drop `viaSplit`

`clearPlanningArtifacts` after the plan stamp becomes unconditional (a no-op when
no split artifacts exist; resumed runs skip APPLY either way), removing the flag
from the context and `ensurePlan`'s return. Separately committed so review can
reject it without touching the rest.

## Risks / Trade-offs

- [The context-extraction diff is large and mechanical] → pure rename only; no
  logic changes in the same commit; suite after each step.
- [A dropped terminal path continues into the next phase with a `ProducerRun`] →
  union returns + `isProducerRun` guard make it a `tsc` error under the repo's
  strict flags, not a runtime bug.
- [The between-sessions "out of budget" note is unpinned] → outcome already
  covered by the two timeout tests; deterministic pinning would need clock
  injection (a seam the guardrails ban) or sleep-based races (banned by the
  testing mechanics). Checks are preserved verbatim; pure-move diff review.
- [Import-line updates in `run.ts` / `claude.test.ts`] → mechanical; a miss fails
  `tsc` and the suite immediately.
- [Module header comments describe the old structure] → final task rewrites them
  per the comment rules (describe reasons, not mechanism), keeping the 13–19%
  `src/` comment baseline.
- Trade-off accepted: `claude.ts` no longer contains the whole producer story —
  the lifecycle reader opens `claudeRun.ts`. That indirection is the point of the
  change.

## Migration Plan

No deployment or data migration. Rollback is `git revert` per commit; each of the
extraction commits is independently revertible because each leaves the suite green.
Archive with `--skip-specs` (no spec deltas exist).

## Open Questions

None blocking. If review rejects D5, the `viaSplit` flag stays and the rest of the
change is unaffected.
