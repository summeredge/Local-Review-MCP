import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationCorrelationRegistry } from "../../src/control-plane/conversation-correlation.js";
import {
  awaitCurrentInboundCorrelation,
  currentInboundCorrelation,
} from "../../src/control-plane/request-correlation-integration.js";
import { withInboundRequestId } from "../../src/mcp/inbound.js";

const temporaryDirectories: string[] = [];

async function makeRegistry(): Promise<ConversationCorrelationRegistry> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-correlation-"));
  temporaryDirectories.push(root);
  return new ConversationCorrelationRegistry(root);
}

function evidence(requestId: string, conversationId: string, documentId = "document-a") {
  return {
    request_id: requestId,
    conversation_id: conversationId,
    document_id: documentId,
    navigation_epoch: 1,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("conversation correlation ownership", () => {
  it.each([
    "wfr_01a014bdd7cd7a15b6b533d3ce2b42f2",
    "32ca0d45-8b29-414a-bbe4-8e26c3aae911",
  ])("keeps the first exact owner for opaque request id %s", async (requestId) => {
    const registry = await makeRegistry();
    expect(await registry.observe(evidence(requestId, "conversation-a"))).toBe("stored");
    expect(await registry.observe(evidence(requestId, "conversation-a", "document-b"))).toBe("same");
    expect(await registry.observe(evidence(requestId, "conversation-b"))).toBe("refused");
    expect(registry.correlation(requestId)).toMatchObject({
      request_id: requestId,
      conversation_id: "conversation-a",
      document_id: "document-b",
    });
    expect(await registry.observe(evidence(requestId, "conversation-a"))).toBe("same");
    expect(registry.correlation(requestId)?.conversation_id).toBe("conversation-a");
    expect(registry.correlation(requestId.toUpperCase())).toBeNull();
  });

  it("wakes only waiters for the same exact request id and times out otherwise", async () => {
    const registry = await makeRegistry();
    const waiting = registry.awaitCorrelation("request-1", 1_000);
    await registry.observe(evidence("request-2", "conversation-b"));
    await expect(Promise.race([
      waiting.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
    ])).resolves.toBe("pending");
    await registry.observe(evidence("request-1", "conversation-a"));

    await expect(waiting).resolves.toMatchObject({ conversation_id: "conversation-a" });
    await expect(registry.awaitCorrelation("missing", 5)).resolves.toBeNull();
  });

  it("isolates current inbound correlation across concurrent async requests", async () => {
    const registry = await makeRegistry();
    await registry.observe(evidence("id-A", "conversation-A"));
    await registry.observe(evidence("id-B", "conversation-B"));

    const seen = await Promise.all([
      withInboundRequestId("id-A", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return currentInboundCorrelation(registry)?.conversation_id;
      }),
      withInboundRequestId("id-B", async () => {
        await Promise.resolve();
        return (await awaitCurrentInboundCorrelation(registry, 10))?.conversation_id;
      }),
    ]);

    expect(seen).toEqual(["conversation-A", "conversation-B"]);
    expect(currentInboundCorrelation(registry)).toBeNull();
    expect(withInboundRequestId("missing", () => currentInboundCorrelation(registry))).toBeNull();
  });

  it("restores proven owners without a time TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-correlation-restore-"));
    temporaryDirectories.push(root);
    const first = new ConversationCorrelationRegistry(root);
    await first.observe(evidence("request-old", "conversation-a"));

    const file = join(root, "control-plane", "request-correlations.json");
    const state = JSON.parse(await readFile(file, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    state.entries[0]!.first_observed_at = 1;
    state.entries[0]!.last_observed_at = 1;
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const second = new ConversationCorrelationRegistry(root);
    await second.restore();
    expect(second.correlation("request-old")?.conversation_id).toBe("conversation-a");
  });

  it("ignores invalid entries and fails closed on a corrupt state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-correlation-invalid-"));
    temporaryDirectories.push(root);
    const directory = join(root, "control-plane");
    const file = join(directory, "request-correlations.json");
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify({
      schema_version: 1,
      entries: [
        {
          ...evidence("valid-request", "conversation-a"),
          first_observed_at: 1,
          last_observed_at: 2,
        },
        { request_id: "invalid" },
      ],
    }), "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const partiallyValid = new ConversationCorrelationRegistry(root);
    await expect(partiallyValid.restore()).resolves.toBeUndefined();
    expect(partiallyValid.correlation("valid-request")?.conversation_id).toBe("conversation-a");
    expect(partiallyValid.correlation("invalid")).toBeNull();

    await writeFile(file, "{broken", "utf8");
    const corrupt = new ConversationCorrelationRegistry(root);
    await expect(corrupt.restore()).resolves.toBeUndefined();
    expect(corrupt.correlation("valid-request")).toBeNull();
    expect(warning).toHaveBeenCalled();
  });
});
