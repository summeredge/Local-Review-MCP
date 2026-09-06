# Review Delivery Adapter and Browser Router

## Scope

Task23.5 connects a persisted Review Delivery to the independent Browser
Worker and submits the Review message. Browser DOM interaction remains inside
the Browser Worker Interaction Layer.

```text
Codex
  |
  v
Task / Execution
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
Browser Router
  |
  v
Browser Worker Delivery Adapter
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

The responsibilities stay separate:

| Component | Responsibility |
| --- | --- |
| Conversation Routing | Says where a Review Request should go. |
| Review Delivery | Stores the state and attempt count for one logical delivery. |
| Review Delivery Adapter | Abstracts delivery to an external target. |
| Browser Router | Resolves routing and delivery, builds the request, and writes delivery state. |
| Browser Worker Delivery Adapter | Maps confirmed `SUBMITTED` or typed Worker failures to Delivery state. |
| Browser Worker Client | Sends `POST /conversation/deliver` to the configured Worker URL. |
| Conversation Navigator | Runs inside Browser Worker, navigates to the Conversation URL, and returns the open Page to the Worker lifecycle. |
| ChatGPT Interaction Layer | Locates the Composer, fills the Review message, clicks Send, and confirms submission. |
| Review Completion | Independent signal that ChatGPT actually finished the Review. |

`Workspace` is not a Conversation. Conversation identity comes from the
task-level chain:

```text
Review Request -> Conversation Routing -> conversation_id
```

There is no Workspace-to-Conversation binding in this layer. One Workspace
may route different tasks to different Conversations, and multiple tasks may
route to the same Conversation.

## Adapter contract

`src/delivery/review-delivery-adapter.ts` defines the transport-neutral
contract:

```typescript
interface ReviewDeliveryRequest {
  delivery_id: string;
  workspace_id: string;
  task_id: string;
  review_request_id: string;
  routing_id: string;
  conversation_id: string;
  message?: string;
  execution_id?: string;
}

type ReviewDeliveryResult =
  | { status: "delivered"; delivered_at: string }
  | {
      status: "failed";
      retryable: boolean;
      error: { code?: string; message: string };
    };

interface ReviewDeliveryAdapter {
  deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult>;
}
```

The adapter knows only the contract and does not depend on Playwright.
`BrowserWorkerDeliveryAdapter` calls `BrowserWorkerClient.deliver()` with
`request.conversation_id` and `request.message`. The client request contains
only the HTTP payload and no DOM logic.

## Browser Router

`src/router/browser-router.ts` exposes the internal entry point:

```text
deliver(workspace_id, routing_id) -> ReviewDelivery
```

It performs this sequence:

1. Load the `ConversationRouting` by the supplied `routing_id`.
2. Reuse `ConversationRoutingService.validateRouting()` to validate the task,
   execution, Review Request, and Workspace links.
3. Load the single Review Delivery associated with that `routing_id` and
   validate its task, request, routing, and Conversation fields.
4. Return a `delivered` record immediately without calling the adapter again.
5. For `pending` or `failed`, call `beginDeliveryAttempt()`.
6. Call the injected adapter with the routed identity fields and the built
   lightweight Review message.
7. Call `markDelivered()` or `markFailed()` on the existing service.

The Router never creates or rewrites `workspace_id`, `routing_id`, or
`conversation_id`. It accepts a Conversation ID, never an arbitrary URL.

## Conversation URL rule

`src/delivery/conversation-url.ts` is the only URL construction helper. A
valid ID contains ASCII letters, digits, `_`, or `-`, starts with a letter or
digit, and is limited to 256 characters. The logical target is:

```text
https://chatgpt.com/c/<conversation_id>
```

Empty values, full URLs, external hosts, slashes, dots, query strings, and
path traversal values are rejected. Calling the helper does not open the URL.

The Router validates the ID before invoking the Adapter. The Browser Worker
Client sends the logical `conversationId` to the Worker; only the Worker-side
Conversation Navigator constructs the ChatGPT URL and navigates to it.

## Browser Worker Client

`src/browser-worker-client/browser-worker-client.ts` is the LRM-to-Worker
communication boundary:

```typescript
interface BrowserWorkerClientConfig {
  baseUrl: string;
  timeoutMs?: number;
}

