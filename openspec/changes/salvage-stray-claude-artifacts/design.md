# Design — Salvage stray claude planning artifacts

## Context

See proposal.md — Why. In short: a `claude -p` area/plan/map session sometimes
writes its dot-file artifact to the checkout root (its cwd) instead of the
bundle, and the orchestrator reads artifacts only from the bundle
(`claudePlan.ts`'s `readPart`/`loadMap`/`loadPlan`, all `bundleDir`-relative),
so the unit is silently lost and a valid plan becomes a zero-progress partial.

The artifacts and their read sites today:

| artifact | file | orchestrator read | produced by |
|---|---|---|---|
| area map | `.odw-map.json` | `planSplit` (`claudeSplit.ts:98`) | map session |
| per-area part | `.odw-plan.part-<area>.json` | `planSplit` area loop (`claudeSplit.ts:217,252`) | one session per area |
| plan file | `.odw-plan.json` | `ensurePlan` (`claudeRun.ts:214,280`) | undecomposed planner |

All three are bundle dot-files the model is told to write at an absolute
`<bundle>/<file>` path (the `MAP_FILE:`/`PART_FILE:`/`PLAN_FILE:` directive
lines). Adoption is scoped to these three names: they are reserved by the
producer's own convention, cannot collide with tracked content, and are the
files whose *presence* the run treats as a checkpoint.

## Goals / Non-Goals

**Goals**

- A valid planning artifact found at the checkout root is moved into the
  bundle and counted, at the moment the orchestrator would otherwise declare
  its unit absent — both right after the session that (mis)wrote it and, for
  map/parts, on a later run before a replacement session would be spawned.
- Adopted artifacts pass through the existing read-and-validate paths; nothing
  new is validated, nothing is trusted because it sat on disk.

**Non-Goals**

- No recovery of misdirected page markdown (paths can collide with repo
  content; no observed failure).
- No change to prompt/path format, no mtime or age heuristics, no sweeping
  cleanup of stale strays, no change to resume-attempt semantics for sessions
  that genuinely wrote nothing.

## Decisions

### 1. One adoption primitive next to the read helpers

Add to `claudePlan.ts`:

```
adoptStray(bundleDir: string, checkoutDir: string, fileName: string): Promise<boolean>
```

It moves `<checkoutDir>/<fileName>` into `<bundleDir>/<fileName>` and returns
whether it did, **only when the bundle location is empty** (never overwrites)
and only for the exact expected file name. Callers invoke it immediately before
a presence decision and then re-read via the unchanged helpers:

- `planSplit` — when `mapped.kind === "absent"`, adopt `.odw-map.json`, reload,
  and let `loadMap`'s recorded-commit check classify it (current / stale /
  invalid) exactly as an in-place map.
- `planSplit` area loop — when `readPart` returns `absent` at the top of the
  loop and again after the session returns, adopt `partFileName(area.id)`,
  re-read, and let the existing branches decide (counts / not planned).
- `ensurePlan` — when the planner session has returned and `loadPlan` is not
  `unapplied`, adopt `.odw-plan.json`, reload, and only then declare "no plan".

Rationale: `readPart`/`loadMap`/`loadPlan` stay pure (no mutation, no hidden
cwd dependency) and are reused by validation paths that must not move files;
the orchestrator is the only place that knows the session's cwd and the moment
a unit would be declared absent.

Alternatives considered: folding adoption into the read helpers by passing
`checkoutDir` — rejected: reads would mutate and merge/validation callers gain
an irrelevant write capability. Scanning the checkout for new `.odw-*` files
after each session — rejected: needs an allowlist and risks adopting stale
strays that match no live unit.

### 2. Same-session adoption for the plan file; cross-run only for map/parts

An unapplied plan has no commit stamp until apply, so a stray `.odw-plan.json`
left by an *earlier* run could encode a plan for a different commit; adopting
it on a later run would resurrect stale context. So `ensurePlan` adopts only
the plan the session that just returned could have written. The map is safe to
adopt across runs only because `loadMap` records and checks the target commit
(a stale stray map is discarded and re-planned like an in-place stale map). A
part is safe to adopt across runs only because a preserved WIP pins the build's
commit (`updateRepo` skips the pull while pinned), so the resumed run builds
the same tree the stray part was made against.

Alternatives considered: adopt the plan across runs too — rejected (no commit
check on unapplied plans, stale-init-plan risk). Adopt nothing across runs —
rejected: a session killed mid-write after landing its part at the root is
exactly the interruption the checkpoint design exists to survive.

### 3. No counter or reporting changes beyond a note

An adopted part flows into the existing `part.kind === "ok"` branch, so it
already increments `run.units` and emits the area progress beat — which is what
keeps an adoption-only run off the resume-attempt counter (spec: "Recovered
part is not zero progress"). Adoption also pushes one note
(`area <id>: part recovered from the checkout root`, analogously for map/plan)
so the operator sees the recovery in `stderr`, mirroring the existing
"part discarded" notes. No new config knob: the behavior is unconditional and
needs no scenario-varying gate.

Alternatives considered: a per-repo opt-out knob — rejected, no requirement
names one and no operator scenario calls for disabling a rescue.

## Risks / Trade-offs

- [A stale valid-looking stray is adopted] → the plan file is limited to the
  session that just ran; the map's recorded commit gates adoption outcome; a
  part is adopted only while a WIP pins the build to the commit the stray was
  written for; every adoption still passes the existing parse/shape/usable-path
  validation, and downstream acceptance (scope, grounding) gates the published
  bundle. Residual: a same-named part stray from a *different* commit could be
  adopted if no WIP exists and the map reuses the area id — accepted; the run's
  own sessions normally overwrite nothing, and the acceptance gate bounds the
  blast radius.
- [The bundle directory and checkout sit on different filesystems, breaking a
  naive rename] → both live under `<dataDir>/repos/<repoId>/`, one volume;
  the primitive falls back to copy+unlink on `EXDEV` if that ever changes.
- [Adoption hides a session that wrote nothing because a stale file matched]
  → bounded by the exact-name, empty-bundle, validation gates above; noted as
  the accepted residual risk rather than engineered around.

## Migration Plan

Behavioral change behind the existing producer branch; no schema or storage
migration. Rollback: revert the spec delta and the code; a published bundle
is untouched either way (adoption operates on WIP/planning state only).

## Open Questions

None — the deferred details (exact note wording, where each test lives) are
implementation choices that cannot change the spec or the approach.
