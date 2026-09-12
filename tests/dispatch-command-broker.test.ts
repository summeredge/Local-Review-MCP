import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { TaskContextService } from "../src/context/service.js";
import { DispatchCommandBroker } from "../src/control-plane/dispatch-command-broker.js";
import {
  ExtensionDeliveryConflictError,
  ExtensionDeliveryService,
} from "../src/control-plane/extension-delivery.js";
import { ExtensionDeliveryAdapter } from "../src/delivery/extension-delivery-adapter.js";
import type { ReviewDeliveryRequest } from "../src/delivery/review-delivery-adapter.js";
import { BrowserRouter } from "../src/router/browser-router.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStorageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-dispatch-broker-"));
  roots.push(root);
  return root;
}

function request(
  deliveryId: string,
  conversationId: string,
  message = "review this exact change",
): ReviewDeliveryRequest {
  return {
    delivery_id: deliveryId,
    workspace_id: "workspace-a",
    task_id: `task-${deliveryId}`,
    review_request_id: `review-${deliveryId}`,
    routing_id: `routing-${deliveryId}`,
    conversation_id: conversationId,
    message,
  };
}

function owner(conversationId: string, suffix: string) {
  return {
    conversation_id: conversationId,
    client_id: `client-${suffix}`,
    document_id: `document-${suffix}`,
    navigation_epoch: 1,
  } as const;
}

async function claimWhenReady(
  deliveries: ExtensionDeliveryService,
  claim: Parameters<ExtensionDeliveryService["claim"]>[0],
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const command = await deliveries.claim(claim);
    if (command !== null) return command;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("durable command was not enqueued");
}

async function persistedDeliveries(root: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(join(root, "control-plane", "extension-deliveries.json"), "utf8");
  return (JSON.parse(contents) as { deliveries: Array<Record<string, unknown>> }).deliveries;
}

async function makeReviewChain(root: string, conversationId: string) {
  const suffix = conversationId.replaceAll("-", "");
  const taskId = `task-${suffix}`;
  const reviewId = `review-${suffix}`;
  const routingId = `routing-${suffix}`;
  await new TaskContextService(root).createTaskContext({
    task_id: taskId,
    workspace_id: "workspace-a",
    status: "reviewing",
  });
  await new ExecutionContextService(root).createExecutionContext({
    execution_id: `execution-${suffix}`,
    task_id: taskId,
    workspace_id: "workspace-a",
  });
  await new ReviewRequestService(root).createReviewRequest({
    review_request_id: reviewId,
    task_id: taskId,
    execution_id: `execution-${suffix}`,
    workspace_id: "workspace-a",
  });
  const routing = await new ConversationRoutingService(root).createRouting({
    routing_id: routingId,
    workspace_id: "workspace-a",
    task_id: taskId,
    review_request_id: reviewId,
    conversation_id: conversationId,
  });
  const delivery = await new ReviewDeliveryService(root).createDelivery({
    workspace_id: routing.workspace_id,
    task_id: routing.task_id,
    review_request_id: routing.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: routing.conversation_id,
  });
  return { routing, delivery };
}

