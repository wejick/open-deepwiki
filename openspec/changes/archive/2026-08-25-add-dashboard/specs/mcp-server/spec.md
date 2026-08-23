# MCP Server Specification — delta for add-dashboard

## MODIFIED Requirements

### Requirement: MCP over HTTP transport with bearer-token auth
The system SHALL run an MCP server using Streamable HTTP transport on a configurable host/port (default `http://localhost:7245/mcp`), so MCP clients such as Claude Desktop can connect to a persistently running, shared LAN server. When the server is bound to an address beyond localhost, it SHALL require a bearer token (`Authorization: Bearer <token>`) on every request and reject unauthenticated requests with 401 — with exactly two exceptions that carry no data: `GET /healthz` and `GET /` (the static dashboard shell) SHALL be served without a token. All data-bearing endpoints (`/mcp`, `/status`, `/api/*`) SHALL remain tokened.

#### Scenario: Client connects
- **WHEN** an MCP client connects to the server endpoint with a valid token
- **THEN** the MCP initialize handshake succeeds and the server advertises its tools

#### Scenario: Unauthenticated request rejected on LAN bind
- **WHEN** the server is bound beyond localhost and a request to a data-bearing endpoint arrives without a valid bearer token
- **THEN** the server responds 401 and no tools are accessible

#### Scenario: Dashboard shell untokened on LAN bind
- **WHEN** the server is bound beyond localhost and a browser requests `GET /` without a token
- **THEN** the dashboard HTML is served with 200, while `/status` and `/api/*` requests without a token still return 401
