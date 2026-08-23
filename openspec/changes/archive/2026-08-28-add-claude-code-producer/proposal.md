## Why

Wiki generation is the only metered part of the pipeline: `openwiki` drives a
DeepAgents loop against a paid endpoint, once per repo, ~100 repos, nightly.
Operators holding a Claude subscription pay twice. The `claude` CLI is a
first-party, subscription-backed agent that reads a repo and writes files — the
producer contract exactly.

Feasibility is established: openwiki's continuity state is one file,
`<clone>/openwiki/.last-update.json`, with no hidden sidecar state, and its reader
ignores unknown fields — so either producer can continue the other's bundle.

## What Changes

- A written producer contract, selected by id from config or the registry. No
  interface and no new pipeline path: one branch where the bundle is produced, and
  the existing run cycle reused around it.
- A second producer implementing it: `claude -p` against the managed clone, guided
  by a repo-owned skill carrying the OKF v0.2 authoring contract.
- Producers read and write `.last-update.json` so migration is per-repo and
  reversible in both directions.
- Bundle acceptance — shared by every producer — gains **grounding**, **coverage**,
  and **scoped-update** checks, plus one repair retry.
- Production becomes resumable: work goes to a staging area, a build pins its target
  commit, an exhausted budget preserves partial work, and the next run continues it.
  Without it, a repo too large for one budget window is unproducible.
- Rate limits become a distinct `rate_limited` outcome that pauses the batch, and
  dispatch is ordered by staleness so a truncated batch still reaches every repo.

## Non-Goals

- Not removing openwiki. It stays the default and the fallback.
- No native producer here; the contract accommodates one, nothing builds it.
- No OpenAI-compatible shim over `claude -p`, and no proxying of subscription
  credentials to a third-party endpoint.
- Embeddings are unchanged — Claude has no embeddings endpoint; `ODW_EMBEDDING_*`
  keeps its OpenAI-compatible provider.
- No reimplementation of openwiki's translation, connectors, or QA subagents.

## Capabilities

### New Capabilities

<!-- None — this extends existing capabilities. -->

### Modified Capabilities

- `okf-producer`: the producer contract and selection, `claude -p` invocation,
  continuity metadata, grounding + proportionality verification, repair retry,
  rate-limit outcome.
- `repo-manager`: per-repo producer override; batch pauses on rate limit.
- `monitoring`: `rate_limited` event and health state; producer and grounding score
  surfaced in status.

## Impact

- `src/producer/` (new `claude.ts`, `grounding.ts`, `continuity.ts`, `wip.ts`, skill
  dir), `config.ts`, `pipeline.ts`, `scheduler.ts`, `registry.ts`, `health.ts`.
- New external prerequisite: `claude` CLI (optional — only when selected).
- No new npm dependencies.
