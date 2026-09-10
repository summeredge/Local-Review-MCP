import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppContext } from "../src/app.js";
import {
  ExtensionDeliveryService,
  type ExtensionDelivery,
} from "../src/control-plane/extension-delivery.js";
import {
  ExtensionReviewCompletionService,
  type ExtensionReviewCompletion,
  type ExtensionReviewCompletionInput,
  type ExtensionReviewCompletionReceipt,
} from "../src/control-plane/extension-review-completion.js";
import { BrowserWorkerClient } from "../src/browser-worker-client/browser-worker-client.js";
import {
  DEFAULT_EXTENSION_REVIEW_COMPLETION_TIMEOUT_MS,
  ExtensionReviewCompletionAdapter,
} from "../src/delivery/extension-review-completion-adapter.js";
import type {
  ReviewCompletionRequest,
  ReviewCompletionResult,
} from "../src/delivery/review-completion-adapter.js";
import type { ResolvedSettings } from "../src/config/settings.js";

const roots: string[] = [];
const request: ReviewCompletionRequest = {
  workspace_id: "workspace-a",
  task_id: "task-a",
  review_request_id: "review-a",
  delivery_id: "delivery-a",
  conversation_id: "conversation-a",
};
const owner = {
  conversation_id: request.conversation_id,
  client_id: "client-a",
  document_id: "document-a",
  navigation_epoch: 0,
} as const;
const physicalDeliveryId = "00000000-0000-4000-8000-000000000001";
const completionId = "00000000-0000-4000-8000-000000000002";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deliveredExtensionDelivery(): ExtensionDelivery {
  return {
    delivery_id: physicalDeliveryId,
    logical_delivery_id: request.delivery_id,
    conversation_id: request.conversation_id,
    message: "review",
    created_at: 1,
    phase: "delivered",
    receipt: {
      ...owner,
      delivery_id: physicalDeliveryId,
      status: "delivered",
      message_id: "user-message-1",
      completed_at: 2,
    },
  };
}

function completionFor(input: ExtensionReviewCompletionInput = {
  ...request,
  review_delivery_id: request.delivery_id,
  expected_user_message_id: "user-message-1",
}): ExtensionReviewCompletion {
  return {
    completion_id: completionId,
    ...input,
    created_at: 1,
    phase: "queued",
  };
}

function completionReceipt(
  status: "completed" | "failed" | "ambiguous",
): ExtensionReviewCompletionReceipt {
  return status === "completed"
    ? {
      completion_id: completionId,
      ...owner,
      status,
      assistant_message_id: "assistant-message-1",
      content: "<lrm-review-result>APPROVE</lrm-review-result>",
      completed_at: 2,
    }
    : {
      completion_id: completionId,
      ...owner,
      status,
      error: status === "ambiguous" ? "two terminal observations" : "observer failed",
      completed_at: 2,
    };
}

function fakeAdapter(
  delivery: ExtensionDelivery | null,
  receipt: ExtensionReviewCompletionReceipt | null,
  options: { readonly timeoutMs?: number } = {},
) {
  const completion = completionFor();
  const getByLogicalDeliveryId = vi.fn(async (_logicalDeliveryId: string) => delivery);
  const enqueue = vi.fn(async (_input: ExtensionReviewCompletionInput) => completion);
  const awaitResult = vi.fn(async (
    _completionId: string,
    _timeoutMs: number,
  ) => receipt);
  const adapter = new ExtensionReviewCompletionAdapter(
    { getByLogicalDeliveryId },
    { enqueue, awaitResult },
    options,
  );
  return { adapter, getByLogicalDeliveryId, enqueue, awaitResult, completion };
}

async function durableDeliveredDelivery(root: string): Promise<ExtensionDeliveryService> {
  const deliveries = new ExtensionDeliveryService(root);
  const queued = await deliveries.enqueue(
    request.conversation_id,
    "review",
    request.delivery_id,
  );
  if (await deliveries.claim(owner) === null) throw new Error("delivery was not claimed");
  await deliveries.acknowledge({
    ...owner,
    delivery_id: queued.delivery_id,
    status: "sent",
    message_id: "user-message-1",
  });
  return deliveries;
}

function appSettings(workspace: string): ResolvedSettings {
  const workspaceIdentity = {
    id: request.workspace_id,
    name: "Workspace A",
    path: workspace,
  } as const;
  return {
    host: "127.0.0.1",
    port: 12080,
    workspace,
    workspaceIdentity,
    workspaces: [workspaceIdentity],
    auth: { token: "token" },
    remote: { enabled: false, endpoint: "" },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
  };
}

