import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserDeliveryAdapter } from "../delivery/browser-delivery-adapter.js";
import { MockBrowserDeliveryDriver } from "../delivery/browser-delivery-driver.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { TaskContextService } from "../context/service.js";
import { BrowserRouter } from "./browser-router.js";

export interface BrowserRouterDiagnosticResult {
  readonly conversation_id: string;
  readonly delivery_status: "delivered";
  readonly attempt_count: number;
}

export async function generateBrowserRouterExample(): Promise<BrowserRouterDiagnosticResult> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-browser-router-"));
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
    await new ReviewDeliveryService(storageRoot).createDelivery({
      workspace_id: routing.workspace_id,
      task_id: routing.task_id,
      review_request_id: routing.review_request_id,
      routing_id: routing.routing_id,
      conversation_id: routing.conversation_id,
    });

    const driver = new MockBrowserDeliveryDriver();
    const final = await new BrowserRouter(
      storageRoot,
      new BrowserDeliveryAdapter(driver),
    ).deliver("example-workspace", routing.routing_id);
    if (final.status !== "delivered") throw new Error("Browser Router diagnostic did not deliver.");
    return {
      conversation_id: final.conversation_id,
      delivery_status: final.status,
      attempt_count: final.attempt_count,
    };
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
}
