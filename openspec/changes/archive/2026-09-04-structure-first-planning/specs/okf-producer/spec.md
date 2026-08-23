## ADDED Requirements

### Requirement: Structure-seeded planning on init
On an init run, the `claude` producer SHALL seed every planning session with the
checkout's structure derived from git at no model cost, so that no planning
session has to enumerate what already exists. The structure handout SHALL
present the documentable file tree per directory, each directory carrying its
file count, its total size, and its files named largest-first up to a bounded
count. The map session SHALL receive the whole handout; the undecomposed
planner on an init run at or below the split threshold SHALL receive the whole
handout; each area session SHALL receive the handout's slice covering the paths
its area owns, in addition to the other-area context the area session already
gets. The planning guidance SHALL treat the handout as authoritative for what
exists, SHALL direct file reads only where the handout cannot answer — to learn
what a directory is, to ground a page's scope or brief, or to trace a flow — and
SHALL keep organizing pages around owned systems and workflows rather than
mirroring the tree. Update planning is not seeded: it is change-scoped, is given
`changedPaths` directly, and is unchanged by this requirement.

#### Scenario: The undecomposed init planner is seeded with the structure
- **WHEN** an init run at or below the split threshold generates the planner session's prompt
- **THEN** the prompt includes the checkout's structure handout — per-directory file counts, sizes, and files named largest-first — produced from git without any model call

#### Scenario: An area session is seeded with the structure it owns
- **WHEN** a split init run generates an area session's prompt
- **THEN** the prompt includes a structure-handout slice covering the paths that area owns — that subtree's directories with counts, sizes, and named files — and does not list the file structure of directories another area owns

#### Scenario: The handout names a directory's load-bearing files
- **WHEN** the structure handout for a directory with several files is rendered
- **THEN** the directory's entry names its largest files first, up to a bounded count, alongside its file count and total size

#### Scenario: The map session keeps the whole structure handout
- **WHEN** a split init run generates the map session's prompt
- **THEN** the prompt includes the whole structure handout for the checkout, exactly as when only the map session was seeded

#### Scenario: Planning guidance reads files only when the handout is not enough
- **WHEN** an init planning session's authoring guidance is generated
- **THEN** it states that the handout is authoritative for what exists, that file reads are for understanding what a directory is, grounding a page's scope or brief, or tracing a flow — never for rediscovering the tree — and that pages are organized around systems and workflows rather than mirroring the tree

#### Scenario: Update planning is not seeded
- **WHEN** an update run generates its planner session's prompt
- **THEN** the prompt contains no structure handout and is unchanged by this requirement

### Requirement: Planning sessions on init do not enumerate
On an init run, the `claude` producer SHALL launch the planning sessions — the
map session, each area session, and the undecomposed planner — without the
directory-enumeration tool in their tool allowlist, because the structure handout
is their enumeration channel. Their allowlist SHALL still include reading files,
searching file contents, and writing the session's artifact. Page sessions and
update-planning sessions SHALL keep the full read toolset including enumeration:
a page session authors one page from `sourcePaths` given to it, and update
planning works from `changedPaths`, so neither has a structure handout to plan
from.

#### Scenario: The map session spawns without enumeration
- **WHEN** a split init run spawns the map session
- **THEN** the session's tool allowlist includes reading files, searching file contents, and writing the map, and does not include the directory-enumeration tool

#### Scenario: An area session spawns without enumeration
- **WHEN** a split init run spawns an area session
- **THEN** the session's tool allowlist includes reading files, searching file contents, and writing its part, and does not include the directory-enumeration tool

#### Scenario: The undecomposed init planner spawns without enumeration
- **WHEN** an init run at or below the split threshold spawns the planner session
- **THEN** the session's tool allowlist includes reading files, searching file contents, and writing the plan, and does not include the directory-enumeration tool

#### Scenario: A page session keeps the full read toolset
- **WHEN** an init run spawns a page session
- **THEN** the session's tool allowlist includes the directory-enumeration tool alongside reading, editing, and writing, exactly as before this requirement

#### Scenario: Update planning keeps enumeration
- **WHEN** an update run spawns its planner session
- **THEN** the session's tool allowlist is unchanged by this requirement and still includes the directory-enumeration tool
