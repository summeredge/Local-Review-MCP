# Review Delivery Adapter and Browser Router

## Scope

Task22 adds the internal boundary between a persisted Review Delivery and a
future browser implementation. It does not open a browser, contact ChatGPT,
access the network, or implement Playwright, Selenium, or CDP behavior.

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
Review Delivery Adapter
  |
  v
Browser Driver
  |
  v
ChatGPT Conversation
```

The responsibilities stay separate:

| Component | Responsibility |
| --- | --- |
| Conversation Routing | Says where a Review Request should go. |
| Review Delivery | Stores the state and attempt count for one logical delivery. |
| Review Delivery Adapter | Abstracts delivery to an external target. |
| Browser Router | Resolves routing and delivery, builds the request, and writes delivery state. |
| Browser Driver | Future boundary for opening a Conversation and sending text. |
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
  message: string;
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

The adapter knows only the contract. It has no dependency on a browser
library. `BrowserDeliveryAdapter` is the current implementation: it wraps a
`BrowserDeliveryDriver`, validates the Conversation target, and maps driver
failures to the adapter result.

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
6. Build a small Review message and call the injected adapter.
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

The Router and Adapter validate the ID before invoking the Driver. The Driver
still receives the logical `conversation_id`; the future Driver can decide how
to use the validated target.

## Browser Driver boundary

`src/delivery/browser-delivery-driver.ts` defines the replaceable boundary:

```typescript
interface BrowserDeliveryDriver {
  openConversation(conversationId: string): Promise<void>;
  sendMessage(
    conversationId: string,
    message: string,
  ): Promise<BrowserDeliveryResult>;
}
```

`MockBrowserDeliveryDriver` is used by tests and diagnostics. It records the
Conversation IDs and messages it receives, but performs no browser or network
operation. The real browser Driver is deferred to Task23.

The defined driver codes and retry policy are:

| Code | Retryable |
| --- | --- |
| `BROWSER_NOT_AVAILABLE` | yes |
| `DELIVERY_TIMEOUT` | yes |
| `SEND_FAILED` | yes |
| `CONVERSATION_NOT_FOUND` | no |
| `AUTH_REQUIRED` | no |

The Router does not run a retry loop or scheduler. A retryable failed Delivery
can be attempted later through the same Router. A non-retryable failure is
recorded and is not retried automatically.

## Review message

`src/delivery/review-message.ts` owns the initial message. It includes the
`workspace_id`, `task_id`, and `review_request_id`, with `execution_id` and
`routing_id` when available:

```text
请 Review 当前任务。请使用 Local Review MCP 读取
workspace_id=... task_id=... review_request_id=...
对应 Workspace，并基于当前 Review Context、Git 状态和未提交 diff 检查本次修改。
```

The message contains identifiers only. It does not contain a diff, source
files, or an execution log; ChatGPT reads those through LRM MCP as needed.

## State writeback and completion

The Router reuses the existing Review Delivery lifecycle:

```text
pending -> delivering -> delivered
                    \-> failed -> delivering
```

It never duplicates the state machine. A successful adapter result writes
`ReviewDelivery.status = "delivered"` and synchronizes a pending
`ReviewRequest.status` to `"requested"`. It never sets the Review Request to
`"completed"`.

```text
message successfully delivered
        |
        v
ReviewDelivery.status = delivered
ReviewRequest.status = requested
        |
        v
independent Review completion signal
        |
        v
ReviewRequest.status = completed
```

The page being visible, a message being present in an input, or an HTTP
success response is not a Review completion signal.

## Idempotency and identity

The existing `routing_id` association remains the logical Delivery key. A
second Router call for a delivered record returns that record without calling
the Adapter or Driver. `conversation_id` is not used as an idempotency key.

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
npm run diagnose:browser-router
```

The command builds a temporary Task -> Execution -> Review Request -> Routing
-> Delivery chain, invokes `BrowserRouter` with
`MockBrowserDeliveryDriver`, prints the final status, and removes the
temporary directory in `finally`:

```json
{
  "conversation_id": "example-conversation",
  "delivery_status": "delivered",
  "attempt_count": 1
}
```

It does not start MCP, modify formal application state, open a browser, or
access the network. No MCP Tool is added or changed by this task.