describe("DispatchCommandBroker", () => {
  it("delivers through an Extension-backed BrowserRouter and keeps the logical key durable", async () => {
    const root = await makeStorageRoot();
    const conversationId = "conversation-normal";
    const { routing, delivery } = await makeReviewChain(root, conversationId);
    const extension = new ExtensionDeliveryService(root);
    const readiness = vi.fn(() => ({ ready: true }));
    const dispatch = new BrowserRouter(
      root,
      new ExtensionDeliveryAdapter(new DispatchCommandBroker(extension, {
        timeoutMs: 1_000,
        readiness,
      })),
    ).deliver("workspace-a", routing.routing_id);
    const claimed = await claimWhenReady(extension, owner(conversationId, "normal"));
    await extension.acknowledge({
      ...owner(conversationId, "normal"),
      delivery_id: claimed.delivery_id,
      status: "sent",
      message_id: "message-normal",
    });

    await expect(dispatch).resolves.toMatchObject({
      delivery_id: delivery.delivery_id,
      conversation_id: conversationId,
      status: "delivered",
      attempt_count: 1,
    });
    expect(claimed.message).toContain("review_request_id: review-conversationnormal");
    expect(readiness).toHaveBeenCalledWith(conversationId);
    expect((await persistedDeliveries(root))[0]).toMatchObject({
      delivery_id: claimed.delivery_id,
      logical_delivery_id: delivery.delivery_id,
      conversation_id: conversationId,
    });
  });

  it("returns EXTENSION_NOT_READY before enqueueing when the Extension is absent", async () => {
    const root = await makeStorageRoot();
    const deliveries = new ExtensionDeliveryService(root);
    const review = request("delivery-not-ready", "conversation-not-ready");
    const readiness = vi.fn(() => ({ ready: false, reason: "Extension is not connected." }));

    await expect(new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(deliveries, { readiness }),
    ).deliver(review)).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "EXTENSION_NOT_READY",
        message: "Extension Delivery is not ready: Extension is not connected.",
      },
    });
    expect(readiness).toHaveBeenCalledWith(review.conversation_id);
    await expect(deliveries.getByLogicalDeliveryId(review.delivery_id)).resolves.toBeNull();
  });

  it("uses EXTENSION_DELIVERY_TIMEOUT only after readiness and retires the command", async () => {
    const root = await makeStorageRoot();
    const deliveries = new ExtensionDeliveryService(root);
    const review = request("delivery-timeout", "conversation-timeout");

    await expect(new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(deliveries, {
        timeoutMs: 10,
        readiness: () => ({ ready: true }),
      }),
    ).deliver(review)).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "EXTENSION_DELIVERY_TIMEOUT",
        message: "Extension Delivery did not produce a durable result before the timeout.",
      },
    });
    await expect(deliveries.getByLogicalDeliveryId(review.delivery_id)).resolves.toBeNull();
    await expect(deliveries.claim(owner(review.conversation_id, "late"))).resolves.toBeNull();
  });

  it("does not accept a late ACK after an already leased delivery times out", async () => {
    const root = await makeStorageRoot();
    const deliveries = new ExtensionDeliveryService(root);
    const review = request("delivery-leased-timeout", "conversation-leased-timeout");
    const pending = new ExtensionDeliveryAdapter(new DispatchCommandBroker(deliveries, {
      timeoutMs: 10,
      readiness: () => ({ ready: true }),
    })).deliver(review);
    const claim = owner(review.conversation_id, "leased-timeout");
    const command = await claimWhenReady(deliveries, claim);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      error: { code: "EXTENSION_DELIVERY_TIMEOUT" },
    });
    await expect(deliveries.get(command.delivery_id)).resolves.toMatchObject({ phase: "ambiguous" });
    await expect(deliveries.acknowledge({
      ...claim,
      delivery_id: command.delivery_id,
      status: "sent",
      message_id: "late-message",
    })).rejects.toBeInstanceOf(ExtensionDeliveryConflictError);
  });

  it("keeps a not-ready ReviewDelivery failed until a later explicit retry is ready", async () => {
    const root = await makeStorageRoot();
    const conversationId = "conversation-delayed";
    const { routing } = await makeReviewChain(root, conversationId);
    const deliveries = new ExtensionDeliveryService(root);
    let ready = false;
    const router = new BrowserRouter(
      root,
      new ExtensionDeliveryAdapter(new DispatchCommandBroker(deliveries, {
        timeoutMs: 1_000,
        readiness: () => ready
          ? { ready: true }
          : { ready: false, reason: "Extension is not connected." },
      })),
    );

    const failed = await router.deliver("workspace-a", routing.routing_id);
    expect(failed).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error: { code: "EXTENSION_NOT_READY" },
    });
    await expect(deliveries.claim(owner(conversationId, "delayed"))).resolves.toBeNull();

    ready = true;
    const retried = router.deliver("workspace-a", routing.routing_id);
    const command = await claimWhenReady(deliveries, owner(conversationId, "delayed"));
    await deliveries.acknowledge({
      ...owner(conversationId, "delayed"),
      delivery_id: command.delivery_id,
      status: "sent",
      message_id: "message-delayed",
    });

    await expect(retried).resolves.toMatchObject({
      status: "delivered",
      attempt_count: 2,
    });
  });

  it("coalesces concurrent logical dispatches into one command and one physical send", async () => {
    const root = await makeStorageRoot();
    const deliveries = new ExtensionDeliveryService(root);
    const adapter = new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(deliveries, { timeoutMs: 1_000 }),
    );
    const review = request("delivery-duplicate", "conversation-duplicate");
    const first = adapter.deliver(review);
    const second = adapter.deliver(review);
    const claim = owner(review.conversation_id, "duplicate");
    const command = await claimWhenReady(deliveries, claim);

    await expect(deliveries.enqueue("conversation-other", review.message!, review.delivery_id))
      .rejects.toBeInstanceOf(ExtensionDeliveryConflictError);
    await expect(deliveries.claim({ ...claim, document_id: "document-other" })).resolves.toBeNull();
    await deliveries.acknowledge({
      ...claim,
      delivery_id: command.delivery_id,
      status: "sent",
      message_id: "message-duplicate",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "delivered", delivered_at: expect.any(String) },
      { status: "delivered", delivered_at: expect.any(String) },
    ]);
    expect(await persistedDeliveries(root)).toHaveLength(1);
    await expect(deliveries.claim(claim)).resolves.toBeNull();
  });

  it("restores the original command after an LRM restart", async () => {
    const root = await makeStorageRoot();
    const first = new ExtensionDeliveryService(root);
    const review = request("delivery-restart", "conversation-restart");
    const queued = await first.enqueue(review.conversation_id, review.message!, review.delivery_id);

    const restarted = new ExtensionDeliveryService(root);
    await restarted.restore();
    const resumed = new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(restarted, { timeoutMs: 1_000 }),
    ).deliver(review);
    const claim = owner(review.conversation_id, "restart");
    const command = await claimWhenReady(restarted, claim);
    expect(command.delivery_id).toBe(queued.delivery_id);

    await restarted.acknowledge({
      ...claim,
      delivery_id: command.delivery_id,
      status: "sent",
      message_id: "message-restart",
    });
    await expect(resumed).resolves.toMatchObject({ status: "delivered" });
    expect(await persistedDeliveries(root)).toHaveLength(1);
  });

  it("replays a lost ACK without enqueueing or claiming a second command", async () => {
    const root = await makeStorageRoot();
    const deliveries = new ExtensionDeliveryService(root);
    const adapter = new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(deliveries, { timeoutMs: 1_000 }),
    );
    const review = request("delivery-replay", "conversation-replay");
    const pending = adapter.deliver(review);
    const claim = owner(review.conversation_id, "replay");
    const command = await claimWhenReady(deliveries, claim);
    const ack = {
      ...claim,
      delivery_id: command.delivery_id,
      status: "sent" as const,
      message_id: "message-replay",
    };

    await deliveries.acknowledge(ack);
    const restarted = new ExtensionDeliveryService(root);
    await restarted.restore();
    await expect(restarted.acknowledge(ack)).resolves.toMatchObject({ accepted: "existing" });
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    await expect(new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(restarted, { timeoutMs: 1_000 }),
    ).deliver(review)).resolves.toMatchObject({ status: "delivered" });
    await expect(restarted.claim(claim)).resolves.toBeNull();
    expect(await persistedDeliveries(root)).toHaveLength(1);
  });

  it("maps a durable not-sent receipt to a failed, non-retryable result", async () => {
    const root = await makeStorageRoot();
    const deliveries = new ExtensionDeliveryService(root);
    const adapter = new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(deliveries, { timeoutMs: 1_000 }),
    );
    const review = request("delivery-failed", "conversation-failed");
    const pending = adapter.deliver(review);
    const claim = owner(review.conversation_id, "failed");
    const command = await claimWhenReady(deliveries, claim);

    await deliveries.acknowledge({
      ...claim,
      delivery_id: command.delivery_id,
      status: "not_sent",
      error: "composer busy",
    });

    await expect(pending).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: { code: "EXTENSION_DELIVERY_FAILED", message: "composer busy" },
    });
  });

  it("keeps ambiguous terminal and blocks a ReviewDelivery retry", async () => {
    const root = await makeStorageRoot();
    const conversationId = "conversation-ambiguous";
    const { routing } = await makeReviewChain(root, conversationId);
    const deliveries = new ExtensionDeliveryService(root);
    const router = new BrowserRouter(
      root,
      new ExtensionDeliveryAdapter(new DispatchCommandBroker(deliveries, { timeoutMs: 1_000 })),
    );
    const pending = router.deliver("workspace-a", routing.routing_id);
    const claim = owner(conversationId, "ambiguous");
    const command = await claimWhenReady(deliveries, claim);
    await deliveries.acknowledge({
      ...claim,
      delivery_id: command.delivery_id,
      status: "ambiguous",
      error: "submit occurred without a stable receipt",
    });

    await expect(pending).resolves.toMatchObject({
      status: "ambiguous",
      last_error: { code: "EXTENSION_DELIVERY_AMBIGUOUS" },
    });
    await expect(router.deliver("workspace-a", routing.routing_id))
      .rejects.toThrow('status "ambiguous"');
    await expect(deliveries.claim(claim)).resolves.toBeNull();
  });

  it("fences ownership and keeps two conversation commands separate", async () => {
    const root = await makeStorageRoot();
    const deliveries = new ExtensionDeliveryService(root);
    const adapter = new ExtensionDeliveryAdapter(
      new DispatchCommandBroker(deliveries, { timeoutMs: 1_000 }),
    );
    const reviewA = request("delivery-a", "conversation-a", "message-a");
    const reviewB = request("delivery-b", "conversation-b", "message-b");
    const resultA = adapter.deliver(reviewA);
    const resultB = adapter.deliver(reviewB);
    const ownerA = owner(reviewA.conversation_id, "a");
    const ownerB = owner(reviewB.conversation_id, "b");

    await expect(deliveries.claim({ ...ownerA, conversation_id: "conversation-wrong" })).resolves.toBeNull();
    const commandA = await claimWhenReady(deliveries, ownerA);
    await expect(deliveries.claim({ ...ownerA, document_id: "document-wrong" })).resolves.toBeNull();
    await expect(deliveries.claim({ ...ownerA, navigation_epoch: 2 })).resolves.toBeNull();
    await expect(deliveries.acknowledge({
      ...ownerA,
      document_id: "document-wrong",
      delivery_id: commandA.delivery_id,
      status: "sent",
      message_id: "message-wrong",
    })).rejects.toThrow("lease owner changed");

    const commandB = await claimWhenReady(deliveries, ownerB);
    expect(commandA.conversation_id).toBe(reviewA.conversation_id);
    expect(commandB.conversation_id).toBe(reviewB.conversation_id);
    await deliveries.acknowledge({
      ...ownerA,
      delivery_id: commandA.delivery_id,
      status: "sent",
      message_id: "message-a",
    });
    await deliveries.acknowledge({
      ...ownerB,
      delivery_id: commandB.delivery_id,
      status: "sent",
      message_id: "message-b",
    });

    await expect(Promise.all([resultA, resultB])).resolves.toEqual([
      { status: "delivered", delivered_at: expect.any(String) },
      { status: "delivered", delivered_at: expect.any(String) },
    ]);
    expect(await persistedDeliveries(root)).toHaveLength(2);
  });
});
