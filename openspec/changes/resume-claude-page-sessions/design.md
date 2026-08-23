# Design — Resume interrupted claude page sessions

## Context

See proposal.md — Why. The pieces that shape the approach:

- **Page production** (`claudeRun.ts` `producePages`): each missing page gets one
  `runSession` child; up to `ODW_CLAUDE_PAGE_WORKERS` run concurrently and share
  one deadline. The overview is a page session too, spawned after the pool.
- **Kills are SIGKILL** (`claude.ts:375-388`), on timeout and on a rate-limit
  abort. A killed child emits no result payload, so the current spawn path
  cannot learn what session it was — the identity must be assigned by us and
  recorded before the child starts.
- **The plan file is the durable checkpoint** (`.odw-plan.json`); page
  completion is derived from the page file on disk, not stored
  (`claudeRun.ts:407`). A live WIP area pins the target commit, so a resumed run
  builds the same tree (`wip.ts`).
- **CLI 2.1.228 advertises** `--session-id <uuid>` (name this session) and
  `-r, --resume [value]` (continue by session ID); sessions persist by default.
  Probing a random ID locally exits 1 printing `No conversation found with
  session ID: …` with no JSON payload, at no API cost. Unknown options are hard
  errors, so flags are probed from `claude --help`, exactly as
  `--setting-sources` already is (`claude.ts:44-56`).
- **Bundle dot-files** are producer-owned and invisible to every page-walking
  consumer: plan, map/parts (removed by `clearPlanningArtifacts`), continuity
  anchor. All of them travel through WIP staging.

## Goals / Non-Goals

**Goals:**

- A page session killed mid-flight by a usage limit, timeout, or peer
  cancellation is continued from its own transcript on a later run, under the
  same pool cap, deadline, per-session timeout, and cancellation as any session.
- The identity is durable before the child can do work; a kill cannot cost the
  record.
- A CLI without the flags degrades to exactly today's behavior; a transcript
  that can no longer be resumed falls back to a fresh session rather than
  losing the page.

**Non-Goals:**

- Planning, map, area, and repair session resume; their units already
  checkpoint by artifact presence.
- `--output-format stream-json` or any output scraping; identity is assigned,
  not observed.
- Any config knob, dependency, or change to WIP/attempt accounting.
- Resuming across target-sha drift: plan staleness plus the WIP pin already
  guarantee a same-tree continuation.

## Decisions

### 1. Assign the session identity at spawn (`--session-id`), don't scrape it

The producer generates a UUID per page session before the spawn, persists it,
and passes it as `--session-id`. Resume then passes the same value to
`--resume`.

The timeout and abort paths SIGKILL the child, so no result payload exists and
output scraping can never see a killed session's ID — exactly the sessions this
change exists for. Pre-assignment is also the only ordering that satisfies
"durable before the child can work": the record is written first, then the
child starts.

Alternatives considered: parse the result payload (only clean exits have one —
a killed peer never does, so the feature would miss the 3-worker case);
`--output-format stream-json` and capture the ID from the first event
(possible, but it changes the output contract and parsing surface for every
session, including healthy ones, to observe something we can simply assign).

### 2. Records live in a producer-owned sidecar, `.odw-sessions.json`

One dot-file mapping bundle-relative page path → `{ id }`. It is written
atomically (temp file + rename) because up to N workers update it, and updates
are serialized through a single in-process promise chain inside the page pool —
a bare read-modify-write from concurrent workers would lose records.

A sidecar rather than a field in `.odw-plan.json`: a corrupt sidecar loses
resume only, while a corrupt field inside the plan fails the plan parse, and an
invalid plan triggers a replan whose apply **deletes the pages already
produced** — a blast radius this feature must not introduce. It also leaves the
plan schema and its readers (`loadPlan`, `readPlanProgress`) untouched.

Cleanup rides `clearPlanningArtifacts`, which already runs at the only three
moments a plan is consumed or a published bundle must carry no checkpoint: after
apply stamps a new plan, on finish, and by the repair path. A resumable plan
returned early from apply never calls it, which is what lets records survive
the resume.

Alternatives considered: embed in the plan (blast radius above, schema churn);
a deterministic UUIDv5 derived from target commit + page path (no record file,
but a fresh retry after an unresumable identity would collide with the old
session, and an interrupted attempt cannot be distinguished from a failed one);
one record file per page (readdir churn and naming for no gain).

