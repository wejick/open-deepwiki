## Context

See proposal.md — Why. What shapes the approach is what already exists:

- `registerRepo(ctx, source, noWiki, instructions, producer)` already takes a
  per-repo producer; `POST /api/repos` simply never passes it.
- `producerFor(cfg, repo)` in `repoManager/registry.ts` already resolves
  override-else-global, and `saveRegistry` already persists `producer`.
- `PRODUCER_IDS` in `config/config.ts` is the single list of valid ids.
- `src/producer/contract.test.ts` scans every non-test `.ts` under `src/` and
  fails if `producerId ===` appears outside `producer/isolation.ts`, or if a
  second `producerFor` is defined. Any validation added to `admin.ts` must
  therefore be a membership test, not a comparison.
- `dashboard.js` keeps every testable behavior in pure exported helpers, with
  DOM work confined to the `typeof document !== "undefined"` block;
  `dashboard.test.ts` mixes helper unit tests with source-text assertions.

## Goals / Non-Goals

**Goals:**
- Wire the existing `producer` parameter through HTTP to the dashboard form.
- Keep the "adding a producer" cost honest: one config union member, one branch
  arm, one file — plus, now, one `<option>` that a test forces you to add.
- Make both submit paths (with and without an override) unit-testable without a
  browser.

**Non-Goals:**
- No new endpoint, no change to `/status`, no producer column in the table.
- No prerequisite probing at add time (see Risks).

## Decisions

**1. Validate the producer before the pre-flight check, with `.includes`.**
`addRepo` reads `body.producer`: absent or `null` → `undefined`; a non-string →
400; a string, trimmed, empty → `undefined`; otherwise it must satisfy
`PRODUCER_IDS.includes(...)` or 400 with the valid ids listed. This runs before
`validateSource`, so a typo fails in microseconds instead of after a
`git ls-remote`, and it satisfies the spec's "no pre-flight work is performed".
Membership rather than equality is what keeps `contract.test.ts` green.
*Alternatives considered:* a zod schema for the body (the file hand-checks
every other field — one shape would not justify the import); validating inside
`registerRepo` (would push HTTP error semantics into the repo manager, and the
CLI already validates its own flag).

**2. Echo the effective producer in the 202, via `producerFor`.**
The response becomes `{ repoId, producer, status: "queued" }`. The dashboard
always sends an explicit choice (decision 3), so for it this just confirms the
pick landed; for any other API caller that omits `producer` (the general HTTP
contract still allows that — see the admin-api delta), the echo is what makes
the fallback to the global default legible. Reusing `producerFor` means the
echo cannot disagree with what the run will do. *Alternatives considered:*
echoing back only the override (shows `null` for the common case and answers
nothing); a producer column in the repo table (a separate display change, and
slower feedback — it needs a Refresh).

**3. The `<option>` list lives in `dashboard.html`, pinned by a test — no
default option.** Per explicit correction, the dashboard must not offer a
"leave it on the global default" choice: every add names `openwiki` or
`claude`. The two ids are static markup in a `<select id="add-producer"
required>`, `openwiki` listed first (so it is the browser's initial selection,
matching `ODW_PRODUCER`'s default — but still submitted as an explicit value,
never omitted). A test parses the option values out of `htmlText` and asserts
they equal `PRODUCER_IDS` exactly, with no additional empty/default entry, so a
third producer fails the suite at the exact line that needs editing rather
than shipping a form that silently omits it. *Alternatives considered:*
keeping a "default" option that sends no producer (rejected — the operator
wants every dashboard-added repo to carry a recorded, explicit choice, not an
implicit one that changes meaning if the global default is later reconfigured);
serving `producers: { available }` from `/status` and rendering the list (no
drift possible and no dashboard edit ever, but it grows the status payload and
the monitoring spec for a two-element list — rejected earlier in review);
rendering from a JS constant in `dashboard.js` (same drift surface, and markup
is the more natural home for a static control).

**4. Two new pure helpers instead of asserting on source text.**
`addBody(source, producer)` returns `{ source, producer }` — producer is never
omitted, matching decision 3 — and `addResultText(ok, body)` formats
`queued: <repoId> · <producer> — hit Refresh to watch` or the error. The wiring
block calls both, so the submit-shape and acceptance-message scenarios become
real unit tests rather than greps for a string literal. Both are declared in
`dashboard.d.ts`, which the existing tests type against. The producer selector
value is left as-is after a successful add (not reset), since there is no
default value to reset to and an operator adding several repos under the same
producer benefits from it sticking. *Alternatives considered:* building the
body inline in the submit handler and asserting with `jsText.toContain(...)` —
cheap to write, but it tests the text of the code rather than its behavior.

## Risks / Trade-offs

- **The hardcoded list drifts from `PRODUCER_IDS`** → the pinning test in
  decision 3 turns drift from a silent dead option into a red suite. This is
  the accepted cost of not serving the list.
- **An operator picks `claude` on a host where `claude` is absent or not
  logged in** → unchanged existing policy: the run warns, skips wiki
  generation, and indexes source-only (okf-producer › missing prerequisite).
  Deliberately no add-time probe: it would duplicate the degradation policy and
  add a config-dir/auth check the CLI path does not have.
- **`producer` is add-time only, so a wrong pick means edit `registry.yaml` or
  remove and re-add** → acceptable; migration is already documented as a
  registry edit, and the echo in decision 2 surfaces a mistake immediately.
- **Two more exported helpers in `dashboard.js`** → within the file's stated
  structure rule; both are consumed by the wiring block, so neither is
  speculative.

## Migration Plan

Purely additive. A client posting `{ source }` behaves exactly as before, so
the dashboard and the API can ship in either order. Rollback is reverting the
three source files; a repo already registered with an override keeps working
because `registry.yaml` and the CLI have supported the field since
`add-claude-code-producer`.
