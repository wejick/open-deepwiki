# AGENTS.md

Working agreements for AI coding agents in this repository. Read before writing any code.

## Project

**open-deepwiki** — org-scale (~100 repos), self-hosted DeepWiki clone.

Pipeline: pure-git repo manager → `openwiki` CLI adapter (writes OKF v0.2 markdown
bundles into each managed clone) → shared libSQL index (metadata + quantized
vectors, no text bodies) → shared-LAN MCP HTTP server (bearer token) serving
recall-only tools to Claude Desktop and other MCP clients.

Status: **implemented**. Two changes are applied and archived under
`openspec/changes/archive/` — `init-open-deepwiki` (the pipeline) and
`add-claude-code-producer` (the second producer). Their requirements live in the
main specs under `openspec/specs/`, which are the source of truth for behavior;
read them before changing code.

## Spec-driven workflow

- Behavior changes require the corresponding spec requirement to change first.
  Never implement beyond what a requirement says.
- Work through `tasks.md` in order; check off tasks only when their tests pass.
- Validate after editing artifacts: `openspec validate --specs`.
- Every requirement has testable scenarios — those are your test plan.

## Tech stack (fixed — do not introduce alternatives)

- **Bun ≥1.4** is the runtime, package manager (`bun.lock`), and test runner
  (`bun:test`). Bun executes TypeScript natively — no ts-node, no build step.
- TypeScript latest 5.x, ESM + NodeNext, strictest flags: `strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`.
  Type-only imports; unions + `satisfies` over enums.
- Lint/format: **oxlint** (strict rules) + **oxfmt**. No eslint, no prettier.
  `tsc --noEmit` covers type-aware checks (oxlint is not type-aware).
- Storage: **`@libsql/client`** embedded `file:` mode, built-in vectors
  (`F32_BLOB` + `vector_distance_cos`). No native extensions, no sqlite-vec,
  no better-sqlite3.
- Server: `@modelcontextprotocol/sdk`, Streamable HTTP transport.
- External CLI prerequisites (spawn as child processes): `openwiki` (pinned
  `^0.3`; install under Node with `npm i -g openwiki` — native better-sqlite3
  bindings don't build under bun's global install), `rg` (ripgrep). Install/auth
  them; never reimplement them.
- Allowed deps: `simple-git`, `node-cron`, `gray-matter`/`yaml`, `zod`,
  `@toon-format/toon` (mcp-server tool response encoding),
  OpenRouter SDK (single OpenAI-compatible endpoint config), `markdown-it` +
  `shiki` (server-side `/wiki` page rendering), `mermaid` — two consumers: its
  installed `dist/` is served as a static client-side asset for diagram
  rendering (a file path string, not a TS `import`), and the `claude`
  producer's bundle finalizer (`src/producer/claudeFinalize.ts`) imports it directly
  to validate diagrams before they ship. `jsdom` exists solely so that second
  consumer can import `mermaid` headlessly — its flowchart/state-diagram
  parsers call DOMPurify, which needs a DOM; nothing else uses `jsdom`. A new
  dependency must name the requirement it serves.

## Engineering guardrails (hard rules)

1. **No over-engineering.** Ship the smallest thing that satisfies the spec.
   Every addition traces to a requirement; if it doesn't, it's cut.
2. **BANNED: multi-layer abstraction** — no clean/onion/hexagonal architecture,
   no use-case/handler indirection, no repository or service interfaces over a
   single implementation, no DI containers or factories, no port/adapter seams,
   no barrel re-export files.
3. **Flat, concrete code.** `src/<capability>/*.ts`:
   `config`, `producer`, `index`, `repoManager`, `server`, `monitor`, `cli`.
   Functions import and call what they use directly. The only swap points
   (openwiki child process, LLM endpoint) are process/config boundaries —
   they must not grow code seams.
