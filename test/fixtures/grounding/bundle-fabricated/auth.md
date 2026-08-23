---
type: concept
title: Auth
description: Token validation.
sources:
  - id: s-real
    resource: repo://src/auth.ts
  - id: s-fake
    resource: repo://src/does-not-exist.ts
  - id: s-fake2
    resource: repo://lib/imaginary/module.ts
  - id: s-escape
    resource: repo://../../etc/passwd
---

# Auth

Three of the four citations above are fabricated; the escaping one must be
refused rather than resolved outside the checkout.
