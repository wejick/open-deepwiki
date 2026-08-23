# okf-producer spec delta

## MODIFIED Requirements

### Requirement: Non-interactive Claude Code producer invocation
The `claude` producer SHALL invoke the `claude` CLI in non-interactive print mode against the managed clone, with stdout/stderr captured. A run SHALL be orchestrated as child sessions rather than one session: a planning session that produces the page plan, then the planned pages — each produced by its own child session, with up to a configurable number of page sessions running concurrently — and a final session for the overview page. A page session SHALL produce exactly one page and no session SHALL be asked to produce more than one. Each child session SHALL be bounded by a configurable per-session timeout, and the run as a whole SHALL be bounded by the existing configurable producer timeout, after which the orchestrator SHALL stop launching further sessions. The whole-run deadline SHALL be a single wall clock shared by every concurrent page session — it is not divided among workers and not extended by them — so a session that starts before the deadline remains bounded by its own per-session timeout computed against the remaining shared budget, and no session is terminated early to divide the budget among workers. When a page session reports a usage limit while other page sessions are in flight, the producer SHALL terminate the in-flight sessions, launch no further page session, and report the run as `rate_limited` with partial work preserved and the reset time that session reported; the overview session SHALL NOT run. When a run ends `failed` with several page sessions failed, the run's report SHALL carry the first failing session by launch order while every failed page is recorded individually in the run's notes. Every session SHALL be constrained so the producer can only read the checkout and write the bundle: no shell execution, no network tools, and no access to paths outside the clone other than the scratch file the planning session writes its plan to. Authoring guidance SHALL come from a repo-owned skill that carries the OKF v0.2 contract, so the prompt is versioned with the code rather than embedded in it; the guidance SHALL be composed as one contract shared by every session plus one phase-specific prompt per session kind. Each step — map (the area-map session), planning (the undecomposed planner session and every area session), and page (each page session, the overview session, and a repair session) — SHALL run on the run's model and effort unless a model or effort is separately configured for that step; an unset step value means the run-wide value, and a configured one applies to that step's sessions only.

#### Scenario: Init run produces a bundle
- **WHEN** a repo is added with the `claude` producer selected
- **THEN** the CLI completes non-interactively and an OKF bundle directory exists at `<clone>/openwiki/`

#### Scenario: Producer cannot execute repository code
- **WHEN** the `claude` producer runs against a checkout containing executable scripts
- **THEN** no shell command from the repository is executed during the run

#### Scenario: Producer cannot write outside the bundle
- **WHEN** a run attempts to modify a source file in the checkout
- **THEN** the write does not occur and the checkout's tracked files are unchanged after the run

#### Scenario: One session per planned page
- **WHEN** a plan containing several pages is generated
- **THEN** each page is produced by its own child session, and no session is asked to produce more than one page

#### Scenario: Page workers cap concurrency
- **WHEN** a run is configured with more than one page worker and its plan contains several pages
- **THEN** page sessions run concurrently with no more than the configured number in flight at once, and each session produces a distinct page

#### Scenario: Page workers default to one
- **WHEN** the page-worker count is not configured
- **THEN** page sessions run one at a time, exactly as when no concurrency is configured

#### Scenario: Concurrent page sessions share one whole-run deadline
- **WHEN** a run configured with several page workers reaches its producer timeout while page sessions are in flight
- **THEN** no further page session is launched, each in-flight session remains bounded by its own per-session timeout against the shared remaining budget, and no session is terminated early to divide the budget among workers

#### Scenario: Per-session timeout bounds one page, not the run
- **WHEN** one page's session exceeds the configured per-session timeout
- **THEN** that child process is terminated, that page is left unproduced, and the remaining planned pages are still attempted

#### Scenario: Per-step model and effort apply to that step only
- **WHEN** a split init runs with a model or effort configured for one step and the other steps unset
- **THEN** only that step's sessions spawn with the configured values — the map session for map, the planner and every area session for planning, the page sessions for page — while every other session keeps the run-wide model and effort

#### Scenario: A rate-limited page session aborts in-flight peers
- **WHEN** any page session reports a usage limit while other page sessions are in flight
- **THEN** the in-flight sessions are terminated, no further page session is launched, the overview session does not run, and the run reports `rate_limited` with partial work preserved and the reset time that session reported

#### Scenario: A rate-limited abort resumes cleanly
- **WHEN** a later run resumes after a rate-limited abort that terminated in-flight page sessions
- **THEN** only pages that are neither present nor conformant are produced again — a terminated worker's partial file is treated as unproduced and does not corrupt the resumed run

#### Scenario: The first failing page leads the failure report
- **WHEN** several page sessions fail in one run
- **THEN** the run's report carries the first failing session by launch order, and every failed page is still recorded individually in the run's notes

#### Scenario: Timeout kills the run
- **WHEN** a run exceeds the configured producer timeout
- **THEN** any running child process is terminated, no further sessions are launched, and the run is reported as timed out
