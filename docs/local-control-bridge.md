# Local Control Bridge

LRM runs two separate local HTTP servers:

- MCP is the read-only Data Plane at the configured MCP endpoint.
- Local Control Bridge is the loopback-only Control Plane used by a future Chrome extension.

The Bridge binds only to `127.0.0.1` and tries these discovery ports in order:
`12081`, `12082`, `12083`, `12084`, `12085`. If none is available, MCP still starts and the
Bridge is reported as unavailable.

## Foundation protocol

The Bridge protocol version is `1`, sent in the `x-lrm-bridge-protocol` header on every route
except `GET /hello`.

- `GET /hello` is unauthenticated discovery. It returns the Bridge service name, protocol,
  application version, and pairing state only.
- `POST /pair` requires a valid `chrome-extension://<32-character-id>` Origin and the matching
  protocol header. It creates one 256-bit bearer token per process and binds it to that Origin.
- `GET /status` requires the matching protocol, paired Origin, and
  `Authorization: Bearer <token>` header.

Bridge request bodies are capped at 64 KiB. Oversized JSON returns `413`; malformed JSON
returns `400`. The token is held in process memory only and is independent of MCP auth/OAuth.

This foundation has no `requestId` to `conversationId` correlation, browser evidence,
navigation/document epochs, delivery queue, command route, filesystem access, shell execution,
Git mutation, Codex execution, or Playwright/DOM control.
