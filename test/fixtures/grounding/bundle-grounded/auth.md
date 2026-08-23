---
type: concept
title: Auth
description: Token validation.
sources:
  - id: s-auth
    resource: repo://src/auth.ts#L1-L3
  - id: s-readme
    resource: repo://README.md
  - id: s-external
    resource: https://example.invalid/docs
  - id: s-noresource
    title: entry with no resource at all
---

# Auth

`validateToken` rejects tokens shorter than eleven characters. External and
resource-less entries above must not count as citations.

See [Cache](./cache.md) for the expiry side, and [nowhere](./missing.md) for a
link that does not resolve.
