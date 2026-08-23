## 1. Admin API accepts a producer

- [x] 1.1 In `src/server/admin.ts` `addRepo`, parse `body.producer` before
      `validateSource`: absent/`null` → `undefined`; non-string → 400; string
      trimmed to `""` → `undefined`; otherwise require
      `PRODUCER_IDS.includes(...)` or return 400 with an error listing the valid
      ids. Pass the result as `registerRepo`'s `producer` argument. Verify with
      new `src/server/admin.test.ts` cases named for the delta scenarios
      "Producer override persisted" (registry entry carries `producer: "claude"`)
      and "Omitted producer follows the global default" (registry entry has no
      `producer` key).
- [x] 1.2 Add the rejection case: `POST /api/repos` with
      `producer: "nonesuch"` returns 400, the error text contains every id in
      `PRODUCER_IDS`, `registry.repos` is unchanged, and no run is tracked in
      `adminRuns` — test named "Unknown producer rejected before any work".
      Use a source value that would fail pre-flight anyway, so the test also
      proves the producer check runs first.
- [x] 1.3 Include the effective producer in the 202 body
      (`{ repoId, producer, status: "queued" }`) using `producerFor` from
      `repoManager/registry.ts`. Verify: the override case echoes `"claude"`,
      the omitted case echoes `cfg.producer`.
- [x] 1.4 Run `bun test ./src/server/admin.test.ts`, `bun run typecheck`, and
      `bun test ./src/producer/contract.test.ts` — the contract test must stay
      green, confirming the membership check introduced no `producerId ===`
      outside `producer/isolation.ts`.

## 2. Dashboard add form

- [x] 2.1 In `src/server/dashboard.html`, add a required
      `<select id="add-producer" required>` to the add form with one option per
      producer id (`openwiki` first, then `claude`) and **no** default or
      empty option — every add must name a producer explicitly. Verify with a
      new `dashboard.test.ts` test "Selector offers exactly the supported
      producers, no default": parse the option values out of `htmlText` for
      `#add-producer` and assert they equal `[...PRODUCER_IDS]`
      (imported from `config/config.ts`) exactly, with no extra entry.
- [x] 2.2 Add pure helpers to `src/server/dashboard.js`, above the wiring
      block: `addBody(source, producer)` always returning
      `{ source, producer }` (producer is never omitted), and
      `addResultText(ok, body)` returning
      `queued: <repoId> · <producer> — hit Refresh to watch` on success and the
      error text otherwise. Declare both in `src/server/dashboard.d.ts`. Verify
      with unit tests named "Selected producer always submitted explicitly"
      (both `openwiki` and `claude` produce a body carrying that key) and
      "Acceptance names the producer" (message contains both repoId and
      producer).
- [x] 2.3 Wire the submit handler to read `$("add-producer").value`, build the
      body with `addBody`, render with `addResultText`, and reset only the
      source field on success (the producer selection has no default to reset
      to, and persists for the next add). Verify: `bun test
      ./src/server/dashboard.test.ts` passes, and the existing "No automatic
      polling" and "Add submits the source" tests still pass (the latter
      updated in this task from `JSON.stringify({ source })` to
      `JSON.stringify(addBody(source, producer))`).

## 3. Whole-suite verification

- [x] 3.1 Run `bun run typecheck`, `bun run lint`, `bun run format:check`, and
      the full `bun test` — all green, with the two delta specs' scenario names
      appearing in the test output.
- [x] 3.2 Manual check against a running `serve`: add a local fixture repo with
      the selector on `claude`, confirm the 202 message names `claude`, and
      confirm `bun odw repo list` annotates that repo's non-default producer.
