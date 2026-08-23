## Context

See proposal.md — Why. Two existing invariants shape every decision below and
initially look like they conflict:

- CONTRACT.md: "nothing under acceptance may name a producer" — `verify.ts`/
  `grounding.ts`/`acceptance.ts` must treat both producers identically, enforced
  by `contract.test.ts` grepping for a producer-id branch outside `isolation.ts`.
- AGENTS.md: the OKF bundle is "openwiki's artifact — read-only for us. Never
  rewrite, never move it." Openwiki already runs its own internal finalizer
  (index sync, Mermaid validate/degrade) before its CLI exits, which is exactly
  why that rule is safe to have.

The resolution: mutating passes (index sync, Mermaid degrade) belong inside the
`claude` producer's own code path — the one place `producerId === "claude"`
already legitimately branches ([isolation.ts](../../../src/producer/isolation.ts),
`produce()`) — never in acceptance. Read-only checks (link validation, the
grounding line-range tightening) belong in acceptance exactly like grounding
already does, because reading an openwiki bundle to check it violates nothing;
only rewriting it would.

## Goals / Non-Goals

**Goals:**
- Give the `claude` producer the same deterministic guarantees openwiki gets
  from its own internal finalizer, without touching openwiki's code path.
- Extend producer-blind acceptance with one new check (link validation) and
  tighten an existing one (grounding), so both producers benefit.
- Keep every addition traceable to a specific measured gap from the
  investigation — no speculative hardening.

**Non-Goals:**
- See proposal.md — Non-goals (no Claims store, no provenance stamping, no
  pre-run migration, no change to the `openwiki` code path).
- Not attempting byte-for-byte visual parity with openwiki's Markdown style
  beyond the four conventions named in the proposal — this is about closing
  measured gaps, not cloning openwiki's prose voice.

## Decisions

**D1 — Finalize inside `runClaude`, not in `acceptance.ts`.**
Index sync and Mermaid degrade both rewrite bundle files. Doing that in
`acceptance.ts` would either mutate an `openwiki`-produced bundle (banned by
AGENTS.md) or require `acceptance.ts` to branch on producer id (banned by
CONTRACT.md, and caught by `contract.test.ts`). Doing it inside `runClaude`,
after the child process reports success and before `runClaude` returns,
requires no change to `isolation.ts` or `acceptance.ts` at all — from their
point of view the bundle simply arrives already finalized, the same way an
`openwiki`-produced bundle already arrives finalized by openwiki's own CLI.
*Alternatives considered:* a producer-blind mutation step in `acceptance.ts`
(rejected — breaks the read-only guarantee for openwiki bundles or reintroduces
a banned producer branch); a config-gated step keyed off `producerId` inside
`acceptance.ts` (rejected — same banned-branch problem, just moved).

**D2 — Link scoring lives in `acceptance.ts`, reusing `resolveLink` from `ingest.ts` rather than a fresh implementation.**
Unlike index sync and Mermaid degrade, checking that a cross-page link resolves
is read-only — it never rewrites anything, so it carries none of D1's conflict.
The indexer already resolves in-body cross-page links during ingestion
(`ingestBundle` in [ingest.ts](../../../src/index/ingest.ts), via `resolveLink`/
`joinBundlePath`), and its own comment states broken/self/duplicate links are
already "silently dropped" by design. Acceptance reuses that exact resolution
logic instead of parsing links a second, potentially-drifting way.
*Alternatives considered:* reimplementing link parsing/resolution directly in
`verify.ts` (rejected — duplicates `resolveLink`, which already handles
bundle-absolute, relative, and openwiki's `/openwiki/x.md` quirk; a second
implementation risks drifting from the one the indexer actually uses).

