# Review Context Projection

## Scope

Review Context Projection is a read-only, derived view for a future ChatGPT
Review consumer. It combines the current Task Context, Execution Context, and
Review Request Context. It does not control ChatGPT, Codex, a browser, or the
MCP runtime, and it is not an MCP Tool.

```text
Workspace
    |
Task Context
    |
Execution Context
    |
Review Request Context
    |
Review Context Projection
    |
ChatGPT Review
```

The local C2C reference project was checked before implementation. Its
`src/execution/` code provides the applicable ideas: lightweight execution
records, separate sanitized output, and workspace-scoped reads. It has no
review or context projection module. LRM therefore reuses the existing
context services without importing C2C session state, conversation binding,
or control-plane state machines.

## Data model

```typescript
interface ReviewContextProjection {
  review_context_id: string;
  workspace_id: string;
  task: {
    task_id: string;
    title?: string;
    description?: string;
    status?: string;
  };
  execution: {
    execution_id: string;
    status: string;
    command?: string;
    summary?: string;
    started_at: string;
    finished_at?: string;
  };
  review_request: {
    review_request_id: string;
    status: string;
    conversation_id?: string;
  };
  generated_at: string;
}
```

The projection copies only review-facing fields. The current Task Context
does not contain `title` or `description`, so those optional fields are
omitted until the source context provides them. Full file contents, Git diff,
test logs, and complete `execution_output` are not copied.

`workspace_id` is validated and checked against every source context. A
projection cannot combine a request, task, or execution from another
workspace.

## Service

`src/context/review-context-service.ts` exposes `ReviewContextService`:

```text
buildReviewContext(workspace_id, review_request_id)
  -> Promise<ReviewContextProjection>
createReviewContext(workspace_id, review_request_id)
  -> Promise<ReviewContextProjection>
getReviewContext(workspace_id, review_request_id)
  -> Promise<ReviewContextProjection | null>
```

All three methods read the current source files. `createReviewContext` and
`getReviewContext` do not create or cache a projection; they are convenience
entry points over the same live build. Missing source contexts fail the build,
while `getReviewContext` returns `null` when the review request itself is
absent.

The result is validated by the strict Zod schema in
`src/context/review-context-schema.ts`. No projection file or cache is
written, so source Context updates are visible on the next build and the
projection does not acquire an independent lifecycle.

## Local diagnostic command

The non-MCP diagnostic command creates minimal source contexts in a temporary
directory, builds one projection, prints the JSON example to stdout, and
removes the temporary directory:

```bash
npm run diagnose:review-context
```

Without arguments it does not load runtime configuration, start the MCP
server, or modify configured application state. To diagnose a concrete runtime
identity, pass the same config file used by the runtime with `--config`; the
projection then carries that registry identity.

## Boundary

This task adds no `review_context` MCP Tool. Existing read-only Git and file
tools remain the on-demand path for diff, file contents, logs, and other large
review inputs. A future MCP projection tool requires a separate scope,
permission, and contract design.
