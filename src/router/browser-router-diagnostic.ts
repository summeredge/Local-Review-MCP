import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWorkerClient } from "../browser-worker-client/browser-worker-client.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { TaskContextService } from "../context/service.js";
import { BrowserWorkerDeliveryAdapter } from "../delivery/browser-worker-delivery-adapter.js";
import { conversationUrl } from "../delivery/conversation-url.js";
import { BrowserRouter } from "./browser-router.js";

export interface BrowserRouterDiagnosticResult {
  readonly conversation_id: string;
  readonly browser_worker_status: "NAVIGATED";
  readonly delivery_status: "delivered";
  readonly attempt_count: number;
}

interface MockBrowserWorker {
  readonly server: Server;
  readonly baseUrl: string;
  readonly conversationIds: string[];
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function startMockBrowserWorker(): Promise<MockBrowserWorker> {
  const conversationIds: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url?.split("?", 1)[0] !== "/conversation/navigate") {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    void readBody(request).then((body) => {
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        sendJson(response, 400, { error: "invalid_body" });
        return;
      }
      const record = body as Record<string, unknown>;
      const conversationId = record.conversationId;
      if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "conversationId")) {
        sendJson(response, 400, { error: "conversationId_only" });
        return;
      }
      if (typeof conversationId !== "string") {
        sendJson(response, 400, { error: "invalid_conversation_id" });
        return;
      }
      conversationIds.push(conversationId);
      sendJson(response, 200, {
        conversationId,
        url: conversationUrl(conversationId),
        status: "NAVIGATED",
      });
    }).catch(() => sendJson(response, 400, { error: "invalid_json_body" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Mock Browser Worker has no listening port.");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, conversationIds };
}

async function closeMockBrowserWorker(mock: MockBrowserWorker): Promise<void> {
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
}

export async function generateReviewDeliveryBrowserExample(): Promise<BrowserRouterDiagnosticResult> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-review-delivery-browser-"));
  let mock: MockBrowserWorker | undefined;
  try {
    mock = await startMockBrowserWorker();
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

    const final = await new BrowserRouter(
      storageRoot,
      new BrowserWorkerDeliveryAdapter(new BrowserWorkerClient({ baseUrl: mock.baseUrl })),
    ).deliver("example-workspace", routing.routing_id);
    const reviewRequest = await new ReviewRequestService(storageRoot)
      .getReviewRequest("example-workspace", "example-review");
    if (final.status !== "delivered"
      || final.conversation_id !== "example-conversation"
      || mock.conversationIds.length !== 1
      || mock.conversationIds[0] !== "example-conversation"
      || reviewRequest?.status !== "pending") {
      throw new Error("Review delivery Browser Worker diagnostic did not preserve the requested boundary.");
    }
    return {
      conversation_id: final.conversation_id,
      browser_worker_status: "NAVIGATED",
      delivery_status: final.status,
      attempt_count: final.attempt_count,
    };
  } finally {
    if (mock !== undefined) await closeMockBrowserWorker(mock);
    await rm(storageRoot, { recursive: true, force: true });
  }
}

export async function generateBrowserRouterExample(): Promise<BrowserRouterDiagnosticResult> {
  return generateReviewDeliveryBrowserExample();
}
