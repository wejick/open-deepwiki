# Tasks: stale-run-liveness

## 1. Lock liveness and takeover (repo-manager delta)

- [x] 1.1 Add `readLockHolder` (parse the lock body to `{pid, startedAt}` or null) and
  `isPidAlive` (`process.kill(pid, 0)`: ESRCH = dead, otherwise alive) to
  `src/repoManager/lock.ts`; new `lock.test.ts` verifying a live pid (a real spawned
  child), a dead pid (a spawned child awaited to exit), and a garbage lock body
  (unparseable → null holder), using a tmpdir lock path and no mocks
- [x] 1.2 Rework `acquireRepoLock`: dead holder pid → take over immediately (remove the
  file, then re-attempt the exclusive `wx` create); unparseable body or live pid →
  return busy until the 12h age window, after which the same remove-then-create takeover
  applies; extend `lock.test.ts` with the four repo-manager scenarios — fresh lock with
  live pid returns null; dead-pid lock of any age is acquired; garbage-body lock under
  12h returns null and past 12h is acquired (set the file's mtime back to fake age);
  takeover genuinely succeeds on an existing file (regression for the `wx`-on-existing
  EEXIST bug)

## 2. Run-state classification (monitoring delta)

- [x] 2.1 Add `runState: "running" | "interrupted" | null` to `RepoStatus` and compute it
  in `buildStatusSummary` for exactly the started-without-finish repos: read the lock via
  `readLockHolder`, `interrupted` only when a parsed lock's pid is dead, `running`
  otherwise; keep the stored start/finish fields and the health color untouched; tests in
  `src/monitor/` covering the four monitoring scenarios — live lock holder reads running,
  dead-pid orphaned run reads interrupted with unchanged health, absent lock reads
  running, and a repo with no started-without-finish run reports null
- [x] 2.2 Verify the classification is carried through the serving surfaces without
  further changes: `server_status` MCP tool response and CLI `status --json` both
  serialize the shared summary — assert `runState` appears in each payload via existing
  test entry points (loopback fetch to an ephemeral-port server for the MCP tool, direct
  summary serialization for the CLI)

## 3. Dashboard rendering (dashboard delta)

- [x] 3.1 Update the repo row rendering in `src/server/dashboard.js` (and
  `dashboard.d.ts`) to prefer `runState`: `running` renders as today's
  `running… since <time>`, `interrupted` renders `interrupted since <time>`, and a
  payload without the field falls back to the existing start/finish derivation;
  `dashboard.test.ts` gains the three dashboard scenarios — classified running renders
  in progress, interrupted renders interrupted (not running), and a field-less entry
  renders exactly as before

## 4. Validation

- [x] 4.1 Run the full gate: `bun test ./src ./test`, `bun run lint`, `bun run
  typecheck`, and `openspec validate --specs`; every scenario named in the three delta
  specs maps to a passing test