**D3 — An unresolved link is a scored, floor-gated signal, not an automatic failure.**
The first draft of this decision treated any unresolved link as an
unconditional conformance failure. Checked against the existing codebase, that
was too strict: `test/fixtures/bundles/valid` — the happy-path fixture used
across nearly the entire producer/pipeline/server test suite — deliberately
contains one (`guide.md`'s `[broken link](/missing.md)`), `ingest.ts` already
tolerates it by design, and `test/eval/metrics.ts` already surfaces a
`linkRatio` metric from exactly this resolution rather than gating on it. A
configurable floor, default 0 (measure, don't gate), mirrors the grounding/
coverage/churn floors already established in
[acceptance.ts](../../../src/producer/acceptance.ts) and AGENTS.md's own
stated reasoning ("floors ship at 0 deliberately... an uncalibrated floor
rejects ordinary [runs]"). It also fits the goal more precisely: making link
decay observable, not rejecting a bundle over one link to a page that
legitimately hasn't been written yet.
*Alternatives considered:* an unconditional hard failure, the earlier draft of
this decision (rejected on the evidence above, discovered during
implementation rather than before — corrected here rather than carried
through as a known-wrong assumption).

**D4 — Mermaid validation uses the real `mermaid` parser with a `jsdom` DOM shim, not a heuristic.**
This requirement is served by validating a diagram the same way it will
eventually be parsed, rather than approximating a handful of known failure
shapes. openwiki's own documented behavior is to use the real parser as its
primary mode and fall back to a heuristic only when its `mermaid`/`jsdom` peer
deps are absent (see [test/fixtures/bundles/openwiki-authored/concepts/okf-output.md](../../../test/fixtures/bundles/openwiki-authored/concepts/okf-output.md));
since we control our own dependency tree, that fallback exists here for no
reason — the deps are simply always present, so there is no fallback branch
to build or keep tested. Both packages are pure JS with no native bindings,
consistent with the project's existing "no native extensions" posture. As
openwiki's own page documents, ordering matters: `jsdom`'s DOM globals must
exist before `mermaid` is first imported, or its flowchart/state-diagram
parsers (which call DOMPurify) fail to load. This design follows the same
shape openwiki uses: a single lazy-loaded, memoized loader function installs
the DOM globals and then imports `mermaid`, and nothing else imports `mermaid`
directly. Unlike openwiki (one process per run), this codebase's `bun test`
runs every file in one shared process, so a first implementation that left
`window`/`document` on `globalThis` permanently broke an unrelated test
(`dashboard.test.ts`'s `typeof document !== "undefined"` browser guard, which
depends on no DOM existing). The globals are installed only for the duration
of the call that needs them (import, or each `mermaid.parse`) and restored to
whatever was there before immediately after, never left in place.
*Alternatives considered:* a dependency-free heuristic checking a handful of
known failure shapes — a reserved `end` node id, a semicolon in a label, an
unescaped `<` in a label (rejected — real false-negative risk: a diagram can
pass every heuristic check and still fail to render, which is exactly the
failure this requirement exists to catch; the real parser removes that risk
entirely for two small, pure-JS, no-native-binding dependencies).

**D5 — Index sync regenerates `index.md` wholesale; it does not diff or merge.**
SKILL.md's own contract for `index.md` is "a linked table of contents" — a
mechanical listing, not prose worth preserving. Deterministic regeneration from
what is actually on disk removes drift entirely rather than reducing it.
*Alternatives considered:* validate the model's `index.md` and only flag
drift (rejected — reintroduces exactly the drift risk this requirement exists
to close); merge model-authored content with regenerated structure (rejected —
unnecessary complexity with nothing worth preserving).

**D6 — New file `src/producer/finalize.ts`; called from `claude.ts`.**
Matches the existing flat-file-per-concern layout (`verify.ts`, `grounding.ts`
already sit beside `claude.ts` under `src/producer/`). `claude.ts` calls it
after classifying a successful run, before returning.
*Alternatives considered:* inline in `claude.ts` (rejected — mixes process
spawning/classification with markdown authoring concerns; the existing files
in this directory already separate by concern, not by producer).

**D7 — Grounding's line-range check extends `grounding.ts`, not a new file.**
It is a small addition to `citedPath`'s existing resolution logic, with one
caller (`scoreGrounding`). A new file would be a seam serving no second caller.
*Alternatives considered:* a separate `lineRange.ts` (rejected — no second
consumer to justify the seam).

## Risks / Trade-offs

- [Risk] `mermaid`/`jsdom` must be imported in a specific order (DOM globals
  before mermaid's first import) or parsing silently breaks for diagram types
  that call DOMPurify → [Mitigation] A single lazy-loaded, memoized loader
  function owns that ordering, mirroring openwiki's own `loadMermaid`/
  `ensureDomGlobals` pattern; nothing else imports `mermaid` directly.
- [Risk] The parser can throw on unexpected input instead of returning a
  clean invalid result → [Mitigation] Each fence is checked independently and
  a thrown error is caught and treated as invalid, the same as a reported
  parse failure — one bad fence cannot abort validation of the rest of the
  bundle.
- [Risk] A link-score floor set too aggressively could reject a bundle that
  legitimately cites a page outside the current change set → [Mitigation]
  Same calibration discipline already used for grounding/coverage/churn: ships
  at 0, an operator raises it only from their own measured baseline.
- [Risk] Wholesale index regeneration could discard an index ordering or
  phrasing choice the model made deliberately → [Mitigation] SKILL.md never
  asked the model to invest authoring effort in `index.md` prose beyond a
  bare table of contents, so there is nothing of specified value to lose.
- [Risk] Finalization runs on every attempt, including the repair retry →
  [Mitigation] It is local file I/O only — no model or network call — negligible
  next to the LLM invocation it sits beside.

## Migration Plan

No data migration. `bun install` picks up the two new dependencies (`mermaid`,
`jsdom`); no other setup step. This only changes behavior for future `claude`
producer runs; the current registry has no repo configured with
`producer: claude`, so there is nothing to backfill. `openwiki`-produced
bundles are unaffected by construction (D1, D2).
