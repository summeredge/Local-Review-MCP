# Step 8 — Browser Transport Decision Gate

**Status:** decision recorded; implementation unchanged  
**Decision:** use Extension Reliable Delivery as the future primary transport for outbound Review Delivery and control commands. Keep the Playwright Browser Worker as a supported explicit/diagnostic transport and as the current completion collector until a separate decision changes that boundary. Do not add automatic fallback in this step.

This gate is based on the current source and tests in this checkout. It does not
infer the call graph from earlier design documents.

## A. Current capability baseline

### A.1 Actual call graph

The requested shape is a useful target, but it is not yet a runtime fan-out in
the current code. `ReviewDeliveryService` persists and validates the logical
delivery; it does not invoke a browser. `BrowserRouter` is the current caller
that invokes a `ReviewDeliveryAdapter`.

The live Playwright path is:

```text
ReviewDelivery record
        |
        v
BrowserRouter.deliver()
        |
        v
ReviewDeliveryAdapter
        |
        v
BrowserWorkerDeliveryAdapter (default)
        |
        v
BrowserWorkerClient.deliver()
        |
        v
POST /conversation/deliver
        |
        v
BrowserWorker
  -> ConversationNavigator
  -> ChatGPTInteraction
  -> confirmed SUBMITTED result
        |
        v
ReviewDeliveryService.markDelivered() / markFailed()
```

The current Extension path is separate:

```text
Open ChatGPT tab
        |
        v
extension/content.js
  -> extension/background.js
        |
        v
Local Control Bridge
  -> ExtensionDeliveryService.claim()/acknowledge()
        |
        v
durable claim / ACK / recovery
```

The following source facts define the current boundary:

| Fact | Current evidence |
| --- | --- |
| `BrowserDeliveryAdapter` is not transport-neutral yet | `src/delivery/browser-delivery-adapter.ts` aliases `BrowserWorkerDeliveryAdapter`. |
| The default `BrowserRouter` transport is Playwright | `src/router/browser-router.ts` constructs `BrowserWorkerDeliveryAdapter(new BrowserWorkerClient())`. |
| Extension delivery is not connected to `ReviewDelivery` | `src/app.ts` wires Extension Delivery into Bridge claim/ACK handlers, but there is no `extensionDeliveries.enqueue()` caller in `src/`. |
| The MCP server does not expose browser control | `src/mcp/server.ts` registers read-only workspace, file, Git, and review-context tools only. |
| Completion is still Worker-based | `src/router/review-completion-router.ts` calls `BrowserWorkerClient.collectCompletion()`. |

Therefore, there is currently no production runtime branch of the form
`ReviewDelivery -> Browser Delivery Layer -> {Worker, Extension}`. The next
implementation phase must add that composition deliberately; this gate does not
add it.

### A.2 Option A capability: Playwright Browser Worker

The current implementation is located at:

- `src/browser-worker/worker.ts`
- `src/browser-worker/navigation/conversation-navigator.ts`
- `src/browser-worker/interaction/chatgpt-interaction.ts`
- `src/browser-worker/profile/manager.ts`
- `src/browser-worker-client/browser-worker-client.ts`
- `src/delivery/browser-worker-delivery-adapter.ts`
- `src/router/browser-router.ts`

The completed capabilities are:

- `POST /conversation/deliver` accepts a Conversation ID and message, validates
  both, navigates to the canonical `https://chatgpt.com/c/<conversation_id>`
  URL, fills the Composer, clicks Send, and confirms that ChatGPT accepted the
  message.
- `BrowserWorkerClient` validates HTTP responses, response schemas, echoed
  Conversation IDs, timeouts, and transport failures.
- `BrowserWorkerDeliveryAdapter` maps only `SUBMITTED` to the persisted
  `delivered` state. Authentication, missing Conversation, Composer, submit,
  timeout, and Worker availability failures are mapped to typed Delivery
  failures.
- The Worker uses a persistent Chromium context and a managed profile. On
  Windows the default profile is under
  `%LOCALAPPDATA%\LocalReviewMCP\browser-worker\profiles`.
- `ReviewDelivery` lifecycle and routing identity checks are already integrated
  with the Worker adapter through `BrowserRouter`.
- Completion collection is implemented independently through
  `POST /conversation/completion`.

This is a confirmed submission path, not a durable command/receipt protocol.
The Worker confirms the page-side result before returning, but the current
Worker request has no durable `delivery_id` lease or ACK outbox. If ChatGPT
accepts a message and the HTTP response is lost, the current Delivery can be
marked failed and a later retry can submit the message again.