### 3. One page-session path serves the pool and the overview

Both spawn sites route through one helper that looks up the record, decides
resume vs fresh, writes the record before the spawn, and classifies the outcome
into keep/drop/replace. The overview is special only in ordering and link
targets; resume is orthogonal and must not be a second copy of the logic.

Alternatives considered: inline the logic at both call sites (drift); a resume
module with an interface (banned seam over a single implementation).

### 4. Lifecycle: keep on interruption, drop on completion or terminal failure, replace on unresumable

An **interruption** — `rate_limited`, `timedOut`, or `aborted` — keeps the
record, so the next run resumes again. Producing the page drops it. A
**terminal failure** drops it, so the next attempt for that page is fresh.
An unresumable identity is replaced by the fresh fallback's new identity.

Keeping the record across repeated interruptions was chosen over a
once-per-identity cap: a page can legitimately need several budget windows, and
a transcript replays at cache-read cost while a restart re-pays the session's
entire fixed overhead. A resume-chain cap can be added later if a real
runaway is measured.

Alternatives considered: resume once, then go fresh (bounds transcript growth,
but a multi-night page loses its exploration every time); drop on every non-ok
outcome (defeats the feature); TTL on records (no measured need, and the WIP
already scopes records to one pinned build).

### 5. Unresumable detection and same-run fallback

A resume attempt whose child exits non-zero with no parseable result payload,
and is neither timed out nor aborted, is classified unresumable: the CLI
refused before doing work (locally observed as `No conversation found`, exit 1,
no JSON). The producer immediately spawns a fresh session for that page with a
new identity and replaces the record, so the page is still attempted this run.
Any other non-ok resume outcome is that attempt's result under decision 4 — and
because a plain `failed` is terminal, the record is dropped anyway: a missed
detection costs one failed attempt, never a resume loop.

Alternatives considered: check the transcript file on disk before resuming
(depends on the CLI's config-dir/project-hash internals, which can move);
match the error wording (drifts across versions); no fallback (a transcript GC'd
between runs would make the page fail forever).

### 6. The capability probe reuses the one `--help` call

The existing probe becomes one function returning both whether
`--setting-sources` and whether the session flags are advertised;
`run.extraArgs` keeps carrying `--setting-sources user`, and `runSession` adds
the per-session flag pair. A CLI advertising neither session flag gets no
identity and no resume, with a run note in the same style as the existing
setting-sources note.

Alternatives considered: a second `claude --help` spawn (waste — one probe
already exists); assume support (an unknown option is a hard error that would
fail the whole run).

### 7. The continuation prompt keeps the page-directive shape

A resumed session gets the page's ordinary directives, rebuilt against the
current bundle (fresh link targets), plus an interruption note: the previous
session was interrupted before finishing, the page may be partially written,
verify what is on disk and finish it. The first line stays `PAGE_PATH:` so
`sessionJob` and every test shim parse it unchanged.

Alternatives considered: resend the original prompt verbatim (stale link
targets, no interruption context); send a bare "continue" (the model may not
know the page is still unproduced).

## Risks / Trade-offs

- [A transcript resumed across many nights becomes expensive to replay] →
  accepted by decision 4; its tokens are cache-read priced, and a restart would
  re-pay the session's whole fixed cost. A measured runaway becomes a follow-up
  cap, not a pre-built knob.
- [SIGKILL drops the in-flight turn's transcript lines] → only flushed turns
  replay; the continuation note tells the session to trust disk over memory,
  and the page is accepted only after a full conformance check.
- [The CLI's unresumable error shape changes] → decision 5's fallback misses,
  the attempt is classified failed (terminal), the record drops, and the next
  run starts fresh — a one-attempt cost, not a permanent loop.
- [Concurrent workers corrupt or clobber the sidecar] → atomic temp+rename
  writes and one serialized update chain inside the pool.
- [The sidecar reaches a published bundle] → it is a dot-file (never walked as
  a page) and `clearPlanningArtifacts` removes it before every finish and
  repair; a stray one is invisible to the indexer and the viewer.

## Migration Plan

Spec-delta-driven behavior change behind the existing producer branch; no
storage, schema, or config migration. Rollback: revert the spec and the code.
A repo left mid-build with a `.odw-sessions.json` is harmless to the previous
code — a dot-file nothing reads or publishes as a page — and the next completed
run removes the plan and the WIP regardless.
