# Proposal: add-claude-step-models

## Why

The producer's three session kinds have different quality/cost profiles: the map and planning steps are deterministically validated (area budget, plan-entry schema) so a cheap fast model suffices, while page prose is what acceptance cannot check. Only the map step can be re-modelled today; the planner, area sessions, and page sessions are stuck on the global model and effort.

## What Changes

- Per-step overrides for model **and** effort on each of the three steps: `ODW_CLAUDE_MAP_MODEL`/`ODW_CLAUDE_MAP_EFFORT` (map session), `ODW_CLAUDE_PLAN_MODEL`/`ODW_CLAUDE_PLAN_EFFORT` (undecomposed planner + every area session), `ODW_CLAUDE_PAGE_MODEL`/`ODW_CLAUDE_PAGE_EFFORT` (page sessions including the overview, and repair). Unset = the run-wide `ODW_CLAUDE_MODEL`/`ODW_CLAUDE_EFFORT`; unset spawns stay byte-identical to today.
- Code defaults stay empty — deployment values live in `.env`.
- The map-model sentence moves out of the checkpointed-planning requirement into the invocation requirement, generalized to all three steps.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: "Non-interactive Claude Code producer invocation" gains the per-step model/effort rule + scenario; "Checkpointed planning for large initial bundles" loses its map-specific model sentence and scenario (subsumed).

## Impact

- `src/config/config.ts` (5 new knobs + effort union), `src/producer/claude.ts` (`session()` takes a step-override pair; call sites pass map/plan/page), `.env.template`, `AGENTS.md` knob table.

## Non-goals

- No per-step timeouts (step timeout already bounds any session kind).
- No code-level default values — the operator's `.env` carries them.
