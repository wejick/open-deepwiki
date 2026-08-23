## Context

See `proposal.md` — Why. The measured waste is planning sessions rediscovering
the tree: the map session globs despite a digest; each area session (~39 on a
~13.7k-file init) rebuilds its own subtree with Globs, then probe-reads to learn
which files exist and which speak for a directory. Today the digest
(`claudeDigest.ts:repoDigest`) is one flat line per directory — count and byte
total only, no file names, no nesting — and it reaches the map session alone.
Area sessions get directory names + the mapper's prose; the undecomposed init
planner gets nothing. Tool policy is one shared allowlist
(`claude.ts:ALLOWED_TOOLS = Read,Grep,Glob,Write,Edit`) applied to every session
kind. Session kinds and their directives are all in `claude.ts`
(`plannerDirectives` / `mapDirectives` / `areaDirectives` / `pageDirectives`).

## Goals / Non-Goals

**Goals:**
- One deterministic git-derived structure handout, built once per init run, that
  every planning session reads from — no model turn spent enumerating.
- No `Glob` on init planning sessions; enforcement by allowlist, not prose.
- Keep the handout bounded (a per-directory cap on named files), so the added
  prompt context is bounded and predictable.
- Keep plan/map/part artifact shapes byte-identical, so resume semantics and the
  checkpoint machinery are untouched.

**Non-Goals:**
- Update planning (change-scoped, keeps `Glob`, gets no handout).
- Page-session tools or page-production behavior.
- Changing the number of planning sessions, budgets, or thresholds.
- Making the tree the information architecture (see proposal Non-goals).

## Decisions

**1. The digest gains a file-name listing; a slice helper renders sub-scopes.**
`repoDigest` output per directory becomes `count files / bytes` plus its largest
files first, bounded by a constant (`DIGEST_MAX_FILES_PER_DIR = 10`), with a
`… and M more files` marker when truncated. Names come from the same
`git ls-files` pass; sizes come from the `stat` pass already done per file.
A structured form (directory → ordered files) is kept in memory and rendered on
demand, so the whole-tree text (map, undecomposed init planner) and an
area-scoped slice share one renderer. Alternative considered: a nested tree with
indentation. Rejected — it is a bigger format change with no measured benefit
over flat directory lines, which the model already reads hierarchically by path.

**2. The handout is written to a file and referenced by path, never inlined.**
Mirrors how the map already receives `digest.txt` (`claude.ts:641`). The
undecomposed init planner gets the whole handout as `digest.txt`; each area
session gets `<promptDir>/digest-<areaId>.txt`, rendered from the structured
form filtered to the directories under the area's owned `paths` (owned files
rendered when a path names a file). Per-area files keep prompts small and
diffable, and match how the test shims already read paths out of directives.
The structured digest is built once per init run regardless of whether a map
session runs, because a resumed run can reach the area loop with the map already
present (map path currently skips building the digest).

**3. Guidance changes live in the phase files as a conditional; the handout
arrival is the trigger.** `PLANNER.md` gains a block: when the session's
instructions reference a structure handout, that handout is authoritative for
what exists, reads are for understanding, grounding, and tracing (the existing
three passes stay as the *reading* strategy), and pages still organize around
systems, never the tree. The update planner sees no handout reference, so the
same file still guides it unchanged. `MAP.md`'s existing "digest is complete, do
not re-derive" stance strengthens to "names are given — read only to learn what
a directory is." Alternative considered: mode-specific guidance in directives.
Rejected — authoring guidance is versioned in the skill files by design.

**4. Tool allowlist becomes a function of session kind + mode.** One small
switch replaces the single `ALLOWED_TOOLS` constant at the spawn site
(`runSession` gains an `allowedTools` argument): map and area and init planner →
`Read,Grep,Write`; update planner, page, overview and repair sessions →
unchanged full set. Rationale for dropping `Edit` on planning sessions: they
only write their dot-file artifact; `Write` suffices and narrows the surface.
`Glob` is absent for init planning regardless of what the model attempts — the
argv allowlist is the enforcement the measured map session proved prose cannot
be.

**5. No new config.** The per-directory name cap is a constant. If measurement
shows the handout too big or too thin, the constant moves first; a knob needs a
scenario that consumes it (guardrail) and none exists yet.

## Risks / Trade-offs

- **Handout adds prompt context up front.** Bound by `DIGEST_MAX_FILES_PER_DIR`
  and the existing directory cap (400); the trade is a few thousand tokens of
  context against dozens of dropped round-trips. Mitigate by measuring: the
  before-numbers for this change are on record (map: 11 Globs; area sessions
  together: hundreds of Globs and Reads, dozens of Greps), and the suite asserts allowlists, so a regression
  to enumeration fails tests.
- **Removing `Glob` could strand a legitimate cross-area discovery need.** Read
  (by path, including other areas' named paths) and Grep (content search) remain;
  the area directive still lists other areas and their paths. A part that
  under-plans a subdirectory is no worse than today — nothing catches that either
  way; the map's reach validation is the backstop and is unchanged.
- **Overlapping areas duplicate slice content.** Overlap is bounded and by design
  (shared code documented from each context); slices are per-directory text, so
  the duplication is proportional to real overlap.
- **Prompt-only behavior change, so an in-flight WIP is safe.** Plan/map/part
  JSON shapes are untouched, so resuming a half-planned init under the new code
  is exactly like resuming under the old; rollback is reverting the prompts and
  allowlist, with nothing on disk to migrate.

## Migration Plan

None: no persisted state, config, or data changes. Ship the digest/directive/
allowlist change; the next init run of each repo picks it up. An update run or a
resumed init is unaffected mid-flight.

## Open Questions

None that would change the specs or approach. The name-cap constant
(`DIGEST_MAX_FILES_PER_DIR`) and whether the whole-tree handout should also cap
directories lower for the undecomposed planner are tuning values to be settled by
the before/after measurement, not by the contract.
