## ADDED Requirements

### Requirement: Init plan page budget

An init plan — the plan produced by the single-session planner below the split
threshold, and the plan merged from area parts above it — SHALL NOT name more
pages than the checkout's page budget: `max(12, ceil(N / 100))` pages for N
documentable files, a fixed ratio rather than an absolute count, so the budget
scales from small checkouts to monorepos. The page-production entry the init
planner derives from the pages that actually shipped is not part of the plan
and is not counted. Planning guidance for init SHALL carry the same ratio as a
target and SHALL name the anti-pattern the budget exists for — planning one
page per screen, dialog, or directory leaf when those share a subject — so
sessions self-limit before validation; the guidance SHALL NOT instruct merging
pages that document distinct subjects.

When the merged plan exceeds the budget, the producer SHALL first reduce it by
deterministic repair, before the plan is validated: an entry group whose
members share `type` and whose source paths share a common parent directory
SHALL merge into one entry — the earliest in map order surviving, titled after
the common parent, its source paths and related pages the union of the group's
— and the pass SHALL repeat until the plan is within budget or no eligible
group remains. Repair SHALL never merge entries that differ in `type`, entries
owned by different map areas, or entries whose only similarity is a shared
cross-cutting stem (those folds already happened and their rules stand). A plan
still over budget after repair SHALL fail the run with a note naming the
budget, the post-repair page count, and the areas that could not merge — the
same outcome as an unparseable plan, recorded by the ordinary run-outcome path.

`bun run eval` SHALL report the evaluated bundle's plan granularity — planned
pages per documentable file — alongside its existing scores. The report is a
measurement surface: bundle acceptance SHALL NOT gate on plan granularity, and
no acceptance floor is added by this change.

#### Scenario: Budget scales with the checkout

- **WHEN** an init plan is produced for a checkout with N documentable files
- **THEN** the plan names at most max(12, ceil(N/100)) pages — e.g. 12 for
  N ≤ 1200, 140 for 14,000 — whatever the planning shape (single session or
  merged parts)

#### Scenario: Guidance carries the ratio and the anti-pattern

- **WHEN** the init planner's or an area session's prompt is generated
- **THEN** it directs the session to size the plan near one page per hundred
  documentable files in scope, and instructs against one-page-per-screen,
  -dialog, or -leaf planning where those pages share a subject

#### Scenario: Over-budget plan merges at the seams, deterministically

- **WHEN** the merged init plan names more pages than the budget
- **THEN** entries sharing `type` and a common source-path parent merge into
  one entry — earliest in map order surviving, titled after the common parent,
  source paths and related pages unioned — repeating until within budget or no
  eligible group remains, and the same plan input always yields the same merged
  plan

#### Scenario: Repair never crosses the seams

- **WHEN** the repair pass runs on an over-budget plan
- **THEN** entries of different `type`, entries from different map areas, and
  entries differing only by a cross-cutting subject stem are never merged, so
  the fold rules of checkpointed planning are not re-applied or weakened

#### Scenario: An irreducible plan fails the run with its numbers

- **WHEN** a plan remains over budget after no eligible group is left to merge
- **THEN** the run fails with a note naming the budget, the post-repair page
  count, and the areas that could not merge, and the ordinary plan-validation
  failure path handles it (no bundle written, last good bundle untouched)

#### Scenario: Eval reports plan granularity without gating

- **WHEN** `bun run eval` runs against a bundle
- **THEN** it reports planned pages per documentable file with its scores, and
  bundle acceptance passes or fails independently of that number
