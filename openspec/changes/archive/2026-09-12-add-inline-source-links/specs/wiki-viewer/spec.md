## ADDED Requirements

### Requirement: Inline source citations linked
Inline code spans in a wiki concept page's body that name a repository file and
a line range (`path:start-end`, `path:start`, `path#Lstart-Lend`, or
`path#Lstart`) SHALL render as a link to that file's forge web location at the
repo's indexed revision when the named path exists in the page's checkout and a
web location is derivable. The link's fragment SHALL use the mention's own line
range, not the page's frontmatter `sources`: GitHub as `#L<start>-L<end>`,
GitLab as `#L<start>-<end>`, and `#L<n>` for a single line. A mention whose path
is missing from the checkout, whose repo has no derivable web location, that
carries no line range, or that sits inside a fenced code block SHALL remain
plain inline code.

#### Scenario: Inline GitLab mention linked
- **WHEN** a page body contains `` `src/auth.ts:10-20` ``, the file exists in the checkout, and the repo's source is `git@gitlab.corp:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered page contains a link to `https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20` wrapping `<code>src/auth.ts:10-20</code>`

#### Scenario: Inline GitHub mention linked
- **WHEN** a page body contains `` `src/auth.ts:10-20` `` and the repo's source is `git@github.com:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered link target is `https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20`

#### Scenario: Single-line mention
- **WHEN** a page body contains `` `src/auth.ts:8` `` and the file exists in the checkout
- **THEN** the rendered link's fragment is `#L8`

#### Scenario: Hash-form mention linked
- **WHEN** a page body contains `` `goal.ts#L71-L86` `` and the file exists in the checkout
- **THEN** the rendered link's fragment is `#L71-L86` (and a single `` `goal.ts#L20` `` mention gets `#L20`)

#### Scenario: Missing file stays code
- **WHEN** a page body contains `` `src/missing.ts:1-2` `` and no such file exists in the checkout
- **THEN** the mention renders as plain `<code>src/missing.ts:1-2</code>` with no link

#### Scenario: Unlinkable repository stays code
- **WHEN** a page body contains `` `src/auth.ts:1-2` `` but the repo's source is a local path, its host is neither GitHub nor GitLab, or the repo has no indexed revision
- **THEN** the mention renders as plain inline code with no link

#### Scenario: Fenced code untouched
- **WHEN** a fenced code block contains `src/auth.ts:1-2`
- **THEN** the block renders unchanged with no link

#### Scenario: Identifier without a line range not matched
- **WHEN** a page body contains an inline code span such as `` `session.execution.succeeded` ``
- **THEN** it renders as plain inline code with no link