4. **Tests ship with every task**, in the same task's scope. Use `bun:test`.
   Mock child processes (`openwiki`, `rg`, `git`) and HTTP (LLM/embeddings);
   never mock our own internal functions — call them with fixture data.
   Fixture repos/wiki bundles live on disk under `test/fixtures/`. No live
   network in tests.
5. **Config knobs need a scenario** that consumes them, or they don't exist.
6. **Comments describe, they don't narrate or compare — and length is
   proportional to what's actually non-obvious, not a target.** State the
   reason the code must be this way (a rejected alternative, a measured
   finding, an outside constraint) in as much or as little as that genuinely
   takes; don't pad it out, and don't compress two real facts into one
   run-on clause just to look short. What to cut: the mechanism the code
   already shows step by step, and any contrast against a prior version
   ("now", "used to", "as before") — both are a second account of something
   that drifts out of sync when the code changes. Tighten a bloated comment
   you find while editing a file even if you didn't write it. Baseline:
   13-19% comment lines in `src/`, 3-5% in tests.

## Testing mechanics

Exactly three techniques; no mocking framework:

1. **Shim binaries on PATH** — for `openwiki`/`rg` child processes. Write a
   3-line executable into a tmpdir, prepend it to the child spawn's `PATH`.
   Variants: happy (copies a fixture bundle), exit-1 (failure isolation),
   hang (timeout), absent (degradation). This exercises the real spawn path
   (argv, stdio, exit codes) with zero `mock.module`.
2. **Stub `globalThis.fetch`** — the only network boundary. Deterministic
   `fakeVec(text)` (hash → vector) makes vector search, RRF ordering, and
   centroid routing assertable offline.
3. **Real everything else** — libSQL as a tmpdir `file:` DB per test; real
   `rg` against fixtures; real `git init`+commits for fixture repos (offline);
   server on an ephemeral port hit via real loopback fetch + MCP client.

Conventions:
- Test names mirror spec scenarios: `"<Requirement> › <Scenario>"` — a failing
  test points at the violated spec line. Every `#### Scenario:` in the specs
  gets a test.
- Golden fixtures under `test/fixtures/`: a valid OKF bundle, a malformed one
  (missing frontmatter / empty `type`), a mini-git-repo generator.
- No sleeps: await real promises; concurrency assertions use in-flight counters.
- Suite runs fully offline in seconds.
- **Live key**: `.env` (git-ignored, auto-loaded by Bun) holds the real
  OpenRouter key — used ONLY for the headless spike (2.1) and manual runs.
  Tests never read `.env`; they use the `fakeVec` fetch stub.

## Architectural invariants (do not violate)

- The server is **recall-only**: it never synthesizes answers, never runs an
  agent loop. The only model call is the embeddings API. Claude synthesizes.
- **No body text in the database.** Chunks store path + line ranges + hash;
  text is read from disk at query time.
- **One shared libSQL database** (`<dataDir>/index.db`), every table scoped by
  `repo_id`, WAL mode. Repo removal is a transactional purge.
- The OKF bundle (`<clone>/openwiki/`) is openwiki's artifact — **read-only**
  for us. Never rewrite, never move it. One exception: `INSTRUCTIONS.md` is
  openwiki's wikiGoal INPUT — the pipeline seeds/refreshes it from the
  registry's per-repo `instructions` before every run; no other bundle file
  is ever written.
- Lexical search = **ripgrep** (single invocation, term alternation, JSON
  match attribution). No FTS, no BM25. Ranking = density × distinct-term
  coverage, fused with vectors via weighted RRF at path level.
- Embeddings quantized by default (int8 or ≤512-dim).
- Monitoring is a **read surface**: health computed at read time, no metrics
  stores, no new state.
- **Admin write surface**: the dashboard + admin API (`/api/*`, mounted only
  when `serve` holds a writable DB handle) are the server's ONLY write paths —
  MCP tools stay read-only. Registry write discipline: run-outcome writers
  (scheduler, updates, adds) write `state.json` only; human-config edits
  (instructions) write `registry.yaml` only; add/remove write both — a
  mid-batch edit must never be clobbered by a batch's final save.
