# Local Control Bridge

LRM runs two separate local HTTP servers:

- MCP is the read-only Data Plane at the configured MCP endpoint.
- Local Control Bridge is the loopback-only Control Plane used by Extension identity and delivery.

The Bridge binds only to `127.0.0.1` and tries these discovery ports in order:
`12081`, `12082`, `12083`, `12084`, `12085`. If none is available, MCP still starts and the
Bridge is reported as unavailable.

## Foundation protocol

The Bridge protocol version is `3`, sent in the `x-lrm-bridge-protocol` header on every route
except `GET /hello`.

- `GET /hello` is unauthenticated discovery. It returns the Bridge service name, protocol,
  application version, and pairing state only.
- `POST /pair` requires a valid `chrome-extension://<32-character-id>` Origin and the matching
  protocol header. It creates one 256-bit bearer token per process and binds it to that Origin.
- `GET /status` requires the matching protocol, paired Origin, and
  `Authorization: Bearer <token>` header.
- `POST /identity-evidence` uses the same protocol, paired Origin, and bearer gates. It accepts
  strict `{ request_id, conversation_id, document_id, navigation_epoch }` evidence and passes it
  to the injectable `onIdentityEvidence` sink.
- `POST /goal-handoff-capture` uses the same gates. It accepts a strict V2 signed handoff plus
  browser identity, stores it in process memory, and invokes the optional capture sink only once
  per `handoff_id`. `GET /goal-handoff-captures` exposes the captured values to the paired
  Extension for diagnostics.
- `POST /delivery/claim` accepts a strict conversation plus browser-document owner and returns
  `{ command: null }` or one durably leased command.
- `POST /delivery/ack` accepts a strict `sent`, `not_sent`, or `ambiguous` receipt and delegates
  durable settlement to the injected Extension Delivery service.

Bridge request bodies are capped at 64 KiB. Oversized JSON returns `413`; malformed JSON
returns `400`. The token is held in process memory only and is independent of MCP auth/OAuth.

The Bridge owns no delivery filesystem state and does not access `ReviewDelivery`; app composition
injects the delivery handlers. Captured handoffs are not HMAC-verified, TTL-verified, consumed,
or submitted to Goal orchestration in this phase. It still exposes no filesystem, shell, Git,
Codex, or MCP write capability.
