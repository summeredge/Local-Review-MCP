# Extension Identity PoC

This extension captures browser identity evidence, `submit_goal` correlation evidence, and the
explicitly activated `GoalHandoffEnvelopeV2`. It does not create or start Goals, deliver reviews,
or control the browser.

## Evidence chain

The existing platform diagnostic path keeps the MCP HTTP `x-request-id` behavior in
`src/mcp/inbound.ts`. ChatGPT's page model may expose a corresponding normalized base ID at
`message.metadata.request_id`, but that platform ID is not the `submit_goal` conversation key.

For `submit_goal`, the MCP input's strict UUID v4 `correlation_key` is matched to the same key in
the real assistant `api_tool` request payload: `content.text` JSON names the `submit_goal` path
and carries `args.correlation_key`. Fiber emits that key through the existing identity-evidence
shape; no new endpoint or evidence schema is used.

Platform `request_id` values are opaque normalized identifiers. Their concrete appearance is not
protocol semantics: ChatGPT may expose a `wfr_*` value, a UUID value such as
`32ca0d45-8b29-414a-bbe4-8e26c3aae911`, or another future value that satisfies the
`[A-Za-z0-9_-]{1,100}` lexical boundary. LRM does not require a prefix, require a UUID, or
infer identity from the ID's format. The browser-side authority is
`message.metadata.request_id`; the MCP-side authority is the normalized value returned by
`src/mcp/inbound.ts::requestIdFromHeader()` from `x-request-id`. The platform-ID path uses exact
string equality; it remains separate from the direct `submit_goal` key path above.

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

For the existing platform identity-evidence path, `fiber.js` emits only
`{ request_id, fiber_conversation_id }` from `message.metadata.request_id`. For the direct
`submit_goal` path it additionally emits the same shape with `request_id` set to the strict key
read from the assistant tool request's `args`; it does not read user text, ordinary assistant text,
tool-result text, reasoning, or metadata to obtain that key. Missing or conflicting Fiber
conversation identities are dropped. The separate Goal handoff path reads only the allowlisted
user activation text and the target tool result envelope described below.

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
validated value to the injectable `onIdentityEvidence` sink. In the production app, that sink
durably stores the first canonical owner in `ConversationCorrelationRegistry`, then schedules
any matching `PendingGoalSubmission` in the background. The Bridge returns `202` without waiting
for Goal/Task/Execution startup. A default no-op sink remains available for isolated PoC tests.

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

For platform-ID evidence, `request_id` equals the normalized base ID from the same MCP HTTP
`x-request-id`. For direct `submit_goal` evidence, `request_id` equals the invocation's
`correlation_key`; `x-request-id` and `metadata.request_id` are not required. The Bridge does not
perform either join in this phase.

## Explicit non-goals

Implemented: evidence capture and authenticated local transport.

The existing identity-evidence path feeds the request-to-conversation correlation registry; the
production direct `submit_goal` path keeps its payload in the separate durable
`PendingGoalSubmission` state until that registry proves the same canonical key. New Chat and
`WEB:*` provisional identity produce no canonical evidence. The reliable delivery transport
documented in `reliable-extension-delivery.md` remains separate. Neither path changes
TaskContext/ReviewRequest/ReviewDelivery, publishes a CRX, installs automatically, or changes the
browser-worker path.
