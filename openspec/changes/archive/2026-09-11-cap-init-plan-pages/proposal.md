## Why

Init planning on a measured ~13.7k-documentable-file repo produced a ~380-page
plan — roughly a quarter of them one-per-screen pages, the tree-mirroring the
planning guidance already forbids. Nothing bounds page count: the area budget
caps files per area, but a planner over-splitting subjects pays nothing. The
cost lands downstream as ~12.8 hours of page sessions per init (~380 × ~2 min),
and upstream in planning itself, where each area session streams its part at a
fixed composition rate (~2.5–3.4 s per planned page — the dominant share of a
71–122 s session). The same repo planned to a ~1-page-per-100-files ratio needs
~130 pages: init time drops proportionally, and retrieval quality does not move
with page granularity because recall is chunk-level (ask_repo matches chunks and
returns citations; code questions fall through to ripgrep search).

## What Changes

- A **page budget on init plans**: the merged init plan (and the single-session
  plan below the split threshold) may name at most `max(12, ceil(N/100))`
  pages, N = documentable files. Planning guidance carries the same ratio and
  names the anti-pattern (one page per screen) so sessions self-limit.
- **Deterministic budget repair at merge**: an over-budget merged plan is first
  reduced by rule — entries sharing `type` and a common `sourcePaths` parent
  merge into one entry that unions source paths and related pages, earliest in
  map order surviving, never across areas or differing types. Only a plan still
  over budget after seam-merges fails the run.
- **Eval reports plan granularity**: `bun run eval` reports pages per
  documentable file for the evaluated bundle's plan, measured — the gate ships
  at the budget itself on plans, not as a bundle-acceptance floor.

## Capabilities

## Modified Capabilities

- `okf-producer` — new requirement: init plan page budget (budget formula,
  guidance, deterministic repair, failure when irreducible, eval reporting).
  No existing requirement is modified; the budget composes with checkpointed
  planning and the ordinary plan requirements.

## Impact

- `src/producer/claudePlan.ts` — budget constant + formula, merge-time repair
  pass, validation hook.
- `src/producer/claude.ts` — planning guidance (planner + area directives and
  `PLANNER.md`/skill files) carries the ratio and anti-pattern.
- `src/eval` (eval command) — report pages-per-documentable-file.
- Tests: budget formula clamps, seam-merge determinism, irreducible-plan
  failure, guidance presence, eval report line.
- No admin API, MCP, dashboard, or index changes. No new config knobs (the
  ratio is a constant, per the no-knob-without-scenario rule).
