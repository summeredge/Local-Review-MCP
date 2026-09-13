# Conversation Correlation

Conversation correlation is the Control Plane's exact ownership join:

```text
HTTP x-request-id
        ==
message.metadata.request_id
        ↓
request_id → conversation_id
```

Request IDs are opaque. UUID and `wfr_*` values use the same lexical boundary and exact,
case-sensitive equality; prefixes, substrings, timestamps, tool names, active tabs, and other
heuristics are not evidence.

The first proven conversation owns a request ID. Seeing that owner again is idempotent and may
refresh the stored browser-source metadata. A different conversation claiming the same request
ID is refused without changing, deleting, or degrading the proven owner. Proven owners have no
time TTL. The registry is bounded to 50,000 entries and evicts by least-recent same-owner
observation order.

State is restored from `<LocalReviewMCP state root>/control-plane/request-correlations.json`.
The versioned JSON snapshot is written through a temporary file and atomic rename. Invalid rows
are ignored; an unreadable or invalid snapshot restores no guessed ownership and does not stop
the MCP Data Plane.

`correlation(requestId)` performs an exact lookup. `awaitCorrelation(requestId, timeoutMs)` only
waits for late evidence for that same exact ID; the timeout bounds the waiter, not ownership.
`currentInboundCorrelation()` combines the existing AsyncLocalStorage `inboundRequestId()` with
that exact lookup and returns `null` when either side is absent.

`document_id`, `navigation_epoch`, and observation times describe the browser evidence source.
They are diagnostics and freshness metadata, never conversation-guessing signals.

Conversation Correlation is not ConversationRouting:

```text
Request Correlation
request_id → conversation_id

future stage, once ReviewRequest identity is authoritative
        ↓
ConversationRouting
review_request_id → conversation_id
```

Correlation does not create or update Task, Execution, ReviewRequest, ConversationRouting, or
Review Delivery records.

`prepare_goal_handoff` is intentionally outside this join: it signs the Goal, selected workspace,
MCP request trace, handoff identity, and validity window without resolving or returning a
`conversation_id`. `submit_goal` retains the exact correlation requirement until a later
Extension handoff step proves the current ChatGPT conversation identity.
