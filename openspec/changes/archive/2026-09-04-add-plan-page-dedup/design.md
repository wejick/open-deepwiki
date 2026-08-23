## Context

Split planning (`claude.ts` split branch) runs one area session per map area;
each session plans independently, seeing only `areaDirectives` — its own area
plus the *paths* other areas own. `mergeParts` (claudePlan.ts:582) concatenates
part pages in map order with no subject-level view, so two areas can both plan
"State Management" under different paths and both pages get produced. The map
guidance (`MAP.md` "Areas are scopes, not a partition") actively encourages
overlap "so a shared component or a cross-cutting concern is documented from
each context that uses it" — the sentence the measured 56 boilerplate pages
obeyed. Path uniqueness is enforced at part validation (`claudePlan.ts:574`);
title collisions are not looked at anywhere.

## Goals / Non-Goals

**Goals:**
- A merged split plan names each cross-cutting subject once, mechanically.
- Area sessions are told, in their directives, not to plan cross-cutting mirrors
  — and are shown the titles other areas already planned, so the rule is
  checkable against facts.
- Determinism: same parts in, same merged plan out.
- Plan bloat becomes measurable, so the deferred consolidation session is
  decided by data.

**Non-Goals:**
- Semantic (near-duplicate) detection — no embeddings, no model call at merge.
- The post-merge consolidation session (held until this is measured; see
  proposal Non-goals).
- Single-session plans: one planner sees the whole tree and did not exhibit
  the failure; `normalizePlan` stays path-scoped.

## Decisions

- **Fold at merge, not reject.** A title collision is expected model behavior,
  not a malformed part — the part validator already treats a *path* collision
  inside one part as invalid, but a collision *across* parts is invisible to
  each session by construction. Rejecting the part would re-plan an area for
  behavior no per-area session can avoid; folding is the only outcome that
  keeps planning resumable without retry churn. (Alternative considered:
  reject as invalid — rejected: contradicts "an invalid part is discarded, not
  fatal" economics and blames a session for a cross-area effect.)

- **Fold trigger: title collision or cross-cutting subject stem.** Two rules,
  both measured on a copy of the live 383-page plan:
  titles differing only by case/whitespace fold (4 pairs — precise but 1%);
  filenames sharing a normalized stem that names a cross-cutting subject —
  the same subjects the ownership guidance names (state management, constants
  or configuration, utilities or helpers, navigation or routing, analytics or
  logging, error handling) — fold too (16 more: eight areas each planned a
  `state-management.md`, five planned a `navigation-and-routing.md`). Total
  383 → 364, zero source-path or related-page loss, valid per the repo's own
  plan parser. A stem naming no cross-cutting subject never folds: the naive
  all-stems rule was tested and rejected — it collapsed the 17 per-stream
  `overview.md` pages into one and merged per-stream API-integration pages,
  destroying real content. Semantic matching beyond this stays tier 3.
  (Alternative considered: fuzzy near-duplicate detection — rejected: needs
  judgment at merge time and baseline data that does not exist yet; the eval
  metrics task exists to produce it.)

- **Survivor = first in map order; fold = union source paths and relatedPages.**
  Map order is already the merge's iteration order and the resumed run's stable
  order (`claudePlan.ts:155`). The survivor keeps its path/type/title/brief;
  folded entries contribute `sourcePaths` and `relatedPages` (union, first-seen
  order, deduped) — the page session needs starting points and navigation, not
  both briefs; concatenating briefs would hand the session two pages' worth of
  scope and recreate the bloat one level down.

- **Directives carry the already-planned titles (facts, not exhortation).** The
  area loop is sequential (claude.ts:694), so when session k starts, parts
  1..k−1 are on disk; `areaDirectives` reads them and lists their page titles.
  Guidance alone is weak — a non-compliant session was observed writing prose
  instead of its part file — but a session shown the concrete list has the
  fact, not the rule. This makes the merge fold a backstop rather than the
  primary mechanism. The prompt was already order-dependent (`others`), and a
  resumed run replays the same prior parts, so determinism is unchanged; the
  list's token cost is trivial against a session's budget.

- **The map records cross-cutting ownership in each area's scope.** `MAP.md`
  directs the mapper to name, per area, which cross-cutting subjects that area
  owns; `areaDirectives` already injects the scope verbatim (claude.ts:210), so
  each session receives a concrete per-area fact ("you own state management")
  with zero new plumbing, instead of deriving its duties from a generic rule.

- **Plan-quality metrics in `eval`, reported never gated.** The eval command
  additionally reports planned page count, titles folded at merge, and
  boilerplate-stem hits, so the deferred consolidation session (tier 3) becomes
  a measurement question after the next big init — the same discipline as the
  acceptance floors shipping at 0. Dev tooling, not system behavior: no spec
  requirement is invented for it.

- **Guidance in two places, one rule.** `MAP.md` states the subject-ownership
  rule where it today states the overlap rule (same bullet, so they cannot
  drift apart), and `areaDirectives` repeats it in the one message the area
  session certainly reads. Guidance is not trusted as a guarantee — the merge
  fold is the backstop; the part validator stays as-is.

- **No new config knob.** Nothing here is scenario-tunable; the split threshold
  already gates the whole path.

## Risks / Trade-offs

- [A generic-subject fold merges genuinely distinct angles — concepts vs
  operations takes on `error-handling`, area-scoped navigation surviving as a
  generic stem] → Accepted per the one-page-per-subject default; the surviving
  page session receives every folded area's source paths, so the subject is
  covered from both areas' files. The guidance layers exist precisely to plan
  such subjects deliberately once instead of by fold.
- [Legitimate same-title pages in different domains — e.g. two modules each
  genuinely owning a "Configuration" page] → The fold keeps one page whose
  source paths span both areas; the page session documents the union. A reader
  loses the split, which the measured data says is the right default; guidance
  tells the map to name subjects distinctly when it wants them distinct.
- [A fold lands on an area whose part already validated, changing the plan a
  resumed run would compute] → The merge runs after *all* parts validate, from
  the same dot-files, in the same order; resume recomputes the identical plan.
  No new checkpoint state is introduced.
- [Guidance ignored by a non-compliant session] → Same exposure as every other
  guidance line (the producer already treats session prose as untrusted);
  mitigated twice — the directives carry the already-planned titles as facts,
  and the mechanical fold still bounds the damage to one page per subject.
- [The already-planned list grows with each part — hundreds of titles on a
  383-page plan] → Titles are short strings; the added tokens are noise
  against a session's exploration budget, and only the sessions after the
  first few see a long list at all.

## Migration Plan

No data or format migration: the plan file shape, part files, and map are
unchanged; only merge output and prompt text differ. A WIP left by an older
build merges under the new rule on its next run. Rollback is reverting the
two files; an already-merged plan is untouched by rollback.

## Open Questions

None.
