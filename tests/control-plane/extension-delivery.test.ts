import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExtensionDeliveryConflictError,
  ExtensionDeliveryService,
  ExtensionDeliveryUnavailableError,
} from "../../src/control-plane/extension-delivery.js";

const roots: string[] = [];
const conversation = "11111111-2222-3333-4444-555555555555";
const owner = {
  conversation_id: conversation,
  client_id: "client-one",
  document_id: "document-one",
  navigation_epoch: 2,
};

async function service(): Promise<{ root: string; deliveries: ExtensionDeliveryService }> {
  const root = await mkdtemp(join(tmpdir(), "lrm-extension-delivery-"));
  roots.push(root);
  const deliveries = new ExtensionDeliveryService(root);
  await deliveries.restore();
  return { root, deliveries };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ExtensionDeliveryService", () => {
  it("durably enqueues, atomically claims, and commits one idempotent sent receipt", async () => {
    const { root, deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "review this exact change");

    await expect(deliveries.claim({ ...owner, conversation_id: "wrong-conversation" })).resolves.toBeNull();
    const claimed = await deliveries.claim(owner);
    expect(claimed).toMatchObject({
      delivery_id: queued.delivery_id,
      conversation_id: conversation,
      message: "review this exact change",
    });
    await expect(deliveries.claim({ ...owner, document_id: "document-two" })).resolves.toBeNull();

    const ack = {
      ...owner,
      delivery_id: queued.delivery_id,
      status: "sent" as const,
      message_id: "message-one",
    };
    await expect(deliveries.acknowledge(ack)).resolves.toMatchObject({
      accepted: "new",
      receipt: {
        delivery_id: queued.delivery_id,
        conversation_id: conversation,
        status: "delivered",
        message_id: "message-one",
      },
    });
    await expect(deliveries.acknowledge(ack)).resolves.toMatchObject({ accepted: "existing" });
    await expect(deliveries.acknowledge({ ...ack, message_id: "message-conflict" }))
      .rejects.toBeInstanceOf(ExtensionDeliveryConflictError);

    const restarted = new ExtensionDeliveryService(root);
    await restarted.restore();
    await expect(restarted.get(queued.delivery_id)).resolves.toMatchObject({
      phase: "delivered",
      receipt: { message_id: "message-one" },
    });
    await expect(restarted.claim(owner)).resolves.toBeNull();
    expect(JSON.parse(await readFile(join(root, "control-plane", "extension-deliveries.json"), "utf8")))
      .toMatchObject({ schema_version: 1 });
    if (process.platform !== "win32") {
      expect((await stat(join(root, "control-plane"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "control-plane", "extension-deliveries.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("restores a live lease and only makes an expired pre-send lease claimable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    const { root, deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "once only");
    await deliveries.claim(owner);

    const restarted = new ExtensionDeliveryService(root);
    await restarted.restore();
    await expect(restarted.get(queued.delivery_id)).resolves.toMatchObject({
      phase: "leased",
      lease: owner,
    });
    await expect(restarted.claim({ ...owner, document_id: "document-two" })).resolves.toBeNull();

    vi.advanceTimersByTime(30_001);
    await expect(restarted.claim({ ...owner, document_id: "document-two" })).resolves.toMatchObject({
      delivery_id: queued.delivery_id,
    });
  });

  it.each(["not_sent", "ambiguous"] as const)("makes %s terminal and never auto-retries it", async (status) => {
    const { deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "do not duplicate");
    await deliveries.claim(owner);
    const pending = deliveries.awaitResult(queued.delivery_id, 1_000);
    await deliveries.acknowledge({
      ...owner,
      delivery_id: queued.delivery_id,
      status,
      error: status === "ambiguous" ? "receipt lost" : "composer_busy",
    });
    await expect(pending).resolves.toMatchObject({
      status: status === "not_sent" ? "failed" : "ambiguous",
    });
    await expect(deliveries.claim(owner)).resolves.toBeNull();
  });

  it("does not miss a receipt committed between the initial check and waiter registration", async () => {
    const { deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "race-proof");
    await deliveries.claim(owner);
    const ack = {
      ...owner,
      delivery_id: queued.delivery_id,
      status: "sent" as const,
      message_id: "message-race",
    };
    const originalGet = deliveries.get.bind(deliveries);
    let releaseGet!: () => void;
    let checked!: () => void;
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve; });
    const getChecked = new Promise<void>((resolve) => { checked = resolve; });
    const getSpy = vi.spyOn(deliveries, "get").mockImplementation(async (deliveryId) => {
      const result = await originalGet(deliveryId);
      checked();
      await getGate;
      return result;
    });

    try {
      const pending = deliveries.awaitResult(queued.delivery_id, 250);
      await Promise.race([getChecked, new Promise<void>((resolve) => setTimeout(resolve, 25))]);
      await deliveries.acknowledge(ack);
      releaseGet();
      await expect(pending).resolves.toMatchObject({
        delivery_id: queued.delivery_id,
        status: "delivered",
        message_id: "message-race",
      });
    } finally {
      releaseGet();
      getSpy.mockRestore();
    }
  });

  it("returns null after a real timeout when no receipt exists", async () => {
    const { deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "wait-for-nothing");
    await expect(deliveries.awaitResult(queued.delivery_id, 10)).resolves.toBeNull();
  });

  it("keeps a corrupt durable state unavailable without replacing the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "lrm-extension-delivery-corrupt-"));
    roots.push(root);
    const file = join(root, "control-plane", "extension-deliveries.json");
    await mkdir(join(root, "control-plane"), { recursive: true });
    await writeFile(file, "{broken", "utf8");
    const deliveries = new ExtensionDeliveryService(root);

    await expect(deliveries.restore()).rejects.toBeInstanceOf(ExtensionDeliveryUnavailableError);
    await expect(readFile(file, "utf8")).resolves.toBe("{broken");
  });
});
