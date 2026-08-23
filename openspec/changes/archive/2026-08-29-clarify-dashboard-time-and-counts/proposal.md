## Why

The dashboard's "last run" column renders raw UTC (`08-29 14:03Z`) with no
conversion, forcing every viewer to do timezone math by hand. Separately, the
`wiki/src` column crams two unrelated final counts into one cell as `18/208`
— which reads exactly like a stalled "18 of 208 done" progress fraction, even
when the wiki finished generating cleanly. Both are display-only bugs in
`dashboard.js`; the underlying `/status` data is already correct.

## What Changes

- `fmtTime` renders timestamps in the viewer's local time zone instead of
  slicing the raw UTC ISO string.
- The single `wiki/src` cell becomes two separate table columns (wiki doc
  count, source doc count), removing the `X/Y` pairing that reads as a
  fraction.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard`: the "Repo status table" requirement's timestamp rendering and
  document-count presentation change — last-run times are local, and doc
  counts render as two distinct columns instead of one combined ratio.

## Non-goals

- No UTC/local toggle or timezone preference setting — the fix is a silent
  switch to the browser's local zone, consistent with this project's
  no-config-knob-without-a-scenario principle.
- No surfacing of `linkHealth` or `build.attempts` as new progress
  indicators — deferred; this change only fixes the misleading existing
  column, it doesn't add a new "in progress" signal.
- No live per-page progress counter during wiki generation — no such
  counter exists anywhere in the producer pipeline; adding one is a
  separate, materially larger change.

## Impact

- `src/server/dashboard.js`: `fmtTime` (local-time formatting) and
  `renderRepoRows` (two doc-count columns instead of one).
- `src/server/dashboard.html`: table header gains a second column, replacing
  `wiki/src` with two labeled headers.
- `src/server/dashboard.test.ts`: new/updated coverage for both.
- No server, API, or `/status` payload changes — `docs.wiki`/`docs.source`
  and ISO timestamps are already present and correct; only client rendering
  changes.
