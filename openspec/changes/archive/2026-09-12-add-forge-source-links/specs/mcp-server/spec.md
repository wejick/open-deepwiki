## ADDED Requirements

### Requirement: Source citation URLs in search results
Every serialized result of `search_code` and `ask_repo` SHALL carry a `url`
field. For a `source`-kind result it SHALL be the cited file's forge web
location at the repo's indexed revision, using the result's first line range as
the fragment, when the registry `source` and `lastIndexedSha` yield one: GitHub
as `https://<host>/<owner>/<repo>/blob/<sha>/<path>#L<start>-L<end>`, GitLab as
`https://<host>/<group-path>/-/blob/<sha>/<path>#L<start>-<end>`, with `#L<n>`
for a single line and no fragment when the result carries no line range. The
field SHALL be null for wiki-kind results and whenever no web location is
derivable (local source, unrecognized host, or no indexed revision).

#### Scenario: Source result carries a GitLab permalink
- **WHEN** a scoped `search_code` returns a source-kind result for `src/auth.ts` lines 10-20 in a repo whose source is `git@gitlab.corp:team/repo.git` and indexed revision is `abc1234`
- **THEN** that result's `url` is `https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20`

#### Scenario: Source result carries a GitHub permalink
- **WHEN** a source-kind result for lines 10-20 belongs to a repo whose source is `git@github.com:team/repo.git` with indexed revision `abc1234`
- **THEN** that result's `url` is `https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20`

#### Scenario: Unlinkable repo yields null
- **WHEN** a source-kind result belongs to a repo whose source is a local path, whose host is unrecognized, or which has no indexed revision
- **THEN** that result's `url` is null

#### Scenario: Cross-repo results link to their own repo
- **WHEN** an unscoped search returns source-kind results from multiple repos
- **THEN** each result's `url` is built from that result's own repo source and indexed revision

#### Scenario: Wiki-kind result has no forge URL
- **WHEN** a result's kind is `wiki`
- **THEN** its `url` is null
