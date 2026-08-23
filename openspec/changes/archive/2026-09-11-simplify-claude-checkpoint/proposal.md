## Why

`align-claude-producer-with-openwiki` gave the `claude` producer a durable
checkpoint (`<bundle>/.odw-run.json`): a `RunState` schema with per-page
`status`, `mode`, `targetSha`, `schemaVersion`, atomic writes after every page,
and a `resumeFrom` validator. But that state is a second copy of two facts that
already exist: a page's completion is its presence in the bundle with parseable
frontmatter (the orchestrator already decides exactly that via
`pageIsWritten`), and the resume pin already lives in `wip.ts`'s `WipMeta`
(`{targetSha, producer}`, which gates resume vs discard). The checkpoint module
is ~250 lines maintaining a redundant encoding, and the per-page rewrite is I/O
the filesystem already did.

## What Changes

- The plan file **is** the checkpoint. The planning session writes
  `.odw-plan.json` directly into the bundle — a dot-file, invisible to every
  bundle consumer, preserved by the work-in-progress area's wholesale copies
  for free. `RunState`, per-page `status`, `mode`, `schemaVersion`, the
  atomic-write helper, and `resumeFrom` are deleted.
- Before any page session runs, the producer deletes every page the plan names
  from the bundle, then stamps the plan file with the commit being built
  (`appliedAtSha`). A page present after that point was produced by this build,
  so resume is "skip pages that already exist and conform" in both modes. The
  stamp closes the kill-mid-deletion window; a stamped commit that differs from
  the run's target commit replans.
- A failed page session deletes its file instead of restoring a pre-run copy —
  pre-deletion means there is nothing earlier to restore.
- The plan schema validates only what the orchestrator acts on: page paths
  (bundle-relative, no reserved names, no escape) and `deletePages`. `type`,
  `title`, `brief`, `sourcePaths`, `relatedPages` become authoring cargo passed
  to the page session, not validated structure.
- The sandbox tightens: no session writes outside the clone — the "except the
  planner's scratch file" exception disappears.
- A completed or repaired run removes the plan file; a published bundle never
  carries one.

## Capabilities

### Modified Capabilities

- `okf-producer`: replaces the "Durable per-page checkpoint" requirement with a
  plan-file checkpoint requirement; relaxes the page-plan entry contract to
  validated paths plus passthrough cargo; tightens the invocation sandbox by
  dropping the outside-the-clone scratch-file exception.

## Non-goals

- No change to the overview page mechanism (a deterministic, finalizer-generated
  overview is a separate judgment call, deliberately not bundled here).
- No change to `run.ts`, `wip.ts`, acceptance, or the shared producer
  vocabulary — the design adds no code outside `claude.ts`/`claudePlan.ts` and
  the shims.
- No module renames, lint-policy changes, or other cleanup.

## Impact

- `src/producer/claudePlan.ts`: rewritten (~250 → ~90 lines).
- `src/producer/claude.ts`: page loop loses per-page checkpoint writes and
  rollback; gains pre-deletion and the stamp.
- `src/producer/claude.test.ts`, `src/producer/claudePlan.test.ts`: scenario
  tests updated to the new requirement names.
- `AGENTS.md`, `src/producer/CONTRACT.md`: checkpoint description updated.
