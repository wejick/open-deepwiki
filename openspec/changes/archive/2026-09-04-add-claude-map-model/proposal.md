# Proposal: add-claude-map-model

## Why

The map session is the cheapest thing to run on a smaller model: its output is deterministically validated (area budget, usable paths, half–double count), so a weaker model's failure mode is a rejected map that replans — never a corrupted bundle. On a 16k-file repo the map session is also the one most likely to explore long, and a faster model shortens it. There is today no way to run it on anything but `ODW_CLAUDE_MODEL`.

## What Changes

- New config knob `ODW_CLAUDE_MAP_MODEL` (empty default = unset): when set, only the map session runs on that model; area sessions, the undecomposed planner, page sessions, and repair keep `ODW_CLAUDE_MODEL`.
- The checkpointed-planning requirement gains that sentence and a scenario.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: the checkpointed-planning requirement — the map session may run on a separately configured model.

## Impact

- `src/config/config.ts` (knob), `src/producer/claude.ts` (`session()` gains an optional model; the map call site passes the override), `.env.template`, `AGENTS.md` knob table.
- No effect unless set; unset behavior identical to today.

## Non-goals

- No per-area, per-page, or per-effort model overrides — one knob, one consumer (a knob without a scenario doesn't exist).
- No acceptance change: the map is validated the same way whatever model wrote it.