### A.3 Option B capability: Extension Reliable Delivery

The current implementation is located at:

- `extension/manifest.json`
- `extension/content.js`
- `extension/chatgpt-dom.js`
- `extension/fiber.js`
- `extension/background.js`
- `src/control-plane/bridge.ts`
- `src/control-plane/bridge-protocol.ts`
- `src/control-plane/extension-delivery.ts`
- `src/control-plane/extension-identity.ts`
- `src/control-plane/conversation-correlation.ts`
- `src/control-plane/request-correlation-integration.ts`

The completed capabilities are:

- The same plain MV3 `extension/` directory can be loaded unpacked in Chrome or
  Edge. It matches `chatgpt.com` and `chat.openai.com` without a build step.
- `fiber.js` runs in the MAIN world and emits only bounded exact evidence from
  `message.metadata.request_id` and the Fiber conversation identity. It does
  not send Bridge requests or own credentials.
- `content.js` accepts only the exact ChatGPT route for the current page and
  requires Fiber Conversation ID equality. It supports `/c/<id>` and one
  Project segment `/g/<project>/c/<id>` and rejects public/share or malformed
  routes.
- `background.js` uses `MessageSender.documentId` as document authority and
  tracks the document's navigation epoch. Stale documents, stale epochs, wrong
  Conversation IDs, and cross-tab ownership are rejected.
- The Bridge is loopback-only on `127.0.0.1`, discovers ports `12081` through
  `12085`, pairs one validated Extension Origin, and authenticates protected
  requests with a bearer token. `GET /hello` remains plain discovery.
- `ExtensionDeliveryService` persists a bounded command queue, claims one
  command for an exact `conversation_id`/client/document/epoch owner, uses a
  30-second lease, restores state after LRM restart, and settles idempotent
  `sent`, `not_sent`, or `ambiguous` ACKs.
- The Extension stores only transport metadata, in-flight state, and an ACK
  outbox in `chrome.storage.local`. A confirmed send is tied to a newly
  rendered ChatGPT user message with a stable `data-message-id`. A send without
  that receipt is terminal `ambiguous`, not an instruction to send again.
- `startApp()` restores correlation and Extension Delivery state before wiring
  the Bridge handlers. A corrupt Extension Delivery file blocks delivery while
  keeping Bridge identity and the MCP Data Plane available.

This path is already reliable at the physical-command boundary, but it is not
yet a `ReviewDeliveryAdapter`: the current source has no logical Review
Delivery enqueue/await composition for it.

### A.4 Identity and correlation boundary

The Extension identity path and Review Delivery routing path are related but
not interchangeable:

```text
MCP x-request-id == Fiber message.metadata.request_id
        |
        v
ConversationCorrelationRegistry
        |
        v
request_id -> conversation_id       (ownership evidence)

ReviewRequest -> ConversationRouting
        |
        v
conversation_id                     (authoritative Delivery target)
```

`ConversationCorrelationRegistry` uses exact, first-owner-wins evidence and
persists it under the Control Plane state directory. A later different
Conversation claiming the same request ID is refused. It does not create or
modify `Task`, `Execution`, `ReviewRequest`, `ConversationRouting`, or
`ReviewDelivery` records.

`ConversationRouting.conversation_id` therefore remains the target for a
Review Delivery. The future Extension adapter must not choose a tab by active
tab, recent activity, tool name, time proximity, or correlation heuristics.

### A.5 COS reference check

The read-only COS checkout at
`C:\Users\shaoy\Documents\Codex\chat-on-steroids` was checked for:

- loopback Bridge discovery, pairing, Origin/protocol checks, and bearer
  authentication in `src/main/bridge.ts`;
- exact request-to-Conversation correlation and first-proof ownership in
  `src/main/session/correlation.ts`;
- Extension-side document ownership, durable queues, ACK outboxes, claim/lease
  handling, and restart behavior in `extension/background.js`;
- corresponding Bridge, correlation, and Extension tests.

Only the transport lessons—exact ownership, durable claim/ACK ordering, and
fail-closed recovery—are relevant here. COS Agent workflow, Worker
orchestration, and Goal/Resume state are not part of this decision and are not
being copied.

## B. Three-option comparison

### Summary matrix

