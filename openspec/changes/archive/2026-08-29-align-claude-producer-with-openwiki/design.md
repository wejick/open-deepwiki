## Context

See proposal.md — Why. Four existing constraints shape every decision below.

- **CONTRACT.md invariant 1**: nothing under acceptance may name a producer.
  `verify.ts`/`grounding.ts`/`acceptance.ts` treat both producers identically,
  enforced by `contract.test.ts` grepping for a producer-id branch.
- **CONTRACT.md invariant 2**: producer selection appears in exactly one place
  (`isolation.ts`), plus `finalizeClaudeBundle` may be imported only by
  `claude.ts`. A new orchestration module must trip neither.
- **AGENTS.md guardrails 1-3**: no over-engineering, no multi-layer abstraction,
  flat concrete code. This change adds process structure inside one producer, so
  it must not grow an interface, a registry, or a job-runner abstraction.
- **The published bundle is never partial.** Production writes to
  `<clone>/openwiki/`; `<dataDir>/repos/wip/<repoId>/` accumulates across runs
  and is never indexed or served. Anything durable the orchestrator needs has to
  survive that copy in and out.

## Goals / Non-Goals

**Goals:**
- Give the `claude` producer openwiki's failure granularity: a stuck page costs
  one page, not the run.
- Make an interrupted run resumable deterministically, from recorded per-page
  state rather than from the model re-reading a half-written bundle.
- Guarantee a synthesized entry-point page the way openwiki guarantees
  `quickstart.md`.
- Move the authoring depth openwiki gets from its planner and worker prompts
  into the two equivalent phases here.

**Non-Goals:**
- See proposal.md — Non-goals.
- Not reproducing openwiki's Claims store, tool-call-time citation validation,
  or content-fingerprint relocation. Those are a persistence layer, not a
  consequence of the pipeline split.

## Decisions

**D1 — One orchestrator inside `runClaude`, driving N+2 `claude -p` sessions.**
The planner/worker split is what produces openwiki's per-page failure
granularity, its resumability, and its mandated-last synthesis page; those are
consequences of the architecture, not features that bolt onto a single-shot
prompt. `runClaude` keeps its exact signature and its single call site in
`isolation.ts`, so nothing outside the producer learns that it now spawns more
than one child.
*Alternatives considered:* keep one session and have it checkpoint its own
progress — rejected because a single process cannot bound one page's cost, so
the livelock case (a repo needing more than one timeout window) survives
unchanged; prompt-only alignment — rejected because it closes gaps 10-16 but
leaves 8 and 9, the two with operational consequences, untouched.

**D2 — The checkpoint lives at `<bundle>/.odw-run.json`.**
`saveWip` copies the whole bundle directory out and `stageWip` copies it back,
so a file inside the bundle is preserved and restored with no new persistence
layer, no new path, and no `repoId` threaded into `runClaude`. It is invisible
downstream: `walkMd`/`conceptPages`/`ingestBundle` see only `.md`, `syncIndexes`
skips dot-files, `/wiki` renders `.md`. `.last-update.json` is the existing
precedent for a dot-file living in the bundle.
*Alternatives considered:* a sibling file in the WIP directory — rejected
because `runClaude` receives `checkoutDir`, not `repoId` or the WIP path, so it
would need a new parameter and `stageWip` would need a second strip rule; a
libSQL table — rejected as a schema addition for state that is worthless once
the bundle it describes is gone.

**D3 — `partial` is a field on `ProducerRun`, not a fourth outcome.**
Contract rule 4 fixes the outcome vocabulary at `ok | failed | rate_limited`,
and `partial` is not an acceptance claim — it says only "resumable state
exists." `isolation.ts` widens its preserve branch to
`outcome === "rate_limited" || run.partial === true`, which is producer-blind:
a field on the shared type, not a producer-id check. `runOpenwiki` never sets
it, so openwiki's behaviour is byte-identical to today.
*Alternatives considered:* a fourth outcome `partial` — rejected as a breaking
change to contract rule 4 and to every consumer that switches on the outcome
(`pipeline.ts`, `health.ts`, `events.ts`, the dashboard); branching on
`producerId` in `isolation.ts`'s preserve step — rejected, it would put a
second producer-id comparison in the file and read as producer-specific policy
where the policy is general.

**D4 — Preserving work in progress on a partial run is what closes gap 9.**
A chronically-oversized repo currently reports `failed`, keeps no WIP, and so
never ticks `attempts`. Once a partial run preserves its WIP, `planResume`
counts attempts, reaches `exhausted` at `cfg.maxResumeAttempts`, and the
existing path already discards the work and surfaces the repo as needing
attention. No new alerting mechanism is introduced.
*Alternatives considered:* a dedicated repeated-timeout detector reading the
event log — rejected as new state and a second convergence policy beside the
one `wip.ts` already owns.