client.deliver(conversationId, message)
  -> POST /conversation/deliver { conversationId, message }
  -> BrowserDeliveryResult
```

The default base URL is `http://127.0.0.1:12081`. Transport, HTTP, timeout,
and invalid-response failures are returned as `BrowserWorkerClientError` and
then mapped by `BrowserWorkerDeliveryAdapter` to a failed Delivery.

The Browser Worker failure codes and retry policy are:

| Code | Retryable |
| --- | --- |
| `AUTH_REQUIRED` | no |
| `CONVERSATION_NOT_FOUND` | no |
| `COMPOSER_NOT_FOUND` | yes |
| `SUBMIT_FAILED` | yes |
| `BROWSER_NOT_AVAILABLE` | yes |
| `DELIVERY_TIMEOUT` | yes |
| `BROWSER_WORKER_HTTP_ERROR` | HTTP 5xx only |
| `BROWSER_WORKER_INVALID_RESPONSE` | no |
| `BROWSER_WORKER_CONFIG_ERROR` | no |

The Router does not run a retry loop or scheduler. A retryable failed Delivery
can be attempted later through the same Router. A non-retryable failure is
recorded and is not retried automatically.

The Router builds a lightweight message containing `workspace_id`, `task_id`,
`execution_id` when present, `review_request_id`, and `routing_id`. It asks
ChatGPT to use Local Review MCP for Workspace, Review Context, Git status, and
uncommitted diff reads; it does not embed the diff or source files.

## State writeback and completion

The Router reuses the existing Review Delivery lifecycle:

```text
pending -> delivering -> delivered
                    \-> failed -> delivering
```

It never duplicates the state machine. Only a confirmed `SUBMITTED` adapter
result writes `ReviewDelivery.status = "delivered"`; a typed Worker failure
writes `ReviewDelivery.status = "failed"` and records the error. It does not
update `ReviewRequest.status`, because submission is not Review completion.

```text
Browser Worker returned SUBMITTED
        |
        v
ReviewDelivery.status = delivered
        |
        v
Later Review completion signal
        |
        v
ReviewRequest.status = completed
```

Conversation navigation, Composer fill, a Send click, or an HTTP success
response is not confirmed submission or completion.

## Idempotency and identity

The existing `routing_id` association remains the logical Delivery key. A
second Router call for a delivered record returns that record without calling
the Adapter or Browser Worker. `conversation_id` is not used as an idempotency
key.

Every Router call validates the complete chain:

```text
Routing.workspace_id      == Delivery.workspace_id
Routing.task_id           == Delivery.task_id
Routing.review_request_id == Delivery.review_request_id
Routing.conversation_id   == Delivery.conversation_id
```

The existing Workspace Identity consistency check remains the source of truth.
Connector session caches, saved ChatGPT URLs, and Project state are not added
to LRM Workspace Identity. The local C2C reference keeps those concerns in
`src/session/state.ts`; LRM only consumes the explicit routing record.

## C2C reference boundary

The local reference project at
`C:\Users\shaoy\Documents\Codex\codex-with-chatgpt` was checked before this
boundary was added. Its `src/session/state.ts` separates saved ChatGPT
conversation pointers from task checkpoints, while `src/execution/records.ts`
keeps execution metadata separate. Its protocol distinguishes an executed
iteration waiting for review from a completed task.

LRM reuses that separation and the explicit completion boundary. It does not
import the C2C session, Project, Agent state machine, connector cache, or
browser automation.

## Diagnostic command

```powershell
npm run diagnose:review-delivery-browser
```

The command builds a temporary Task -> Execution -> Review Request -> Routing
-> Delivery chain, invokes `BrowserRouter` with a local mock Browser Worker,
prints the final status, and removes the temporary directory in `finally`:

```json
{
  "conversation_id": "example-conversation",
  "browser_worker_status": "SUBMITTED",
  "delivery_status": "delivered",
  "attempt_count": 1
}
```

It does not start MCP, modify formal application state, open a browser, or
access the network. No MCP Tool is added or changed by this task.
