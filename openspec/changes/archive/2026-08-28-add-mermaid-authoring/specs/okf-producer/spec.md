## ADDED Requirements

### Requirement: Mermaid diagram authoring guidance
The `claude` producer's authoring skill SHALL instruct the model to embed a
Mermaid diagram in a page's body where the page describes component or module
relationships, a decision point with multiple outcomes, or a sequence of
interactions over time — using `flowchart TD` for the first two and
`sequenceDiagram` for the third — and SHALL instruct that every diagram be
followed by one sentence of prose describing what it shows. The skill SHALL
instruct that a page which is pure reference or already a single linear path
needs no diagram.

#### Scenario: Skill instructs diagram authoring for structural and decision content
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to embed a `flowchart TD` diagram for component
  or module relationships and for a decision point with multiple outcomes

#### Scenario: Skill instructs diagram authoring for sequential content
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to embed a `sequenceDiagram` for a sequence of
  interactions over time

#### Scenario: Skill instructs a caption after every diagram
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance that every diagram is followed by one sentence
  of prose describing what it shows

#### Scenario: Skill instructs omitting diagrams from reference-only pages
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to skip diagrams on pages that are pure
  reference or already a single linear path with nothing to branch or
  sequence
