import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExtensionReviewCompletionConflictError,
  ExtensionReviewCompletionNotFoundError,
  ExtensionReviewCompletionService,
  ExtensionReviewCompletionUnavailableError,
  extensionReviewCompletionStateFile,
} from "../../src/control-plane/extension-review-completion.js";

const roots: string[] = [];
const input = {
  workspace_id: "workspace-a",
  task_id: "task-a",
  review_request_id: "review-a",
  review_delivery_id: "delivery-a",
  conversation_id: "conversation-a",
  expected_user_message_id: "user-message-1",
} as const;
const owner = {
  conversation_id: input.conversation_id,
  client_id: "client-a",
  document_id: "document-a",
  navigation_epoch: 0,
} as const;

async function service(): Promise<{ root: string; completions: ExtensionReviewCompletionService }> {
  const root = await mkdtemp(join(tmpdir(), "lrm-extension-review-completion-"));
  roots.push(root);
  const completions = new ExtensionReviewCompletionService(root);
  await completions.restore();
  return { root, completions };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ExtensionReviewCompletionService", () => {
  it("durably enqueues one queued watch and coalesces only the exact identity", async () => {
    const { root, completions } = await service();
    const first = await completions.enqueue(input);
    expect(first).toMatchObject({ ...input, phase: "queued" });
    expect(await completions.enqueue({ ...input })).toEqual(first);
    await expect(completions.enqueue({ ...input, conversation_id: "conversation-b" }))
      .rejects.toBeInstanceOf(ExtensionReviewCompletionConflictError);
    await expect(completions.enqueue({ ...input, expected_user_message_id: "user-message-2" }))
      .rejects.toBeInstanceOf(ExtensionReviewCompletionConflictError);
    await expect(completions.getByReviewRequestId(input.review_request_id)).resolves.toEqual(first);
    expect(JSON.parse(await readFile(extensionReviewCompletionStateFile(root), "utf8")))
      .toMatchObject({ schema_version: 1, completions: [{ completion_id: first.completion_id, phase: "queued" }] });
  });

  it("claims only the exact conversation, renews the same owner, and reclaims after lease expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    const { completions } = await service();
    const queued = await completions.enqueue(input);

    await expect(completions.claim({ ...owner, conversation_id: "conversation-b" })).resolves.toBeNull();
    const claimed = await completions.claim(owner);
    expect(claimed).toMatchObject({
      completion_id: queued.completion_id,
      conversation_id: input.conversation_id,
      review_request_id: input.review_request_id,
      expected_user_message_id: input.expected_user_message_id,
      deadline: Date.now() + 30_000,
    });
    await expect(completions.claim(owner)).resolves.toEqual(claimed);
    await expect(completions.claim({ ...owner, document_id: "document-b" })).resolves.toBeNull();

    vi.advanceTimersByTime(30_001);
    await expect(completions.claim({ ...owner, document_id: "document-b", navigation_epoch: 1 }))
      .resolves.toMatchObject({ completion_id: queued.completion_id });
    await expect(completions.get(queued.completion_id)).resolves.toMatchObject({
      phase: "leased",
      lease: { document_id: "document-b", navigation_epoch: 1 },
    });
  });

  it("persists a terminal completed receipt, wakes awaiters, and accepts only an exact duplicate", async () => {
    const { root, completions } = await service();
    const queued = await completions.enqueue(input);
    await completions.claim(owner);
    const ack = {
      ...owner,
      completion_id: queued.completion_id,
      status: "completed" as const,
      assistant_message_id: "assistant:logical-1",
      content: "final review text",
    };
    const pending = completions.awaitResult(queued.completion_id, 1_000);
    await expect(completions.acknowledge(ack)).resolves.toMatchObject({
      accepted: "new",
      receipt: {
        completion_id: queued.completion_id,
        conversation_id: input.conversation_id,
        status: "completed",
        assistant_message_id: ack.assistant_message_id,
        content: ack.content,
      },
    });
    const receipt = await pending;
    expect(receipt).toMatchObject({ status: "completed", content: ack.content });
    await expect(completions.acknowledge(ack)).resolves.toMatchObject({ accepted: "existing" });
    await expect(completions.acknowledge({ ...ack, content: "different" }))
      .rejects.toBeInstanceOf(ExtensionReviewCompletionConflictError);
    await expect(completions.acknowledge({ ...ack, document_id: "document-b" }))
      .rejects.toBeInstanceOf(ExtensionReviewCompletionConflictError);
    await expect(completions.get(queued.completion_id)).resolves.toMatchObject({
      phase: "completed",
      receipt: { assistant_message_id: ack.assistant_message_id },
    });
    expect(JSON.parse(await readFile(extensionReviewCompletionStateFile(root), "utf8")))
      .toMatchObject({ completions: [{ phase: "completed", receipt: { status: "completed" } }] });
  });

  it("restores queued, leased, and terminal state without losing ownership", async () => {
    const { root, completions } = await service();
    const queued = await completions.enqueue(input);
    const leased = await completions.claim(owner);
    if (leased === null) throw new Error("expected a lease");
    const restarted = new ExtensionReviewCompletionService(root);
    await restarted.restore();
    await expect(restarted.get(queued.completion_id)).resolves.toMatchObject({
      phase: "leased",
      lease: owner,
    });
    await expect(restarted.claim({ ...owner, document_id: "document-b" })).resolves.toBeNull();
    await restarted.acknowledge({
      ...owner,
      completion_id: queued.completion_id,
      status: "failed",
      error: "observation failed",
    });
    const terminal = new ExtensionReviewCompletionService(root);
    await terminal.restore();
    await expect(terminal.get(queued.completion_id)).resolves.toMatchObject({
      phase: "failed",
      receipt: { error: "observation failed" },
    });
  });

  it("maps missing completions to not found and preserves corrupt state", async () => {
    const { root } = await service();
    const file = extensionReviewCompletionStateFile(root);
    await rm(file, { force: true });
    await mkdir(join(root, "control-plane"), { recursive: true });
    await writeFile(file, "{broken", "utf8");
    const completions = new ExtensionReviewCompletionService(root);
    await expect(completions.get(randomUUID())).rejects.toBeInstanceOf(
      ExtensionReviewCompletionUnavailableError,
    );

    const { completions: available } = await service();
    await expect(available.acknowledge({
      ...owner,
      completion_id: randomUUID(),
      status: "failed",
      error: "missing",
    })).rejects.toBeInstanceOf(ExtensionReviewCompletionNotFoundError);
  });
});