- **Dashboard shell is untokened**: `GET /` + `GET /dashboard.js` carry no
  data and are served without a token even on LAN binds; every data endpoint
  (`/status`, `/mcp`, `/api/*`) stays tokened. The page's JS is plain vanilla
  with exported pure helpers (unit-tested in Bun) and DOM wiring behind a
  `document` guard — no framework, no build step, no external assets.
- **`/wiki` is a separate, server-rendered read surface**, not the dashboard:
  full HTML pages rendered per request from the same chunks/bundles the MCP
  tools read, real `/wiki/<repoId>/<path>` URLs, no client router. Auth is
  self-contained — a cookie (set once via `/wiki?token=<token>`) carrying the
  same shared bearer token — and does not touch `/api/*`/`/mcp`'s header
  check or their auth behavior. `index.md` files are read straight off disk
  (never through the DB — they're excluded from indexing) for repo-root and
  directory listings; concept pages come from the DB like `get_wiki_page`.
  Markdown rendering (`markdown-it` + Shiki) is server-side only; the one
  client script is a lazy-loaded Mermaid module, included only on pages that
  actually contain a diagram.
- Repo access is **pure git** (clone/pull via server credentials). No GitHub/
  GitLab APIs, no webhooks.
- Unscoped searches route via repo centroids to top-k repos; results always
  carry repo attribution.

## The producer contract

A *producer* turns a checkout into an OKF bundle. Two exist: `openwiki` (the
default and fallback) and `claude` (`claude -p`, subscription-backed). The full
contract lives in `src/producer/CONTRACT.md`; the short form:

1. Write the bundle to `<clone>/openwiki/` and touch nothing else.
2. Read the commit anchor from `.last-update.json` when updating; scope work to
   the supplied change set, or derive an equivalent one.
3. Never reassign an existing page's frontmatter `type` (a new page may
   introduce a new value).
4. Report exactly one outcome — `ok` | `failed` | `rate_limited`. **Acceptance
   is not the producer's decision.**

`claude` is **orchestrated**: a planning session emits a validated page plan,
page sessions — up to a configured number concurrently, one page each — produce
the pages, and a guaranteed `overview.md` entry
point is produced last from the pages that actually shipped — openwiki's own
planner/worker shape. The plan file doubles as the checkpoint: the planner
writes `<bundle>/.odw-plan.json` (`producer/claudePlan.ts`, a dot-file nothing
downstream sees), a page's completion is its presence in the bundle, and the
file is stamped once its deletions have run — so an interrupted run keeps its
finished pages and the next run resumes at the rest. A run that ends
incomplete sets `ProducerRun.partial`, and `run.ts` preserves the
work-in-progress area on that exactly as it does on a rate limit — which is what
stops a repo too large for one budget window from restarting at page one every
night. `openwiki` never sets the field and is unaffected.

Producer choice is a config value plus **one branch**, not an interface — so the
"no port/adapter seams" rule above stands unamended. Two invariants keep that
honest, both enforced by `src/producer/contract.test.ts` and both confirmed to
fail when deliberately violated:

- **Nothing under acceptance may name a producer** — no `ProducerId` import and
  no branching on a producer id in verify, grounding, or the scoped checks.
- **Selection appears in exactly one place** — every `producerId === …` lives in
  `run.ts`; resolution (`producerFor`) lives in `registry.ts`.

Adding a producer costs one config union member, one branch arm, and one new
file. Nothing under acceptance is touched.

**Producer module naming**: `run.ts` is the orchestrator and the only file
that may branch on producer id. Each producer is `<producerId>.ts`
(`openwiki.ts`, `claude.ts`), and any module private to one producer carries
its prefix (`claudeFinalize.ts`, `claudePlan.ts`). Unprefixed files are
producer-blind shared code (`acceptance.ts`, `verify.ts`, `grounding.ts`,
`contract.ts` — the shared `ProducerRun`/`ProducerInput` vocabulary). State
modules are named for their scope: `anchor.ts` is artifact-scoped (the
published bundle's `.last-update.json`), `wip.ts` is build-scoped (the
in-flight area under `repos/wip/`).

