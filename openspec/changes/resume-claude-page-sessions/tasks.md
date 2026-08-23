## 1. Live spike: pin the CLI session semantics

- [ ] 1.1 Add gated `test/spike/sessionResume.spike.test.ts` (skipped unless `ODW_SPIKE=1`): spawn a real `claude -p --session-id <uuid>` session that writes a marker, SIGKILL it mid-run, then `--resume <uuid>` in the same cwd and assert the continuation sees the prior turn; also assert an unknown ID exits non-zero with no result JSON. Verify: `ODW_SPIKE=1 bun test test/spike/sessionResume.spike.test.ts` passes. If resume-after-SIGKILL does not hold, stop and revisit design.md before wiring anything to it.

## 2. Session identity in the session substrate (`claude.ts`)

- [ ] 2.1 Extend the one-shot `--help` probe to report session-flag support (`--session-id`, `--resume`) alongside `--setting-sources`, still one spawn per run. Verify: `claude.test.ts` drives a help banner with and without the flags and asserts both capability values.
- [ ] 2.2 Teach `runSession` to append `--session-id <id>` for a fresh session or `--resume <id>` for a continuation from an optional session argument. Verify: `claude.test.ts` asserts the exact flag pair in the spawned argv for both modes.

## 3. Checkpoint sidecar (`claudePlan.ts`)

- [ ] 3.1 Add `.odw-sessions.json` helpers — read (corrupt or absent yields no records), record, and clear a page's identity — written atomically via temp file + rename; extend `clearPlanningArtifacts` to remove the sidecar. Verify: unit tests cover round-trip, corrupt-file fail-soft, replacement, and that the sidecar is gone after finish/repair/apply while surviving a resumable-plan apply.
- [ ] 3.2 Verify a published bundle carries no session records: extend the existing checkpoint-invisibility test to assert `.odw-sessions.json` is removed by finalization paths and never surfaces as a page.

## 4. Test shims for resume

- [ ] 4.1 Extend `test/helpers/shim.ts`: capture `--session-id`/`--resume` values into a log, provide a resume-aware session shim (asserts its own identity is already in the sidecar before it would write), an unresumable variant (prints `No conversation found with session ID: …`, exit 1, no JSON when resumed), and keep a legacy probe without the session flags. Verify: used by the task 5 tests, which fail without the capture.

## 5. Page-pool resume (`claudeRun.ts`)

- [ ] 5.1 Route pool and overview sessions through one helper: a fresh page session records its generated identity before spawn; a missing page carrying a record resumes it with the continuation prompt; produced and terminally failed pages drop the record; interruptions keep it. Verify: pool/checkpoint tests cover identity-before-spawn, resumed-not-restarted, repeated-interruption resume, and produced/terminal drop.
- [ ] 5.2 Fall back in the same run when the CLI refuses a resume: classify a non-zero resume exit with no result payload and no timeout/abort as unresumable, spawn a fresh session for that page with a new identity, and replace the record. Verify: the unresumable shim test asserts the page is produced in the same run and the record now holds the fresh identity.
- [ ] 5.3 Keep the continuation prompt parseable and current: rebuild the page directives with current link targets and append the interruption note, first line still `PAGE_PATH:`. Verify: the resumed shim's captured prompt carries `PAGE_PATH:` and the interruption note.
- [ ] 5.4 Degrade on a CLI without the flags: no session argument reaches any spawn and runs behave exactly as before. Verify: the legacy-probe test asserts no `--session-id`/`--resume` in argv and the pool completes normally.

## 6. Gates

- [ ] 6.1 Run `bun run test`, `bun run lint`, `bun run typecheck`, and `openspec validate resume-claude-page-sessions --strict`; fix anything they surface.
