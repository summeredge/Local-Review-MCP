import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_DELIVERY_LEASE_MS,
  ExtensionDeliveryConflictError,
  ExtensionDeliveryService,
  ExtensionDeliveryUnavailableError,
  type ExtensionDelivery,
  type ExtensionDeliveryReceipt,
} from "../../src/control-plane/extension-delivery.js";

const roots: string[] = [];
const conversation = "11111111-2222-3333-4444-555555555555";
const owner = {
  conversation_id: conversation,
  client_id: "client-one",
  document_id: "document-one",
  navigation_epoch: 2,
};

type ExtensionDeliveryWaiter = (receipt: ExtensionDeliveryReceipt) => void;
type ExtensionDeliveryInternals = {
  waiters: Map<string, Set<ExtensionDeliveryWaiter>>;
  persist(deliveries: Map<string, ExtensionDelivery>): Promise<void>;
};

class WaiterRegistrationProbe extends Map<string, Set<ExtensionDeliveryWaiter>> {
  public registered = false;

  public constructor(
    private readonly target: string,
    private readonly onRegistration: () => void,
    source: Map<string, Set<ExtensionDeliveryWaiter>>,
  ) {
    super(source);
  }

  public override set(key: string, value: Set<ExtensionDeliveryWaiter>): this {
    const result = super.set(key, value);
    if (key === this.target) {
      this.registered = true;
      this.onRegistration();
    }
    return result;
  }
}

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
    const readinessCheckTime = Date.now();
    const queued = await deliveries.enqueue(conversation, "review this exact change", undefined, {
      readiness_check_time: readinessCheckTime,
      readiness_result: "ready",
    });

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
      readiness_check_time: readinessCheckTime,
      readiness_result: "ready",
      claim_time: expect.any(Number),
      ack_time: expect.any(Number),
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

  it("looks up a logical delivery id, returns a clone, and leaves durable state unchanged", async () => {
    const { deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "logical delivery", "review-delivery-one");
    const lookedUp = await deliveries.getByLogicalDeliveryId("review-delivery-one");
    expect(lookedUp).toEqual(queued);
    if (lookedUp !== null) (lookedUp as { message: string }).message = "mutated clone";
    await expect(deliveries.getByLogicalDeliveryId("review-delivery-one")).resolves.toEqual(queued);
    await expect(deliveries.getByLogicalDeliveryId("missing-delivery")).resolves.toBeNull();
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

    vi.advanceTimersByTime(EXTENSION_DELIVERY_LEASE_MS + 1);
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

  it("returns a receipt when acknowledge reaches persistence before awaitResult registration", async () => {
    const { deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "race-proof-ack-first");
    await deliveries.claim(owner);
    const ack = {
      ...owner,
      delivery_id: queued.delivery_id,
      status: "sent" as const,
      message_id: "message-ack-first",
    };
    const internal = deliveries as unknown as ExtensionDeliveryInternals;
    const probe = new WaiterRegistrationProbe(queued.delivery_id, () => undefined, internal.waiters);
    internal.waiters = probe;
    let releasePersist!: () => void;
    let persistStarted!: () => void;
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
    const persistEntered = new Promise<void>((resolve) => { persistStarted = resolve; });
    const originalPersist = internal.persist.bind(deliveries);
    const persistSpy = vi.spyOn(internal, "persist").mockImplementation(async (snapshot) => {
      persistStarted();
      await persistGate;
      await originalPersist(snapshot);
    });

    try {
      const acknowledged = deliveries.acknowledge(ack);
      await persistEntered;
      const pending = deliveries.awaitResult(queued.delivery_id, 1_000);
      releasePersist();

      await expect(acknowledged).resolves.toMatchObject({
        accepted: "new",
        receipt: {
          delivery_id: queued.delivery_id,
          status: "delivered",
          message_id: "message-ack-first",
        },
      });
      await expect(pending).resolves.toMatchObject({
        delivery_id: queued.delivery_id,
        status: "delivered",
        message_id: "message-ack-first",
      });
      expect(probe.registered).toBe(false);
    } finally {
      releasePersist();
      persistSpy.mockRestore();
    }
  });

  it("drains a late owner ACK without changing a timeout ambiguity into success", async () => {
    const { deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "late ack after local timeout");
    const lateOwner = {
      conversation_id: conversation,
      client_id: "client-a",
      document_id: "document-a",
      navigation_epoch: 0,
    };
    await expect(deliveries.claim(lateOwner)).resolves.toMatchObject({ delivery_id: queued.delivery_id });
    await expect(deliveries.expire(queued.delivery_id)).resolves.toBeNull();
    const timeout = (await deliveries.get(queued.delivery_id))?.receipt;
    expect(timeout).toMatchObject({ delivery_id: queued.delivery_id, status: "ambiguous" });

    await expect(deliveries.acknowledge({
      ...lateOwner,
      delivery_id: queued.delivery_id,
      status: "sent",
      message_id: "message-late",
    })).resolves.toMatchObject({ accepted: "existing", receipt: timeout });
    await expect(deliveries.acknowledge({
      ...lateOwner,
      delivery_id: queued.delivery_id,
      status: "sent",
      message_id: "message-late",
    })).resolves.toMatchObject({ accepted: "existing", receipt: timeout });
    await expect(deliveries.get(queued.delivery_id)).resolves.toMatchObject({
      phase: "ambiguous",
      ack_time: expect.any(Number),
      receipt: { status: "ambiguous" },
    });
  });

  it("wakes a waiter when awaitResult registration reaches the queue before acknowledge", async () => {
    const { deliveries } = await service();
    const queued = await deliveries.enqueue(conversation, "race-proof-waiter-first");
    await deliveries.claim(owner);
    const ack = {
      ...owner,
      delivery_id: queued.delivery_id,
      status: "sent" as const,
      message_id: "message-waiter-first",
    };
    let registrationReached!: () => void;
    const registration = new Promise<void>((resolve) => { registrationReached = resolve; });
    const internal = deliveries as unknown as ExtensionDeliveryInternals;
    internal.waiters = new WaiterRegistrationProbe(
      queued.delivery_id,
      registrationReached,
      internal.waiters,
    );

    const pending = deliveries.awaitResult(queued.delivery_id, 1_000);
    await registration;
    const acknowledged = deliveries.acknowledge(ack);

    await expect(acknowledged).resolves.toMatchObject({
      accepted: "new",
      receipt: {
        delivery_id: queued.delivery_id,
        status: "delivered",
        message_id: "message-waiter-first",
      },
    });
    await expect(pending).resolves.toMatchObject({
      delivery_id: queued.delivery_id,
      status: "delivered",
      message_id: "message-waiter-first",
    });
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
