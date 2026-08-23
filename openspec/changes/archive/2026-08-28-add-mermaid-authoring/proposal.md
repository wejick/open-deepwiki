## Why

A wiki viewer is being built to render OKF bundle pages for humans, and Mermaid
diagrams are part of that surface. Today only the `openwiki` producer emits
Mermaid diagrams; the `claude` producer's skill never instructs the model to
author one, so every bundle it writes is diagram-free. That gap was previously
accepted because the only consumer was a recall-only text index — a viewer
changes that.

## What Changes

- Add a "Diagrams" section to the `claude` producer's authoring skill
  ([SKILL.md](../../../src/producer/skill/skills/okf-wiki/SKILL.md)) instructing
  when to embed a Mermaid fence and which diagram form to use, matching the
  pattern observed in openwiki's own real output: `flowchart TD` for component
  relationships and branching decisions, `sequenceDiagram` for interactions
  over time, one caption sentence following every diagram, and no diagram on
  pages that are pure reference or already a single linear path.
- No validation, extraction, or degradation pipeline for Mermaid syntax.
  Acceptance (`verify.ts`/`grounding.ts`) stays exactly as-is: it does not
  parse fence content today for either producer, and this change does not
  give it a reason to start.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: the `claude` producer's authoring skill now instructs
  Mermaid diagram usage, matching where/when `openwiki` uses diagrams in its
  own real output.

## Impact

- Code: `src/producer/skill/skills/okf-wiki/SKILL.md` (prose only — one new
  section).
- Tests: `src/producer/claude.test.ts` — assert the injected authoring prompt
  (`authoringPrompt()`) contains the new diagram guidance.
- No change to `verify.ts`, `grounding.ts`, `adapter.ts`, or any producer
  selection/acceptance code.

## Non-Goals

- No Mermaid syntax validation, extraction, or degradation for either
  producer — openwiki's own equivalent pipeline lives entirely inside its
  opaque external binary and is out of reach; building an equivalent for
  `claude`'s output is a separate change once the viewer needs it.
- No changes to the wiki viewer itself, or to how any consumer (index,
  mcp-server, dashboard) reads a page's body.
- No enforcement that a page's diagram, once written, is syntactically valid
  Mermaid — this change is prompt guidance only, not a gate.