### Bundle acceptance

Every producer's output passes the same gate before it is indexed. A producer's
own "success" is never taken as proof it produced anything useful — a measured
`claude` run exited 0 with `terminal_reason: "completed"` and wrote no bundle.

| Check | What it catches |
|---|---|
| conformance | missing/unparseable frontmatter, no root `index.md` |
| grounding | pages citing source paths that do not exist, including a `#Lstart-Lend` fragment past the end of the file, or reached through a symlink (`lstat` + a realpath containment check, so a repo cannot point evidence at a host file) |
| citation density | a bundle that cites nothing, and so resolves 100% of nothing |
| link score | in-body cross-page links (`resolveLink`, the same resolver the indexer uses) that don't resolve to a page in the bundle |
| init coverage | a bundle truncated by an exhausted context |
| scoped update | rewriting pages the change set never touched, or reassigning a page's `type` |
| churn ratio | a bundle change wildly out of proportion to the code change |

Like grounding, the link score ships at floor 0 (`ODW_LINK_MIN`, measure don't
gate) — `test/fixtures/bundles/valid` itself carries one deliberately
unresolved link, used as the happy-path fixture across most of the test suite,
so an unconditional failure would be wrong on its own terms.

Before acceptance ever sees a `claude`-produced bundle, `claude.ts` runs a
finalization pass (`src/producer/claudeFinalize.ts`) that regenerates every
directory `index.md` from what's actually on disk and degrades any Mermaid
fence that fails to parse (real `mermaid` + a `jsdom` DOM shim, not a
heuristic) to plain text. This runs only for the `claude` producer — openwiki
already does the equivalent internally before its own CLI exits, and its
bundle is never rewritten.

The scoped-update check reads a page's citations from **both sides** of the run.
A page deleted because the file it documented was deleted has no post-run
citations, so judging it on those alone would make every legitimate deletion a
scope violation.

A rejected bundle is restored from the last verified snapshot; the index is left
alone. One repair retry is attempted, for acceptance failures only.

```ini
ODW_CLAUDE_TIMEOUT_SEC=3600    # whole-run budget: planner + page sessions + overview
ODW_CLAUDE_STEP_TIMEOUT_SEC=1800 # one session's budget
ODW_CLAUDE_PAGE_WORKERS=1      # concurrent page sessions (1 = sequential); they share
                               # the whole-run deadline, never divided among workers
ODW_CLAUDE_MAP_MODEL=          # per-step overrides, empty = ODW_CLAUDE_MODEL/EFFORT:
ODW_CLAUDE_MAP_EFFORT=         #   map = the area-map session
ODW_CLAUDE_PLAN_MODEL=         #   plan = planner + every area session
ODW_CLAUDE_PLAN_EFFORT=
ODW_CLAUDE_PAGE_MODEL=         #   page = page/overview/repair sessions
ODW_CLAUDE_PAGE_EFFORT=
ODW_CLAUDE_SPLIT_PLAN_FILES=2000 # init only: tracked files above which planning splits
                                 # (map session + one bounded session per area), so one
                                 # lost session costs an area, never the whole plan
ODW_GROUNDING_MIN=0            # 0 = measure but do not gate (the default)
ODW_GROUNDING_MIN_DENSITY=0
ODW_LINK_MIN=0
ODW_INIT_COVERAGE_MIN=0
ODW_UPDATE_MAX_CHURN_RATIO=0
```

The floors ship at 0 deliberately. Scores are recorded from the first run, so an
operator measures their own baseline with `bun run eval` before enforcing
anything; an uncalibrated floor rejects bundles from a producer that simply does
not cite. Do not raise these defaults without baseline data — task 1.5 is open
for exactly this reason.