**D5 — One new config knob, `ODW_CLAUDE_STEP_TIMEOUT_SEC` (default 900).**
It serves the "Non-interactive Claude Code producer invocation" requirement's
per-session bound: without it every child session inherits the whole-run budget
and one stuck page can still consume it. `ODW_CLAUDE_TIMEOUT_SEC` keeps its
meaning as the overall budget — when its deadline passes the orchestrator stops
launching sessions and returns partial, so the existing "Timeout kills the run"
scenario stays true while becoming non-destructive.
*Alternatives considered:* separate planner and worker knobs — rejected, two
knobs where one scenario exists; deriving the step budget as a fraction of the
run budget — rejected as an undiscoverable coupling an operator cannot tune.

**D6 — The overview page is enforced inside the producer, never in acceptance.**
Acceptance is producer-blind by contract and an `openwiki` bundle has no
`overview.md`, so an acceptance-side requirement would either reject every
openwiki bundle or need a producer-id branch. Enforcement therefore lives in
plan normalization (insert the job on init, filter it out of `deletePages` on
update, sort it last) and in the completion check that gates `ok`.
*Alternatives considered:* accepting either `overview.md` or `quickstart.md` in
acceptance — rejected as encoding two producers' conventions into the one place
that must know about neither.

**D7 — `overview.md` is a normal concept page, not a reserved name.**
Adding it to `RESERVED_NAMES` would exempt it from frontmatter verification and
exclude it from indexing and `/wiki` — the opposite of the intent, which is a
findable entry point. Being non-reserved means it is subject to acceptance's
byte-identity check, so on update it is regenerated only when the plan adds or
removes a page; an unprovoked rewrite would read as a scope violation.
*Alternatives considered:* reserving it and generating it deterministically from
frontmatter like `index.md` — rejected because a mechanical listing is what
`index.md` already is, and the value here is the synthesized routing prose a
model writes with the finished page map in hand.

**D8 — Phase prompts are files beside `SKILL.md`, composed at spawn time.**
`SKILL.md` keeps the invariants both phases share (frontmatter, `sources`
citations, cross-linking, diagrams, prose, guardrails); `PLANNER.md` and
`PAGE.md` carry the phase-specific protocol. Each session's system prompt is
`SKILL.md` plus one phase file, mirroring openwiki's own `prompt.ts` (shared)
plus `repository-prompts.ts` (planner/worker) split. Keeping them as files
preserves the property that the prompt is versioned with the code and diffable.
*Alternatives considered:* one SKILL.md with phase sections the prompt selects
from — rejected, it ships every phase's instructions to every session and makes
the two prompts impossible to diff independently.

**D9 — Machine-readable directive lines in each prompt.**
The planner prompt carries `PLAN_FILE: <absolute path>` and a worker prompt
carries `PAGE_PATH: <bundle-relative path>`. The model needs both facts anyway,
and stating them on their own line lets the shell shims in `test/helpers/shim.ts`
`sed` them out of argv to decide what to write — so the tests keep exercising
the real spawn path (argv, stdio, exit codes) without a test-only hook in
production code.
*Alternatives considered:* passing the paths as environment variables —
rejected, the real CLI reads the prompt, not the environment, so the variables
would exist solely for tests; a `--output-file` style flag — rejected, no such
flag exists on the CLI.

**D10 — The planner writes its plan to one file outside the checkout.** A file
is more robust than parsing prose for JSON, and writing it into our own scratch
directory (the same `mkdtemp` that already stages the authoring contract) keeps
contract rule 1 intact — nothing in the checkout is touched. A plan that is
missing, unparseable, or empty fails the run before any page is written.
*Alternatives considered:* having the planner write the plan into the bundle —
rejected, it puts a scratch artifact in the published output for the window
before it is cleaned up; parsing the session's `result` text as a second
channel — rejected, a brace-matching scan over model prose is a parser to
maintain and a way for a half-narrated plan to reach generation, and the
session is told plainly which file is its only answer.

**D11 — Symlink defense counts as unresolved rather than throwing.**
openwiki raises `EvidenceSecurityError`; our grounding score is an aggregate
over a whole bundle, and one hostile citation should degrade the score, not
abort scoring for every other page. `lstat` plus a `realpath` containment check
mirrors `resolver.ts:201-223` while fitting the scoring model we already have.
*Alternatives considered:* throwing and failing the run — rejected, it converts
a scoring signal into an unconditional rejection and gives a malicious
repository a denial-of-service against its own indexing.
