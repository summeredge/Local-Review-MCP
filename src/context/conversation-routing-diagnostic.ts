import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkspaceIdentity } from "../workspace/identity.js";
import type { WorkspaceIdentity } from "../workspace/types.js";
import { ConversationRoutingService } from "./conversation-routing-service.js";
import type { ConversationRouting } from "./conversation-routing.js";
import { ExecutionContextService } from "./execution-service.js";
import { ReviewRequestService } from "./review-request-service.js";
import { TaskContextService } from "./service.js";

export async function generateConversationRoutingExample(
  workspaceIdentity?: WorkspaceIdentity,
): Promise<ConversationRouting> {
  const workspaceRoot = workspaceIdentity === undefined
    ? await mkdtemp(join(tmpdir(), "local-review-mcp-conversation-routing-workspace-"))
    : undefined;
  const identity = validateWorkspaceIdentity(workspaceIdentity ?? {
    id: "example-workspace",
    name: "Example Workspace",
    path: workspaceRoot!,
  });
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-conversation-routing-"));
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
      { status: "passed", summary: "Example: tests passed" },
    );

    await new ReviewRequestService(storageRoot).createReviewRequest({
      review_request_id: "example-review",
      task_id: "example-task",
      execution_id: "example-execution",
      workspace_id: identity.id,
    });

    return await new ConversationRoutingService(storageRoot, identity).createRouting({
      workspace_id: identity.id,
      task_id: "example-task",
      review_request_id: "example-review",
      conversation_id: "example-conversation",
    });
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}
