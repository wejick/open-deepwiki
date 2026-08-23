# This session: write one page

You own exactly the page named as `PAGE_PATH` in this session's instructions,
under `./openwiki/`. **Write only that page. Do not create, edit, or delete
another wiki page** — another session owns each of the others, and editing one
would overwrite work you cannot see.

On an update, read the current page first. Preserve accurate content the change
does not affect, and change only what current repository evidence requires.

Start from the source paths you were given, then follow the evidence outward
through callers, callees, state owners, integration boundaries and
representative tests as far as the page needs. Seed paths are starting points,
not research boundaries. Read the code before you write about it.

## What the page must cover

Research deeply enough to explain, for the items that genuinely apply to this
page's subject:

- **Responsibilities** — what this unit is for, and what it deliberately is not.
- **Entry points** — how it is reached: the functions, routes, commands or
  events that start its work.
- **Mechanisms and control flow** — what actually happens, in order, including
  the branch that decides between outcomes.
- **Relationships** — what it depends on, what depends on it, and what it
  shares infrastructure with.
- **State and lifecycle** — what it holds, where that lives, when it is created,
  mutated and discarded.
- **Invariants and failure modes** — what must stay true, what happens when it
  does not, and what the code does about it.
- **Extension points** — where a change is meant to be made, and what adding one
  costs.
- **Configuration and operations** — the knobs, their defaults, and what an
  operator sees when it misbehaves.
- **Focused tests** — the tests that pin this behaviour, and what each one
  establishes. A test is the clearest statement of an invariant a repository
  has.

Skip an item the subject does not have; never write a heading with nothing
under it.

**Do not turn the page into a source-file inventory.** A list of files with a
sentence each is the failure this checklist exists to prevent: it repeats what a
directory listing already shows and explains nothing. Organize by what the unit
does, and name files as evidence inside that explanation.

**Concise means dense and non-redundant, not short.** Cut a sentence that
restates its neighbour; keep one carrying a fact nothing else does. Do not
target a page length, and do not omit an important behaviour, component or
relationship for the sake of brevity.

## Relationship modeling

Every concept page is a node, and a Markdown link between two of them is a
directed edge. Tags, `sources` entries, directory placement and the generated
`index.md` are none of them relationships — only a body link is.

- Model the meaningful runtime, dependency, ownership, data-flow, security,
  lifecycle and user-flow relationships, not just navigation.
- **Put the link in the sentence that explains the relationship**, and let the
  prose state what the relationship is: _dispatches to_, _depends on_, _shares
  infrastructure with_, _is configured through_, _is surfaced by_, _is secured
  by_. "See also X" tells a reader nothing.
- **Do not add links solely to increase graph density, and do not automatically
  add a reciprocal link.** Add the inverse only where it genuinely helps explain
  the other page and the evidence supports it.
- Where evidence supports it, a substantive page should connect to at least two
  other substantive pages. If this page stays isolated, either add the
  evidence-backed relationships it really has or say in the prose why it is
  genuinely standalone.
- Prefer linking to the page that already owns a concept over re-explaining it
  here.

Link only to pages on the list you were given. A link to a page that does not
exist degrades the bundle's link health.

## Finishing

The page is done when it has frontmatter with a non-empty `type`, a `title` and
a retrieval-oriented `description`, a non-empty body, its `sources` citations,
and its closing related-pages section. Do not leave a stub to fill in later: a
run cut short keeps whole pages, and a stub is a page nothing will revisit.
