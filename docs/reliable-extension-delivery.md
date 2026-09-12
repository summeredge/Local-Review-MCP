# Reliable Extension Delivery

Reliable Extension Delivery is an independent Local Control Plane transport. It does not replace
the existing Playwright `BrowserDeliveryAdapter` or add an MCP tool. The Control Plane
`DispatchCommandBroker` composes it with `ReviewDelivery` through an injected adapter.

The related identities have separate owners:

- Conversation Correlation proves which ChatGPT conversation owns an MCP request.
- Reliable Extension Delivery safely sends one physical command to that exact open conversation.
- ReviewDelivery remains the logical review-delivery record.
- Browser Transport Gate remains the future choice between Extension and Playwright transports.

## Durable command and lease

`ExtensionDeliveryService.enqueue(conversationId, message, logicalDeliveryId?)` stores a versioned command in
`<LocalReviewMCP state root>/control-plane/extension-deliveries.json`. Writes are serialized and
use a mode-`0600` temporary file followed by atomic rename; the containing directory is mode
`0700`. State is bounded to 1,000 commands and never enters `.task/`.

When supplied, `logicalDeliveryId` is the stable `ReviewDelivery.delivery_id`. A repeated enqueue
with the same logical ID and exact target/message returns the original durable command; a changed
target or message is rejected. Keyed terminal commands are retained when the bounded queue evicts
legacy unkeyed commands, so a logical delivery cannot be remapped to a second physical command.

An open content document pulls work through `POST /delivery/claim`. The background worker binds
the claim to its stable `client_id`, Chrome's authoritative `MessageSender.documentId`, the exact
sender URL conversation, and the document's `navigation_epoch`. The service persists the lease
before returning the message body. A second tab cannot claim the same `delivery_id`.

LRM restart restores `queued` and `leased` commands as stored. A live lease stays owned until its
original deadline. An expired pre-submit lease can be claimed again; delivered, failed, and
ambiguous commands are terminal and are never returned again.

## Composer and receipt gate

Selectors live in `extension/chatgpt-dom.js`. Content claims only when the exact document is still
on the target conversation, the composer exists and is empty, there are no attachments, and
ChatGPT is not generating. Existing drafts are never cleared, overwritten, appended to, or sent.

After inserting the exact command text, content asks background to durably record the
`submitting` boundary before clicking Send. Every await is fenced by conversation, URL, and
navigation epoch, so A to B to A cannot revive an old operation.

A click is not delivery. `sent` requires a newly rendered ChatGPT user message whose normalized
text exactly matches the command and whose stable `data-message-id` was not present before the
click. The resulting durable receipt binds `delivery_id`, `conversation_id`, and `message_id`.
If submit occurred without that proof, the result is `ambiguous` and is never retried.

## Durable ACK recovery

The MV3 background worker stores only transport metadata in `chrome.storage.local`: stable
`client_id`, in-flight identity/stage, and the ACK outbox. It never stores the command message.

The order is:

```text
ChatGPT message receipt
  -> save ACK outbox
  -> POST /delivery/ack
  -> LRM atomically commits receipt and retires lease
  -> remove ACK outbox entry
```

After suspension or browser restart, pending ACKs are flushed before new work is claimed. A lost
HTTP ACK response therefore retries only the identical ACK. Repeated identical ACKs return the
existing receipt; changed status, conversation, owner, epoch, or message ID returns `409`.

Crash windows fail closed:

- claim before submit: the stored pre-submit lease may safely expire and retry;
- confirmed ChatGPT message before HTTP success: the durable ACK outbox retries ACK only;
- submit without a stable receipt: the durable `submitting` marker becomes terminal ambiguous,
  never a second send.

## Repeatable Goal E2E diagnostic

Run the existing diagnostic against one concrete Chat conversation:

```powershell
npm run diagnose:goal-e2e -- --config config.production.json --conversation-id <conversation_id>
```

The command starts one Runtime, verifies the existing Connector, and waits up to 60 seconds for
Bridge pairing plus live Extension presence before it creates a Goal. A Bridge restart therefore
cannot create a false failed delivery while the Extension is still recovering. Keep the target
Chat page open; its existing polling recovers pairing and presence without changing OAuth,
Connector binding, workspace identity, or the delivery state machine.

Each run uses its `goal_id` as the `run_id` and marker, prints an `E2E Pre-run Snapshot`, then ends
with an `E2E Run Summary`. The summary reports runtime, Connector, readiness, delivery, completion,
verdict, Goal, failure stage, and safe lifecycle timestamps. It never prints the delivery message,
assistant response, OAuth tokens, or Connector credentials.

Delivery claim and broker timeouts share a 90-second bound so Chromium background timer throttling
does not consume the entire lease. If an ACK arrives after a local timeout, it is accepted only from
the original owner to drain the durable outbox; the saved `ambiguous` outcome is never promoted to
`delivered`.

Diagnostic state is retained. Control Plane arrays and `.task` records contain shared production
and test relationships, so the command does not guess which historical records are safe to delete.

## Protocol and manual gate

Bridge protocol `2` adds `POST /delivery/claim` and `POST /delivery/ack`. Both retain Extension
Origin validation, protocol validation, bearer authentication, strict schemas, and the 64 KiB
request cap. `GET /hello` remains plain discovery. Protocol-1 identity-only extensions and bridges
are incompatible and receive/observe the existing fail-closed `426` behavior.

Automated tests cover state, claim ownership, receipt idempotency, restarts, composer protection,
epoch fencing, ACK loss, and ambiguous submit. Final acceptance still requires one real Edge gate:

1. Keep only the target ChatGPT conversation open and enqueue one test command.
2. Confirm exactly one new user message, capture its `message_id`, and verify the local receipt is
   `delivered` with the same `delivery_id`, `conversation_id`, and `message_id`.
3. Simulate ACK transport failure or restart LRM, then confirm the page still contains exactly one
   copy of that test message.
