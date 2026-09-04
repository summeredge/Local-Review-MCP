import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewRequestService } from "../src/context/review-request-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-review-request-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ReviewRequestService", () => {
  it("creates a review request in pending status and persists it", async () => {
    const storageRoot = await makeStorageRoot();
    const service = new ReviewRequestService(storageRoot);

    const request = await service.createReviewRequest({
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
    });

    expect(request).toMatchObject({
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
      status: "pending",
    });
    expect(request.review_request_id).toBeTruthy();
    expect(request.conversation_id).toBeUndefined();
    expect(request.created_at).toBeTruthy();
    expect(request.updated_at).toBe(request.created_at);
    expect(JSON.parse(await readFile(
      join(
        storageRoot,
        ".task",
        "review_requests",
        "workspace-a",
        `${request.review_request_id}.json`,
      ),
      "utf8",
    ))).toEqual(request);
  });

  it("updates status from pending to requested to completed", async () => {
    const service = new ReviewRequestService(await makeStorageRoot());
    const created = await service.createReviewRequest({
      review_request_id: "review-001",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
    });

    const requested = await service.updateReviewRequest(
      "workspace-a",
      "review-001",
      { status: "requested" },
    );
    expect(requested).toMatchObject({
      review_request_id: "review-001",
      status: "requested",
      created_at: created.created_at,
    });
    expect(requested.updated_at > created.updated_at).toBe(true);

    const completed = await service.updateReviewRequest(
      "workspace-a",
      "review-001",
      { status: "completed" },
    );
    expect(completed.status).toBe("completed");
    expect(completed.execution_id).toBe("exec-001");
  });

  it("does not mix review requests across workspaces", async () => {
    const service = new ReviewRequestService(await makeStorageRoot());
    await service.createReviewRequest({
      review_request_id: "review-001",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
    });
    await service.createReviewRequest({
      review_request_id: "review-001",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-b",
    });

    expect(await service.listReviewRequests("workspace-a")).toHaveLength(1);
    expect(await service.listReviewRequests("workspace-b")).toHaveLength(1);
    expect((await service.getReviewRequest("workspace-a", "review-001"))?.workspace_id)
      .toBe("workspace-a");
    expect(await service.getReviewRequest("workspace-a", "review-999")).toBeNull();
    expect((await service.getReviewRequest("workspace-b", "review-001"))?.workspace_id)
      .toBe("workspace-b");
  });

  it("allows multiple review requests for one execution", async () => {
    const service = new ReviewRequestService(await makeStorageRoot());
    await service.createReviewRequest({
      review_request_id: "review-001",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
    });
    await service.createReviewRequest({
      review_request_id: "review-002",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
    });

    expect((await service.listReviewRequests("workspace-a"))
      .map(({ review_request_id }) => review_request_id))
      .toEqual(["review-001", "review-002"]);
  });
});
