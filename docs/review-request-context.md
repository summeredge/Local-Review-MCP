# Review Request Context design

## Scope

Review Request Context is a small internal data layer on top of Task Context
and Execution Context. It records that a specific execution result needs to
enter a review flow when Codex has finished a task. LRM stores and validates
data only; it does not start, send, or complete a review.

It does not control Codex, ChatGPT, a browser, or the MCP runtime, and it is
not an MCP tool in the V0.1 contract. Creating and updating review requests
are mutating operations in the future Control Plane, so no MCP Tool is added
in this task.

The ownership boundaries are:

```text
Workspace
    |
Task Context
    |
Execution Context
    |
Review Request Context
    |
Review Context
```

Review Request Context represents:

> A particular execution result needs to enter the review flow.

It does not represent LRM actively initiating a review.

## C2C reference review

The local C2C project
(`C:\Users\shaoy\Documents\Codex\codex-with-chatgpt`) was reviewed before
implementation. C2C appends execution records as JSONL and stores sanitized
output per workspace, and it exposes read-only `execution_summary` and
`test_status` projections; it has no review-request data model. LRM reuses the
same design ideas at the minimum viable scale already established by Task and
Execution Context: JSON files under the application-local state root,
validated with the existing Zod dependency, and isolated by `workspace_id`.
C2C session state, workspace-conversation binding, the
INIT/PLAN/EXECUTED/REVIEW/DONE state machine, and agent control logic are not
introduced.

## Data model

```typescript
interface ReviewRequestContext {
  review_request_id: string;
  task_id: string;
  execution_id: string;
  workspace_id: string;
  conversation_id?: string;
  status: "pending" | "requested" | "completed";
  created_at: string;
  updated_at: string;
}
```

- `review_request_id` identifies one review request. It is generated
  independently when omitted and remains stable for the stored request.
- `task_id` links the request to the owning `TaskContext.task_id`.
- `execution_id` links the request to the owning
  `ExecutionContext.execution_id`: which Codex execution result needs review.
- `workspace_id` is the stable ID supplied by the Workspace Registry and keeps
  review requests isolated between workspaces.
- `conversation_id` is optional. It is a future routing target for Browser
  Router to ChatGPT conversation and may be empty now; no workspace-conversation
  or task-conversation binding is enforced.
- `status` is a flat value only: `pending` (request created), `requested`
  (review request sent), `completed` (review done). No transition graph is
  enforced and failed/cancelled/timeout states are reserved for a future state
  machine.
- `created_at` and `updated_at` are ISO 8601 timestamps. Updates preserve
  identities and refresh `updated_at`.

## Relationship to Execution Context

Review Request holds a one-way reference down to Execution Context:

```text
Review Request
    |
    v
Execution Context
```

Execution Context does not store Review Requests, because one execution may
not be reviewed at all or may be reviewed multiple times:

```text
exec-001
 |
 +-- review-001
 |
 +-- review-002
```

This is intentionally not `Execution = Review`.

## Local persistence

Review requests are stored below the application-local state root, matching
the Execution Context layout:

```text
<LocalReviewMCP application state root>/
└── .task/
    ├── contexts/
    │   └── <task_id>.json
    ├── executions/
    │   └── <workspace_id>/
    │       └── <task_id>/
    │           └── <execution_id>.json
    └── review_requests/
        └── <workspace_id>/
            └── <review_request_id>.json
```

On Windows the default root is `%LOCALAPPDATA%\LocalReviewMCP`. Tests and
embedding code can provide another storage root to `ReviewRequestService`.
The service creates directories lazily, requests a restrictive file mode where
the platform supports it, and keeps no in-memory cache; a new service instance
reads the same files.

Example persisted value:

```json
{
  "review_request_id": "review-001",
  "task_id": "task-001",
  "execution_id": "exec-001",
  "workspace_id": "026e562c5692",
  "conversation_id": "abc123",
  "status": "pending",
  "created_at": "2026-09-04T10:00:00.000Z",
  "updated_at": "2026-09-04T10:00:00.000Z"
}
```

Review request files do not change Workspace Registry entries, workspace
access policy, the existing `execution_output` tool, or MCP Runtime behavior.

## Service surface

`src/context/review-request-service.ts` exposes the internal
`ReviewRequestService`:

```text
createReviewRequest(input)                    -> Promise<ReviewRequestContext>
getReviewRequest(workspace_id, review_request_id)
                                              -> Promise<ReviewRequestContext | null>
updateReviewRequest(workspace_id, review_request_id, patch)
                                              -> Promise<ReviewRequestContext>
listReviewRequests(workspace_id)              -> Promise<ReviewRequestContext[]>
```

The service validates ids, timestamps, the status enum, and unknown fields
with the existing Zod dependency through `src/context/review-schema.ts`.
Review requests are only reachable through their `workspace_id`; there is no
cross-workspace query path.

## MCP decision

No MCP Tool is added in this task. Review Requests are internal Control
Context, and creating and updating them are mutating operations. A future
read-only `review_context` projection can be considered separately once its
caller, scope, and contract are defined (proposed as LRM-Task18).