The churn ratio in particular runs high by construction: a bundle has far fewer
pages than the repo has files, so one page revised for one changed file out of
500 already measures ~25x. It is reported on every update — read a few real
numbers off `repo list` before choosing a ceiling.

A usage limit is **not** a failure: it is recorded as `rate_limited`, which is
neither success nor failure, the repo goes yellow rather than red, the published
bundle stays queryable, and any reset time the provider reported is stored so the
next batch can wait.

Every path that finishes a run records it through `recordRun` — the CLI, the
admin API and the nightly batch alike. It is the only writer of `lastRun`,
`lastIndexedSha` and `lastSuccessAt`; a second recorder flattens `rate_limited`
to `failed` and silently drops `resetAt` and the grounding score.

A limit is classified from the payload's `api_error_status`, then from whether
the run completed, and only then from the wording of `result`. That order
matters: `result` is the model's own summary of the work it did, so a wiki for a
throttling library legitimately says "rate limiter" in it.

### Migrating a repo between producers

Migration is per-repo and reversible in both directions, because both producers
read and write the same `openwiki/.last-update.json`.

1. **Check it is worth it.** Token usage is **not** recorded — the field exists
   in state and in `status --json` but is always null, because no producer's
   usage figures are threaded through — so estimate openwiki spend from your
   provider's own billing, not from here. The per-run floor for `claude` barely
   shrinks with repo size — agent overhead dominates — so a fleet of small repos
   saves less than it looks like it should.
2. **Measure a baseline first**:
   `bun run eval --checkout <clone> --a <clone>/openwiki`. Write the decision
   rule down *before* looking at the comparison.
3. **Move one cohort**: `bun odw repo add --producer claude …`, or set
   `producer: claude` on existing `registry.yaml` entries.
4. **Compare** the same repo at the same commit:
   `bun run eval --checkout <clone> --a <claude-bundle> --b <openwiki-bundle>`.
5. **Raise the floors** once the numbers are trustworthy.
6. **Roll back** by flipping the value back — bundle and index are untouched, and
   openwiki reads the recorded `gitHead` and picks up incrementally.

`repo list` annotates a non-default producer and the last grounding score. A repo
that **exhausts its resume attempts** stops being retried and is surfaced for a
decision, because more automated attempts will not help: split the repo, exclude
it with `--no-wiki`, or run that one against an API key instead of a
subscription.

### Published vs work-in-progress

Two bundle states at two paths, so "keep the partial work" and "any failure
restores the last good bundle" stop contradicting each other:

- `<clone>/openwiki/` — **published**. Always accepted, always serveable,
  **never partial**.
- `<dataDir>/repos/wip/<repoId>/` — **work in progress**. Accumulates across
  runs, never indexed, never served, records `{targetSha, producer, attempts}`.

A build **pins its target commit** — the HEAD it is building, never the anchor
it is building away from — while a WIP exists, so multi-run production converges
instead of chasing a moving head. Pinning the anchor instead would hand the
resumed run an empty change set. An interrupted **first** build has no anchor at
all, and that is the case the WIP area exists for, so preservation keys off the
target and never off the anchor. Promotion is all-or-nothing: an
accepted bundle is already at the published path, so promotion is "keep it and
drop the WIP". A WIP whose recorded producer differs from the one now selected
is discarded rather than resumed. Preservation fires on `rate_limited` **or** on
a run reporting `partial` — a producer saying it left resumable work — which is
how an oversized repo accumulates attempts instead of silently restarting.
Attempts are capped
(`ODW_MAX_RESUME_ATTEMPTS`); on exhaustion the WIP is dropped and the repo is
surfaced for a human.

## Runtime mechanics (verified live against openwiki v0.3.3 and Claude Code 2.1.228)

