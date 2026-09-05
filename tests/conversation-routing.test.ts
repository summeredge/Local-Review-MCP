import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { generateConversationRoutingExample } from "../src/context/conversation-routing-diagnostic.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewContextService } from "../src/context/review-context-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { TaskContextService } from "../src/context/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-routing-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeContexts(storageRoot: string, workspaceId = "workspace-a"): Promise<void> {
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: workspaceId,
    status: "reviewing",
  });
  await new ExecutionContextService(storageRoot).createExecutionContext({
    execution_id: "execution-001",
    task_id: "task-001",
    workspace_id: workspaceId,
  });
  await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "review-001",
    task_id: "task-001",
    execution_id: "execution-001",
    workspace_id: workspaceId,
  });
}

describe("ConversationRoutingService", () => {
  it("creates, validates, and persists a routing", async () => {
    const storageRoot = await makeStorageRoot();
    await makeContexts(storageRoot);
    const service = new ConversationRoutingService(storageRoot);

    const routing = await service.createRouting({
      workspace_id: "workspace-a",
      task_id: "task-001",
      review_request_id: "review-001",
      conversation_id: "conversation-001",
    });

    expect(routing).toMatchObject({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-001",
      review_request_id: "review-001",
      conversation_id: "conversation-001",
    });
    expect(routing.routing_id).toMatch(/^routing-/u);
    expect(await service.getRouting("workspace-a", routing.routing_id)).toEqual(routing);
    expect(JSON.parse(await readFile(join(
      storageRoot,
      ".task",
      "conversation_routings",
      "workspace-a",
      `${routing.routing_id}.json`,
    ), "utf8"))).toEqual(routing);
  });

  it("rejects a review request from another workspace", async () => {
    const storageRoot = await makeStorageRoot();
    await makeContexts(storageRoot, "workspace-a");
    const service = new ConversationRoutingService(storageRoot);

    await expect(service.createRouting({
      workspace_id: "workspace-b",
      task_id: "task-001",
      review_request_id: "review-001",
      conversation_id: "conversation-001",
    })).rejects.toMatchObject({
      code: "WORKSPACE_IDENTITY_MISMATCH",
    });
  });

  it("rejects a routing that differs from the runtime workspace identity", async () => {
    const storageRoot = await makeStorageRoot();
    await makeContexts(storageRoot);
    const service = new ConversationRoutingService(storageRoot, {
      id: "workspace-a",
      name: "Workspace A",
      path: ".",
    });

    await expect(service.createRouting({
      workspace_id: "workspace-b",
      task_id: "task-001",
      review_request_id: "review-001",
      conversation_id: "conversation-001",
    })).rejects.toMatchObject({ code: "WORKSPACE_IDENTITY_MISMATCH" });
  });

  it("leaves the existing review projection unchanged", async () => {
    const storageRoot = await makeStorageRoot();
    await makeContexts(storageRoot);
    const routingService = new ConversationRoutingService(storageRoot);
    const before = await new ReviewContextService(storageRoot)
      .buildReviewContext("workspace-a", "review-001");

    await routingService.createRouting({
      workspace_id: "workspace-a",
      task_id: "task-001",
      review_request_id: "review-001",
      conversation_id: "conversation-001",
    });

    const after = await new ReviewContextService(storageRoot)
      .buildReviewContext("workspace-a", "review-001");
    expect(after).toMatchObject({
      workspace_id: before.workspace_id,
      task: before.task,
      execution: before.execution,
      review_request: before.review_request,
    });
    expect(after.review_request).not.toHaveProperty("routing_id");
  });

  it("generates a complete temporary diagnostic record", async () => {
    const routing = await generateConversationRoutingExample();

    expect(routing).toMatchObject({
      workspace_id: "example-workspace",
      task_id: "example-task",
      execution_id: "example-execution",
      review_request_id: "example-review",
      conversation_id: "example-conversation",
    });
  });
});
