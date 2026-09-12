## ADDED Requirements

### Requirement: Interactive diagrams
Every rendered Mermaid diagram SHALL be static until expanded. Clicking the
diagram, pressing Enter or Space while it is focused, or activating its Expand
control SHALL open a centered popup sized to 90% of the viewport with a margin,
containing the diagram with pointer-drag panning, wheel zooming centered on
the pointer, Zoom in and Zoom out controls, and a Close control. The popup
SHALL be dismissed by its Close control, Escape, or a click outside, and SHALL
remove itself. Pan and zoom SHALL adjust the SVG's `viewBox` and SHALL be
bounded so zoom cannot leave the configured range. Panning and zooming SHALL
exist only in the popup: the inline diagram's `viewBox` SHALL never change. The
interaction SHALL come from the existing diagram bootstrap; pages without
diagrams SHALL remain free of any script.

#### Scenario: Diagram expands on click
- **WHEN** a rendered diagram is clicked, or Enter/Space is pressed while it is focused, or its Expand control is activated
- **THEN** a centered popup opens showing the diagram with its zoom and pan controls

#### Scenario: Popup zoom and pan
- **WHEN** the popup is open and the pointer drags, the wheel scrolls, or a zoom control is activated
- **THEN** the diagram's `viewBox` changes accordingly, bounded so zoom cannot leave the configured range

#### Scenario: Popup dismissed
- **WHEN** the Close control is activated, Escape is pressed, or the backdrop is clicked
- **THEN** the popup closes and is removed

#### Scenario: Inline diagrams stay static
- **WHEN** the pointer drags or the wheel scrolls over an inline diagram
- **THEN** its `viewBox` does not change

#### Scenario: No diagrams, no viewer
- **WHEN** a page without a Mermaid diagram is rendered
- **THEN** neither the diagram bootstrap nor any viewer code is present
