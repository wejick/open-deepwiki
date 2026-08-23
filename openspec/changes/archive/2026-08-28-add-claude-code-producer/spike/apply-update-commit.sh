#!/bin/sh
# Run this AFTER `openwiki --init` (or a `claude -p` init run) has completed
# inside ./update/ and produced update/openwiki/.last-update.json, recording
# the baseline commit as gitHead.
#
# It applies a real behavior change — an eviction callback threaded through
# LruCache -> Store -> the login demo — and commits it, so `openwiki --update`
# (or a hand-fed changedPaths list for the claude producer) has something
# real to diff against:
#   - src/cache.ts and src/store.ts change (should be revised)
#   - src/index.ts changes (should be revised)
#   - src/format.ts and README.md are untouched (their wiki pages, if any,
#     should stay byte-identical — the check tasks.md 3.3 is testing)
#
# The replacement files live in ../update-after/, deliberately OUTSIDE the
# spike repo: anything inside update/ is visible to the producer and would be
# documented as if it were part of the sample codebase.
set -e
cd "$(dirname "$0")"

if [ ! -d update/.git ]; then
  echo "update/ is not a git repo yet — see README.md (git init && git add -A && git commit)" >&2
  exit 1
fi

cp update-after/cache.ts update/src/cache.ts
cp update-after/store.ts update/src/store.ts
cp update-after/index.ts update/src/index.ts

cd update
if git diff --quiet; then
  echo "No change to apply — already applied?" >&2
  exit 1
fi
git add -A
git commit -q -m "cache: fire onEvict when capacity forces an eviction"
echo "Applied. New HEAD: $(git rev-parse HEAD)"
echo "Changed since baseline:"
git diff --name-only HEAD~1..HEAD