- **openwiki isolation**: the CLI hardcodes `~/.openwiki` (no config-dir env
  override in v0.3), so the adapter spawns it with `HOME=<dataDir>/openwiki-config`
  where the openwiki module pre-writes the onboarding gate (`onboarding.json`
  `{completedAt, modeId:"code", version:1}` + non-empty `INSTRUCTIONS.md` +
  provider `.env` with `OPENWIKI_PROVIDER` / `OPENROUTER_API_KEY` or
  `OPENAI_COMPATIBLE_API_KEY`+`BASE_URL` / `OPENWIKI_MODEL_ID`).
- **No `--version` flag**: version is parsed from the `--help` banner
  (`OpenWiki v0.3.3`); major-version mismatch warns but still runs.
- **Failure isolation**: after every successful run the verified bundle is
  snapshotted; any failed run (non-zero exit, timeout, conformance failure)
  restores the last good bundle and leaves the index untouched.
- **Embeddings**: `<baseUrl>/embeddings` (OpenAI-compatible), truncated/padded
  to `ODW_EMBEDDING_DIM` (default 512); provider failure degrades to
  metadata-only indexing (lexical search keeps working).
  `ODW_VECTOR_MIN_SIMILARITY` (default 0.05) gates ask_repo's honest
  "no relevant content" response.
- **claude producer** (measured in the gated live spike, `test/spike/`):
  - The authoring contract is injected with **`--append-system-prompt-file`**,
    NOT `--plugin-dir`. `--plugin-dir` is a real flag and the plugin is found,
    but invoking the skill inside a headless `-p` run fails with a generic
    execution error and no bundle is written. The plugin layout is kept so the
    other path can be re-tested (`ODW_SPIKE_MECHANISM=plugin-dir`).
  - **No config-dir isolation.** Both `HOME=<tmp>` and `CLAUDE_CONFIG_DIR=<tmp>`
    return `"Not logged in · Please run /login"`: `claude` reads credentials
    from the very directory openwiki-style isolation would replace. This is the
    one place the two producers genuinely differ. `ODW_CLAUDE_CONFIG_DIR` is
    honored only if the operator authenticated into it once.
  - A run is **several sessions**, each spawned with the same flags:
    `ODW_CLAUDE_STEP_TIMEOUT_SEC` (default 1800) bounds one session and
    `ODW_CLAUDE_TIMEOUT_SEC` (default 3600) bounds the whole run. Each prompt
    carries one machine-readable directive line — `PLAN_FILE:` for the planner,
    `MAP_FILE:` for the map session, `AREA_ID:`/`PART_FILE:` for an area session,
    `PAGE_PATH:` for a page — which the shell shims in `test/helpers/shim.ts`
    read out of argv, so the tests still exercise the real spawn path.
  - The authoring guidance is composed per phase: `SKILL.md` is the contract
    every session inherits, plus `PLANNER.md`, `MAP.md` or `PAGE.md`.
  - **Init planning splits above `ODW_CLAUDE_SPLIT_PLAN_FILES`** (default
    2000 tracked files): a map session (seeded by a git-derived digest at no
    model cost) writes `<bundle>/.odw-map.json`, then one bounded session per
    area writes `<bundle>/.odw-plan.part-<area>.json`. Each dot-file is a
    checkpoint — present and valid means done, a later run resumes the missing
    areas, and all parts merge into the ordinary plan file before any page
    session runs. A `ProducerRun.unitsCompleted` report drives the resume
    counter: completing a unit resets it, so only zero-progress runs advance
    toward exhaustion.
  - Flags: `-p`, `--model`, `--effort` (`low|medium|high|xhigh|max`),
    `--output-format json`, `--allowedTools Read,Grep,Glob,Write,Edit`,
    `--disallowedTools Bash`, and `--setting-sources user` when the CLI knows
    it. **`Bash` denied is a hard requirement, not hardening** — the producer
    runs untrusted third-party repositories. The spike plants a `build.sh` and
    asserts it is never executed.
  - **`--setting-sources user`** for the same reason: the cwd is a clone of the
    repository being documented, so its `.claude/settings.json` and
    `.claude/settings.local.json` are *its* permission grants and hooks, not
    the operator's. Headless `-p` already declined to honor them — the
    workspace is never trusted, since the trust dialog cannot be shown — but
    only as a side effect, and it announced that on stderr once per session
    ("Ignoring N permissions.allow entries … this workspace has not been
    trusted"). Three lines of that warning were all a failed run showed the
    operator, because `describeWikiFailure` reports the stderr tail.
    Nothing pins the CLI and **an unknown option is a hard error**, so the flag
    is not passed blind: `supportsSettingSources` greps `claude --help` once
    per run (no API cost) and a CLI without it falls back to the old behavior,
    saying so in the run's notes.
  - **A failed page says why.** Each unproduced page's note carries the
    session's own account (exit code, `terminal_reason`, its last line of
    output), and a session that claims success is distinguished by whether it
    wrote nothing or wrote something malformed. The run reports the *first*
    failing session, not whichever ran last, and the producer's notes go last
    in `stderr` so the child's incidental chatter cannot push them out of the
    tail.
  - Outcome is classified from **`terminal_reason`** (`completed` / `api_error`
    / …), not the free-text `result`.
  - **A run can report success having produced nothing.** A spike run exited
    `0` with `is_error: false, terminal_reason: "completed"` and wrote no
    bundle, for ~$0.22 of quota. Never treat a producer's own signal as
    acceptance.
