## Context

See proposal.md — Why. Design-relevant current state:

- The producer seam is already a process boundary: `runOpenwiki` spawns a CLI with
  `cwd` = the clone; `verifyBundle` gates the artifact; `runIsolatedOpenwiki`
  snapshots on success and restores on any failure. Nothing downstream of the
  bundle knows which process wrote it.
- The indexer reads only `type`, `title`, `description`, the body, and relative
  markdown links. That is the whole downstream contract a producer must satisfy.
- `updateRepo` already computes the changed-path set (`diffNames(oldSha, newSha)`)
  before invoking the producer — input openwiki derives for itself and a second
  producer can simply be handed.

Two findings from reading openwiki v0.3.3 shape this design:

- Its entire continuity state is `<clone>/openwiki/.last-update.json`
  (`{updatedAt, command, gitHead, model, status, language}`), and its update
  algorithm is "read `gitHead`, diff to HEAD, edit affected pages". Its reader
  picks only those six fields and ignores everything else, so the file is a stable
  two-way contract.
- **Correction to this design's own earlier draft**: an earlier pass here claimed
  openwiki 0.3.3 emits no `.claims/` directory. That was wrong, checked directly
  against openwiki's own self-hosted bundle (its repo dogfoods itself and commits
  `openwiki/`, `.claims/` included, at exactly `generated: { by: "openwiki/0.3.3" }`).
  `.claims/<page-path>.json` is real: per-claim evidence keyed to `repo://path#Lstart-Lend`
  with a content-hashed version, reconciled by a deterministic post-authoring pass
  (`src/claims/`, `src/okf/claims-verification.ts`) — documented in openwiki's own
  generated `concepts/grounded-claims.md`. It is not part of the OKF spec and the
  `claude` producer will not reproduce it (D2's non-goals already rule that out), so
  it cannot be what grounding reads — but it is exactly why every page's `sources:`
  frontmatter is reliably populated: `.claims/` evidence is what `sources:` is
  *projected from*. That projection is producer-agnostic OKF surface, and that is
  what D6 reads. Measured against the real bundle: 21 concept pages, 245 `sources[]`
  entries, all 245 resolve against the checkout (100%), density (sources per 1000
  body words) ranging 3.9–22.8 with no page at zero. Grounding is well-founded on
  this signal, and calibratable from it.

## Goals / Non-Goals

**Goals:**

- Add a producer without adding an abstraction: selection is a config value and one
  branch, and the run cycle around it is reused unchanged.
- Keep every producer on the identical run → verify → isolate path, so parity is
  enforced by the pipeline rather than trusted from a prompt.
- Make migration per-repo and reversible in both directions.
- Make production survive an exhausted budget: partial work is kept, the next run
  continues it, and a repo too large for one budget window still converges.

**Non-Goals:**

- No `Producer` interface, record, registry, factory, or capability negotiation.
  The contract is written down, not expressed as a type.
- No new queue, lock, or per-producer pipeline path. Producers reuse the existing
  run cycle. Scheduling changes are confined to dispatch order and skipping the pull
  for a pinned repo; one outcome value and one event are added because health needs
  to distinguish them.
- No `native` producer, and no changes made in anticipation of one.
- No change to embeddings, search, indexing, or the MCP surface.
- No attempt to reproduce openwiki's translation, connectors, or QA subagents.

## Decisions

### D1: Selection is a config value and one branch — no interface

A producer is chosen by id from config or the registry. The branch lives at the one
point where the bundle is produced, inside the isolation routine, so everything
after it is already producer-blind:

```ts
const run = producerId === "claude"
  ? await runClaude(cfg, mode, checkoutDir, input)
  : await runOpenwiki(cfg, mode, checkoutDir, input);
// verify, grounding, scoped checks, snapshot/restore, metadata: unchanged below,
// and none of it asks who produced the bundle
```

The run cycle around it — per-repo lock, pull, produce, verify, index, `recordRun`,
`run_started`/`run_succeeded`/`run_failed` — is reused as-is. A producer does not get
its own path through the pipeline.

The result type gets only the change a present requirement forces: rename
`OpenwikiRun` to `ProducerRun` and add `outcome: "ok" | "failed" | "rate_limited"`,
because rate limiting must be distinguishable *now* for health classification. The
process fields stay required — both producers today are child processes. Making them
optional for an in-process producer that does not exist would be precisely the
speculative change the guardrails ban; that edit lands with `native`, not before.

- *Alternatives considered*: a `Producer` record in a `PRODUCERS` lookup table
  (rejected — the record is a growth surface, accreting `check`, `estimateCost`,
  `supportsIncremental` one locally reasonable addition at a time, which is the exact
  decay the guardrail exists to prevent); a discriminated union with an exhaustive
  switch (rejected — identical behavior to the `if` at two producers while adding
  vocabulary it has not earned; revisit if producers ever outgrow a readable branch);
  spawning every producer including `native` behind a process boundary (deferred —
  the right answer if a producer ever needs crash isolation or a non-TypeScript
  implementation, and the option to reach for when `native` is real); a fork of
  openwiki adding a provider (rejected — we would own agent internals we do not need,
  and the upstream provider would still require a subscription-backed HTTP endpoint
  that does not exist).

### D1b: The contract is written down, not typed

What every producer must satisfy is documented, and enforced by tests and review
rather than by a type:

1. Write a conformant OKF bundle to `<clone>/openwiki/` and touch nothing else in
   the checkout.
2. Read the commit anchor from `.last-update.json` when updating; scope work to the
   supplied change set, or derive an equivalent one.
3. Never grow the existing frontmatter `type` vocabulary.
4. Report one outcome. Acceptance is not the producer's decision.

Everything about *accepting* a bundle stays outside: `verifyBundle`, grounding (D6),
the scoped-update checks (D7), the repair retry (D9), snapshot/restore, the
`.last-update.json` write (D3), and indexing.

Two invariants make this checkable by grep, which is what keeps it honest without a
type to lean on:

- **Nothing under acceptance may name a producer.** No `ProducerId` import, no
  producer string, anywhere in verify, grounding, scoped checks, or restore.
- **Selection appears in exactly one place.** A second `producerId === …` anywhere
  in the pipeline means the branch is spreading and the contract has leaked.

- *Alternatives considered*: letting each producer self-verify (rejected — parity
  enforcement would become per-producer, the exact failure the grounding gate
  exists to prevent); encoding the contract as a TypeScript interface so the compiler
  enforces it (rejected — the compiler can only enforce shape, and none of the four
  rules above are shape; the tests enforce them and the type would add nothing but
  surface).

### D2: Replace the producer process, not openwiki's model

openwiki drives a tool-calling agent loop (streaming, subagents, filesystem tools).
`claude -p` is itself an agent and exposes no raw completion surface, so it cannot
honestly serve `/v1/chat/completions`.

- *Alternatives considered*: an OpenAI-compatible shim translating chat completions
  into `claude -p` (rejected — the shim would have to synthesize `tool_calls`
  deltas for a loop running inside another loop; fragile and token-wasteful);
  pointing openwiki's `anthropic` provider at `ANTHROPIC_BASE_URL` backed by a
  subscription-OAuth proxy (rejected — cleanest wire fit, but it moves subscription
  credentials outside the first-party CLI).

### D3: `.last-update.json` is the continuity contract, owned by neither producer

Both producers read `gitHead` from it and write it back on success, preserving
openwiki's six fields verbatim. Producer identity goes in an extension field
(`producer`), never by repurposing `model`.

Anchor precedence: `.last-update.json` (wiki truth) over the registry's
`lastIndexedSha` (index truth) — they legitimately diverge on a run where indexing
succeeded but wiki generation was skipped or restored.

- *Alternatives considered*: our own sidecar under `dataDir` (rejected — a second
  source of truth, and it breaks openwiki resuming the bundle); the registry's
  `lastIndexedSha` as the sole anchor (rejected — wrong semantics, see above).

Serves: *Wiki continuity metadata*.

### D4: The prompt is a versioned skill file, injected per-run

The OKF authoring contract lives at `src/producer/skill/` — code-reviewed,
diffable, testable, not a string constant. On update runs it is given the
changed-path set and the bundle's existing `type` vocabulary, extracted
deterministically from the current bundle's frontmatter.

**It is injected with `--append-system-prompt-file`, not `--plugin-dir`.**
Measured in the 1.7 spike (`test/spike/`, CLI 2.1.228): `--plugin-dir` is a real
flag and the plugin is found, but invoking the skill inside a headless `-p` run
fails — the agent reported "a generic execution error, not a 'not found' error"
and produced no bundle, while the same contract passed as system-prompt text
produced a conformant, fully grounded bundle on the first attempt. The plugin
layout (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`) is kept anyway:
it costs nothing, it is what `--plugin-dir` would need if that path ever works,
and the skill's body is what gets injected either way. So `SKILL.md`'s body must
read standalone, with its frontmatter stripped before injection.

- *Alternatives considered*: `--plugin-dir` (measured, does not work headlessly —
  see above; the spike keeps `ODW_SPIKE_MECHANISM=plugin-dir` so a newer CLI can
  be re-tested in one command); an inline `--append-system-prompt` string
  (rejected — unreviewable and untestable at size, and a file gives the same
  injection without pasting prose into argv); seeding a skill into openwiki's own
  `~/.openwiki/skills/` (rejected — changes openwiki's behavior, not its cost).

### D5: The child is constrained to read the checkout and write the bundle

`claude -p` runs with `cwd` = the clone, an allowlist of `Read/Grep/Glob/Write/Edit`,
and `Bash` denied. Denying `Bash` is a hard requirement, not hardening: the
producer runs untrusted third-party repositories. The 1.7 spike confirms both
halves hold in practice — a `build.sh` planted in the checkout was never
executed, and every tracked source file came back byte-identical.

**Config-dir isolation is NOT available, and this corrects an error in this
decision's earlier draft.** It claimed the isolated dir would mirror the existing
`HOME=<dataDir>/openwiki-config` isolation. That mirroring is invalid: openwiki
takes its credential from the environment, whereas `claude` reads credentials
from its config dir. Measured — both `HOME=<tmp>` and `CLAUDE_CONFIG_DIR=<tmp>`
return `{is_error: true, terminal_reason: "api_error", result: "Not logged in ·
Please run /login", total_cost_usd: 0}`, while the ambient config succeeds. So
isolation costs authentication outright.

Two ways forward, to settle before 5.2: run against the operator's ambient Claude
config (simplest, but the producer shares the operator's session and settings),
or keep `ODW_CLAUDE_CONFIG_DIR` as a dir the operator authenticates into once as
a documented setup step — the analogue of `seeding.ts` for openwiki. Either way
"not logged in" is a distinct startup failure from "CLI absent" and needs its own
diagnostic, because it presents as a *successful* exit (see D8b).

- *Alternatives considered*: allowing `Bash` so the agent can run `git log` itself
  (rejected — we already pass the diff; arbitrary execution of cloned code is not
  worth saving one argument); `--dangerously-skip-permissions` (rejected for the
  same reason); an `ANTHROPIC_API_KEY` in an isolated dir (rejected — it restores
  isolation by abandoning the subscription premise of the whole change).

Serves: *Non-interactive Claude Code producer invocation*.

### D6: Grounding reads `sources:` frontmatter, not wiki body prose

Extract cited paths from each page's `sources[].resource` (`repo://<path>`,
optionally `#Lstart-Lend`), resolve them against the checkout at the indexed sha,
and score the resolved fraction — gated by a minimum citation density, because a
bundle citing nothing resolves 100% of nothing and the ratio alone is not a test.
No model, no network, fast enough to run on every production run rather than only
in an eval. On init, where there is no prior bundle to compare against, a coverage
floor catches the truncated-by-compaction case that conformance and grounding both
pass.

The signal is `sources:` frontmatter, not markdown links or path-shaped text in the
body — verified against openwiki's own real output, whose page bodies link to
*other wiki pages*, not to source files; the only place a source file is named at
all is `sources[].resource`. A citation convention the Claude producer's skill
invents for the body (a path in a code span, say) would not be what openwiki
already emits, breaking the "applied identically to both producers" premise below.
`sources:` is OKF surface both producers write into naturally — openwiki because
its own `.claims/` evidence is projected into it (see Context), Claude because the
skill instructs it to record what it read.

Applying it to *both* producers is deliberate: it gives a baseline from existing
openwiki bundles before any Claude run exists, so the floor is calibrated against
real data instead of guessed. Measured directly (see Context): 100% resolved,
density 3.9–22.8 per 1000 body words. **Open**: the exact density formula
(per-word, per-page, unique-files-cited) is not yet chosen; 1.5 must pick one
before `ODW_GROUNDING_MIN_DENSITY` has a unit.

- *Alternatives considered*: parsing wiki body text for cited paths (rejected —
  not what openwiki emits; would require inventing and enforcing a body citation
  convention neither producer has a reason to follow); an LLM judge on page quality
  (rejected as a gate — cost, nondeterminism, and self-preference bias when judging
  its own output; it stays available as an offline tiebreaker); trusting
  `verifyBundle` alone (rejected — structural conformance says nothing about
  fabricated citations).

Config: `ODW_GROUNDING_MIN` and `ODW_GROUNDING_MIN_DENSITY` serve *Bundle grounding
verification*; `ODW_INIT_COVERAGE_MIN` serves *Initial bundles must cover the
repository*.

### D7: Drift is controlled in code, not by asking the model nicely

openwiki suppressed structural drift with deterministic middleware and a critic
subagent. We replace that with three mechanical checks: a closed `type` vocabulary
extracted from the current bundle, a churn-ratio ceiling comparing bundle change to
source change, and byte-identity for pages outside the change set.

The "closed" part needs one clarification openwiki's own bundle exposes: it does
not use one `type` per page. Its real bundle reuses 14 values across 21 pages
(`architecture`, `workflow`, `concept`, `reference`, ...), so type vocabulary does
not simply grow with page count — but it is not perfectly disciplined either
(`integration guide` / `integration-guide`, `architecture-overview` /
`architecture-map` / `architecture` all appear). "SHALL NOT grow" (spec:
*Scoped updates preserve existing conventions*) has to mean *the vocabulary a page
already carries does not change*, not *no update run may ever introduce a value* —
a genuinely new kind of unit added on update legitimately needs a type nothing in
the bundle used before, and that is a normal update, not drift.

- *Alternatives considered*: prose instructions in the skill alone (rejected — drift
  is cumulative over update cycles and unenforceable by instruction); porting
  openwiki's `okf/index-sync.js` and frontmatter repair now (deferred — the repair
  retry covers the same failures at lower cost; revisit if retries are frequent).

Config: `ODW_UPDATE_MAX_CHURN_RATIO` serves *Scoped updates preserve existing
conventions*.

### D8: Rate limiting is a third outcome, not a failure

A subscription limit is a "come back later" signal. Recording it as `failed` would
mark every repo red on one exhausted limit and destroy the health signal, so it
gets its own outcome, its own event, and pauses the batch for that producer.

- *Alternatives considered*: retry with backoff inside the run (rejected — limits
  reset on the order of hours, far beyond a run timeout); treating it as success
  with a warning (rejected — hides that the wiki is stale).

### D8b: The CLI's own success signals are not evidence of success

The 1.7 spike produced a run that exited **0** with `is_error: false` and
`terminal_reason: "completed"`, having written no bundle at all, for ~$0.22 of
quota. The agent had hit an internal error, narrated it in `result`, and finished
tidily. Nothing in the child's report distinguished that from a real success.

So outcome classification (5.6) reads the CLI's fields to *label* a run, never to
*accept* one. `ok` from the process means only "the child exited cleanly"; whether
anything usable exists is decided by `verifyBundle` + grounding + coverage on the
artifact, which is why acceptance sits outside the producer (D1b) and why the
init coverage floor (D6) is load-bearing rather than belt-and-braces. A producer
that reports success and produces nothing must land as a verification failure,
not a success — and the exhausted-context risk in Risks takes exactly this shape.

`terminal_reason` is still the right field to classify *which* failure occurred
(`completed` / `api_error` / …) — more stable than matching the free-text
`result`. It just cannot be trusted to mean the work got done.

- *Alternatives considered*: trusting exit code plus `is_error` and skipping
  artifact checks on a clean exit (rejected — measured to be exactly the case
  that lies); parsing `result` prose for apologies (rejected — unbounded natural
  language as a control signal).

### D9: One repair retry, only for verification failures

Verification errors are specific and actionable, so feeding them back once is cheap
and recovers most malformed-bundle runs. Execution failures (spawn, exit, timeout,
rate limit) get no retry — nothing about them is fixable by re-prompting.

- *Alternatives considered*: unbounded retry until valid (rejected — unbounded cost
  against a rate-limited budget); no retry (rejected — discards a mostly-good bundle
  over one missing frontmatter block).

### D10: Shims for the suite, one gated live test for the assumptions

A fake `claude` on a tmpdir `PATH` with happy / malformed / rate-limited / exit-1 /
hang variants. This exercises the real spawn path and adds no test machinery.

**Amended:** an earlier draft of this decision rejected live `claude` calls in
tests outright, leaving 1.7 as a manual runbook. A runbook nobody executes
verifies nothing, and every assumption it covered is load-bearing for section 5 —
in the event, running it overturned D4 and D5 and produced D8b. So the live spike
is an automated test (`test/spike/`) gated behind `ODW_SPIKE=1`: skipped in the
default suite and in CI, so the offline-suite rule still holds for every run that
is not explicitly opted into. It pins model and effort (`ODW_CLAUDE_MODEL`,
`ODW_CLAUDE_EFFORT`) because an unpinned run is not comparable across machines or
over time, and it prints its findings so a run leaves evidence even when an
assertion fails.

A shim can only say what it was told to say — it can confirm argv, stdio, exit
codes and timeout kills, and it cannot confirm that a skill loaded, that pages
cite real paths, or what a real rate-limit payload looks like. Those need the real
binary exactly once, on the smallest possible input.

- *Alternatives considered*: ungated live calls in the default suite (rejected —
  breaks the offline rule and bills quota on every `bun test`); keeping 1.7 manual
  (rejected — see above; it is the task most likely to be skipped and the one
  whose findings changed the most); mocking our own functions (rejected — banned).

### D11: The parity harness is tooling, not a capability

`bun run eval` compares two bundles for the same repo at the same sha on
conformance, link resolution, grounding, coverage, and `hybridSearch` recall@k
against a golden question set. It has no runtime behavior, so it gets tasks but no
spec requirement. It reuses the grounding module from D6 rather than
reimplementing it.

- *Alternatives considered*: specifying the harness as a capability (rejected —
  specs describe behavior; inventing a requirement to justify a dev tool violates
  the no-over-engineering rule).

### D12: Published bundle and work-in-progress are different states

Failure isolation ("any failure restores the last verified bundle") and resumption
("keep the partial work") are in direct opposition only while both live at the same
path. They separate cleanly:

- `<clone>/openwiki/` — **published**. Always verified, always serveable, never
  partial.
- `<dataDir>/repos/wip/<repoId>/` — **work-in-progress**, beside the existing
  `snapshots/`. Accumulates across runs; never indexed, never served.

Producers write into WIP. A complete WIP that passes acceptance is promoted to
published in one atomic swap. The published bundle is therefore never partially
written during production at all — restore matters only if a promotion is
interrupted, which is a rename, not a generation.

Without this, a repo whose build exceeds one budget window can never be produced:
each night burns quota, gets cut short, discards the work, and starts over. That is
a livelock, not slow progress.

- *Alternatives considered*: producing in place and snapshotting more often
  (rejected — the published bundle would be readable in a partial state, and the
  index would serve it); keeping partial work but indexing it (rejected — an
  incoherent half-wiki in search results is worse than a stale complete one).

### D13: A build pins its target commit

While a WIP exists the repo is pinned to the commit recorded in it: no pull, no
advancing target, until production completes or is abandoned.

This is what makes resumption converge. Resuming against a moving HEAD means work
built for commit A is stale by the next night, so it is discarded and restarted —
the livelock again. A repo that takes three nights to build should produce a wiki
coherent for one commit, publish it, record that commit, and only then walk forward.
Days of lag on a repo that currently has no wiki at all is the obvious trade.

- *Alternatives considered*: rebasing partial work onto the new head each night
  (rejected — reconciling half a wiki against a moving diff is harder than the
  original problem); accepting a bundle spanning several commits (rejected — the
  continuity anchor would be a lie, and incremental updates depend on it being true).

### D14: The WIP bundle is the checkpoint — no unit manifest

Resuming means handing the producer a partially-complete bundle and telling it to
continue. It diffs intended against present (the skeleton and root `index.md` name
the target pages) and fills the gaps.

This keeps the contract uniform without a capability flag, which was the trap to
avoid. A producer that cannot resume simply redoes the work — correct, just slower —
so openwiki needs no special case and no `supportsResume` field appears anywhere.

- *Alternatives considered*: an explicit unit manifest (`{id, scope, status,
  attempts}`) with per-unit checkpointing (deferred — more precise and more
  machinery; adopt it if resumption proves unreliable in practice, which the resume
  attempt counts will show); a `supportsResume` capability flag (rejected — the exact
  interface growth D1 exists to prevent).

### D15: Resume is bounded, and exhaustion is a human signal

A repo that always dies mid-build would retry nightly forever, consuming the whole
budget and starving the fleet while never finishing. Attempts are capped; on
exhaustion the WIP is discarded, retries stop, and the repo goes red as needing
attention. That outcome wants a person — split the repo, exclude it, or run it
against an API key — not another automated attempt.

Fair dispatch is the other half: the batch is ordered by staleness rather than
registration order (`scheduler.ts:63` currently iterates `registry.repos` as
registered), so a budget-truncated batch reaches every repo over successive nights
instead of grinding the same head of the list forever. Updates are dispatched ahead
of first builds so that adding one large repo cannot stall the fleet's refresh.

- *Alternatives considered*: unbounded retry (rejected — one pathological repo
  consumes the fleet's budget indefinitely); automatic fallback to openwiki on
  exhaustion (rejected — silently switching producers mid-fleet corrupts the parity
  comparison and the recorded `producer` field; the per-repo flip stays manual).

## Risks / Trade-offs

- **Large repos exceed one run's context; the bundle comes back thin** → Compaction
  makes this silent: the run exits 0 and every existing gate passes, because the
  pages that exist are well-formed and their citations are real. The skill works in
  two phases — a skeleton pass, then one invocation per section with a bounded
  working set — and the init coverage floor (D6) is what actually detects the
  failure at runtime rather than only in the harness.
- **A build that never fits one budget window** → D12–D15: produce into WIP, pin the
  commit, resume next run, cap the attempts. Without all four, large repos are simply
  unproducible on a subscription.
- **Cumulative structural drift across many update cycles** → D7's mechanical
  checks, plus periodic full re-init when cumulative churn since the last init
  crosses a threshold.
- **Grounding floor set too high blocks legitimate runs; too low is useless** →
  Calibrate from openwiki baselines measured before cutover (D6), not from a guess.
- **Wiki decay: pages describing deleted code linger under incremental-only
  updates** → The grounding score falls as citations stop resolving, surfacing as
  yellow health. This risk is inherited from openwiki, not introduced here.
- **Throughput, not cost, becomes the constraint** → ~100 repos may not fit a
  nightly full pass on one subscription. Mitigated by per-repo migration, batch
  pause on limit, and keeping `openwiki` available as overflow.
- **Reduced feature surface vs openwiki** (no translation, connectors, QA
  subagents, mermaid) → Accepted: none is consumed by a recall-only index.

## Migration Plan

1. Measure baselines: run the D11 harness over existing openwiki bundles. This sets
   the grounding floor and the parity thresholds.
2. Land the producer with `ODW_PRODUCER=openwiki` — default behavior unchanged.
3. Write the decision rule down *before* looking at results (e.g. grounding within
   2 points of baseline, recall@5 within 3 points, conformance 100%, on ≥ 6 of 8
   sample repos).
4. Migrate a small cohort by per-repo override. Run the continuation fixture: an
   openwiki bundle at sha A, updated by `claude` to sha B, then updated by
   `openwiki` to sha C — proving the round-trip.
5. Expand cohorts while health and grounding hold. Rollback is per-repo: flip the
   override back; the bundle and index are untouched.

## Open Questions

- Default value for `ODW_GROUNDING_MIN` — deliberately deferred to the baseline
  measurement in step 1; it does not change the specs or the task breakdown.
- The `ODW_GROUNDING_MIN_DENSITY` formula (D6) — per-word, per-page, or
  unique-files-cited. Real-bundle density spans roughly 4–23 per 1000 body words
  depending on page length and topic, so per-page-count alone would conflate a
  short focused page with a thin one; 1.5 needs to pick a formula the baseline
  data can actually discriminate with, not just a threshold.
- Whether frequent repair retries justify porting openwiki's deterministic
  index-sync pass (D7) — answerable from retry rates after the first cohort.
- Whether a shared server generating wikis for ~100 repos on one subscription fits
  the operator's plan terms. This is an operator question, not a design one: the
  same producer works unchanged against an API key.
