import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionContextService } from "./execution-service.js";
import { ReviewContextService } from "./review-context-service.js";
import type { ReviewContextProjection } from "./review-context.js";
import { ReviewRequestService } from "./review-request-service.js";
import { TaskContextService } from "./service.js";

export async function generateReviewContextExample(): Promise<ReviewContextProjection> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-review-context-example-"));
  try {
    await new TaskContextService(storageRoot).createTaskContext({
      task_id: "example-task",
      workspace_id: "example-workspace",
      status: "reviewing",
    });

    const executions = new ExecutionContextService(storageRoot);
    await executions.createExecutionContext({
      execution_id: "example-execution",
      task_id: "example-task",
      workspace_id: "example-workspace",
      command: "npm test",
    });
    await executions.updateExecutionContext(
      "example-workspace",
      "example-task",
      "example-execution",
      { status: "passed", summary: "Example: 170 tests passed" },
    );

    await new ReviewRequestService(storageRoot).createReviewRequest({
      review_request_id: "example-review",
      task_id: "example-task",
      execution_id: "example-execution",
      workspace_id: "example-workspace",
      conversation_id: "example-conversation",
    });

    return await new ReviewContextService(storageRoot)
      .buildReviewContext("example-workspace", "example-review");
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
}
