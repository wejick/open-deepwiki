# This session: plan the bundle

You are **planning**, not writing. Produce no page in this session. Your only
output is one JSON plan naming every page the bundle should contain; a separate
session then writes each page from your brief for it, and sees nothing you
learned except what you put in that brief.

Design the **smallest complete** information architecture for this specific
repository — the one that lets a coding agent understand the system and change
it safely. Page paths are final once you submit them.

## Structure is given when this session names a handout

When this session's instructions point at a structure handout — a file listing
the repository's (or your area's) documentable files with per-directory counts,
sizes, and its largest files named — that handout is authoritative for what
exists. Do not re-derive it: never enumerate the tree yourself. Read files only
where the handout cannot answer — to understand what a directory _is_, to ground
a page's scope or brief, or to trace a flow. When no handout is named, discover
the structure as you explore.

## Explore before you plan, in three passes

Do not plan from directory names, and do not stop at one representative file.
Work through all three passes; each corrects the picture the previous one left.

1. **Map the surface.** Read the manifests, the major directories, the entry
   points, the public surfaces, the configuration, and the run or deploy
   scripts. This tells you what the repository _is_ and what it exposes.
2. **Trace representative end-to-end flow.** Follow control and data through the
   flows that carry the repository's real work, from entry to effect: callers
   and callees, where state is held and persisted, how failures are handled,
   what configuration steers the path, and which external systems it integrates
   with. One traced flow teaches you more than ten skimmed files.
3. **Verify boundaries and invariants.** Read the focused tests and the
   neighbouring implementations around each boundary you found. Tests state the
   invariants the code is expected to hold; neighbours show where a
   responsibility actually ends. Correct pass 2's picture with what you find.

Explore only until the major systems, behaviours, and relationships are
supported by evidence you have actually read. An exhaustive file-by-file
inventory is not the goal and is not worth the budget.

## Organize around systems, not the source tree

**Organize around owned systems, runtime domains, and cross-system workflows
rather than mirroring the source tree.** A page per directory reproduces a
layout the reader can already see; a page per system explains something they
cannot. One page per coherent unit — a subsystem, a domain, a workflow — never
one page per file, and never a flat dump of unrelated top-level pages.

When the plan covers a whole repository — an init, or an update that
genuinely reshapes the bundle — size it near one page per hundred
documentable files. Do not plan one page per screen, dialog, or directory
leaf when those pages would share a subject: cover them as sections of
the page that documents that subject, so the reader gets one entry point
per subject instead of one file per node.

Use hierarchical paths for the groups the repository actually earns:

- `architecture/` — how the parts fit together, and why
- `concepts/` — the domain nouns and invariants the code is built around
- `workflows/` — a cross-system path from trigger to effect
- `operations/` — running it: configuration, failure modes, recovery
- `integrations/` — the external systems it talks to
- `testing/` — how correctness is established and pinned

Do not invent a page to fill a section, and do not target a page count in either
direction. Equally, do not omit an important domain, an independent component,
or a relationship for the sake of brevity.

An init plan must cover every significant source directory: a well-formed bundle
describing only a corner of the repository is rejected. On an update, plan only
the pages the change set actually affects, plus any page it genuinely adds; a
run rewriting far more of the bundle than the code changed is rejected. **An
update that needs no page edit and no deletion may submit `"pages": []`.**

## The brief is what a page's session gets

Each page's session sees your `brief`, your `sourcePaths`, and your
`relatedPages` — nothing else you learned. A thin brief makes that session
re-explore the whole repository from scratch, so spend your effort here:

- **`brief`** — what this page must establish, in your words. Name the specific
  mechanisms, invariants and failure modes you found that belong on it, and say
  what belongs on a _different_ page so two pages do not converge.
- **`sourcePaths`** — the files you actually read that support the page, most
  load-bearing first. These are starting points, not research boundaries.
- **`relatedPages`** — the conceptual and workflow neighbours most useful from
  this page, so the finished wiki is navigable across system boundaries. You are
  the only participant who sees the whole tree; the page's own session cannot
  work these out.

## Write the plan

Write your plan as JSON to the absolute path given as `PLAN_FILE` in this
session's instructions, using the `Write` tool. The path is inside the bundle,
so the usual write scope is unchanged, and it is the only channel the run
reads your plan from — a session that does not write it has produced no plan.

```json
{
  "pages": [
    {
      "path": "architecture/producer-pipeline.md",
      "type": "architecture",
      "title": "Producer pipeline",
      "brief": "How a checkout becomes a bundle: the run wrapper's accept-or-restore decision, the one repair retry, and why acceptance never trusts the producer's own outcome. Leave the plan-file checkpoint mechanics to workflows/resumable-production.md.",
      "sourcePaths": ["src/producer/run.ts", "src/producer/acceptance.ts"],
      "relatedPages": ["workflows/resumable-production.md", "concepts/bundle-acceptance.md"]
    }
  ],
  "deletePages": []
}
```

- `path` is bundle-relative and ends in `.md`. `index.md` and `log.md` are
  reserved at any depth and are rejected.
- `type` names the page's kind, from the bundle's closed set, singular:
  `architecture`, `concepts`, `workflow`, `component`, `operations`,
  `reference`. Never pluralize (`components`, `workflows`), never invent a
  kind. The page's session copies this value into its frontmatter verbatim, so
  two spellings of one kind are two kinds forever.
- `deletePages` is for update runs only: pages the change set justifies
  removing, such as a page whose source file was deleted. An init plan that
  names any is rejected.
- `overview.md` is added for you and always written last, from the pages that
  actually shipped. You do not need to plan it, and it cannot be deleted.

A plan that is unparseable, names a reserved file, or — on init — contains no
pages fails the run before anything is written.
