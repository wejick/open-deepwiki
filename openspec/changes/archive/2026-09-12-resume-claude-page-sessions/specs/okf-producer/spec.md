## ADDED Requirements

### Requirement: Resumable page sessions

The `claude` producer SHALL give every page session an identity that outlives
the child process, so a session killed mid-flight can be continued instead of
restarted. When the installed CLI advertises session identity and resume, the
producer SHALL assign each page session a fresh identity and persist it in the
bundle's checkpoint before the child process starts, and SHALL pass that
identity to the CLI; when the CLI does not advertise them, the producer SHALL
spawn page sessions with no identity and behave exactly as before. On a later
run, a planned page that is not yet produced and carries a persisted identity
SHALL be continued by resuming that session with a continuation prompt, in
place of a fresh session; a resumed session SHALL be subject to the same pool
concurrency cap, the same shared whole-run deadline, the same per-session
timeout, and the same cancellation as a fresh one. A persisted identity SHALL
remain resumable across interruptions until the page is produced or its
session ends in a terminal failure: producing the page, or a session outcome
that is neither a completion nor an interruption — a rate limit, a timeout, or
a cancellation — SHALL drop the record, so the next attempt for that page
starts fresh. When a recorded identity cannot be resumed — the transcript is
gone or the CLI refuses it — the producer SHALL spawn a fresh session for that
page in the same run and replace the record with the new identity. The
overview page is a page session and is covered by this requirement like any
other.

#### Scenario: An interrupted page session is resumed, not restarted
- **WHEN** a run resumes a bundle whose checkpoint records an identity for a planned page that is still unproduced
- **THEN** that page's session is started by resuming the recorded session, not as a fresh one

#### Scenario: A session identity is persisted before its session starts
- **WHEN** a page session is spawned while the CLI advertises session identity
- **THEN** its identity is already written in the bundle's checkpoint before the child process starts

#### Scenario: Resume survives repeated interruptions
- **WHEN** a resumed session is interrupted again without producing its page
- **THEN** a later run resumes the same session again rather than starting fresh

#### Scenario: A produced or terminally failed page is not resumed
- **WHEN** a page session produces its page, or ends in a terminal failure that is not an interruption
- **THEN** its checkpoint record is dropped and a later attempt for that page starts a fresh session

#### Scenario: An unresumable session falls back to a fresh one
- **WHEN** the CLI cannot resume a recorded identity
- **THEN** a fresh session for that page runs in the same run and its identity replaces the recorded one

#### Scenario: A CLI without session identity degrades to fresh sessions
- **WHEN** the installed CLI does not advertise session identity and resume
- **THEN** no page session is given an identity or resumed, and the run proceeds exactly as when every session is fresh
