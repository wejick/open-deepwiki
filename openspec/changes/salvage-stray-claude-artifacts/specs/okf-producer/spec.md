## ADDED Requirements

### Requirement: Stray planning artifacts are recovered

A `claude` session writes its planning artifact — the area map, the plan file,
or a per-area part, each a dot-file the orchestrator reads from inside the
bundle — at an absolute path inside the bundle, but a session that misses the
bundle places the file at exactly that artifact's name in the checkout root,
the only other place its write tools reach (its working directory). When the
producer is about to treat one of these artifacts as absent, it SHALL probe the
checkout root for a file of exactly that artifact's name and, if found, adopt
it by moving it into the bundle before deciding the unit's state. Adoption
SHALL NOT overwrite: it fires only when the bundle location for that artifact
is empty. An adopted artifact SHALL be validated exactly as one written in
place — a stray that does not parse, names unusable page paths, or belongs to a
commit other than the one being built is deleted and its unit treated as not
done, identically to an invalid artifact found in the bundle. Adoption SHALL
apply wherever the producer would otherwise treat the artifact as absent: after
the session that should have written it returns, and — for the area map and the
per-area parts, whose presence is a checkpoint meant to survive an interrupted
run — at the start of a later run before a replacement session would be
spawned. Adoption of a plan file SHALL be limited to the session that just
returned, never a file left by an earlier run, so an unapplied plan from
another commit cannot be resurrected. A unit completed through adoption SHALL
count as a completed unit: a run whose only recoveries are adopted artifacts is
not a zero-progress run, so it does not advance the resume-attempt counter.

#### Scenario: An area part written to the checkout root is recovered
- **WHEN** an area session ends with a valid part present at the checkout root under the part's file name and no part in the bundle
- **THEN** the part is moved into the bundle, the area counts as planned, and the run continues with the remaining areas rather than reporting the area unplanned

#### Scenario: A recovered part is not zero progress
- **WHEN** a run's only completed unit is an area part recovered from the checkout root
- **THEN** the run reports that unit completed, so the resume-attempt counter resets rather than advancing

#### Scenario: A misdirected part survives an interrupted run
- **WHEN** a run is interrupted after an area session wrote a valid part to the checkout root but before the area was counted, and a later run resumes the same pinned commit
- **THEN** the later run adopts the part from the checkout root before re-running that area's session, and the parts merge when the last missing area is covered

#### Scenario: A map written to the checkout root is recovered
- **WHEN** a map session ends with the area map present at the checkout root and none in the bundle
- **THEN** the map is adopted; a map validating against the commit being built proceeds to the area sessions, and one for another commit is discarded and re-planned exactly as an in-place stale map would be

#### Scenario: A plan written to the checkout root is recovered
- **WHEN** a planning session ends with the plan file present at the checkout root and none in the bundle
- **THEN** the plan is adopted and processed exactly as a plan written in place, and a plan that does not validate is discarded

#### Scenario: Adoption never overwrites an in-bundle artifact
- **WHEN** an artifact already exists in the bundle while a file of the same name sits in the checkout root
- **THEN** the in-bundle artifact stands and the stray is left untouched

#### Scenario: An adopted stray that does not validate is discarded
- **WHEN** the file adopted from the checkout root does not parse or names unusable page paths
- **THEN** it is deleted and its unit treated as not done, exactly as an invalid in-place artifact is, and the run reports the incomplete work rather than failing outright
