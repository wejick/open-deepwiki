# Design: add-claude-map-model

## Context

See proposal.md — Why. Every session currently spawns with `--model cfg.claude.model` inside `runSession`; the `session()` closure is the one funnel. The map call site is unique and identifiable.

## Goals / Non-goals

- Goals: one optional model override consumed by exactly one call site.
- Non-goals: no per-phase matrix, no effort override, no acceptance change.

## Decisions

1. **Knob shape: `ODW_CLAUDE_MAP_MODEL`, empty string default = unset.**
   Mirrors `ODW_CLAUDE_CONFIG_DIR`'s empty-default pattern (config.ts:52): absent from argv entirely when unset, so an unset config is byte-identical to today's spawn.
   *Alternatives considered:* `.optional()` without a default (then every reader must handle `undefined` vs `""` twice); a general per-phase map of models (a knob without a consuming scenario).

2. **`session()` takes the override; only the map call site passes it.**
   `session(systemPromptFile, prompt, model?)` → `runSession` uses `model ?? cfg.claude.model`. The map site passes `cfg.claude.mapModel === "" ? undefined : cfg.claude.mapModel`.
   *Alternatives considered:* a second `mapSession()` closure (duplicates the spawn beat hook); reading the override inside `runSession` keyed on the prompt file path (couples the spawn layer to phase knowledge).

## Risks / Trade-offs

- [A weak map model wastes a step budget on rejections] → bounded by the step timeout; a rejected map replans on the same model, and the operator sees it in the run error ("the map was rejected: …").
- [Model name typos surface only at spawn] → `claude` fails fast on an unknown model and the session report says so; no silent fallback.

## Migration Plan

Additive, unset by default. Rollback = unset the variable.

## Open Questions

None.
