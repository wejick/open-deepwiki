## Why

The `claude` producer exists, and the CLI can pin it per repo
(`repo add --producer claude`). The dashboard cannot: its add form posts only
`{ source }`, and `POST /api/repos` ignores any producer field. So the one
surface an operator actually uses to onboard a repo silently forces the global
default, and moving a repo to `claude` means hand-editing `registry.yaml` or
dropping to the CLI — exactly the migration step AGENTS.md documents as
per-cohort and routine.

## What Changes

- `POST /api/repos` accepts an optional `producer` field; an id outside
  `PRODUCER_IDS` is rejected 400 naming the valid ids, registering nothing.
  Omitted or empty means *no per-repo override* — the repo follows the global
  default, identical to `repo add` without `--producer`.
- The 202 response echoes the producer that will run, so the operator can see
  the choice took effect without waiting for the run.
- The dashboard add form gains a producer `<select>` next to the source input,
  requiring an explicit choice between the producers the server supports — no
  default or no-override option; the operator always picks `openwiki` or
  `claude`. Its option list is hardcoded in the page and pinned to
  `PRODUCER_IDS` by a test, so a divergence fails the suite instead of shipping
  a dead option.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `admin-api`: the add endpoint gains the optional `producer` field, its
  validation, and the echoed effective producer.
- `dashboard`: the add form is no longer single-field — it carries a producer
  selector that requires an explicit choice, with no default or no-override
  option.

## Non-goals

- **Changing an existing repo's producer from the dashboard.** Out of scope;
  the field is add-time only, as requested. `registry.yaml` and the CLI remain
  the way to migrate a registered repo.
- **A producer column in the repo table.** `/status` already carries
  `producer`; rendering it is a separate display change.
- **Serving the producer list from the server.** Considered and rejected in
  design.md; the list stays in the page, guarded by a test.
- No change to producer selection, acceptance, or the one-branch contract.

## Impact

- `src/server/admin.ts` (`addRepo`), `src/server/dashboard.html`,
  `src/server/dashboard.js`.
- Tests: `src/server/admin.test.ts`, `src/server/dashboard.test.ts`.
- No new dependency, no config knob, no change under `src/producer/`.
  `registerRepo` already takes a `producer` argument — this wires the existing
  parameter to HTTP.