| Dimension | Option A — Playwright Worker | Option B — Extension Reliable Delivery | Option C — Hybrid |
| --- | --- | --- | --- |
| ChatGPT session | Separate managed Chromium profile | User's already-authenticated Chrome/Edge page | Two possible sessions and authorities |
| Current LRM wiring | Already the `BrowserRouter` default | Bridge/Extension path complete but not wired to `ReviewDelivery` | No arbitration layer exists |
| Targeting many Conversations | Opens a fresh Worker page per request using the Conversation ID | Claims the exact open tab, document, Conversation, and epoch | Must coordinate both targeting systems |
| Physical-send proof | Page-side confirmation returned over one HTTP request | Durable message receipt plus idempotent ACK | Requires a cross-transport receipt authority |
| Crash/ACK behavior | No durable Worker-side command ACK | Durable app queue, Extension outbox, lease, and ambiguity terminal | Worst-case ambiguity exists in both paths |
| User/browser dependency | Worker must launch and maintain Chromium/profile/login | Browser and Extension must be running with target tabs open | Either dependency can fail, plus selection logic |
| Future Codex execution fit | Good for isolated headless automation | Best fit for commands in the user's live ChatGPT session | Potentially useful only after explicit arbitration semantics |
| Maintenance | Playwright/Chromium lifecycle plus DOM selectors | MV3 lifecycle, DOM/Fiber selectors, Bridge, and browser compatibility | Both maintenance surfaces plus policy/reconciliation |

### Option A — Playwright Browser Worker

**Advantages**

- It is already the current `BrowserRouter` path and satisfies the existing
  `ReviewDeliveryAdapter` contract.
- It can navigate directly to a known Conversation ID without requiring that
  the user's visible browser already has the Conversation open.
- It provides one isolated profile and one explicit automation process, which is
  useful for deterministic diagnostics and unattended Worker operation.
- The same Worker already exposes submission and completion operations.

**Disadvantages**

- The default headless persistent profile is separate from the user's normal
  Chrome/Edge profile. Login/session setup and profile health become a separate
  operational problem on Windows.
- It depends on Playwright, Chromium startup, a managed profile directory, and
  mutable ChatGPT DOM selectors. A Worker start failure is recorded and is not
  automatically restarted by the current implementation.
- A request timeout or lost HTTP response after a successful ChatGPT send has no
  durable Worker ACK boundary. A later retry can therefore duplicate a review
  message.
- Each request opens a new Worker page. The current path has no per-Conversation
  browser-document lease comparable to the Extension path, so concurrent or
  repeated work needs higher-level serialization and reconciliation.
- A headless Worker page does not automatically participate in the user's live
  Extension identity/correlation path.

**Suitable scenarios**

- Isolated Worker diagnostics and test environments.
- An explicitly provisioned, dedicated ChatGPT profile whose login and lifecycle
  are managed as part of the Worker deployment.
- Completion collection while that path remains the established implementation.

**Maintenance cost**

Medium to high: Playwright/Chromium versioning, Windows profile/process
management, ChatGPT navigation and Composer selectors, authentication
diagnostics, and duplicate-send reconciliation.

### Option B — Extension Reliable Delivery

**Advantages**

- It operates in the user's real ChatGPT Web session, avoiding a second Windows
  login/profile authority for the normal interactive workflow.
- It already models the multi-Conversation problem with explicit
  `conversation_id`, `document_id`, `navigation_epoch`, client identity, and
  exact route checks. A stale tab cannot claim or ACK a newer page's command.
- Durable queue state, leases, ACK outbox recovery, idempotent settlement, and
  terminal `ambiguous` handling address the lost-response window that remains
  open in the current Worker path.
- It matches the future Codex execution direction: ChatGPT Web, the Extension,
  the Bridge, and the dispatcher remain in the Control Plane while MCP stays a
  read-only data source.
- It supports root and Project Conversation routes in the live browser and
  leaves visible evidence of the submitted message for the user.

**Disadvantages**

- The browser must be running, the Extension must be enabled, and the target
  Conversation must have an open live document. The current Extension path does
  not open a missing tab on behalf of a Review Delivery.
- MV3 service-worker suspension, background-tab throttling, Chrome/Edge
  differences, and ChatGPT DOM changes remain operational concerns.
- Fiber and DOM access use undocumented page implementation details. The route,
  selector, and Fiber allowlists must be maintained and revalidated against real
  browser releases.
- The current Extension path has no Review Delivery enqueue/await adapter yet;
  Step 9 must add that composition without weakening the existing ownership
  fences.
- The Bridge currently pairs one Extension Origin. Multiple Conversations in
  one browser Extension are supported; multiple independently paired Extension
  identities would need an explicit future decision.

**Suitable scenarios**

