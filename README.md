# open-deepwiki

A self-hosted, org-wide DeepWiki. One server generates wiki pages for your git repos, indexes them alongside the source, and gives Claude Desktop and other MCP clients recall tools to answer questions about your whole codebase — on your LAN, with your own repos and your own LLM endpoint.

```
git repo → wiki bundle ┐
                       ├→ shared index → MCP server → Claude Desktop
raw source files       ┘
```

The server only *retrieves*: it returns ranked pages, snippets, and citations. Your client LLM writes the answer, so answers stay grounded in your actual code.

**Contents**

- [Tools](#tools)
- [Quickstart](#quickstart)
- [Browse the wiki](#browse-the-wiki)
- [Configure](#configure)
- [CLI reference](#cli-reference)
- [Producers](#producers)
- [Monitoring](#monitoring)

## Tools

Six MCP tools, all read-only:

| Tool | Purpose |
|---|---|
| `ask_repo(repoId?, question, keywords?, limit?)` | Ask a question, get ranked pages, snippets, and citations. Omit `repoId` to search every repo |
| `search_code(repoId?, query, mode?, limit?)` | Find code — exact identifiers, fixed strings, or regex |
| `get_wiki_page(repoId, path)` | Read a full wiki page |
| `list_related(repoId, path)` | A page's links and backlinks |
| `list_repos` | Every indexed repo, its doc counts, and topics |
| `server_status` | Queue state and per-repo health — ask Claude "why is repo X stale?" |

## Quickstart

Four steps: install, add a repo, start the server, ask questions.

**1. Install prerequisites** (on the server host)

- [Bun](https://bun.sh) ≥ 1.4
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`brew install ripgrep`)
- git, with credentials for your private repos
- The producer CLIs — installed with npm under Node, *not* bun, because openwiki ships native bindings bun's global install doesn't build:

  ```sh
  npm i -g openwiki                   # required — the default producer
  npm i -g @anthropic-ai/claude-code  # optional — only if you use ODW_PRODUCER=claude
  ```

  `claude` also needs a one-time interactive login before it can run headless (see [Producers](#producers)).

**2. Clone and install**

```sh
git clone <this repo> && cd open-deepwiki
bun install
```

Nothing is installed globally; the CLI runs from the checkout as `bun odw <command>`.

> Re-run `bun install` after pulling — the wiki viewer's Mermaid renderer and the test suite (`bun test`) need project dependencies in place, and a stale `node_modules` fails with confusing missing-package errors.

**3. Set your LLM key** — create a `.env` (Bun loads it automatically):

```ini
OPENROUTER_API_KEY=sk-or-...
ODW_LLM_MODEL=deepseek/deepseek-v4-flash
```

See [Configure](#configure) for the full list — OpenRouter, any OpenAI-compatible gateway, or a fully local endpoint (Ollama, LiteLLM) all work.

**4. Add a repo and serve**

```sh
bun odw repo add git@gitlab.corp:team/repo.git    # clone, generate wiki, index
bun odw serve                                     # MCP server + nightly refresh
```

Point your MCP client at `http://wiki-host:7245/mcp` and start asking. `bun odw repo add --from-file repos.txt` batch-imports one URL per line; `bun odw repo list` shows what's indexed.

## Browse the wiki

Every repo's generated wiki is also readable as plain HTML — Mermaid diagrams, syntax-highlighted code, and cross-page links included:

```
http://wiki-host:7245/wiki                 # every registered repo
http://wiki-host:7245/wiki/<repoId>        # a repo's wiki
http://wiki-host:7245/wiki/<repoId>/<path> # a page, e.g. architecture/overview
```

On a LAN bind, visit `/wiki?token=<token>` once — it sets a session cookie so plain links and bookmarks work afterward without repeating the token.

## Configure

Everything lives in `.env`, which Bun loads automatically. Every knob is an `ODW_*` env var; defaults live in [config.ts](src/config/config.ts).

```ini
# LLM endpoint — one config powers wiki generation AND search embeddings.
# OpenRouter, any OpenAI-compatible gateway, or fully local (Ollama, LiteLLM).
OPENROUTER_API_KEY=sk-or-...
ODW_LLM_MODEL=deepseek/deepseek-v4-flash
ODW_LLM_BASE_URL=https://openrouter.ai/api/v1
ODW_EMBEDDING_MODEL=openai/text-embedding-3-small

# Server
ODW_DATA_DIR=./data
ODW_BIND_HOST=127.0.0.1          # 0.0.0.0 to share on the LAN
ODW_PORT=7245
ODW_BEARER_TOKEN=change-me       # REQUIRED when bound beyond localhost

# Optional
ODW_MAX_PARALLEL_INDEXING=2
ODW_NIGHTLY_TIME=02:00
```

### Per-repo settings

Repos live in `<dataDir>/registry.yaml`, which is hand-editable — comments and formatting survive:

```yaml
repos:
  - repoId: gitlab.corp/team/repo
    source: git@gitlab.corp:team/repo.git
    schedule: null            # or a cron expression, e.g. "0 * * * *"
    options:
      noWiki: false           # true = code index only, no wiki generation
    instructions: |           # custom wiki prompt for this repo
      Focus the wiki on the public API surface and auth flows.
```

Set `instructions` at add time (`--instructions <file>` or `-` for stdin), read it back with `bun odw repo instructions <repoId>`, or edit the YAML. Run state (last sha, durations, errors) is kept separately in `state.json` so the YAML stays readable.

## CLI reference

All commands are `bun odw <subcommand>`:

| Command | What it does |
|---|---|
| `repo add <url\|path> [--no-wiki] [--instructions <file\|->] [--producer <id>]` | Clone, generate wiki, index |
| `repo add --from-file <file>` | Batch import with bounded parallelism |
| `repo instructions <repoId> [--show]` | Show the repo's wiki prompt |
| `repo remove <repoId>` | Remove the repo, its clone, and its index data |
| `repo list [--json]` | Registered repos with doc counts, sha, topics, link health |
| `repo update <repoId>` | Pull, update the wiki, re-index changed files only |
| `repo reinit <repoId>` | Discard the wiki and rebuild from scratch from the existing clone |
| `update --all` | One-shot batch — point system cron or launchd at this |
| `index <repoId>` | Re-index without regenerating the wiki |
| `serve` | MCP HTTP server plus the nightly batch |
| `status [--failing\|--json\|--server <url>]` | Health table |
| `logs [--repo <repoId>]` | Tail the event log |

Separately, `bun run eval` scores a bundle's conformance, link resolution, grounding, and coverage — useful for comparing two producers on the same repo.

## Producers

A *producer* turns a checkout into a wiki bundle. Two are available:

| Producer | Runs | Billed to |
|---|---|---|
| `openwiki` (default) | the `openwiki` CLI | your metered LLM endpoint |
| `claude` | `claude -p` against the clone | your Claude subscription |

```ini
ODW_PRODUCER=claude              # fleet-wide
ODW_CLAUDE_MODEL=claude-sonnet-5
ODW_CLAUDE_EFFORT=medium         # low | medium | high | xhigh | max
```

Or per repo, which is how migration is meant to be done — one cohort at a time:

```sh
bun odw repo add --producer claude git@gitlab.corp:team/repo.git
```

Both producers read and write the same continuity file, so either can continue a bundle the other wrote and rolling back is a config edit — the bundle and index are untouched.

Using `claude` needs the `claude` CLI on `PATH` and already authenticated. Leave `ODW_CLAUDE_CONFIG_DIR` empty: `claude` keeps its credentials in its config dir, so pointing it elsewhere produces "Not logged in" on every run. Embeddings are unaffected — Claude has no embeddings endpoint, so `ODW_EMBEDDING_*` keeps its own provider.

Whichever producer ran, the bundle passes the same acceptance gate before it is indexed — conformance, grounding, citation density, coverage, and update scope. A rejected bundle is restored from the last verified snapshot and the index is left alone. Hitting a usage limit is *not* a failure: the repo goes yellow rather than red and its published wiki stays queryable. See [AGENTS.md](AGENTS.md) for the checks and their thresholds.

## Monitoring

| Surface | Token? | What |
|---|---|---|
| `GET /healthz` | no | Liveness: `{ok, uptimeSec, repoCount}` |
| `GET /status` | yes | Queue state, per-repo health, last error, cost |
| `bun odw status` | — | Health table; `--failing` shows only problems |
| `bun odw logs` | — | What the indexer and scheduler did |

**Red** = the last run failed. **Yellow** = nothing has succeeded for more than twice its update interval, or the run was rate-limited — the wiki still works, it just hasn't moved forward. **Green** = healthy. You can also just ask Claude "why is repo X red?"; the `server_status` tool answers.

---

Architecture, internal invariants, the producer contract, and contributor guardrails live in [AGENTS.md](AGENTS.md).
