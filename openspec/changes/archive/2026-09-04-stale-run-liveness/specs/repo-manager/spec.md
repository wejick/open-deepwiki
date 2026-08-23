## MODIFIED Requirements

### Requirement: Update concurrency safety
The system SHALL prevent overlapping update runs for the same repo using a per-repo lock, skipping and logging runs that collide with an in-progress update, and SHALL bound concurrent openwiki runs across repos by the configured maximum parallelism.

The lock SHALL record its holder's process id and start time. A lock whose recorded holder process is no longer alive SHALL be taken over immediately by the next acquirer, regardless of age. A lock whose recorded body cannot be parsed, or whose holder process appears alive, SHALL be taken over only after the staleness window (12 hours, from the lock file's modification time) — the age rule is the guard against a pid recycled by the operating system after a reboot. Taking a lock over SHALL replace the existing file and succeed; the acquisition SHALL NOT fail merely because the lock file exists.

#### Scenario: Overlapping run skipped
- **WHEN** a scheduled update starts while a previous update for the same repo is still running
- **THEN** the new run is skipped and a message is logged

#### Scenario: Dead holder taken over immediately
- **WHEN** a lock file exists whose recorded holder process is dead, whatever the file's age
- **THEN** the next acquisition attempt takes the lock over and proceeds instead of being skipped

#### Scenario: Live or unparseable lock blocks until the staleness window passes
- **WHEN** a lock file exists whose holder process is alive, or whose body cannot be parsed, and its age is under 12 hours
- **THEN** acquisition returns busy, and the colliding run is skipped and logged

#### Scenario: A stale lock is genuinely taken over
- **WHEN** a lock file's age exceeds the 12-hour staleness window
- **THEN** the next acquisition replaces the file and acquires the lock — the run proceeds rather than being skipped forever, including on the first attempt after the window passes
