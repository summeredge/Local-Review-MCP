import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import type { ReviewSnapshotProvider } from "../src/context/review-request-snapshot.js";
import { ReviewResultService } from "../src/context/review-result-service.js";
import type { ReviewResult } from "../src/context/review-result.js";
import { TaskContextService } from "../src/context/service.js";
import {
  LoopController,
  LoopControllerIdentityError,
  type LoopControllerFacts,
} from "../src/control/loop-controller.js";
import { IterationDirectiveBuilder } from "../src/control/iteration-directive-builder.js";
import { ReviewVerdictParser } from "../src/control/review-verdict-parser.js";
import type { ReviewSnapshot } from "../src/git/types.js";

const matchingSnapshot: ReviewSnapshot = {
  branch: "main",
  head: "0123456789abcdef0123456789abcdef01234567",
  diff_sha256: "a".repeat(64),
};
const matchingProvider: ReviewSnapshotProvider = {
  capture: async () => matchingSnapshot,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-loop-controller-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeDeliveredChain(
  storageRoot: string,
  reviewSnapshot: ReviewSnapshot | null = matchingSnapshot,
) {
  const task = await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: "workspace-a",
    status: "reviewing",
  });
  const execution = await new ExecutionContextService(storageRoot).createExecutionContext({
    execution_id: "execution-001",
    task_id: task.task_id,
    workspace_id: task.workspace_id,
  });
  const request = await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "review-001",
    task_id: task.task_id,
    execution_id: execution.execution_id,
    workspace_id: task.workspace_id,
    ...(reviewSnapshot === null ? {} : { review_snapshot: reviewSnapshot }),
  });
  const routing = await new ConversationRoutingService(storageRoot).createRouting({
    routing_id: "routing-001",
    workspace_id: task.workspace_id,
    task_id: task.task_id,
    review_request_id: request.review_request_id,
    conversation_id: "conversation-001",
  });
  const deliveries = new ReviewDeliveryService(storageRoot);
  const pending = await deliveries.createDelivery({
    workspace_id: routing.workspace_id,
    task_id: routing.task_id,
    review_request_id: routing.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: routing.conversation_id,
  });
  await deliveries.beginDeliveryAttempt(task.workspace_id, pending.delivery_id);
  const delivery = await deliveries.markDelivered(task.workspace_id, pending.delivery_id);
  return { task, execution, request, delivery };
}

function verdictContent(
  reviewRequestId: string,
  decision: "APPROVE" | "ITERATE" | "HUMAN_REQUIRED",
): string {
  const payload = {
    schema_version: 1,
    review_request_id: reviewRequestId,
    decision,
    summary: `${decision} summary`,
    ...(decision === "ITERATE" ? {
      iteration: {
        goal: "Fix the blocking issue.",
        requirements: ["Keep the change inside the current task."],
        acceptance_criteria: ["The blocking issue is fixed."],
      },
    } : {}),
  };
  return `<lrm-review-result>${JSON.stringify(payload)}</lrm-review-result>`;
}

async function createResult(
  storageRoot: string,
  status: ReviewResult["status"],
  content?: string,
): Promise<ReviewResult> {
  const { request, delivery } = await makeDeliveredChain(storageRoot);
  return new ReviewResultService(storageRoot).createReviewResult({
    review_request_id: request.review_request_id,
    delivery_id: delivery.delivery_id,
    workspace_id: request.workspace_id,
    status,
    ...(content === undefined ? { error: "review did not complete" } : { content }),
  });
}