- **Live MCP testing**: the repo ships a project-local `opencode.json`
  registering `http://127.0.0.1:7245/mcp` — start `serve` and the running
  opencode session can call the tools directly. Never edit the user's global
  `~/.config/opencode/opencode.json` (schema mismatch in older configs).

## Search internals

Lexical and semantic retrieval are fused, never blended into prose — the server
returns citations and the client LLM synthesizes.

**`search_code`**
1. The query plus mode (`auto`/`literal`/`regex`) becomes one ripgrep pattern. In
   `auto`, identifiers expand to every casing variant (`validateToken` →
   `validate_token`, `validate-token`, …).
2. A single ripgrep pass ranks files by *distinct query terms present* (coverage),
   not raw hit count.
3. In parallel the query is embedded and compared against every chunk vector.
4. The two rankings are fused, deduplicated per file, and snippets are read from
   disk at query time.

**`ask_repo`**
1. The **question** is embedded and matched against wiki pages and code chunks.
2. Optional **keywords** drive the lexical side: terms inside one keyword are
   ANDed, separate keywords are ORed — the caller controls the grep, the question
   controls meaning.
3. Results fuse into one ranked list (page id, kind, title, snippet, file/line
   citations) plus **one-hop neighbors** of the top hit as navigation hints.
4. Without `repoId`, the question is matched against per-repo centroids first and
   only the top repos are searched; every result carries its repo.

## What happens when a repo is added

1. Cloned into `<dataDir>/repos/<repoId>/`.
2. The producer writes an OKF bundle into `<clone>/openwiki/`.
3. The bundle passes acceptance, then wiki pages and source files are indexed —
   metadata into the shared DB, **file contents stay on disk**.
4. Nightly, changed repos get an update run and only changed files are re-indexed.

## Commands

```sh
bun install          # deps
bun run test         # all tests (no network) — shards across 8 bun processes
bun test ./src ./test  # same suite, one process (serial, ~2× slower)
bun run lint         # oxlint
bun run format       # oxfmt
bun run typecheck    # tsc --noEmit
openspec validate --specs   # main spec consistency
bun run eval         # bundle quality: conformance, links, grounding, coverage
```

## When unsure

Follow the artifacts (`openspec/specs/` first, then the archived change at
`openspec/changes/archive/2026-08-23-init-open-deepwiki/`) over this file,
and this file over general convention. If a task seems to require breaking a
guardrail or invariant, stop and ask — don't refactor the rules to fit the code.
