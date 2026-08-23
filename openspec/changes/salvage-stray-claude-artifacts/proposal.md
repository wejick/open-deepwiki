## Why

A `claude -p` session is told the absolute path of the dot-file it must write
(`PART_FILE`, `MAP_FILE`, `PLAN_FILE`, all inside the bundle), but sessions
occasionally write it to the checkout root instead — the one other place the
session's `Write` tool reaches, since its cwd is the checkout. The orchestrator
reads planning artifacts only from the bundle, so the artifact is neither
present (read where expected) nor classifiable as invalid: the unit is silently
lost. On a large repository this stranded two of the run's area
parts in one night, turning a resume into a zero-progress run — a slot and real
`claude` spend with nothing produced, advancing toward resume-attempt
exhaustion even though the plans were valid, complete, and sitting on disk.

## What Changes

- After a map, area, or planning session ends with its expected artifact
  absent from the bundle, the producer probes the checkout root for a file of
  exactly that artifact's name and, if found, moves it into the bundle before
  deciding the unit's state. The same probe runs where the orchestrator would
  otherwise treat an artifact as absent across runs (a resumed area loop), so a
  misdirected-but-valid part left by an earlier run is recovered without
  re-spending a session.
- Adoption never overwrites: it fires only when the bundle location is empty,
  and the moved file then passes through the existing read-and-validate paths —
  a stray that does not parse or validates against the wrong commit is handled
  exactly as an invalid artifact already is (deleted, unit not done).
- An adopted artifact counts as the unit completed, so a misdirected write no
  longer makes a partial run zero-progress.
- Scope is the dot-file planning artifacts (map, plan, per-area parts) only.
  Misdirected *page* bodies are not adopted: page paths are repo-relative
  names that can collide with real checkout content, and no observed failure
  has stranded one.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `okf-producer`: the Claude producer's checkpointed split planning must
  recover a planning artifact a session wrote next to the checkout instead of
  inside the bundle, keeping "present and valid means done" true for that
  session.

## Non-goals

- No change to resume-attempt semantics for genuinely lost sessions: a session
  that claims success having written nothing still advances the counter, as
  today.
- No recovery of misdirected page markdown bodies (see scope above).
- No sweeping cleanup of stale strays beyond the artifact being adopted.
- No prompt or path-format changes; the absolute-path directive stays.

## Impact

- `src/producer/claudePlan.ts`: shared artifact helpers and one adoption
  primitive (probe the checkout root for an exact expected file name, move it
  into the bundle).
- `src/producer/claudeSplit.ts` (`planSplit`): map absence probe and the area
  loop's absent-part probe.
- `src/producer/claudeRun.ts` (`ensurePlan`): post-session probe for a
  misdirected plan file.
- Tests (`claude.test.ts` / split-planning tests): a shim variant whose area
  session writes its part to the session cwd instead of `PART_FILE`, asserting
  the run adopts it, the area counts, and the run is not zero-progress.
