## Context

`fmtTime` (`src/server/dashboard.js:36-39`) is the only place a dashboard
timestamp is formatted, and it's a plain string slice of the UTC ISO value
`/status` already returns — no `Date`/`Intl` object is ever constructed. The
`wiki/src` column (`dashboard.html:80`, `dashboard.js:74`) renders two
unrelated final counts (`docs.wiki`, `docs.source` from `docCounts()` in
`src/index/db.ts`) as one `X/Y` cell. See `proposal.md` for why both read as
confusing/misleading. Both fixes are entirely client-side; `/status` needs
no changes.

## Goals / Non-Goals

**Goals:**
- Render last-run/running-since times in the viewer's actual local time
  zone, with no perceptible loss of the current compact format.
- Split the doc-count cell into two plain columns so it can no longer be
  misread as a progress fraction.
- Keep `dashboard.test.ts` deterministic in CI regardless of the host
  machine's time zone.

**Non-Goals:**
- No UTC/local toggle, no user-configurable format, no new dependency (see
  proposal.md's Non-goals for the fuller list — this section only adds the
  test-determinism boundary above).

## Decisions

**Local time via native `Intl.DateTimeFormat`, not a date library.**
Replace the string slice with
`new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))`.
Passing no `timeZone` option makes `Intl` resolve the browser's local zone
automatically — no offset math, no toggle. Alternatives considered:
(a) a manual `Date` getter approach (`getHours()`/`getMinutes()` etc.,
zero-padded by hand) — works but reimplements formatting `Intl` already does
correctly across locales' month/day ordering; (b) pulling in `date-fns` or
similar — rejected outright, no requirement here needs anything a
one-line native `Intl` call doesn't already provide, and the project bans
dependencies without a direct consumer beyond a single formatting call.

**Test determinism: pin `TZ=UTC` for `dashboard.test.ts`, not the assertions.**
Because `fmtTime` now reads the host's local zone, running the existing
"format a known ISO string" style test unpinned would produce a different
string on every machine/CI runner. Setting `process.env.TZ = "UTC"` before
the test file's imports makes Bun's `Date`/`Intl` resolve to UTC, so the
test asserts a fixed, known output while production code is unchanged and
still honors each real viewer's own browser zone. Alternative considered:
assert only the *shape* (regex like `/^\d{2}-\d{2} \d{2}:\d{2}$/`) instead of
an exact string — rejected as strictly weaker coverage for no benefit, since
pinning `TZ` gives an exact, still-portable assertion.

**Doc counts: two columns, not a relabeled single cell.**
Split `<th>wiki/src</th>` into `<th>wiki docs</th><th>source docs</th>`, and
the single `${wiki}/${source}` cell into two `<td>` values. This was an
explicit user decision over the alternative of keeping one cell with a
clearer label (e.g. "18 wiki · 208 src") — two columns fully removes the
`X/Y` shape rather than just softening it, at the cost of one extra table
column (negligible given the existing header's short numeric content).

## Risks / Trade-offs

- [Risk] `Intl`-based formatting makes the dashboard's *displayed* time
  locale-dependent (e.g. month/day order) in addition to zone-dependent →
  Mitigation: this is a debugging-facing internal dashboard, not a public
  product surface; consistent-per-viewer, zone-correct output is the goal,
  not a single canonical string.
- [Risk] Splitting one column into two widens the repo table → Mitigation:
  both new headers are as short as the one they replace; the table already
  scrolls/wraps at `max-width: 72rem` and has headroom.
- [Risk] Nothing currently pins `fmtTime`'s exact output in tests, so this
  is a safe rename/reformat with no hidden consumer — confirmed by reading
  `dashboard.test.ts`, which only asserts `fmtDuration`.

## Migration Plan

None needed — pure client-side rendering change (`dashboard.js`/`.html`),
no API/schema/version change, takes effect for every viewer on next page
load.
