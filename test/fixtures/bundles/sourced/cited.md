---
type: concept
title: Cited Page
description: Page citing repository sources for the forge-link tests
sources:
  - id: ranged
    resource: repo://src/auth.ts#L10-L20
  - id: bare
    resource: repo://README.md
  - id: single
    resource: repo://src/auth.ts#L8
  - id: external
    resource: https://example.com/spec
  - id: escaped
    resource: repo://src/a&b<c>.ts#L1
---

# Cited Page

Body text with citations. The hook (`src/auth.ts:10-20`) runs, and so does
(`src/auth.ts:8`); the hash form (`src/auth.ts#L5-L7`) links too. A typo
(`src/missing.ts:1-2`) stays plain, as does `session.execution.succeeded`.

```
src/auth.ts:1-2
```
