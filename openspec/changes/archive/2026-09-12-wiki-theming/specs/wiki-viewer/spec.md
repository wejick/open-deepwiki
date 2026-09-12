## ADDED Requirements

### Requirement: Wiki theme preference
Every wiki page SHALL render with a theme resolved server-side from a
long-lived `odw_wiki_theme` cookie whose value is `light`, `dark`, or
`system`; an absent or unrecognized value SHALL resolve to `system`. The
resolved theme SHALL be applied as a `data-theme` attribute on the document
element so the first paint already uses it, with `system` following the
browser's `prefers-color-scheme`. Every wiki page SHALL offer the three
choices as links — Light, Dark, Auto — marking the active one
`aria-current="true"` and no other. Selecting a choice (`?theme=<value>`) SHALL
set the cookie scoped to `/wiki` and redirect to the same path without the
query, all without client-side script; a request carrying an unrecognized
theme value SHALL redirect without setting a theme cookie.

#### Scenario: Absent cookie follows the system
- **WHEN** a wiki page is requested with no theme cookie
- **THEN** the response renders `data-theme="system"` and the stylesheet's system rules follow `prefers-color-scheme`

#### Scenario: Theme choice sets a cookie and renders
- **WHEN** `/wiki/<path>?theme=dark` is requested
- **THEN** the response sets the `odw_wiki_theme=dark` cookie scoped to `/wiki` and redirects to `/wiki/<path>` without the query, and subsequent requests render `data-theme="dark"`

#### Scenario: Stored choice is applied
- **WHEN** a wiki page is requested with cookie `odw_wiki_theme=light`
- **THEN** the response renders `data-theme="light"`

#### Scenario: Unrecognized value ignored
- **WHEN** `/wiki/<path>?theme=blue` is requested
- **THEN** the response redirects without setting a theme cookie

#### Scenario: Active choice marked
- **WHEN** a wiki page is rendered
- **THEN** the toggle link matching the resolved theme carries `aria-current="true"` and the other two do not

#### Scenario: Token and theme bootstrap together
- **WHEN** a LAN-bound server receives `/wiki/<path>?token=<valid>&theme=dark`
- **THEN** the response sets both the session and theme cookies and redirects once

#### Scenario: Theme applied without a script
- **WHEN** a wiki page is rendered
- **THEN** the theme is present on the server-rendered document and no script reads or writes the theme cookie

### Requirement: Theme-aware rendering
Rendered code blocks SHALL use the syntax palette of the active theme: the
light palette under `light`, the Mariana-derived palette under `dark`, and the
`system` theme follows `prefers-color-scheme`. Mermaid diagrams SHALL
initialize with diagram theme variables matching the effective theme. Both
SHALL use only the existing diagram bootstrap — no additional client-side
script.

#### Scenario: Dark code palette
- **WHEN** a page renders a code block under `data-theme="dark"`
- **THEN** the rendered block carries the dark syntax palette and the stylesheet selects it

#### Scenario: Light code palette
- **WHEN** a page renders a code block under `data-theme="light"`
- **THEN** the rendered block carries the light syntax palette and the stylesheet selects it

#### Scenario: System follows the preference
- **WHEN** a page renders under `data-theme="system"`
- **THEN** code block colors follow `prefers-color-scheme`

#### Scenario: Diagrams match the effective theme
- **WHEN** a page containing a Mermaid diagram is rendered under a dark theme
- **THEN** the diagram bootstrap initializes Mermaid with the dark theme variables

## MODIFIED Requirements

### Requirement: On this page outline
Every rendered wiki page SHALL render an "On this page" outline listing the
page body's h1–h3 headings in document order as links to those headings'
in-page anchors, indented by heading level. Every h1–h3 heading in the rendered
content SHALL carry a stable `id` matching its outline link, and headings whose
text repeats SHALL receive distinct ids. A page whose body contains no h1–h3
heading SHALL NOT render the outline. When scripts run, the outline SHALL mark
the heading currently in view as the current entry as the page scrolls; without
scripting the outline SHALL render unchanged.

#### Scenario: Outline links to anchored headings
- **WHEN** a page body contains a heading
- **THEN** the outline contains a link to that heading's anchor and the rendered heading carries the matching `id`

#### Scenario: Duplicate headings get distinct ids
- **WHEN** a page body contains two headings with the same text
- **THEN** the rendered headings carry different `id`s and both outline links resolve to them

#### Scenario: Indented by heading level
- **WHEN** a page body contains headings at different levels
- **THEN** the outline shows deeper heading levels at greater indentation

#### Scenario: Page without headings
- **WHEN** a page body contains no h1–h3 heading
- **THEN** the rendered page contains no outline

#### Scenario: Section in view marked
- **WHEN** a page with an outline is scrolled so a heading reaches the top of the reading area
- **THEN** the outline entry for that heading is marked current, and the mark moves as other headings take its place
