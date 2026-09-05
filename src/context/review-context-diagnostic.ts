import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionContextService } from "./execution-service.js";
import { ReviewContextService } from "./review-context-service.js";
import type { ReviewContextProjection } from "./review-context.js";
import { ReviewRequestService } from "./review-request-service.js";
import { TaskContextService } from "./service.js";
import { validateWorkspaceIdentity } from "../workspace/identity.js";
import type { WorkspaceIdentity } from "../workspace/types.js";

export async function generateReviewContextExample(
  workspaceIdentity: WorkspaceIdentity = {
    id: "example-workspace",
    name: "Example Workspace",
    path: ".",
  },
): Promise<ReviewContextProjection> {
  const identity = validateWorkspaceIdentity(workspaceIdentity);
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-review-context-example-"));
  try {
    await new TaskContextService(storageRoot).createTaskContext({
      task_id: "example-task",
      workspace_id: identity.id,
      status: "reviewing",
    });

    const executions = new ExecutionContextService(storageRoot);
    await executions.createExecutionContext({
      execution_id: "example-execution",
      task_id: "example-task",
      workspace_id: identity.id,
      command: "npm test",
    });
    await executions.updateExecutionContext(
      identity.id,
      "example-task",
      "example-execution",
      { status: "passed", summary: "Example: 170 tests passed" },
    );

    await new ReviewRequestService(storageRoot).createReviewRequest({
      review_request_id: "example-review",
      task_id: "example-task",
      execution_id: "example-execution",
      workspace_id: identity.id,
      conversation_id: "example-conversation",
    });

    return await new ReviewContextService(storageRoot)
      .buildReviewContext(identity.id, "example-review");
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
}
