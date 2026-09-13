# Extension Identity PoC

This extension captures browser identity evidence and the explicitly activated
`GoalHandoffEnvelopeV2`. It does not correlate MCP requests, create or start Goals, deliver
reviews, or control the browser.

## Evidence chain

The MCP HTTP server keeps the existing `x-request-id` behavior in
`src/mcp/inbound.ts`. ChatGPT's page model exposes the same normalized base ID at
`message.metadata.request_id`.

`request_id` is an opaque normalized identifier. Its concrete appearance is not protocol
semantics: ChatGPT may expose a `wfr_*` value, a UUID value such as
`32ca0d45-8b29-414a-bbe4-8e26c3aae911`, or another future value that satisfies the
`[A-Za-z0-9_-]{1,100}` lexical boundary. LRM does not require a prefix, require a UUID, or
infer identity from the ID's format. The browser-side authority is
`message.metadata.request_id`; the MCP-side authority is the normalized value returned by
`src/mcp/inbound.ts::requestIdFromHeader()` from `x-request-id`. Any future correlation must
use exact string equality.

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

For the existing identity-evidence path, `fiber.js` emits only
`{ request_id, fiber_conversation_id }`. It reads no prompt, assistant text, tool arguments,
cookies, authorization, or full Fiber/message objects. Missing or conflicting Fiber conversation
identities are dropped. The separate Goal handoff path reads only the allowlisted user activation
text and the target tool result envelope described below.

For Goal handoff capture, the same bounded `turn.messages` scan additionally requires an
assistant `api_tool` request and a `tool` result whose `metadata.invoked_resource.resource_uri`
names `prepare_goal_handoff`; the result is paired by `metadata.parent_id` to the request's
message id. Its structured result is accepted only when it is exactly V2 and has no
`conversation_id`. The signed envelope is carried through unchanged; the Extension does not
verify its HMAC or authoritative TTL.

`content.js` reads the real current URL and accepts an entry only when the Fiber
conversation equals the concrete `/c/<id>` or `/g/<project>/c/<id>` route. The project
segment must be exactly one path segment. New Chat and non-owner routes produce no evidence.
SPA route changes increment the document-local epoch, including `/c/A → /c/B → /c/A` and
`/g/project/c/A → /g/project/c/B → /g/project/c/A` becoming epochs `0 → 1 → 2`.

`background.js` is the only component that calls the Bridge. It discovers ports
`12081`–`12085`, checks `service === "local-review-control-bridge"` and `protocol === 3`,
pairs through `/pair`, and stores the bearer token in its extension-local storage. MV3
`chrome.storage.local` survives service-worker suspension and extension reload, while the
Bridge bearer token exists only in Bridge process memory. After a Bridge restart,
`hello.paired === false` therefore invalidates any cached token but keeps the discovered
port; the extension clears that stale credential, pairs once, and only then sends evidence.
Concurrent evidence shares the same pairing attempt. The
Bridge body always gets `sender.documentId`; a body-supplied document ID is ignored.
Stale documents and lower epochs are rejected before transport. A single `401` clears
the stored token, re-pairs, and retries once. A `403` after `hello.paired === true` fails
closed and does not attempt to take pairing ownership from another Extension Origin.

The Bridge validates all four required fields with a strict schema and passes the exact
validated value to the injectable `onIdentityEvidence` sink. The default sink is a no-op,
so this PoC does not persist evidence or modify Core state.

## Goal handoff capture gate

The Extension considers only the latest Fiber turn. The latest user message before the paired
tool request must match a fixed explicit activation pattern such as `建立一个 Goal`、`创建一个
Goal` or `启动一个 Goal`, and must also contain a direct Codex execution handoff such as
`交给 Codex 执行`. Assistant and tool messages never satisfy this gate. The current URL must
match the Fiber conversation, and the existing document/epoch checks must still pass before the
handoff is sent to the Bridge as:

```json
{
  "handoff": { "...": "GoalHandoffEnvelopeV2" },
  "conversation_id": "<URL conversation>",
  "document_id": "<Chrome sender documentId>",
  "navigation_epoch": 0
}
```

The Bridge stores captures temporarily and de-duplicates by `handoff_id`; a conflicting payload
for the same id is rejected. This phase never calls `GoalSubmissionService`, creates a Goal,
Task, or Execution, starts Codex, or performs HMAC/TTL consume verification.

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

The same plain-source files are used by both Chromium browsers:

```text
extension/manifest.json
extension/background.js
extension/chatgpt-dom.js
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
   contain the exact request ID exposed by `message.metadata.request_id` for the same MCP
   request and the current conversation ID;
   `evidence: []` fails the gate.
7. Use the extension service-worker DevTools Network view to confirm a successful
   `POST /identity-evidence` with status `202`, or start the Bridge with an injected
   `onIdentityEvidence` sink in a test harness.
8. Confirm the received value has exactly this shape:

```json
{
  "request_id": "<exact-request-id>",
  "conversation_id": "...",
  "document_id": "...",
  "navigation_epoch": 0
}
```

The `request_id` must equal the normalized base ID from the same MCP HTTP
`x-request-id`. The Bridge does not perform that join in this phase.

## Explicit non-goals

Implemented: evidence capture and authenticated local transport.

Identity remains separate from the request-to-conversation correlation registry and the reliable
delivery transport documented in `reliable-extension-delivery.md`. Neither changes
TaskContext/ReviewRequest/ReviewDelivery, publishes a CRX, installs automatically, or changes the
browser-worker path.
