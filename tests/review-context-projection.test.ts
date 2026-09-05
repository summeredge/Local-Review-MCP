import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { generateReviewContextExample } from "../src/context/review-context-diagnostic.js";
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
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-projection-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeContexts(storageRoot: string, workspaceId = "workspace-a") {
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: workspaceId,
    status: "reviewing",
  });
  const executionService = new ExecutionContextService(storageRoot);
  await executionService.createExecutionContext({
    execution_id: "exec-001",
    task_id: "task-001",
    workspace_id: workspaceId,
    command: "npm test",
  });
  const execution = await executionService.updateExecutionContext(
    workspaceId,
    "task-001",
    "exec-001",
    { status: "passed", summary: "170 tests passed" },
  );
  const reviewRequest = await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "review-001",
    task_id: "task-001",
    execution_id: execution.execution_id,
    workspace_id: workspaceId,
    conversation_id: "conversation-001",
  });
  return { executionService, reviewRequest };
}

describe("ReviewContextService", () => {
  it("generates a self-contained diagnostic example", async () => {
    const projection = await generateReviewContextExample();

    expect(projection).toMatchObject({
      workspace_id: "example-workspace",
      task: { task_id: "example-task", status: "reviewing" },
      execution: { execution_id: "example-execution", status: "passed" },
      review_request: { review_request_id: "example-review" },
    });
  });

  it("builds a bounded projection from the three contexts", async () => {
    const storageRoot = await makeStorageRoot();
    await makeContexts(storageRoot);

    const projection = await new ReviewContextService(storageRoot)
      .buildReviewContext("workspace-a", "review-001");

    expect(projection).toMatchObject({
      workspace_id: "workspace-a",
      task: { task_id: "task-001", status: "reviewing" },
      execution: {
        execution_id: "exec-001",
        status: "passed",
        command: "npm test",
        summary: "170 tests passed",
      },
      review_request: {
        review_request_id: "review-001",
        status: "pending",
        conversation_id: "conversation-001",
      },
    });
    expect(projection.review_context_id).toMatch(/^review-context-/u);
    expect(projection.generated_at).toBeTruthy();
    expect(projection.task).not.toHaveProperty("conversation_id");
  });

  it("reads current execution state on every build", async () => {
    const storageRoot = await makeStorageRoot();
    const { executionService } = await makeContexts(storageRoot);
    const service = new ReviewContextService(storageRoot);
    const first = await service.buildReviewContext("workspace-a", "review-001");

    await executionService.updateExecutionContext(
      "workspace-a",
      "task-001",
      "exec-001",
      { status: "failed", summary: "1 test failed" },
    );

    const second = await service.buildReviewContext("workspace-a", "review-001");
    expect(second.execution).toMatchObject({ status: "failed", summary: "1 test failed" });
    expect(second.review_context_id).not.toBe(first.review_context_id);
  });

  it("does not build a review request from another workspace", async () => {
    const storageRoot = await makeStorageRoot();
    await makeContexts(storageRoot, "workspace-a");

    await expect(new ReviewContextService(storageRoot)
      .buildReviewContext("workspace-b", "review-001"))
      .rejects.toThrow('Review request "review-001" was not found.');
  });

  it("does not persist the derived projection", async () => {
    const storageRoot = await makeStorageRoot();
    await makeContexts(storageRoot);
    const before = await readdir(join(storageRoot, ".task"));

    await new ReviewContextService(storageRoot).buildReviewContext("workspace-a", "review-001");

    await expect(access(join(storageRoot, ".task", "review_contexts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(storageRoot, ".task"))).toEqual(before);
  });
});
