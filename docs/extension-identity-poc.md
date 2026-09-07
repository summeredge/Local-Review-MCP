# Extension Identity PoC

This PoC captures browser identity evidence only. It does not correlate MCP requests,
change routing, deliver reviews, or control the browser.

## Evidence chain

The MCP HTTP server keeps the existing `x-request-id` behavior in
`src/mcp/inbound.ts`. ChatGPT's page model exposes the same normalized base ID at
`message.metadata.request_id`.

The unpacked MV3 extension then performs this bounded flow:

```text
message.metadata.request_id
        +
Fiber conversation evidence
        +
concrete URL /c/<conversation_id> or /g/<project>/c/<conversation_id>
        +
Chrome MessageSender.documentId
        +
navigation_epoch
        ↓
ExtensionIdentityEvidence
        ↓
POST /identity-evidence
```

`fiber.js` runs in MAIN world and emits only `{ request_id, fiber_conversation_id }`.
It reads no prompt, assistant text, tool arguments, cookies, authorization, or full
Fiber/message objects. Missing or conflicting Fiber conversation identities are dropped.

`content.js` reads the real current URL and accepts an entry only when the Fiber
conversation equals the concrete `/c/<id>` or `/g/<project>/c/<id>` route. The project
segment must be exactly one path segment. New Chat and non-owner routes produce no evidence.
SPA route changes increment the document-local epoch, including `/c/A → /c/B → /c/A` and
`/g/project/c/A → /g/project/c/B → /g/project/c/A` becoming epochs `0 → 1 → 2`.

`background.js` is the only component that calls the Bridge. It discovers ports
`12081`–`12085`, checks `service === "local-review-control-bridge"` and `protocol === 1`,
pairs through `/pair`, and stores the bearer token in its extension-local storage. The
Bridge body always gets `sender.documentId`; a body-supplied document ID is ignored.
Stale documents and lower epochs are rejected before transport. A single `401` clears
the stored token, re-pairs, and retries once.

The Bridge validates all four required fields with a strict schema and passes the exact
validated value to the injectable `onIdentityEvidence` sink. The default sink is a no-op,
so this PoC does not persist evidence or modify Core state.

## Manual unpacked installation

No extension build, bundle, package, or signing step is required. The directory
`Local-Review-MCP/extension` is the unpacked extension root.

### Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `Local-Review-MCP/extension`.
5. Confirm there is no manifest or runtime error.

### Microsoft Edge

1. Open `edge://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** / **加载解压缩的扩展**.
4. Select the same `Local-Review-MCP/extension` directory.
5. Confirm there is no manifest or runtime error.

The same four files are used by both Chromium browsers:

```text
extension/manifest.json
extension/background.js
extension/content.js
extension/fiber.js
```

## PoC verification

1. Start LRM and confirm the Local Control Bridge is listening on one of
   `127.0.0.1:12081` through `127.0.0.1:12085`.
2. Load the extension manually in Chrome or Edge as above.
3. Open a concrete ChatGPT conversation:

   ```text
   https://chatgpt.com/c/<conversation_id>
   https://chatgpt.com/g/<project>/c/<conversation_id>
   ```
4. Invoke an LRM MCP tool such as `workspace_info` or `review_summary`.
5. In the ChatGPT page model, confirm the resulting message contains
   `metadata.request_id`.
6. Run the existing MAIN-world fiber ask manually. This is a gate: `evidence` must
   contain the exact `wfr_*` ID from this MCP request and the current conversation ID;
   `evidence: []` fails the gate.
7. Use the extension service-worker DevTools Network view to confirm a successful
   `POST /identity-evidence` with status `202`, or start the Bridge with an injected
   `onIdentityEvidence` sink in a test harness.
8. Confirm the received value has exactly this shape:

```json
{
  "request_id": "wfr_...",
  "conversation_id": "...",
  "document_id": "...",
  "navigation_epoch": 0
}
```

The `request_id` must equal the normalized base ID from the same MCP HTTP
`x-request-id`. The Bridge does not perform that join in this phase.

## Explicit non-goals

Implemented: evidence capture and authenticated local transport.

Not implemented: requestId → conversationId correlation registry, ConversationRouting
integration, TaskContext/ReviewRequest/ReviewDelivery changes, reliable delivery,
durable retry, CRX/store publishing, automatic installation/update, browser-worker
changes, or browser actuation.
