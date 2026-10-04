# Review Delivery Architecture

## Scope

Review Delivery records an attempt to submit a Review request to the Conversation
selected by Conversation Routing. Production uses `ExtensionDeliveryAdapter` through
`DispatchCommandBroker` and the live Extension. `BrowserWorkerDeliveryAdapter` remains
available when explicitly selected for diagnostics. Submission does not read the
ChatGPT reply or decide whether the Review itself is complete.

```text
Codex completes a task
        |
        v
Execution Context
        |
        v
Review Request
        |
        v
Conversation Routing
        |
        v
Review Delivery
        |
        v
BrowserRouter (routing validation and state writeback)
        |
        v
ExtensionDeliveryAdapter
        |
        v
DispatchCommandBroker
        |
        v
ExtensionDeliveryService / Local Control Bridge
        |
        v
Extension background + ChatGPT content document
        |
        v
Durable Extension receipt
```

The explicit Browser Worker diagnostic path is:

```text
BrowserWorkerDeliveryAdapter
        |
        v
Browser Worker Client
        |
        v
Conversation Navigator
        |
        v
ChatGPT Conversation Page
        |
        v
ChatGPT Interaction Layer
        |
        v
Confirmed Review Message Submission
```

The boundaries are deliberately separate:

* **Review Request** is the logical request that a result should be reviewed.
* **Conversation Routing** says which Conversation should receive that request.
* **Review Delivery** records whether that logical delivery is pending, in
  progress, delivered, or failed, including its attempts and last error.
* **ExtensionDeliveryAdapter** maps the durable Extension receipt to the
  persisted Delivery state; `DispatchCommandBroker` binds that command to the
  logical `delivery_id`.
* **BrowserWorkerDeliveryAdapter** is an explicitly selected diagnostic
  transport. Its client is the LRM-to-Worker HTTP boundary and has no Playwright
  or DOM dependency.

`Workspace` is not a `Conversation`. The relationship is:

```text
Workspace -> Task -> Review Request -> Routing -> Conversation
```

## Data model

`src/context/review-delivery.ts` defines the model and re-exports the adapter
contract:

```typescript
interface ReviewDelivery {
  delivery_id: string;
  workspace_id: string;
  task_id: string;
  review_request_id: string;
  routing_id: string;
  conversation_id: string;
  status: "pending" | "delivering" | "delivered" | "failed" | "ambiguous";
  attempt_count: number;
  last_error?: { code?: string; message: string };
  created_at: string;
  updated_at: string;
  delivered_at?: string;
}
```

The Zod schema is strict and also enforces lifecycle invariants: pending has
no attempts, an active or terminal delivery has at least one attempt, failed
or ambiguous has `last_error`, and delivered has `delivered_at`.

The adapter boundary is intentionally small:

```typescript
interface ReviewDeliveryAdapter {
  deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult>;
}
```

`ReviewDeliveryRequest` carries the delivery id plus
`conversation_id`, `workspace_id`, `task_id`, `review_request_id`, and
`routing_id`, plus the lightweight Review message built by the Delivery layer.
`ReviewDeliveryResult` distinguishes confirmed submission, ordinary failed
delivery, and an uncertain `ambiguous` terminal result. The Router and adapter
boundary are documented in `docs/review-delivery-adapter.md`.

## Lifecycle and retry semantics

```text
pending
   |
   v
delivering -----> delivered
   |
   v
failed ---------> delivering
   \
    ambiguous
```

`beginDeliveryAttempt()` is only valid from `pending` or `failed`; it changes
the status to `delivering` and increments `attempt_count`. `markFailed()` is
only valid from `delivering` and records the failure. `markAmbiguous()` is also
only valid from `delivering`, but its result is terminal and cannot be retried.
A later begin starts the next attempt only from `failed`. `markDelivered()` is
only valid from `delivering` and records the delivery timestamp.

`delivered` is terminal for this internal record. A delivered record cannot
start another attempt and a repeated `createDelivery()` for its `routing_id`
returns the existing record without sending anything again.

Production Delivery success means only:

> The Extension returned a durable receipt proving that the Review message was
> accepted by the target Conversation.

It does **not** mean that ChatGPT has finished reviewing the request. An
Extension receipt without proof that the message was not sent is recorded as
`ambiguous`, never as a retryable `failed` result.

## Idempotency

`routing_id` is the stable key for one logical delivery target. The service
scans the workspace's delivery records before creating a record. A second
creation request for the same routing returns the existing `delivery_id`,
regardless of its current status. It does not create another logical Delivery
or increment attempts. Attempt counting happens only in
`beginDeliveryAttempt()`.

`conversation_id` is not an idempotency key: one Conversation may receive
different tasks and Review Requests. A supplied Conversation, task, or Review
Request that differs from the existing Routing is rejected.

## Association validation

`ReviewDeliveryService.validateDelivery()` revalidates the delivery schema,
the optional runtime Workspace Identity, and the referenced Conversation
Routing. The following values must match the same chain:

```text
Routing.workspace_id       == Delivery.workspace_id
Routing.task_id            == Delivery.task_id
Routing.review_request_id  == Delivery.review_request_id
Routing.conversation_id    == Delivery.conversation_id
```

The existing `ConversationRoutingService.validateRouting()` is then reused to
verify the Task, Execution, Review Request, and Workspace links. A routing
record found under a different workspace is rejected with
`WORKSPACE_IDENTITY_MISMATCH`. The existing
`validateWorkspaceIdentityConsistency()` check is also reused when a runtime
identity is supplied.

## Persistence

The service uses the existing application-local Context storage root and the
same strict JSON file pattern as the other Context Services:

```text
.task/
├── contexts/
├── executions/
├── review_requests/
├── conversation_routings/
└── review_deliveries/
    └── <workspace_id>/
        └── <delivery_id>.json
```

Creates use exclusive file creation (`flag: "wx"`) and files are written with
the existing `0700` directory and `0600` file permissions. Reads and state
updates are parsed through the strict Zod schema.

The service is internal and exposes only:

```text
createDelivery(input)
getDelivery(workspace_id, delivery_id)
getDeliveryByRouting(workspace_id, routing_id)
beginDeliveryAttempt(workspace_id, delivery_id)
markDelivered(workspace_id, delivery_id)
markFailed(workspace_id, delivery_id, error)
validateDelivery(delivery)
```

It does not add an MCP tool or modify the existing Task, Execution, Review
Request, Routing, or Review Projection APIs.

## Review completion boundary

The production submission flow is:

```text
Extension returned durable delivered receipt
        |
        v
ReviewDelivery.status = delivered
```

An explicitly selected Browser Worker diagnostic may instead confirm `SUBMITTED`;
that path does not make Browser Worker the production default.

Only a later Review completion signal may represent the actual review result:

```text
ChatGPT review actually completes
        |
        v
independent completion signal/listener
        |
        v
ReviewRequest.status = completed
```

Page navigation, composer fill, a Send click, or an HTTP success response must
not be treated as confirmed submission or completion. This task does not
update Review Request status.

## Diagnostic command

The Browser Worker integration diagnostic builds a temporary chain:

```text
Task -> Execution -> Review Request -> Conversation Routing -> Review Delivery
```

and explicitly injects a local mock Browser Worker to print the final `delivered`
JSON record:

```powershell
npm run diagnose:review-delivery-browser
```

The command uses a temporary storage root and removes it in a `finally` block.
It does not start the MCP server, access configured application state, open a
browser, contact ChatGPT, or send a review message.
