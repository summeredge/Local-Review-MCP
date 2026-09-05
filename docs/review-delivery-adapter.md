# Review Delivery Adapter and Browser Router

## Scope

Task23.4 connects a persisted Review Delivery to the independent Browser
Worker. It navigates to a Conversation only; it does not send Review content,
interact with page elements, or implement the ChatGPT Interaction Layer.

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
ChatGPT Conversation Navigation
```

The responsibilities stay separate:

| Component | Responsibility |
| --- | --- |
| Conversation Routing | Says where a Review Request should go. |
| Review Delivery | Stores the state and attempt count for one logical delivery. |
| Review Delivery Adapter | Abstracts delivery to an external target. |
| Browser Router | Resolves routing and delivery, builds the request, and writes delivery state. |
| Browser Worker Delivery Adapter | Maps `NavigationResult` to Delivery success or failure. |
| Browser Worker Client | Sends `POST /conversation/navigate` to the configured Worker URL. |
| Conversation Navigator | Runs inside Browser Worker and navigates to the Conversation URL. |
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
`BrowserWorkerDeliveryAdapter` calls `BrowserWorkerClient.navigate()` with
`request.conversation_id`. The client request contains only
`{ conversationId }`; the optional message is reserved for the later
ChatGPT Interaction Layer.

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
6. Call the injected adapter with the routed identity fields; the current
   adapter uses only `conversation_id`.
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

client.navigate(conversationId)
  -> POST /conversation/navigate { conversationId }
  -> NavigationResult
```

The default base URL is `http://127.0.0.1:12081`. Transport, HTTP, timeout,
and invalid-response failures are returned as `BrowserWorkerClientError` and
then mapped by `BrowserWorkerDeliveryAdapter` to a failed Delivery.

The navigation failure codes and retry policy are:

| Code | Retryable |
| --- | --- |
| `BROWSER_NOT_AVAILABLE` | yes |
| `DELIVERY_TIMEOUT` | yes |
| `BROWSER_NAVIGATION_FAILED` | yes |
| `BROWSER_WORKER_HTTP_ERROR` | HTTP 5xx only |
| `BROWSER_WORKER_INVALID_RESPONSE` | no |
| `BROWSER_WORKER_CONFIG_ERROR` | no |

The Router does not run a retry loop or scheduler. A retryable failed Delivery
can be attempted later through the same Router. A non-retryable failure is
recorded and is not retried automatically.

Review content construction and sending are deferred to Task23.5. The current
request may retain the optional `message` field for that later adapter, but it
is not sent to the Browser Worker.

## State writeback and completion

The Router reuses the existing Review Delivery lifecycle:

```text
pending -> delivering -> delivered
                    \-> failed -> delivering
```

It never duplicates the state machine. A `NAVIGATED` adapter result writes
`ReviewDelivery.status = "delivered"`; a `FAILED` result writes
`ReviewDelivery.status = "failed"` and records the error. It does not update
`ReviewRequest.status`, because navigation is not Review submission.

```text
Browser Worker returned NAVIGATED
        |
        v
ReviewDelivery.status = delivered
        |
        v
Task23.5 Review interaction/completion signal
        |
        v
ReviewRequest.status = completed
```

Conversation navigation or an HTTP success response is not Review submission
or completion.

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
  "browser_worker_status": "NAVIGATED",
  "delivery_status": "delivered",
  "attempt_count": 1
}
```

It does not start MCP, modify formal application state, open a browser, or
access the network. No MCP Tool is added or changed by this task.
