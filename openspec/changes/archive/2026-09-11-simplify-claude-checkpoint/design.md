## Context

`align-claude-producer-with-openwiki` (archived) introduced `<bundle>/.odw-run.json`:
a `RunState` (`mode`, `targetSha`, per-page `status`, `schemaVersion`) written
atomically after every page, plus a `resumeFrom` validator. Two facts make most
of that redundant:

- The orchestrator already treats "page done" as "file present with parseable
  frontmatter and a non-empty `type`" (`pageIsWritten`). The `status` field
  re-encodes the filesystem.
- `wip.ts`'s `WipMeta` already records `{targetSha, producer}` and already
  decides resume vs discard vs exhausted; a plan file only reaches a new run
  via `stageWip`'s wholesale copy, so the checkpoint's own `mode`/`targetSha`
  re-encode a decision the WIP layer already made.

The boundary constraint from the earlier change stands: nothing outside
`claude.ts`/`claudePlan.ts` may learn that the producer orchestrates sessions
(`contract.test.ts` greps enforce it).

## Goals / Non-Goals

**Goals:**
- One durable artifact per run — the plan itself — instead of a plan plus a
  checkpoint describing the plan's progress.
- One code path for fresh runs and resumes: read plan → apply → produce
  missing pages.
- A tighter sandbox: no session writes outside the clone.

**Non-Goals:**
- The overview page mechanism is unchanged (deterministic generation was
  considered and is deliberately deferred).
- No changes to `run.ts`, `wip.ts`, acceptance, or `contract.ts`.
- No renames or lint-policy changes.

## Decisions

**D1 — The plan file is the checkpoint; the filesystem is the status store.**
The planning session writes `.odw-plan.json` into the bundle. Resume skips
pages that are present and conformant. `RunState`, `PageJob.status`, `mode`,
`schemaVersion`, `writeRunState`'s atomic write, and `resumeFrom` are deleted —
`schemaVersion` only existed because a durable cross-run format is an API
surface, and deleting the format deletes the API.
*Alternatives considered:* keep `RunState` — rejected, it duplicates the
filesystem and `WipMeta`; statusless `RunState` with `targetSha` — rejected,
still a second artifact with nothing left to say.

**D2 — Apply once: delete planned pages, then stamp the plan with
`appliedAtSha`.** Deleting every planned page (and every `deletePages` entry)
before the first page session makes "present and conformant ⟺ produced by this
build" hold in update mode too, where a planned page pre-exists. The stamp —
one field carrying the commit being built — does two jobs: its absence means
"planned but never applied" (a kill between the planning session and
application re-runs the idempotent deletion), and a mismatch means "stale plan"
(replan). Fresh runs and resumes then share one code path: read plan → apply if
unstamped → produce missing pages.
*Alternatives considered:* status per page — rejected, re-introduces the
redundant store; overwrite-in-place without pre-deletion — rejected, on update
a pre-existing page would be mistaken for done, and pre-deletion also removes
a planted symlink before its page session writes, so a `Write` can never
follow one out of the bundle; trusting the WIP pin alone — rejected, one field
keeps the drift check producer-local and directly testable.

**D3 — The planner writes the plan inside the bundle.** The plan path becomes a
fixed bundle-relative location stated in the planner prompt, so the sandbox
rule loses its one exception ("no writes outside the clone" — the tmpdir
scratch file disappears), and the WIP area's wholesale copies preserve and
restore the checkpoint for free. Dot-file invisibility follows the
`.last-update.json` precedent.
*Alternatives considered:* keep the tmpdir scratch file — rejected, it is the
only outside-the-clone write and extra plumbing (stage, path threading,
cleanup) for a file the bundle can hold.

**D4 — The orchestrator validates only what it acts on: paths.** `pages[].path`
and `deletePages` are validated (bundle-relative, `.md`, no reserved names, no
escape, no duplicates). `type`, `title`, `brief`, `sourcePaths`,
`relatedPages` are authoring cargo passed into the page session's prompt
verbatim; a plan entry missing one is not a run failure (the page session's
PAGE.md guidance covers what the page needs).
*Alternatives considered:* keep the strict entry schema — rejected, a missing
`brief` failing the whole run is a failure mode with no acceptance benefit;
acceptance, not the plan schema, gates page quality.

**D5 — A failed page session deletes its file; there is no rollback.** After
pre-deletion there is no earlier content to restore. A half-written file fails
`pageIsWritten`, so the page stays pending and a later session overwrites it;
deleting the file keeps the WIP bundle clean. Acceptance plus
snapshot-restore remains the promotion gate, unchanged.
*Alternatives considered:* keep `rollbackPage` — rejected, it defends a case
(pre-existing content) that pre-deletion eliminates.

**D6 — The boundary stays clean by construction, and the one implicit
invariant gets a test.** `run.ts` and `wip.ts` stay content-blind (wholesale
`rm`+`cp`); acceptance keeps walking `.md` only; `contract.ts` gains nothing.
What replaces `resumeFrom`'s explicit validation is a positional invariant — a
plan file is present ⟺ staged from a gated WIP — maintained by copy semantics
in three places rather than checked in one. That is the deliberate trade: less
code, one unenforced invariant. It holds because failed runs restore wholesale
(plan file gone), partial runs without a WIP area destroy their output, a
published bundle never carries a plan file (removed before `ok`), and
`stageWip` strips only `.odw-wip.json` by name. Two tests pin it: `stageWip`
preserves a plan file, and a restored-after-failure bundle contains none.
*Alternatives considered:* re-validate in `run.ts` — rejected, it would name a
claude-private file in the producer-agnostic layer, which is the leak this
design exists to avoid.

## Risks / Trade-offs

- [The positional invariant is broken by a future change to staging or
  restore] → graceful degradation (a stale plan whose stamp matches can only
  exist via WIP, which pins the commit; a lost plan file costs one replan) plus
  the two D6 tests.
- [A kill lands mid-stamp, corrupting the plan file] → parse failure on the
  next run replans; one planner session is lost, no page work.
- [Passthrough cargo lets a thin plan produce thin page prompts] → acceptance
  (grounding, links, coverage, scope) gates the artifact exactly as today.
- [An existing WIP area still carries an old `.odw-run.json`] → ignored by the
  new code (different filename), so the run replans; noted in the spec's
  migration line.
