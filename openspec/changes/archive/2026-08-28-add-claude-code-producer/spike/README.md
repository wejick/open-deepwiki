# 1.7 spike fixture

A minimal, real codebase for running the actual `openwiki` and `claude` CLIs
by hand (not shims) — the live spike task 1.7 requires. Not a git repo itself
(you create that locally, see below) so it stays plain text under version
control here.

Deliberately small (4 source files, one real cross-file relationship: `index.ts`
→ `store.ts` → `cache.ts`, plus an unrelated `format.ts`) so a live run is cheap
and its output is easy to read by hand. `format.ts` exists specifically so an
update run has a page that should stay untouched — see `update/`.

## `init/` — testing `--init` (either producer)

No git needed for init — confirmed by reading openwiki's own source
(`getGitHead` swallows a missing-repo error and returns `undefined`; init
does not require a git history to run).

```sh
cd init
openwiki --init
# or, for the claude producer once the skill exists:
claude -p --plugin-dir <path-to-skill> "produce the OKF wiki bundle at ./openwiki/"
```

Look for: does `openwiki/` get created; does every page's `sources[]`
resolve to a real path in `init/`; is density (see design.md D6) usable
across pages, not just the longest one.

## `update/` — testing `--update`

Real `openwiki --update` shells out to `git diff`/`git rev-parse` internally
(confirmed by reading `src/agent/utils.ts` in the openwiki repo), so this one
needs a real git history — just local, no remote:

```sh
cd update
git init -q && git add -A && git commit -q -m baseline
openwiki --init                    # records this commit as gitHead
../apply-update-commit.sh          # applies + commits the follow-up change
openwiki --update                  # should scope its revision to the diff
```

The follow-up change (`update-after/{cache,store,index}.ts`, applied by the
script) threads a real `onEvict` callback through `LruCache` → `Store` →
the login demo. It touches `cache.ts`, `store.ts`, `index.ts` — `format.ts`
and `README.md` are untouched, so their concept pages (if any) are exactly
what tasks.md 3.3's byte-identity check should find unchanged.

**`update-after/` and the script live outside `update/` on purpose.** The
producer documents whatever it finds in the checkout, so staging the
replacement files inside the repo would put three near-duplicate copies of
`src/` in front of it — polluting the generated wiki and skewing the very
coverage number this spike exists to measure. Keep `update/` containing
nothing but the sample codebase.

For the **claude producer**, update mode doesn't need git at all when
spiking the producer directly: `ProducerInput.changedPaths` is computed by
open-deepwiki's own pipeline (`diffNames`) and handed to the producer, not
derived by the producer itself. Skip the git dance and just tell the prompt
what changed:

```sh
./apply-update-commit.sh   # still applies the file changes
cd update
claude -p --plugin-dir <path-to-skill> \
  "update the OKF wiki bundle at ./openwiki/. Changed paths: src/cache.ts, src/store.ts, src/index.ts. Existing type vocabulary: <paste from the init run's pages>"
```

Look for: are `cache.ts`/`store.ts`/`index.ts` pages revised; is a page for
`format.ts` (if one was produced by init) byte-identical after; does no page
pick up a `type` outside what init already used, except a page for a
genuinely new unit (neither applies here — this change adds no new file).