describe("LoopController", () => {
  it("maps an APPROVE verdict to COMPLETE", async () => {
    const storageRoot = await makeStorageRoot();
    const result = await createResult(storageRoot, "COMPLETED", verdictContent("review-001", "APPROVE"));

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: matchingProvider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({
        action: "COMPLETE",
        reason_code: "REVIEW_APPROVED",
        review_result_id: result.result_id,
      });
  });

  it("maps ITERATE and keeps the verdict iteration unchanged", async () => {
    const storageRoot = await makeStorageRoot();
    const { task, execution, request, delivery } = await makeDeliveredChain(storageRoot);
    const result = await new ReviewResultService(storageRoot).createReviewResult({
      review_request_id: request.review_request_id,
      delivery_id: delivery.delivery_id,
      workspace_id: request.workspace_id,
      status: "COMPLETED",
      content: verdictContent(request.review_request_id, "ITERATE"),
    });
    const verdict = new ReviewVerdictParser().parse(result);
    const before = JSON.stringify(verdict);
    const facts: LoopControllerFacts = {
      task,
      execution,
      review_request: request,
      review_delivery: delivery,
      review_result: result,
      review_verdict: verdict,
      current_review_snapshot: matchingSnapshot,
    };

    const decision = new LoopController(storageRoot).decide(facts);

    expect(decision).toMatchObject({
      action: "ITERATE",
      reason_code: "REVIEW_REQUIRES_ITERATION",
      review_result_id: result.result_id,
    });
    expect(JSON.stringify(verdict)).toBe(before);
    expect(verdict.iteration?.goal).toBe("Fix the blocking issue.");

    const directive = new IterationDirectiveBuilder().build(decision, verdict);
    expect(directive).toMatchObject({
      loop_decision_id: decision.decision_id,
      workspace_id: task.workspace_id,
      task_id: task.task_id,
      source_execution_id: execution.execution_id,
      review_request_id: request.review_request_id,
      review_result_id: result.result_id,
    });
  });

  it("maps HUMAN_REQUIRED to HUMAN_REQUIRED", async () => {
    const storageRoot = await makeStorageRoot();
    await createResult(storageRoot, "COMPLETED", verdictContent("review-001", "HUMAN_REQUIRED"));

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: matchingProvider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({
        action: "HUMAN_REQUIRED",
        reason_code: "REVIEW_REQUIRES_HUMAN",
      });
  });

  it("maps TIMEOUT and FAILED to RETRY_REVIEW", async () => {
    const timeoutRoot = await makeStorageRoot();
    await createResult(timeoutRoot, "TIMEOUT");
    await expect(new LoopController(timeoutRoot).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "REVIEW_TIMEOUT" });

    const failedRoot = await makeStorageRoot();
    await createResult(failedRoot, "FAILED");
    await expect(new LoopController(failedRoot).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "REVIEW_FAILED" });
  });

  it("retries a completed result with an invalid verdict", async () => {
    const storageRoot = await makeStorageRoot();
    await createResult(storageRoot, "COMPLETED", "The review has no machine-readable verdict.");

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: matchingProvider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "REVIEW_VERDICT_INVALID" });
  });

  it("returns STALE_REVIEW when the diff fingerprint changes", async () => {
    const storageRoot = await makeStorageRoot();
    const result = await createResult(storageRoot, "COMPLETED", verdictContent("review-001", "APPROVE"));
    const provider: ReviewSnapshotProvider = {
      capture: async () => ({ ...matchingSnapshot, diff_sha256: "b".repeat(64) }),
    };

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: provider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({
        action: "RETRY_REVIEW",
        reason_code: "STALE_REVIEW",
        review_result_id: result.result_id,
      });
    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: provider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.not.toMatchObject({ action: "COMPLETE" });
  });

  it("returns STALE_REVIEW when head changes", async () => {
    const storageRoot = await makeStorageRoot();
    await createResult(storageRoot, "COMPLETED", verdictContent("review-001", "APPROVE"));
    const provider: ReviewSnapshotProvider = {
      capture: async () => ({ ...matchingSnapshot, head: "f".repeat(40) }),
    };

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: provider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "STALE_REVIEW" });
  });

  it("returns STALE_REVIEW when branch changes", async () => {
    const storageRoot = await makeStorageRoot();
    await createResult(storageRoot, "COMPLETED", verdictContent("review-001", "APPROVE"));
    const provider: ReviewSnapshotProvider = {
      capture: async () => ({ ...matchingSnapshot, branch: "feature" }),
    };

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: provider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "STALE_REVIEW" });
  });

  it("does not map a stale ITERATE verdict to ITERATE", async () => {
    const storageRoot = await makeStorageRoot();
    await createResult(storageRoot, "COMPLETED", verdictContent("review-001", "ITERATE"));
    const provider: ReviewSnapshotProvider = {
      capture: async () => ({ ...matchingSnapshot, diff_sha256: "c".repeat(64) }),
    };

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: provider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "STALE_REVIEW" });
  });

  it("returns REVIEW_SNAPSHOT_MISSING for historical completed requests", async () => {
    const storageRoot = await makeStorageRoot();
    const { request, delivery } = await makeDeliveredChain(storageRoot, null);
    await new ReviewResultService(storageRoot).createReviewResult({
      review_request_id: request.review_request_id,
      delivery_id: delivery.delivery_id,
      workspace_id: request.workspace_id,
      status: "COMPLETED",
      content: verdictContent(request.review_request_id, "APPROVE"),
    });

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: matchingProvider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "REVIEW_SNAPSHOT_MISSING" });
  });

  it("returns REVIEW_SNAPSHOT_UNAVAILABLE when provider capture fails", async () => {
    const storageRoot = await makeStorageRoot();
    await createResult(storageRoot, "COMPLETED", verdictContent("review-001", "APPROVE"));
    const failingProvider: ReviewSnapshotProvider = {
      capture: async () => { throw new Error("snapshot capture failed"); },
    };

    await expect(new LoopController(storageRoot, undefined, {
      reviewSnapshotProvider: failingProvider,
    }).evaluate("workspace-a", "review-001"))
      .resolves.toMatchObject({ action: "RETRY_REVIEW", reason_code: "REVIEW_SNAPSHOT_UNAVAILABLE" });
  });

  it("waits when delivery exists but no ReviewResult exists", async () => {
    const storageRoot = await makeStorageRoot();
    await makeDeliveredChain(storageRoot);

    const decision = await new LoopController(storageRoot).evaluate("workspace-a", "review-001");
    expect(decision).toMatchObject({ action: "WAIT", reason_code: "REVIEW_PENDING" });
    expect(decision).not.toHaveProperty("review_result_id");
  });

  it("rejects mismatched identity chains", async () => {
    const storageRoot = await makeStorageRoot();
    const { task, execution, request, delivery } = await makeDeliveredChain(storageRoot);
    const result = await new ReviewResultService(storageRoot).createReviewResult({
      review_request_id: request.review_request_id,
      delivery_id: delivery.delivery_id,
      workspace_id: request.workspace_id,
      status: "TIMEOUT",
      error: "review timed out",
    });
    const facts: LoopControllerFacts = {
      task: { ...task, workspace_id: "workspace-b" },
      execution,
      review_request: request,
      review_delivery: delivery,
      review_result: result,
    };

    const cases: LoopControllerFacts[] = [
      { ...facts, task: { ...task, workspace_id: "workspace-b" } },
      { ...facts, task: { ...task, task_id: "task-002" } },
      { ...facts, execution: { ...execution, execution_id: "execution-002" } },
      { ...facts, review_request: { ...request, review_request_id: "review-002" } },
      { ...facts, review_result: { ...result, review_request_id: "review-002" } },
      { ...facts, review_result: { ...result, delivery_id: "delivery-002" } },
    ];

    for (const candidate of cases) {
      expect(() => new LoopController(storageRoot).decide(candidate))
        .toThrow(LoopControllerIdentityError);
      expect(() => new LoopController(storageRoot).decide(candidate))
        .toThrow(/LOOP_IDENTITY_MISMATCH/);
    }
  });
});
