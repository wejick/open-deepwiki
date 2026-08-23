# Design: add-claude-step-models

## Context

See proposal.md — Why. `session()` already threads an optional model (the map knob); `runSession` builds argv with `--model`/`--effort` from `cfg.claude`. The five call sites are map, area, unsplit planner, page loop, repair.

## Goals / Non-goals

- Goals: six knobs (map/plan/page × model/effort), unset = run-wide value, byte-identical spawns when unset.
- Non-goals: no per-step timeouts, no code defaults, no acceptance change.

## Decisions

1. **Knob shape: empty-string default, `""` → `undefined` at load** — the established pattern (`ODW_CLAUDE_MAP_MODEL`, `ODW_CLAUDE_CONFIG_DIR`). Step efforts accept the closed effort set or empty.
   *Alternatives considered:* `.optional()` without default (doubles the unset-check at every reader).

2. **One `stepOverrides(step)` lookup consumed by the five call sites.** `session(file, prompt, overrides?)` where overrides is `{model?, effort?}`; map passes `("map")`, planner and area pass `("plan")`, page and repair pass `("page")` — repair edits pages, so it inherits the page pair.
   *Alternatives considered:* separate params for model and effort (call sites read as loose positional flags); overriding inside `runSession` keyed on prompt identity (couples the spawn layer to phase knowledge).
   The map-model sentence leaves the checkpointed-planning requirement and the generalized rule lives in the invocation requirement — per-step spawning is an invocation concern, and page/repair sessions are not planning.

3. **Shim records `<kind> <model> <effort>` per session** so one split run asserts all three steps' pairs at once through the real spawn path.
   *Alternatives considered:* separate tests per step (same fixture rebuilt three times for no extra coverage).

## Risks / Trade-offs

- [Six knobs to misconfigure] → every one is per-step and inert when unset; a typo'd model name fails fast at spawn and lands in the run error via the existing session report.
- [Area sessions silently differing from the planner] → impossible by construction: both call sites pass `("plan")`.

## Migration Plan

Additive; unset by default. Rollback = unset the variables.

## Open Questions

None.
