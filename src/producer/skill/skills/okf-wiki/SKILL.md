---
name: okf-wiki
description: >-
  Author and maintain the OKF wiki bundle at ./openwiki/ describing the
  repository in the current working directory. Use when asked to generate,
  update, or continue a wiki bundle for a checkout — the bundle is consumed by
  open-deepwiki's retrieval index, not read start-to-finish by a person.
allowed-tools: Read Grep Glob Write Edit
---

# Author the OKF wiki bundle

Write the wiki for the repository in the current working directory into
`./openwiki/`. Write **nothing** outside `./openwiki/` — never modify a tracked
source file.

Your output feeds a **retrieval index**. A page earns its place by making some
part of this repository findable by someone who does not know it exists.

This contract governs every session. The instructions that follow it describe
the one job this session has been given.

## Hard rules — a bundle breaking any of these is rejected

1. Every `.md` file you write must open with a YAML frontmatter block whose
   first line is `---` and which sets a non-empty `type`.
2. Every page must have a non-empty body. A page with frontmatter and no body is
   never indexed — it is worse than absent.
3. `index.md` and `log.md` are reserved at any depth — never use those names for
   a concept page. **Directory `index.md` files are generated deterministically
   after the run, from the pages actually on disk. Do not create or edit one.**

## Record what you read in `sources`

Every page lists the source files it was written from, as `repo://`-prefixed
repo-relative paths:

```yaml
sources:
  - id: auth-token
    resource: repo://src/auth/token.ts
  - id: auth-mw
    resource: repo://src/auth/middleware.ts#L40-L82
```

This is the **grounding** signal: after the run, every cited path is resolved
against the checkout, and a bundle whose citations do not resolve is rejected.
So cite only files you actually opened, never a path you guessed or tidied. A
page that describes behaviour while citing nothing is exactly the page that
cannot be verified — cite generously.

Prefer the line-range form (`#L40-L82`) over a whole-file citation whenever
you can point at the specific lines that support a claim — it is a stronger,
more checkable signal than "somewhere in this file." Cite the whole file only
when the claim is genuinely about the file as a unit.

Do not put source paths in the body as markdown links: body links are read as
concept cross-links and a link to a non-`.md` target degrades the bundle's link
health. Naming a file or symbol in prose or a code span is fine.

## Only four fields reach the index

`type`, `title`, `description`, and the **body**, which is what gets embedded
for semantic search. Spend your effort there; do not pad frontmatter with
fields nothing reads. One field is worth adding despite that: a `tags` list of
relevant kebab-case terms for the page. Nothing indexes it today, but it is
part of the OKF shape a real bundle carries, and it costs nothing to keep
accurate.

`description` is what a retrieval tool matches a question against before anyone
opens the page, so **write it for search**: name the concrete subject, the
mechanism, and the terms someone would actually type. "How tokens are rotated
without re-login, and where the refresh middleware enforces it" retrieves;
"Details about authentication" does not. It is also displayed verbatim as the
page's one-line summary, so describe the page's subject — never the page's own
role in this wiki ("entry point", "start here to find").

A page's id is its path under `./openwiki/` minus `.md`
(`services/auth.md` → `services/auth`), so choose paths that read as names.

## Cross-link concepts

```
Rotation happens without re-login — see [Token Refresh](/auth/token-refresh.md).
```

Bundle-absolute (`/auth/token-refresh.md`) is preferred; relative
(`./sibling.md`, `../other/page.md`) also resolves. The target must end in `.md`
and name a page that exists. Say what the relationship _is_ in the prose — the
link itself carries no meaning.

## Diagrams

Where a diagram would clarify structure that prose alone would need many
words for, embed a Mermaid fence directly in the page body:

- Component or module relationships → `flowchart TD`
- A decision point with multiple outcomes → `flowchart TD` with diamond
  nodes for the branch
- A sequence of interactions over time → `sequenceDiagram`

Follow every diagram with one sentence of prose describing what it shows —
never leave a diagram to speak for itself. Skip diagrams on pages that are
pure reference or already a single linear path with nothing to branch or
sequence.

Quote every node label (`A["cli.tsx entrypoint"]`, not `A[cli.tsx entrypoint]`)
rather than leaving it bare. An unquoted label containing a special character
is the most common way a diagram fails to parse; quoting it is free insurance.

## Page structure and prose

Close every page with a section linking to other pages in the bundle that are
actually relevant to it, each entry followed by a short description of what
that page covers — the same shape a directory `index.md` uses:

```
## Related pages

- [Token Refresh](/auth/token-refresh.md) — rotation without re-login.
- [Middleware](/auth/middleware.ts.md) — where validation is enforced.
```

Bold a term the first time you formally introduce it in a page
("**Connection pooling** reuses one authenticated session across many
requests."), the way a definition is marked the first time it appears. Do not
re-bold it on later mentions.

Write plainly. State a fact or a contrast directly rather than through a
contrastive-redefinition construction — not "it's not a caching problem, it's
an invalidation problem," but "the bug is in invalidation, not caching." Cut
hedging and filler ("it's worth noting," "at the end of the day," "the key
insight is") — say the thing.

## Guardrails

- **Never invent a path, symbol, or behaviour.** If you cannot confirm it in the
  checkout, leave it out. An omission is recoverable; a fabricated citation
  poisons retrieval and fails the run.
- **You cannot run commands.** No build, no tests, no `git`. Everything you know
  comes from reading files.
- **Write only under `./openwiki/`**, except where this session's instructions
  name one specific file elsewhere to write your answer to.
- Describe what the code does, grounded in the files you read — not what it
  should do, and not a paraphrase of the README.
