## 1. Local time rendering

- [x] 1.1 Replace `fmtTime`'s UTC string-slice with an
  `Intl.DateTimeFormat`-based local-time formatter in
  `src/server/dashboard.js`, and pin `TZ=UTC` at the top of
  `src/server/dashboard.test.ts` so the `fmtTime` test asserts a fixed,
  known output regardless of the host machine's time zone.
- [x] 1.2 Start the dashboard in a browser and confirm a repo's last-run /
  running-since time reflects the browser's local zone rather than raw UTC.

## 2. Doc-count columns

- [x] 2.1 Split the `wiki/src` header in `src/server/dashboard.html` into
  two `<th>` columns (`wiki docs`, `source docs`), and split
  `renderRepoRows`'s single `${wiki}/${source}` cell in
  `src/server/dashboard.js` into two `<td>` values; update
  `dashboard.test.ts`'s `renderRepoRows` coverage to assert both counts
  render as separate cells.

## 3. Verification

- [x] 3.1 Run `bun test src/server/dashboard.test.ts`, `tsc --noEmit`, and
  `oxlint`/`oxfmt` and confirm all pass with no new warnings.
