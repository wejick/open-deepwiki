## Why

Split planning (repos above the init split threshold) lets every area session
invent its own copy of the same cross-cutting pages. A measured run
(measured on a ~380-page plan) carries ~56 per-area boilerplate entries —
`state-management`, `constants`, `utilities`, `navigation`, `analytics` repeated
once per product area — plus several exact-title duplicates
("state management" ×3, "feature flags and experiments" ×2, one area's
`feature-x/*` vs another's `x-feature/*`). Every duplicated entry costs one
full page session, and the
resulting near-identical pages dilute retrieval. The waste scales exactly where
sessions are most expensive: the repos large enough to split.

## What Changes

- Area-session directives list the page titles other areas have already
  planned (the area loop is sequential, so earlier parts are on disk), and
  instruct each session to plan only pages specific to its own paths — no page
  mirroring a cross-cutting subject (state management, constants, utilities,
  navigation, analytics/logging, error handling) for its slice.
- The map guidance keeps overlap as an exploration scope, directs the mapper to
  record each area's cross-cutting ownership in its `scope`, and assigns each
  cross-cutting subject to the one area hosting that code.
- The part merge collapses plan entries naming the same cross-cutting subject —
  a mechanical backstop measured on a copy of the live plan:
  383 → 364 pages. Two triggers: titles differing only in case or whitespace,
  and filenames sharing a normalized stem naming a cross-cutting subject (state
  management, constants/configuration, utilities/helpers, navigation/routing,
  analytics/logging, error handling) — the first entry in map order survives,
  later duplicates fold their source paths and related pages into it, so no
  source attribution or navigation intent is lost. Stems outside that list
  never fold, so per-stream `overview.md` and API pages survive.
- The eval command additionally reports plan-quality metrics (planned page
  count, titles folded, boilerplate-stem hits) — reported only, never gating.
- No change to single-session planning (one session sees the whole repository
  and does not exhibit the failure), to page generation, or to acceptance.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: the "Checkpointed planning for large initial bundles"
  requirement gains the merge-time title-collision fold; the "Claude producer
  map ownership guidance" requirement is amended so overlap governs exploration
  scopes, not page subjects, and its guidance extends to the area sessions.

## Impact

- `src/producer/claudePlan.ts` (`mergeParts`), `src/producer/claude.ts`
  (`areaDirectives`), `src/producer/skill/skills/okf-wiki/MAP.md`, the eval
  command's report.
- Tests: `claudePlan.test.ts` (merge fold), `claude.test.ts` (directive text).
- No config knobs, no schema or acceptance changes; bundles remain OKF v0.2.

## Non-goals

- No post-merge model-driven consolidation session (the heavier fix, held until
  the guidance plus mechanical fold are measured on a real split run).
- No change to single-session plans, update-run plans, or the plan validator's
  existing path/reserved-name rules.
