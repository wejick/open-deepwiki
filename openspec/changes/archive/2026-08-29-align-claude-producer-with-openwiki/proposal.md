## Why

`src/producer/claude-openwiki-gap.md` traces most of its 16 gaps to one root
cause: openwiki runs a **planner/worker pipeline** — a planner lays out the page
tree, an isolated worker produces each page, a durable `.run.json` records
per-page completion — while `runClaude` runs **one `claude -p` session**.

Three consequences are load-bearing:

- **A timeout discards everything.** One process, one timer, `SIGKILL`; a
  `failed` run gets no repair and no resume, and only `rate_limited` reaches the
  work-in-progress area. A repo needing more than one timeout window retries
  nightly forever, restarting from page 1, never converging, never alerting.
- **No guaranteed entry point.** openwiki mandates `quickstart.md`, protects it,
  and generates it last from the finished page map. Our `index.md` is
  unconditionally overwritten by `finalize.ts` — while SKILL.md tells the model
  to write it first as its checklist. The two contradict each other.
- **Thin authoring guidance.** No exploration protocol, no page-content
  checklist, no information-architecture principle, no interlinking discipline.

This is also spec-to-code reconciliation: "Resumable production across runs"
already requires a run ending *without completing* to preserve its
work-in-progress area, but every scenario under it exercises only a rate limit.

## What Changes

- `runClaude` becomes an orchestrator: a planning session emits a validated page
  plan, one session per page produces that page, the overview page is produced
  last from the finished page list, then the existing finalize pass runs.
- Page-job state is checkpointed at `<bundle>/.odw-run.json` after every
  transition, so an interrupted run keeps completed pages and the next run
  resumes at the rest. A changed target commit discards the plan and replans.
- An incomplete run reports a resumable partial and preserves its
  work-in-progress area exactly as a rate limit does — which makes the existing
  bounded-attempts path surface an oversized repo instead of burning quota.
- A guaranteed `overview.md`: required on init, undeletable on update, always
  generated last with the finished page map in hand.
- The authoring contract splits into a shared base plus two phase prompts,
  carrying openwiki's exploration protocol, taxonomy, page-content checklist,
  interlinking discipline, retrieval-oriented `description` guidance, and its
  dense-not-short definition of concise.
- Citation resolution refuses a symlink or filesystem alias before reading a
  cited file, mirroring openwiki's evidence resolver.

## Capabilities

### Modified Capabilities
- `okf-producer`: replaces the single-session `claude` invocation requirement
  with an orchestrated planner/worker one; adds page-plan, durable per-page
  checkpoint, guaranteed overview page, and exploration/page-depth authoring
  requirements; extends resumable production to any incomplete run; tightens
  grounding verification against symlinked evidence.

## Non-goals

- No `.claims/`-style evidence store, no content-fingerprint citation
  relocation, no per-citation staleness across runs (gaps 2-4, 7). Those need a
  persistence layer this change does not build.
- No guard against citing `.git/` or the bundle's own output (gap 5); no
  `openwiki` version bump (gap 1).
- No change to the `openwiki` code path — it self-checkpoints, and the partial
  signal is a field it never sets.
- No parallelism across page workers; concurrency is separable tuning once
  per-page cost is measured.
- No acceptance-side overview enforcement: acceptance is producer-blind by
  contract, and an openwiki bundle has no `overview.md`.

## Impact

- `src/producer/claude.ts`: rewritten as the orchestrator; the existing
  spawn/classify body factored into a per-session helper.
- New `src/producer/plan.ts` (plan schema, planner-output parsing,
  normalization, `.odw-run.json` I/O) plus tests.
- New `skill/skills/okf-wiki/PLANNER.md` and `PAGE.md`; `SKILL.md` trimmed to
  the shared contract both phases inherit.
- `adapter.ts`: a `partial` field on `ProducerRun`. `isolation.ts`: the preserve
  branch widens to include it. `grounding.ts`: `lstat` + realpath containment.
- `config.ts` / `.env.template`: `ODW_CLAUDE_STEP_TIMEOUT_SEC`.
- `test/helpers/shim.ts`: every `claude*` shim becomes phase-aware.
