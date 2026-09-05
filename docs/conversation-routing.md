# Conversation Routing

## Scope

Conversation Routing is Control Plane metadata for associating one Review
Request with one external ChatGPT Conversation. It does not make a
conversation part of Workspace Registry state and does not control Codex,
ChatGPT, a browser, or the MCP runtime.

```text
Workspace
    |
    v
Task
    |
    v
Execution
    |
    v
Review Request
    |
    v
Conversation Routing
    |
    v
ChatGPT Conversation
```

One workspace can therefore have many tasks, executions, review requests, and
conversation routings. A conversation is not stored as a Workspace child.

## Data model

```typescript
interface ConversationRouting {
  routing_id: string;
  workspace_id: string;
  task_id: string;
  execution_id?: string;
  review_request_id: string;
  conversation_id: string;
  created_at: string;
  updated_at: string;
}
```

`workspace_id` is supplied by the Workspace Identity Runtime Context. The
service never derives it from a path, creates it, or replaces it with a
temporary ID. When a runtime identity is provided, the routing ID is checked
with `validateWorkspaceIdentityConsistency()`.

`execution_id` is optional for review stages that do not have an execution.
For the current Review Request Context, `createRouting()` derives it from the
referenced review request and checks the execution, task, and workspace links.
`conversation_id` is only stored; no conversation is created or contacted.

Routing records are persisted as strict, Zod-validated JSON under the
application state directory:

```text
<LocalReviewMCP state root>/
└── .task/
    ├── contexts/
    ├── executions/
    ├── review_requests/
    └── conversation_routings/
        └── <workspace_id>/
            └── <routing_id>.json
```

The service surface is internal:

```text
createRouting(input) -> Promise<ConversationRouting>
getRouting(workspace_id, routing_id) -> Promise<ConversationRouting | null>
validateRouting(routing) -> Promise<void>
```

`validateRouting()` rejects task, execution, review-request, and runtime
workspace mismatches. A cross-workspace review request is rejected with
`WORKSPACE_IDENTITY_MISMATCH`.

## Diagnostic command

The command creates a temporary workspace identity and temporary Context
records, prints one complete routing record, then removes all temporary data:

```powershell
npm run diagnose:conversation-routing
```

It does not write configured application state, add an MCP Tool, call ChatGPT,
open a browser, or send a message. A configured identity may be supplied with
the same `--config` argument used by the runtime; the records still use a
temporary storage root.

The local C2C reference project was reviewed before implementation. Its
lightweight session and execution metadata informed the JSON/context approach,
but its agent state machine, session automation, and browser control are not
included here.
