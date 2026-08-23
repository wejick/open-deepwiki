## Why

A usage limit aborts the page pool by killing every in-flight page session — up
to the configured worker count. All of their work is lost: the next run starts
those pages from zero, re-paying each session's fixed cost (contract, repo
orientation, file reads) with no credit for what the killed session had already
explored. Claude Code keeps per-session transcripts and can continue one by ID
(`claude -p --resume`), and this pipeline is unusually safe to resume because a
live work-in-progress area pins the target commit, so the tree a resumed
session sees is byte-identical to the one it was working against.

## What Changes

- A page session's identity is assigned by the producer before it spawns
  (`--session-id <uuid>`) and recorded, before the child starts, in a
  producer-owned checkpoint file inside the bundle. A kill cannot lose state
  that was persisted first.
- On a later run, a planned page that is still unproduced and carries a
  recorded identity is continued with `claude -p --resume <id>` and a
  continuation prompt instead of a fresh session. Resumed sessions join the
  same pool, share the whole-run deadline, and are cancelled by the same
  abort as fresh ones.
- Resume persists until the page is produced or the session ends in a terminal
  failure. Producing the page, or a terminal failure, drops the record; an
  interruption keeps it. A resume the CLI refuses — the transcript is gone —
  falls back to a fresh session in the same run and replaces the record.
- The session flags are passed only when the installed CLI advertises them;
  without them the producer runs exactly as it does today, with no session
  identity and no resume.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `okf-producer`: the Claude producer's page pool resumes interrupted page
  sessions from a durably recorded identity rather than always starting them
  fresh, degrading to fresh sessions when the CLI cannot resume or a record is
  unusable.

## Non-goals

- No resume for planning, map, area, or repair sessions; their units already
  checkpoint by artifact presence.
- No change to resume-attempt accounting or work-in-progress semantics.
- No new configuration knob.
- No switch to `--output-format stream-json` and no output scraping; identity
  is assigned, not observed.
- No `--fork-session` experimentation.

## Impact

- `src/producer/claude.ts`: `runSession` gains the session flag pair; the
  one-shot `--help` probe reports both capabilities.
- `src/producer/claudeRun.ts`: the pool and overview resume-or-fresh decision,
  the continuation prompt, pre-spawn recording, post-session clearing, and the
  unresumable fallback.
- `src/producer/claudePlan.ts`: the checkpoint sidecar (`.odw-sessions.json`)
  read/write/clear helpers, atomic writes, and cleanup.
- Tests: shim variants and pool/checkpoint tests; a gated live spike proving a
  killed session resumes.
