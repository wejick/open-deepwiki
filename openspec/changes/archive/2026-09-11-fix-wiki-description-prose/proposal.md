## Why

The frontmatter `description` of produced wiki pages is the one field that
serves two readers at once: retrieval matches questions against it before a
page is opened, and humans see it verbatim as the page's one-line summary in
generated directory `index.md` listings, `/wiki` pages, and `ask_repo` results.
Authored guidance says only "write it for search", so the model stuffs the
field with wiki-meta language — a produced overview describes itself as
"Entry point to the mobile app wiki … Start here to find the page for…",
which reads as navigation scaffolding, not a description of the repository.

## What Changes

- The `claude` producer's per-page guidance is amended: a `description` SHALL
  describe the page's subject — the concrete thing the page documents — as
  natural, self-contained prose, and SHALL NOT describe the page's own role in
  the wiki bundle ("entry point to the wiki", "start here", "this wiki") or
  carry navigation meta-text. The existing retrieve-orientation instruction is
  unchanged and stays first.
- The synthesized overview brief (`claudePlan.ts`) is reworded so its role
  framing ("the bundle's entry point: a compact task-routing map") cannot leak
  into the description field; the brief keeps the same job — what the
  repository is, its major domains, which page covers each.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: the **Claude producer page-depth guidance** requirement's
  description instruction is extended with a subject-not-wiki-role constraint
  and a matching scenario. No other requirement changes; the guaranteed
  overview page requirement is untouched (the overview keeps its routing job —
  only how its description is worded is constrained).

## Impact

- `src/producer/skill/skills/okf-wiki/SKILL.md` (description paragraph) and
  `PAGE.md` ("Finishing" checklist wording); `src/producer/claudePlan.ts`
  (overview brief string); prompt-content tests in `claude.test.ts` /
  `claudePlan.test.ts`.
- Already-published bundles are unaffected until their next update run; the
  overview re-words on its next wiki update. Retrieval is unaffected —
  descriptions keep naming their concrete subjects and terms.

## Non-goals

- No acceptance check, floor, or validator on description wording — this is
  authoring guidance, not a gate; a bad description degrades retrieval quality,
  it does not make a bundle invalid.
- No change to which frontmatter fields are indexed, to the `description`
  semantics in the index or MCP tools, or to the guaranteed-overview-page
  mechanics (ordering, update identity, deletion refusal).
- No retroactive rewrite of existing bundles.
