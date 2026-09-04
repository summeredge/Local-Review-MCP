# Task Context design

## Scope

Task Context is a small internal data layer for a future Codex to ChatGPT
review loop. It does not control Codex, ChatGPT, a browser, or the MCP
runtime, and it is not an MCP tool in the V0.1 contract.

The ownership boundaries are:

```text
Workspace Registry -- workspace_id --> Task Context -- conversation_id? --> Conversation
```

This is intentionally not:

```text
Workspace -------------------------> Conversation
```

`Workspace` remains the data source and security boundary. `Task Context`
describes one development task. `Conversation` is only an optional future
review routing target.

## Data model

```typescript
interface TaskContext {
  task_id: string;
  workspace_id: string;
  conversation_id?: string;
  status: "pending" | "reviewing" | "completed" | "failed";
  created_at: string;
  updated_at: string;
}
```

- `task_id` is generated independently from `workspace_id` when omitted and
  remains stable for the stored context.
- `workspace_id` is the stable ID supplied by the Workspace Registry. The
  service stores and validates its shape but does not resolve or mutate the
  registry.
- `conversation_id` is optional. The service does not create conversations,
  infer one from a workspace, or enforce a one-to-one binding.
- `status` is a flat value only. The service does not enforce a transition
  graph or introduce an INIT/PLAN/EXECUTED/REVIEW/DONE state machine.
- `created_at` and `updated_at` are ISO 8601 timestamps. Updates preserve the
  task and workspace identities and refresh `updated_at`.

## Local persistence

Contexts are stored below the application-local state root, separate from the
selected workspace and Workspace Registry:

```text
<LocalReviewMCP application state root>/
└── .task/
    └── contexts/
        └── <task_id>.json
```

On Windows the default root is `%LOCALAPPDATA%\LocalReviewMCP`. Tests and
embedding code can provide another storage root to `TaskContextService`. The
service creates the directory lazily, requests a restrictive file mode where
the platform supports it, and keeps no in-memory cache; a new service instance
reads the same files.

Example persisted value:

```json
{
  "task_id": "abc123",
  "workspace_id": "workspace-a",
  "status": "pending",
  "created_at": "2026-09-04T10:00:00.000Z",
  "updated_at": "2026-09-04T10:00:00.000Z"
}
```

One workspace may have many task contexts:

```text
workspace-a
├── task-1
├── task-2
└── task-3
```

The context files do not change Workspace Registry entries, workspace access
policy, or MCP Runtime startup/shutdown behavior.

## Service surface

`src/context/service.ts` exposes the internal `TaskContextService`:

```text
createTaskContext(input)       -> Promise<TaskContext>
getTaskContext(task_id)        -> Promise<TaskContext | null>
updateTaskContext(task_id, patch) -> Promise<TaskContext>
listTaskContexts()             -> Promise<TaskContext[]>
```

The service uses the existing Zod dependency for persisted-data and input
validation. It rejects unsafe task IDs because they become filenames, rejects
unknown status values, and rejects extra fields in stored contexts. It does
not expose arbitrary file paths.

## MCP decision

No MCP Tool is added in this task. Creating and updating a Task Context are
mutating operations in the future Control Plane, while the frozen LRM surface
is a read-only Review Data Plane. Exposing them now would add a new permission
surface and blur the existing boundary. A future read-only review-context
projection can be considered separately once its caller, scope, and contract
are defined.

## Future extension

The following is reserved design space only; `metadata` is not implemented in
this task:

```json
{
  "task_id": "",
  "workspace_id": "",
  "conversation_id": "",
  "status": "",
  "metadata": {}
}
```
