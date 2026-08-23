## Why

The `claude` producer's map session is asked to partition **every** tracked file
into **exactly one** area. Two measured failures on a 16k-file repo
trace straight back to that contract: the map became a directory mirror with
~40% layer-stub areas (constants re-export modules, asset-index helpers …), and
it claimed all ~16k files covered while whole feature subtrees (15% and 8% of
the repo) had no owner. A
wiki explains code people look for; inert assets, string catalogs and lockfiles
are not code, and shared components legitimately belong to more than one context.

## What Changes

- The map contract drops exclusivity and full-file coverage: **areas may
  overlap** (a shared component is documented from each context that uses it)
  and a file need not belong to any area. Prompt change to the map phase.
- The mapper's digest **excludes non-documentable files** (media/binary by
  extension, lockfiles by name, string/localization catalogs, generated dirs,
  lottie animations) instead of listing every tracked file. Engine change.
- Area sizing (`min(5% of N, 100)`, expected count, split threshold) is
  computed from the **documentable** count so budget, digest and validation all
  agree on the set the map must actually own.
- `MAP.md` and `mapDirectives` wording updates: the map covers what the digest
  lists; omitted kinds get no area and no owner is needed.

## Capabilities

### New Capabilities

- `okf-producer`: no new capability — see modified.

### Modified Capabilities

- `okf-producer`: two requirement deltas —
  1. *Checkpointed planning for large initial bundles*: the digest and the
     area-sizing count operate on the checkout's **documentable** files
     (non-documentable kinds excluded); new scenarios pin the exclusions.
  2. New requirement *Claude producer map ownership guidance*: `MAP.md`
     instructs overlapping areas, no coverage of inert files, no
     directory-stub / asset areas, and a budget check against the digest
     before writing.

## Non-goals

- No deterministic **engine reach-check** ("every code group covered at least
  once") — reach stays model-side guidance; the check is a later change.
- No per-repo or `instructions`-driven denylist customization — the exclusion
  kinds are one fixed, shared rule.
- No change to the `openwiki` producer, the planner/area phase, or the page
  phase guidance.
- No change to area-file-budget / expected-count formulas — only their input N.

## Impact

- Code: `src/producer/claudeDigest.ts` (filter + digest), `src/producer/claude.ts`
  (planning branch uses the filtered list; `mapDirectives` wording),
  `src/producer/skill/skills/okf-wiki/MAP.md` (contract wording).
- Tests: `claudeDigest.test.ts`, `claude.test.ts`, `claudePlan.test.ts`.
- Spec: `openspec/specs/okf-producer/spec.md`.
