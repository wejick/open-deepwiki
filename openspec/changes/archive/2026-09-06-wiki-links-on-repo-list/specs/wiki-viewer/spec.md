## MODIFIED Requirements

### Requirement: Wiki authentication
`/wiki/*` requests SHALL require the server's configured bearer token when
one is set and the server is bound beyond localhost, matching the exemption
already applied to the admin API. The token SHALL be presentable via
`?token=<token>` on any `/wiki/*` path — including deep links to a specific
repo or page — which SHALL establish a session that subsequent `/wiki/*`
requests in the same browser reuse without repeating the token; the response
SHALL redirect to the same path without the token in the URL.

#### Scenario: Token accepted via bootstrap link
- **WHEN** a request for `/wiki?token=<valid-token>` is made
- **THEN** the response establishes a session and subsequent `/wiki/*` requests from that browser succeed without a token in the URL or headers

#### Scenario: Deep link bootstrap sets session and redirects cleanly
- **WHEN** a request for `/wiki/<repoId>/<path>?token=<valid-token>` is made
- **THEN** the response establishes the same session and redirects to `/wiki/<repoId>/<path>` without the token in the URL

#### Scenario: Deep link with invalid token rejected
- **WHEN** a bearer token is configured, the server is bound beyond localhost, and a request for `/wiki/<repoId>?token=<wrong-token>` is made
- **THEN** the response is 401 and no session is established

#### Scenario: Missing session and token rejected
- **WHEN** a bearer token is configured, the server is bound beyond localhost, and a `/wiki/*` request arrives with neither a valid session nor a valid token
- **THEN** the response is 401

#### Scenario: Localhost bind exempt
- **WHEN** the server is bound to localhost
- **THEN** `/wiki/*` requests succeed without a token, matching the admin API's existing localhost exemption
