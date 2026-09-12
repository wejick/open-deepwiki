## ADDED Requirements

### Requirement: Page sources rendered with forge links
A wiki concept page whose frontmatter `sources` lists `repo://` resources SHALL
render a Sources section identifying each citation by its repo-relative path
and line range. An entry SHALL link to the repository's forge web location at
the repo's indexed revision when the registry `source` and `lastIndexedSha`
yield one: GitHub as `https://<host>/<owner>/<repo>/blob/<sha>/<path>`, GitLab
as `https://<host>/<group-path>/-/blob/<sha>/<path>`, with fragment
`#L<start>-L<end>` on GitHub, `#L<start>-<end>` on GitLab, `#L<n>` for a single
line, and no fragment for a citation without a line range. An entry whose
repository is local, whose host is not recognized, or whose repo has no indexed
revision SHALL render as plain `path` (with `:start-end` when the citation
carries a range) text instead of an anchor. Sources that are not `repo://`
resources SHALL be omitted, and a page with no renderable sources SHALL NOT
show the section.

#### Scenario: GitLab citation linked
- **WHEN** a page cites `repo://src/auth.ts#L10-L20` and its repo's source is `git@gitlab.corp:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered page links that entry to `https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20`

#### Scenario: GitHub citation linked
- **WHEN** a page cites `repo://src/auth.ts#L10-L20` and its repo's source is `git@github.com:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered page links that entry to `https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20`

#### Scenario: File citation without a line range
- **WHEN** a page cites `repo://README.md` with no fragment
- **THEN** the rendered link points at the file at the indexed revision and carries no line fragment

#### Scenario: Single-line citation
- **WHEN** a page cites `repo://src/auth.ts#L8`
- **THEN** the rendered link's fragment is `#L8`

#### Scenario: Unlinkable repository degrades to text
- **WHEN** a page cites `repo://src/auth.ts#L10-L20` but its repo's source is a local path, its host is neither GitHub nor GitLab, or the repo has no indexed revision
- **THEN** the entry renders as plain `src/auth.ts:10-20` text with no anchor

#### Scenario: Page without renderable sources
- **WHEN** a concept page has no `sources` frontmatter, or none of its sources are `repo://` resources
- **THEN** the rendered page contains no Sources section