function appEnvironment(storageRoot: string): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? { ...process.env, LOCALAPPDATA: storageRoot }
    : { ...process.env, XDG_STATE_HOME: storageRoot };
}

describe("ExtensionReviewCompletionAdapter", () => {
  it("maps the logical delivery to the stable user message and enqueues the exact completion identity", async () => {
    const receipt = completionReceipt("completed");
    const fake = fakeAdapter(deliveredExtensionDelivery(), receipt);

    await expect(fake.adapter.collect(request)).resolves.toEqual({
      status: "COMPLETED",
      content: receipt.content,
    });
    expect(fake.getByLogicalDeliveryId).toHaveBeenCalledWith(request.delivery_id);
    expect(fake.enqueue).toHaveBeenCalledWith({
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      review_request_id: request.review_request_id,
      review_delivery_id: request.delivery_id,
      conversation_id: request.conversation_id,
      expected_user_message_id: "user-message-1",
    });
    expect(fake.awaitResult).toHaveBeenCalledWith(
      fake.completion.completion_id,
      DEFAULT_EXTENSION_REVIEW_COMPLETION_TIMEOUT_MS,
    );
  });

  it.each([
    ["completed", completionReceipt("completed"), {
      status: "COMPLETED",
      content: "<lrm-review-result>APPROVE</lrm-review-result>",
    }],
    ["failed", completionReceipt("failed"), {
      status: "FAILED",
      error: "observer failed",
    }],
    ["ambiguous", completionReceipt("ambiguous"), {
      status: "FAILED",
      error: "Extension Review Completion ambiguous: two terminal observations",
    }],
    ["timeout", null, {
      status: "TIMEOUT",
      error: "Extension Review Completion did not produce a durable result before the timeout.",
    }],
  ] as const)("maps completion %s without changing ReviewCompletionResult semantics", async (_name, receipt, expected) => {
    const fake = fakeAdapter(deliveredExtensionDelivery(), receipt, { timeoutMs: 1 });
    await expect(fake.adapter.collect(request)).resolves.toEqual(expected);
  });

  it.each([
    ["missing Extension Delivery", null, /was not found/u],
    ["logical identity mismatch", {
      ...deliveredExtensionDelivery(),
      logical_delivery_id: "different-delivery",
    } as ExtensionDelivery, /logical_delivery_id/u],
    ["conversation mismatch", {
      ...deliveredExtensionDelivery(),
      conversation_id: "conversation-b",
    } as ExtensionDelivery, /conversation_id/u],
    ["pending delivery", {
      ...deliveredExtensionDelivery(),
      phase: "queued",
      receipt: undefined,
    } as ExtensionDelivery, /has not produced/u],
    ["failed delivery", {
      ...deliveredExtensionDelivery(),
      phase: "failed",
      receipt: {
        ...deliveredExtensionDelivery().receipt!,
        status: "failed",
        message_id: undefined,
        error: "not sent",
      },
    } as ExtensionDelivery, /has not produced/u],
    ["ambiguous delivery", {
      ...deliveredExtensionDelivery(),
      phase: "ambiguous",
      receipt: {
        ...deliveredExtensionDelivery().receipt!,
        status: "ambiguous",
        message_id: undefined,
        error: "send ambiguous",
      },
    } as ExtensionDelivery, /has not produced/u],
    ["missing delivery receipt", {
      ...deliveredExtensionDelivery(),
      receipt: undefined,
    } as ExtensionDelivery, /has not produced/u],
    ["missing message_id", {
      ...deliveredExtensionDelivery(),
      receipt: { ...deliveredExtensionDelivery().receipt!, message_id: undefined },
    } as ExtensionDelivery, /missing message_id/u],
  ] as const)("fails closed for %s", async (_name, delivery, error) => {
    const fake = fakeAdapter(delivery, completionReceipt("completed"));
    const result = await fake.adapter.collect(request);
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected a failed result");
    expect(result.error).toMatch(error);
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it("fails closed when completion durable state is unavailable or has an identity conflict", async () => {
    const delivery = deliveredExtensionDelivery();
    const unavailable = new ExtensionReviewCompletionAdapter(
      { getByLogicalDeliveryId: vi.fn(async () => delivery) },
      {
        enqueue: vi.fn(async () => {
          throw new Error("extension review completion state could not be restored");
        }),
        awaitResult: vi.fn(),
      },
    );
    await expect(unavailable.collect(request)).resolves.toEqual({
      status: "FAILED",
      error: "extension review completion state could not be restored",
    });

    const conflict = new ExtensionReviewCompletionAdapter(
      { getByLogicalDeliveryId: vi.fn(async () => delivery) },
      {
        enqueue: vi.fn(async () => {
          throw new Error("Extension Review Completion identity conflict.");
        }),
        awaitResult: vi.fn(),
      },
    );
    await expect(conflict.collect(request)).resolves.toEqual({
      status: "FAILED",
      error: "Extension Review Completion identity conflict.",
    });
  });

  it("coalesces concurrent retries into one durable completion watch", async () => {
    const root = await mkdtemp(join(tmpdir(), "lrm-extension-completion-adapter-retry-"));
    roots.push(root);
    const deliveries = await durableDeliveredDelivery(root);
    const completions = new ExtensionReviewCompletionService(root);
    const adapter = new ExtensionReviewCompletionAdapter(deliveries, completions, { timeoutMs: 0 });

    const results = await Promise.all([
      adapter.collect(request),
      adapter.collect(request),
    ]);
    expect(results).toEqual([
      {
        status: "TIMEOUT",
        error: "Extension Review Completion did not produce a durable result before the timeout.",
      },
      {
        status: "TIMEOUT",
        error: "Extension Review Completion did not produce a durable result before the timeout.",
      },
    ]);
    await expect(completions.getByReviewRequestId(request.review_request_id)).resolves.toMatchObject({
      review_delivery_id: request.delivery_id,
      expected_user_message_id: "user-message-1",
      phase: "queued",
    });
  });

  it("reuses an already-completed durable watch after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "lrm-extension-completion-adapter-restart-"));
    roots.push(root);
    const deliveries = await durableDeliveredDelivery(root);
    const completions = new ExtensionReviewCompletionService(root);
    const queued = await completions.enqueue({
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      review_request_id: request.review_request_id,
      review_delivery_id: request.delivery_id,
      conversation_id: request.conversation_id,
      expected_user_message_id: "user-message-1",
    });
    if (await completions.claim(owner) === null) throw new Error("completion was not claimed");
    await completions.acknowledge({
      ...owner,
      completion_id: queued.completion_id,
      status: "completed",
      assistant_message_id: "assistant-message-1",
      content: "completed before restart",
    });

    const adapter = new ExtensionReviewCompletionAdapter(
      new ExtensionDeliveryService(root),
      new ExtensionReviewCompletionService(root),
      { timeoutMs: 0 },
    );
    await expect(adapter.collect(request)).resolves.toEqual({
      status: "COMPLETED",
      content: "completed before restart",
    });
    expect(await deliveries.getByLogicalDeliveryId(request.delivery_id)).not.toBeNull();
  });

  it("wires production AutoIteration completion to the same Extension services and never calls Browser Worker completion", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "lrm-extension-completion-production-state-"));
    const workspace = await mkdtemp(join(tmpdir(), "lrm-extension-completion-production-workspace-"));
    roots.push(storageRoot, workspace);
    const context = createAppContext(appSettings(workspace), appEnvironment(storageRoot));
    const router = context.autoIteration!.completionRouter;
    const routerInternals = router as unknown as { adapter: unknown };
    const adapter = routerInternals.adapter as ExtensionReviewCompletionAdapter;
    expect(adapter).toBeInstanceOf(ExtensionReviewCompletionAdapter);
    const adapterInternals = adapter as unknown as {
      extensionDeliveries: unknown;
      extensionReviewCompletions: unknown;
    };
    expect(adapterInternals.extensionDeliveries).toBe(context.extensionDeliveries);
    expect(adapterInternals.extensionReviewCompletions).toBe(context.extensionReviewCompletions);

    const queued = await context.extensionDeliveries.enqueue(
      request.conversation_id,
      "review",
      request.delivery_id,
    );
    if (await context.extensionDeliveries.claim(owner) === null) throw new Error("delivery was not claimed");
    await context.extensionDeliveries.acknowledge({
      ...owner,
      delivery_id: queued.delivery_id,
      status: "sent",
      message_id: "user-message-1",
    });
    const completion = await context.extensionReviewCompletions.enqueue({
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      review_request_id: request.review_request_id,
      review_delivery_id: request.delivery_id,
      conversation_id: request.conversation_id,
      expected_user_message_id: "user-message-1",
    });
    if (await context.extensionReviewCompletions.claim(owner) === null) {
      throw new Error("completion was not claimed");
    }
    await context.extensionReviewCompletions.acknowledge({
      ...owner,
      completion_id: completion.completion_id,
      status: "completed",
      assistant_message_id: "assistant-message-1",
      content: "production completion",
    });

    const collectCompletion = vi.spyOn(BrowserWorkerClient.prototype, "collectCompletion");
    await expect(adapter.collect(request)).resolves.toEqual({
      status: "COMPLETED",
      content: "production completion",
    });
    expect(collectCompletion).not.toHaveBeenCalled();
  });
});
