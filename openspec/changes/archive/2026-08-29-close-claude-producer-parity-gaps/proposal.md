## Why

The `claude` producer's authoring skill was checked against how the real `openwiki` CLI produces OKF bundles — measured directly against openwiki's own self-hosted bundle, not assumption. Two classes of gap turned up: things openwiki guarantees deterministically that `claude -p` currently leaves entirely to model judgment (a synced index, valid Mermaid, resolvable cross-links), and authoring conventions openwiki's output consistently carries that the skill never asks for (a closing related-pages section, first-mention bold terms, `tags`, quoted Mermaid labels, line-precise citations — openwiki's real bundle cites 245/245 `sources[]` entries as `repo://path#Lstart-Lend`). Closing these narrows the gap between "the skill describes OKF v0.2" and "the skill produces what openwiki actually produces."

## What Changes

- Add a deterministic finalize pass inside `runClaude`, after the agent writes and before the run reports its outcome — mirroring openwiki's own internal finalizer, which runs before anything downstream ever sees its bundle:
  - Regenerate every directory `index.md` from the concept pages actually on disk (title/description from frontmatter), replacing trust in the model to keep it current.
  - Validate every Mermaid fence with the real `mermaid` parser (via a `jsdom` DOM shim, the same mechanism openwiki itself uses) and degrade an invalid fence to a text fence plus a comment, so a broken diagram never reaches the renderer.
- Add a link-resolution score to `acceptance.ts`, applied identically to both producers, reusing the indexer's own `resolveLink` rather than a second implementation; gated by a configurable floor that ships at 0 (measured, not enforced), mirroring the existing grounding/coverage/churn floors.
- Extend the `claude` producer's authoring skill (`SKILL.md`) with: a closing related-pages section per page, bold-on-first-mention for defined terms, a `tags` frontmatter field, quoted Mermaid node labels, a preference for line-range (`#Lstart-Lend`) citations over whole-file ones, and plain, direct prose (no contrastive redefinitions like "it's not X, it's Y," no hedging filler) in page bodies.
- Tighten `grounding.ts`'s citation check: when a `sources[].resource` carries a `#Lstart-Lend` fragment, validate the range against the cited file's actual line count, not just the file's existence.

## Capabilities

### Modified Capabilities
- `okf-producer`: adds a producer-side finalization requirement for the `claude` producer (index sync, Mermaid validation/degrade), adds a producer-blind link-resolution scoring requirement, extends the authoring-guidance requirements with the style conventions above, and tightens bundle grounding verification to validate cited line ranges.

## Non-goals

- No `.claims/`-style evidence store, no claim reconciliation, no `generated`/`verified` provenance stamping — no consumer reads any of it today (SKILL.md: only `type`/`title`/`description`/body reach the index), and it's the heaviest part of openwiki's architecture.
- No pre-run frontmatter migration/normalization — the existing repair-retry mechanism already covers a malformed bundle.
- No change to the `openwiki` producer — it already finalizes its own bundle internally; nothing here touches its code path.
- No persisted trend or CLI/dashboard visibility for the new link score — unlike `grounding.score`, which `pipeline.ts` copies into `RunState` for `health.ts`/`cli/main.ts` to surface, `linkScore` exists only inside the `AcceptanceResult` a single `acceptBundle` call returns. Giving it the same persisted-trend treatment is a real, separable follow-up, not required by this change's stated scope (compute the score, gate it identically to grounding).

## Impact

- `src/producer/claude.ts`: new finalize step wired into `runClaude`.
- New: `src/producer/finalize.ts` (or similar) for index sync and Mermaid validate/degrade — plus tests.
- `src/producer/acceptance.ts`: new link-resolution scoring, reusing `resolveLink`/`joinBundlePath` from `src/index/ingest.ts`; `src/config/config.ts`: new `ODW_LINK_MIN` floor.
- New dependencies: `mermaid`, `jsdom` (Mermaid diagram parsing for the finalize pass; pure JS, no native bindings).
- `src/producer/skill/skills/okf-wiki/SKILL.md`: authoring guidance additions.
- `src/producer/grounding.ts`: line-range validation on cited fragments.
- `openspec/specs/okf-producer/spec.md`: new/extended requirements via delta spec.
