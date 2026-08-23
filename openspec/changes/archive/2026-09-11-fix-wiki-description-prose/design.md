## Context

`description` is one of the four fields that reach the retrieval index, and it
is also displayed verbatim to humans: generated directory `index.md` lines
(`- [Title](file) - description`), `/wiki` listings, and `ask_repo` results.
The only authored instruction today is "write it for search"
(`SKILL.md:70-74`), and the overview session's brief is itself written in
wiki-meta vocabulary ("The bundle's entry point: a compact task-routing map…",
`claudePlan.ts:144`), which the session echoes into the field. A produced
overview is the measured result.

## Goals / Non-Goals

**Goals:**

- Descriptions read as natural one-line summaries of their subject while
  staying retrieval-oriented (concrete subject, mechanism, terms a person
  would type).
- The overview page — the worst offender, because its whole job is routing —
  stops describing itself in its `description`.

**Non-Goals:**

- No acceptance check on description wording (see proposal Non-goals).
- No change to the guaranteed-overview-page mechanics: ordering, update
  byte-identity, deletion refusal all stay as specced.

## Decisions

- **Guidance lives in `SKILL.md`'s description paragraph, extended in place.**
  It is the contract every session inherits, so page and overview sessions get
  the constraint from one text. Alternatives: a per-session patch in
  `pageDirectives` (rejected — duplicates the contract and only reaches one
  session shape); a new guidance file (rejected — one more artifact for one
  paragraph).
- **Reword the overview brief in `claudePlan.ts` to content-first language**
  ("what this repository is, its major domains, and which page covers each")
  without "entry point"/"task-routing map". The brief is the strongest local
  signal the overview session sees; fixing SKILL.md alone leaves a meta-
  vocabulary template at the top of its prompt. Alternatives: leave the brief
  and rely on the negative guidance (rejected — asks the model to override its
  own brief); pin a literal description string for the overview (rejected —
  the session should still write from evidence, and the string would be
  wrong for repos whose overview is not a routing page).
- **Phrase the constraint as "describe the page's subject, not its role in the
  wiki"** rather than banning specific words. A word ban ("entry point") would
  also forbid the legitimate body usage (`PAGE.md`'s "Entry points" checklist
  item, node labels like `cli.tsx entrypoint`). Role-vs-subject is the actual
  distinction; it composes with the existing plain-prose guardrail. Reviewed
  in planning: the full good/bad example pair drafted first was cut as too
  much prompt for every session to carry — the shipped form is the two-line
  "displayed verbatim as the page's one-line summary … never the page's own
  role in this wiki ('entry point', 'start here to find')" appended to the
  write-for-search paragraph.

## Risks / Trade-offs

- [Shorter, subject-first descriptions carry fewer stuffed terms, so recall
  on odd phrasings could dip slightly] → The retrieval instruction stays first
  and unchanged; only wiki-meta language is banned, not keywords. Grounding and
  link scores are unaffected, and `bun run eval` can compare a before/after
  bundle if it matters.
- [Existing bundles do not self-heal] → The overview is regenerated only when
  the page set changes (`claudePlan.ts:137`), so an overview keeps its old
  wording through ordinary no-op updates until a page is added, removed, or
  the bundle is re-initialized. Accepted: bundles are artifacts, not config.

## Migration Plan

Prompt-content tests fail until SKILL.md, `claudePlan.ts` and the assertions
move together — there is no runtime state to migrate. Rollback is reverting
the three files.

## Open Questions

(none)
