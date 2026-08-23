## ADDED Requirements

### Requirement: Update flow derives the run mode from published state
The update flow SHALL determine a run's mode from the checkout's published-bundle
state, not from the command the run arrived through: a run SHALL execute with
update semantics only when a published bundle exists at the clone's bundle path,
and SHALL execute with init semantics otherwise — whatever entry point reached it,
including the scheduled batch and the standalone update command. A first build
recovered through the update path (for example, after a failed add left nothing
published) SHALL therefore receive init semantics: the producer is not told a
bundle exists, whole-repository planning applies (on a checkout beyond the split
threshold, planning is decomposed exactly as any init), initial-coverage
acceptance applies, and no scoped-update comparison is made against a
nonexistent prior bundle. The flow's no-op skip check SHALL respect the same
truth: a repo whose published bundle is absent SHALL NOT be skipped for being
already at the last indexed sha — except a repo configured without a wiki,
whose bundle is absent by configuration rather than by loss; it keeps the skip.

#### Scenario: Update on a repo with no published bundle runs as init
- **WHEN** the update flow reaches a repo whose checkout has no published bundle
- **THEN** the run executes with init semantics — whole-repository planning and initial-coverage acceptance — and the producer is not told a bundle exists

#### Scenario: Update on a repo with a published bundle keeps update semantics
- **WHEN** the update flow reaches a repo whose checkout has a published bundle
- **THEN** the run keeps update semantics — change-set-scoped planning and scoped-update acceptance — exactly as before

#### Scenario: A repo whose bundle is gone is rebuilt despite an unchanged head
- **WHEN** the update flow reaches a repo whose head equals the recorded last indexed sha but whose checkout has no published bundle
- **THEN** the run is not skipped and executes as an init

#### Scenario: A no-wiki repo at its indexed sha stays skipped
- **WHEN** the update flow reaches a repo configured without a wiki whose head equals the recorded last indexed sha
- **THEN** it is skipped exactly as before — its bundle is absent by configuration, not by loss — while a moved head still pulls and re-indexes it

#### Scenario: A failed first build recovered by the batch is an init
- **WHEN** a repo's initial run fails before anything is published and the scheduled batch later reaches it
- **THEN** the batch's run for that repo is an init run, and on a beyond-threshold checkout its planning is decomposed
