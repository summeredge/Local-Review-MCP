# Execution Context design

## Scope

Execution Context is an internal data layer describing one run of a task by
Codex. It is a read-only context provider for a future Codex to ChatGPT review
loop and is not an MCP tool in the V0.1 contract.

Execution Context represents:

> Codex has completed or is running one task run result.

It does not represent LRM executing a task. The service stores and validates
data only; it never runs a shell, calls Codex, npm, or a test framework, and
it does not start or stop the MCP runtime.

The ownership boundaries are:

```text
Workspace
    |
Task Context
    |
Execution Context
    |
Review Context
```

- `Workspace` remains the data source and security boundary.
- `Task Context` describes one development task.
- `Execution Context` describes one run of that task.
- `Review Context` is the read-only review projection consumed by ChatGPT.

## C2C reference review

The local C2C project
(`C:\\Users\\shaoy\\Documents\\Codex\\codex-with-chatgpt`) was reviewed before
implementation:

- `src/execution/records.ts` appends lightweight execution records as JSONL,
  one file per workspace, and reads the latest records back.
- `src/execution/output.ts` stores sanitized command output with an index and
  per-workspace isolation.

LRM reuses the same ideas at the minimum viable scale: JSON files under the
application-local state root, validated with the existing Zod dependency, and
isolated by `workspace_id`. C2C session state, project lifecycle, the
INIT/PLAN/EXECUTED/REVIEW/DONE state machine, and agent control logic are not
introduced.

## Data model

```typescript
interface ExecutionContext {
  execution_id: string;
  task_id: string;
  workspace_id: string;
  status: "running" | "passed" | "failed";
  command?: string;
  started_at: string;
  finished_at?: string;
  summary?: string;
}
```

- `execution_id` identifies one execution instance. It is generated
  independently when omitted and remains stable for the stored context.
- `task_id` links the execution to the owning `TaskContext.task_id`.
- `workspace_id` is the stable ID supplied by the Workspace Registry and keeps
  executions isolated between workspaces.
- `status` is a flat value only. No transition graph is enforced.
- `command` is context only, not an execution entry point.
- `summary` holds a short human-readable result such as "170 tests passed" for
  ChatGPT Review.
- `started_at` is the creation timestamp. `finished_at` is set when an update
  moves the status away from `running`.

One task may have many executions:

```text
task-001
 |
 +-- exec-001
 |
 +-- exec-002
```

This is intentionally not `Task = Execution`.

## Local persistence

Executions are stored below the application-local state root, separate from
the selected workspace, Workspace Registry, and the fixed
`.review/execution_output.json` review input:

```text
<LocalReviewMCP application state root>/
└── .task/
    ├── contexts/
    │   └── <task_id>.json
    └── executions/
        └── <workspace_id>/
            └── <task_id>/
                └── <execution_id>.json
```

On Windows the default root is `%LOCALAPPDATA%\\LocalReviewMCP`. Tests and
embedding code can provide another storage root to `ExecutionContextService`.
The service creates directories lazily, requests a restrictive file mode where
the platform supports it, and keeps no in-memory cache; a new service instance
reads the same files.

Example persisted value:

```json
{
  "execution_id": "exec-001",
  "task_id": "task-001",
  "workspace_id": "workspace-a",
  "status": "passed",
  "command": "npm test",
  "started_at": "2026-09-04T10:00:00.000Z",
  "finished_at": "2026-09-04T10:05:00.000Z",
  "summary": "170 tests passed"
}
```

Execution files do not change Workspace Registry entries, workspace access
policy, the existing `execution_output` tool, or MCP Runtime behavior.

## Service surface

`src/context/execution-service.ts` exposes the internal
`ExecutionContextService`:

```text
createExecutionContext(input)               -> Promise<ExecutionContext>
getExecutionContext(workspace_id, task_id, execution_id)
                                            -> Promise<ExecutionContext | null>
updateExecutionContext(workspace_id, task_id, execution_id, patch)
                                            -> Promise<ExecutionContext>
listExecutions(workspace_id, task_id)       -> Promise<ExecutionContext[]>
```

The service uses the existing Zod dependency for persisted-data and input
validation. It rejects unsafe IDs because they become filenames, rejects
unknown status values, and rejects extra fields in stored contexts. It does
not expose arbitrary file paths.

## Relationship to execution_output

The existing read-only MCP tool `execution_output` reads the fixed
`.review/execution_output.json` file inside the selected workspace. Execution
Context is a separate internal data layer; it is the input that can later be
organized into a review input. Nothing in this task deletes, migrates, or
writes that file.

## MCP decision

No MCP Tool is added in this task. Execution Context is internal Control
Context on the Data Plane, and creating and updating executions are mutating
operations. Exposing them now would add a new permission surface and blur the
existing read-only boundary. A future read-only review projection can be
considered separately once its caller, scope, and contract are defined.
