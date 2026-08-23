# The producer contract

A _producer_ turns a repo checkout into an OKF wiki bundle. There are two:
`openwiki` (a third-party CLI, the default and the fallback) and `claude`
(`claude -p`, subscription-backed). Adding a third costs one config union
member, one branch arm, and one new file — and nothing under acceptance.

This is written down rather than expressed as a type, because none of the four
rules below is a shape a compiler can check (design D1b). Two greppable
invariants keep it honest instead; `contract.test.ts` fails if either breaks.
Design letters throughout (D1b, D7, D8b, D14) cite decisions in
`openspec/changes/archive/2026-08-28-add-claude-code-producer/design.md`.

## The four rules

1. **Write the bundle to `<clone>/openwiki/` and touch nothing else in the
   checkout.** Not a source file, not a dotfile, nothing outside the bundle.
2. **Read the commit anchor from `.last-update.json` when updating**, and scope
   work to the supplied change set — or derive an equivalent one. openwiki
   self-diffs and ignores what it is handed; that is allowed.
3. **Never reassign an existing page's frontmatter `type`.** A genuinely new
   page may introduce a value the bundle has not used before; an existing page
   keeps what it has (design D7).
4. **Report exactly one outcome** — `ok`, `failed`, or `rate_limited`.
   **Acceptance is not the producer's decision.**

## Rule 4 is not a formality

A clean `ok` means only that the child process exited without error. It is
**not** evidence that a usable bundle exists. The 1.7 live spike produced a run
that exited `0` with `is_error: false` and `terminal_reason: "completed"` having
written no bundle at all, and charged for the privilege. Whether anything
usable exists is decided by `verifyBundle` + grounding + coverage on the
artifact (design D8b). That is why acceptance lives outside the producer, and
why the init coverage floor is load-bearing rather than belt-and-braces.

## The two invariants

- **Nothing under acceptance may name a producer.** No `ProducerId` import, no
  producer id compared against, anywhere in verification, grounding, the
  scoped-update checks, or restore. Parity is enforced by every producer
  travelling one code path — not by trusting a prompt.
- **Selection appears in exactly one place.** The branch lives in
  `run.ts`, at the single point the bundle is produced. Resolution of
  "which producer does this repo use" lives in `producerFor` in
  `repoManager/registry.ts`. A second `producerId === …` anywhere means the
  branch is spreading.

## The `claude` producer is orchestrated, not one session

`openwiki` is one child process. `claude` is several: a planning session emits a
validated page plan, one page session per planned page produces that page — up
to `ODW_CLAUDE_PAGE_WORKERS` sessions concurrently, each owning one page file —
and the overview page is produced last, after the pool drains, from the pages
that actually shipped. Page workers share the run's single whole-run deadline
(it is never divided among them), and a page session that reports a usage limit
terminates its in-flight peers: the run reports `rate_limited` with the
limited session's own reset time and leaves its plan in place, so a later run
resumes exactly where the limit hit. That shape
is openwiki's own (`repository-prompts.ts` splits planner from page worker,
`generation/run-state.ts` checkpoints the queue), and it is what makes a stuck
page cost one page instead of the whole run.

Nothing outside the producer learns this. `runClaude` keeps its signature and
its single call site in `run.ts`, and reports exactly one outcome as rule
4 requires. Two consequences are worth knowing:

- **The plan file is the checkpoint** (`producer/claudePlan.ts`,
  `<bundle>/.odw-plan.json`, beside `.last-update.json`). The planning session
  writes it; a page's completion is its presence in the bundle with conformant
  frontmatter — no per-page state exists. Before the first page session the
  producer deletes every page the plan names and stamps the file with the
  commit being built, so a stale page is never mistaken for a produced one and
  a stamp naming another commit replans. The work-in-progress area copies the
  bundle, so it preserves and restores the plan file for free. It is a
  dot-file, so `walkMd`, `syncIndexes`, the indexer and `/wiki` never see it,
  and a completed run deletes it.
- **`ProducerRun.partial` says resumable work exists.** `run.ts` preserves
  the work-in-progress area on `rate_limited` **or** `partial`, without asking
  which producer set it — `runOpenwiki` simply never does. This is what stops a
  repo too large for one budget window from restarting at page one every night:
  its attempts now accumulate, and `planResume` surfaces it at the cap.

A **repair retry** does not replan. `runClaude` sees `repairErrors` and runs one
session over the whole bundle with those errors, exactly as it did before the
split — replanning would discard the pages being corrected.

`overview.md` is guaranteed by the producer, never by acceptance: it is required
on init, restored on update, refused as a deletion, and always produced last.
Acceptance must stay producer-blind, and an `openwiki` bundle has no
`overview.md` — it has `quickstart.md`.

## The claude-only finalization pass

`claude` gets one thing `openwiki` doesn't need: a deterministic finalize step
(`claudeFinalize.ts` — index sync, Mermaid validate/degrade) run inside `runClaude`
itself, after the agent finishes and before the run reports its outcome.
`openwiki` already does the equivalent internally before its own CLI exits, so
its bundle is never touched by this and never needs to be — rewriting an
`openwiki`-produced bundle would break rule 1's read-only guarantee for the
one producer that doesn't need the help.

This does **not** weaken the two invariants above: `claudeFinalize.ts` never
branches on a producer id (there is nothing for it to branch on — it has no
producer context, no bundle-origin marker) and is called from exactly one
place, `claude.ts`. `contract.test.ts` enforces both: that `claudeFinalize.ts`
contains no producer-id comparison, and that `finalizeClaudeBundle` (and the
mutating functions it composes, `syncIndexes`/`degradeInvalidMermaidFences`)
are imported from nowhere but `claude.ts`. A second import site would mean the
"claude-only by construction" guarantee has started resting on discipline
instead of on the one call site — exactly the kind of drift the existing two
invariants exist to catch for producer selection.

## What adding a producer costs

Exactly three edits, verified by walking a stub through them:

1. One member added to `PRODUCER_IDS` in `config/config.ts`.
2. One arm added to the branch in `run.ts` (`produce()` and
   `prepareProducer()` — both in that one file, by design).
3. One new file, `producer/<name>.ts`, exporting a `run…` with the same shape as
   `runOpenwiki`/`runClaude`.

Nothing under acceptance is touched, and nothing in monitoring: the pipeline,
verification, grounding, the scoped checks, isolation, continuity, health and
the CLI are all producer-blind and stay that way. If a fourth edit seems
necessary, the contract has leaked — check `contract.test.ts`.

## What is deliberately NOT here

No `Producer` interface, record, registry, factory, or capability negotiation.
A record would be a growth surface, accreting `check`, `estimateCost`,
`supportsIncremental` one locally reasonable addition at a time — the exact
decay the project's no-over-engineering rule exists to prevent. At two
producers an `if` is the whole abstraction that has been earned.

No `supportsResume` flag either: a producer that cannot resume simply redoes
the work, which is correct and merely slower (design D14).