- Normal Windows use with a user-authenticated Chrome or Edge session.
- Multiple live ChatGPT Conversations that must remain separate and auditable.
- Future Codex/ChatGPT command dispatch where the browser page is the execution
  surface and the local process is only the Control Plane broker.

**Maintenance cost**

Medium to high: MV3 lifecycle and browser compatibility, ChatGPT DOM/Fiber
changes, Bridge protocol compatibility, tab/document recovery, and a remaining
logical Review Delivery adapter. The delivery correctness model is already
stronger than the present Worker request model, which reduces duplicate-send
reconciliation work.

### Option C — Hybrid

**Is it necessary?**

Not for the current requirements. Extension Reliable Delivery covers the
primary Windows interactive case; Playwright remains available for explicit
diagnostics and the current completion path. Automatic fallback would solve a
future availability problem by introducing a present correctness problem.

**Complexity introduced**

A hybrid needs a durable per-Delivery transport decision and arbitration model:

1. Which transport owns a Delivery before the first physical send?
2. How does the second transport know that the first send did not succeed when
   the first response is missing?
3. How are two browser accounts, profiles, tabs, or documents proven to refer
   to the same ChatGPT Conversation?
4. Which transport owns the final receipt and prevents a duplicate after a
   crash or restart?

The current `ReviewDeliveryAdapter` result is not enough to answer these
questions. A retryable HTTP failure is not proof that the message was not
accepted, and an Extension `ambiguous` result must not trigger a second
transport.

**Fallback value**

There is value in a future explicit operator-selected transport for a known
environment—for example, a dedicated Worker profile when no live browser tab
exists. That is different from transparent automatic fallback. It should be
added only after a durable cross-transport receipt and an explicit account/tab
ownership policy exist.

**Maintenance cost**

Highest: both transports, two failure/recovery models, transport selection,
cross-transport idempotency, diagnostics, and substantially more test cases.

## C. Decision recommendation

### Selected direction

Select **Option B — Extension Reliable Delivery** as the primary transport for
future outbound Review Delivery and Dispatch Command Broker work.

This is a forward direction only. The current runtime remains unchanged:

- `BrowserRouter` still defaults to `BrowserWorkerDeliveryAdapter`.
- `BrowserWorker` is not deleted or demoted to a fallback implementation in
  this step.
- `ExtensionDeliveryService`, Bridge protocol `2`, Extension identity, and
  correlation behavior are not changed.
- No automatic Hybrid fallback is introduced.

### Why this fits LRM

1. **Windows operating model.** The Extension can use the authenticated browser
   session the user already operates. The current headless Worker profile is a
   second session that must be logged in, kept healthy, and diagnosed separately.
2. **ChatGPT Web behavior.** ChatGPT is treated as a mutable SPA/UI surface:
   route changes, background tabs, document lifetimes, Composer readiness, and
   rendered message receipts all matter. The Extension path already records the
   browser document and navigation epoch instead of guessing from the active
   tab or rendered text alone.
3. **Multiple Conversations.** `ConversationRouting.conversation_id` remains
   the explicit target, and Extension claims are fenced by Conversation,
   document, client, and epoch. This is the safer model for several live
   Conversations in one browser.
4. **Reliability.** Extension Delivery has a durable claim/lease/ACK boundary
   and a terminal answer for uncertain sends. The current Worker path has a
   confirmed HTTP request but no equivalent durable command receipt.
5. **Future Codex execution.** The next Dispatch Command Broker can dispatch
   exact commands through the existing Control Plane boundary to the browser
   page that will execute them. MCP remains the read-only source of Workspace,
   Git, and Review Context data.

### Decision scope

This recommendation is for the **outbound Review Delivery transport**. It does
not decide that the Extension must collect Review completion. Completion remains
an independent concern and currently uses the Playwright Worker. A future
completion transport decision must account for how a live Extension observes and
proves assistant completion before replacing that path.

## D. Architecture impact

### Future interface changes required by the selected direction

These are implementation requirements for the next stages, not changes made by
this gate:

1. **Keep the transport-neutral adapter seam.** Reuse
   `ReviewDeliveryAdapter.deliver(request)` as the logical boundary. Add an
   Extension/Broker-backed implementation behind it rather than placing Bridge
   calls in MCP code or in `ReviewDeliveryService`.
2. **Connect logical Delivery to the durable command.** The future adapter or
   Dispatch Command Broker must enqueue a command containing the existing
   `delivery_id`, authoritative `conversation_id`, and exact Review message,
   then await the durable Extension receipt. The mapping from logical Delivery
   to broker command must be persisted or otherwise idempotent before the
   command is offered to a page.
