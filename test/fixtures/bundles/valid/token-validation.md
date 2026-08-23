---
type: token-validation
title: Token Validation
description: Documentation for the token validation functionality
tags: [validation, token]
---

# Token Validation

The `validateToken` function checks whether a token is valid:

- The token must be longer than 10 characters
- The token must not contain spaces

The system is authenticating users via bearer tokens issued at login.
Token refresh rotates the bearer without re-login — see [Token Refresh](./token-refresh.md).
