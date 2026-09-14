# Conversation Correlation

For `submit_goal`, conversation correlation is the Control Plane's exact ownership join:

```text
submit_goal arguments.correlation_key
        ==
assistant api_tool request for submit_goal: args.correlation_key
        ↓
request_id → conversation_id
```

`correlation_key` is a strict UUID v4. Each `submit_goal` invocation must use a newly generated
key, and the equality above is exact and case-sensitive. The Extension emits the matching key
through the existing `{ request_id, fiber_conversation_id }` identity-evidence format. HTTP
`x-request-id`, JSON-RPC body `id`, and `message.metadata.request_id` remain platform or
transport diagnostics; they are not `submit_goal` conversation authority.

The first proven conversation owns a registry key. For direct `submit_goal` calls, that key is
the UUID v4 `correlation_key` stored in the registry's `request_id` field. Seeing that owner again
is idempotent and may refresh the stored browser-source metadata. A different conversation
claiming the same key is refused without changing, deleting, or degrading the proven owner.
Proven owners have no time TTL. The registry is bounded to 50,000 entries and evicts by
least-recent same-owner observation order.

State is restored from `<LocalReviewMCP state root>/control-plane/request-correlations.json`.
The versioned JSON snapshot is written through a temporary file and atomic rename. Invalid rows
are ignored; an unreadable or invalid snapshot restores no guessed ownership and does not stop
the MCP Data Plane.

`correlation(requestId)` performs an exact lookup. `awaitCorrelation(requestId, timeoutMs)` only
waits for late evidence for that same exact ID; the timeout bounds the waiter, not ownership.
`submit_goal` passes its input `correlation_key` directly to these lookup methods and does not
use the AsyncLocalStorage inbound request ID.

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
`conversation_id`. `submit_goal` uses the exact UUID v4 key supplied in its invocation until
the Extension proves the matching current ChatGPT conversation identity.
