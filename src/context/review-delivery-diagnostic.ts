import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationRoutingService } from "./conversation-routing-service.js";
import { ExecutionContextService } from "./execution-service.js";
import { ReviewDeliveryService } from "./review-delivery-service.js";
import type { ReviewDelivery } from "./review-delivery.js";
import { ReviewRequestService } from "./review-request-service.js";
import { TaskContextService } from "./service.js";

export async function generateReviewDeliveryExample(): Promise<ReviewDelivery> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-review-delivery-"));
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
      { status: "passed", summary: "Example: tests passed" },
    );

    await new ReviewRequestService(storageRoot).createReviewRequest({
      review_request_id: "example-review",
      task_id: "example-task",
      execution_id: "example-execution",
      workspace_id: "example-workspace",
    });

    const routing = await new ConversationRoutingService(storageRoot).createRouting({
      workspace_id: "example-workspace",
      task_id: "example-task",
      review_request_id: "example-review",
      conversation_id: "example-conversation",
    });

    const deliveries = new ReviewDeliveryService(storageRoot);
    const delivery = await deliveries.createDelivery({
      workspace_id: routing.workspace_id,
      task_id: routing.task_id,
      review_request_id: routing.review_request_id,
      routing_id: routing.routing_id,
      conversation_id: routing.conversation_id,
    });
    await deliveries.beginDeliveryAttempt("example-workspace", delivery.delivery_id);
    return await deliveries.markDelivered("example-workspace", delivery.delivery_id);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
}
