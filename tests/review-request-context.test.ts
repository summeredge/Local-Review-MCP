import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewRequestSnapshotCoordinator, type ReviewSnapshotProvider } from "../src/context/review-request-snapshot.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import type { ReviewSnapshot } from "../src/git/types.js";

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

const reviewSnapshot: ReviewSnapshot = {
  branch: "main",
  head: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  diff_sha256: "a".repeat(64),
};

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

  it("persists an immutable review snapshot and preserves it across updates", async () => {
    const storageRoot = await makeStorageRoot();
    const service = new ReviewRequestService(storageRoot);
    const created = await service.createReviewRequest({
      review_request_id: "review-snapshot-001",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
      review_snapshot: reviewSnapshot,
    });

    expect(created.review_snapshot).toEqual(reviewSnapshot);
    expect(JSON.parse(await readFile(
      join(
        storageRoot,
        ".task",
        "review_requests",
        "workspace-a",
        "review-snapshot-001.json",
      ),
      "utf8",
    ))).toMatchObject({ review_snapshot: reviewSnapshot });

    const updated = await service.updateReviewRequest("workspace-a", "review-snapshot-001", {
      status: "completed",
    });
    expect(updated.review_snapshot).toEqual(reviewSnapshot);
  });

  it("rejects an invalid review snapshot", async () => {
    const service = new ReviewRequestService(await makeStorageRoot());
    await expect(service.createReviewRequest({
      review_request_id: "review-invalid-snapshot",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
      review_snapshot: {
        branch: "main",
        head: "",
        diff_sha256: "not-a-sha256",
      },
    })).rejects.toThrow();
  });

  it("captures a snapshot before creating a ReviewRequest through the coordinator", async () => {
    const storageRoot = await makeStorageRoot();
    const service = new ReviewRequestService(storageRoot);
    const calls: string[] = [];
    const provider: ReviewSnapshotProvider = {
      capture: async () => {
        calls.push("capture");
        return reviewSnapshot;
      },
    };
    const coordinator = new ReviewRequestSnapshotCoordinator(service, provider);

    const request = await coordinator.createReviewRequest({
      review_request_id: "review-coordinated-001",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
    });
    expect(calls).toEqual(["capture"]);
    expect(request.review_snapshot).toEqual(reviewSnapshot);
  });

  it("rejects a stored request whose identity does not match its file", async () => {
    const storageRoot = await makeStorageRoot();
    const service = new ReviewRequestService(storageRoot);
    const created = await service.createReviewRequest({
      review_request_id: "review-001",
      task_id: "task-001",
      execution_id: "exec-001",
      workspace_id: "workspace-a",
    });
    await writeFile(
      join(storageRoot, ".task", "review_requests", "workspace-a", "review-001.json"),
      JSON.stringify({ ...created, review_request_id: "review-002" }),
    );

    await expect(service.getReviewRequest("workspace-a", "review-001"))
      .rejects.toThrow(/invalid/iu);
  });
});