3. **Preserve uncertain-send semantics.** The current
   `ReviewDeliveryResult` only distinguishes `delivered` and `failed`, while
   Extension Delivery also has terminal `ambiguous`. Before wiring it into the
   main path, either extend the Review Delivery lifecycle with a terminal
   ambiguous state or add an equivalent durable no-retry guard. Silently mapping
   `ambiguous` to an ordinary retryable `failed` is not acceptable.
4. **Keep Router state ownership in one place.** `BrowserRouter` may continue to
   own `beginDeliveryAttempt()` and final Review Delivery writeback. The new
   adapter must not duplicate the `ReviewDelivery` state machine.
5. **Keep target ownership explicit.** `ConversationRouting` remains the
   authority for the target Conversation. Request correlation remains evidence
   for `request_id -> conversation_id`; it must not select a Review Delivery
   target or replace routing metadata.
6. **Reuse the existing Bridge contract.** `POST /delivery/claim` and
   `POST /delivery/ack`, strict schemas, Origin/protocol/bearer checks, bounded
   bodies, and restart recovery remain the low-level Extension transport. Any
   new enqueue/await composition must be added in the Control Plane, not by
   exposing Bridge operations as MCP tools.

### Boundaries that remain unchanged

```text
MCP = Read-only Data Plane

Browser / Extension / Dispatcher / Codex execution
= Control Plane
```

The selected direction preserves these rules:

- MCP does not gain a browser-control tool.
- MCP does not directly operate ChatGPT or access Extension credentials.
- Local Control Bridge remains loopback-only and separate from the MCP HTTP
  server and MCP authentication.
- `ReviewDeliveryService` remains internal logical state and validation.
- `ConversationCorrelationRegistry` remains exact identity evidence, not a
  dispatcher or routing authority.
- Existing Playwright Worker, Client, Interaction, Profile, and completion
  modules remain in place.
- No protocol version change, Hybrid fallback, or ReviewDelivery main-chain
  switch is part of Step 8.

### Risks and controls

| Risk | Control required before production use |
| --- | --- |
| ChatGPT DOM, route, or Fiber shape changes | Keep strict allowlists and negative tests; run a real Chrome/Edge gate for identity, one send, receipt, and restart behavior. |
| Target Conversation tab is closed or background-throttled | Return an explicit unavailable/pending result; do not guess another tab and do not transparently switch transports. |
| ChatGPT accepted a message but the ACK was lost | Persist the Extension ACK outbox first; retry the identical ACK only; treat missing stable receipt as terminal ambiguous. |
| Stale tab/document acts after navigation | Continue requiring exact `MessageSender.documentId`, Conversation URL equality, and navigation epoch. |
| Bridge or Extension state is corrupt | Keep delivery unavailable and preserve the corrupt file for diagnosis; keep MCP identity/Data Plane available. |
| Extension and Worker refer to different sessions/accounts | Do not use automatic Hybrid fallback. If explicit Worker selection is later needed, make profile/account ownership visible and deliberate. |
| Submission and completion use different browser transports | Keep completion as a separate contract until its own identity and receipt proof are decided. |

The current automated Extension and Worker tests cover the source-level
contracts. The existing documentation still calls for one real Edge validation
of the Extension send/receipt and ACK-recovery path; that is an operational
readiness gate, not a reason to weaken the architecture decision.

## Step 9 — Dispatch Command Broker

Step 9 implements the smallest Control Plane composition that turns the
selected direction into a Review Delivery-capable transport:

1. Define the durable logical-Delivery-to-command identity and its terminal
   outcomes, including `ambiguous`.
2. Enqueue before page claim; use the existing exact Conversation/document/epoch
   ownership fence.
3. Return only the durable Extension receipt to the Review Delivery adapter;
   never treat a click or HTTP success alone as delivery.
4. Preserve idempotent ACK replay and restart recovery without copying COS
   Agent/Goal/Resume workflows.
5. Add focused tests for multiple Conversations, stale documents, lost ACKs,
   ambiguous sends, corrupt state, and repeated logical Delivery requests.

The implementation is in `src/control-plane/dispatch-command-broker.ts` and
`src/delivery/extension-delivery-adapter.ts`. The current Playwright
`BrowserRouter` default remains available; an Extension-backed Router uses the
injected adapter and the same `ExtensionDeliveryService` instance as the
Bridge. Completion remains Worker-based and no automatic Hybrid fallback is
introduced.
