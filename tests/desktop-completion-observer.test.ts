import type { CallToolRequestParams, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createCodexAppToolContracts,
  type CodexAppMcpClient,
} from "../src/desktop-codex/index.js";
import {
  DesktopCompletionObserver,
  type DesktopCompletionBaseline,
} from "../src/desktop-codex/completion-observer.js";

const EXECUTOR_THREAD = "executor-thread";
const TARGET_THREAD = "target-thread";
const HOST_ID = "local";
const A = "turn-A";
const B = "turn-B";
const C = "turn-C";

function tool(
  name: string,
  inputSchema: { readonly type: "object"; readonly [key: string]: unknown },
): Tool {
  return { name, inputSchema };
}

function appTools(options: { read?: boolean; wait?: boolean } = {}): Tool[] {
  const tools: Tool[] = [];
  if (options.read !== false) {
    tools.push(tool("read_thread", {
      type: "object",
      properties: {
        threadId: { type: "string" },
        hostId: { type: "string" },
        cursor: { type: "string" },
        turnLimit: { type: "integer", minimum: 1, maximum: 10 },
        includeOutputs: { type: "boolean" },
      },
      required: ["threadId"],
    }));
  }
  if (options.wait !== false) {
    tools.push(tool("wait_threads", {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              threadId: { type: "string" },
              hostId: { type: "string" },
              afterCursor: { type: "string" },
            },
            required: ["threadId"],
          },
        },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120_000 },
      },
      required: ["targets"],
    }));
  }
  return tools;
}

function turn(
  id: string,
  status: string,
  values: Partial<Record<"error" | "completedAt" | "items", unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    durationMs: status === "completed" ? 1 : null,
    items: [],
    ...values,
  };
}

function readPayload(turns: readonly Record<string, unknown>[], threadId = TARGET_THREAD, hostId = HOST_ID): CallToolResult {
  return result({
    schemaVersion: 1,
    thread: { id: threadId, hostId, status: { type: "idle" } },
    page: { order: "newest_first", limit: 10, nextCursor: null, hasMore: false },
    turns,
  });
}

function waitPayload(values: Record<string, unknown> = {}): CallToolResult {
  return result({
    timedOut: false,
    polls: [{
      cursor: "wait-cursor-1",
      thread: { id: TARGET_THREAD, hostId: HOST_ID, status: { type: "idle" } },
      latestTurn: { id: B, status: "completed" },
    }],
    ...values,
  });
}

function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

interface ClientSetup {
  readonly observer: DesktopCompletionObserver;
  readonly calls: CallToolRequestParams[];
}

function setup(
  reads: readonly CallToolResult[],
  waits: readonly CallToolResult[] = [],
  options: { readonly read?: boolean; readonly wait?: boolean; readonly pollIntervalMs?: number } = {},
): ClientSetup {
  const readQueue = [...reads];
  const waitQueue = [...waits];
  const calls: CallToolRequestParams[] = [];
  let lastRead = reads.at(-1);
  let lastWait = waits.at(-1);
  const callTool: CodexAppMcpClient["callTool"] = async (params) => {
    calls.push(params);
    if (params.name === "read_thread") {
      const next = readQueue.shift() ?? lastRead;
      if (next === undefined) throw new Error("unexpected read_thread call");
      lastRead = next;
      return next;
    }
    if (params.name === "wait_threads") {
      const next = waitQueue.shift() ?? lastWait;
      if (next === undefined) throw new Error("unexpected wait_threads call");
      lastWait = next;
      return next;
    }
    throw new Error(`unexpected tool: ${params.name}`);
  };
  const contracts = createCodexAppToolContracts(appTools({
    read: options.read,
    wait: options.wait,
  }));
  return {
    calls,
    observer: new DesktopCompletionObserver({
      client: { callTool },
      contracts,
      pollIntervalMs: options.pollIntervalMs ?? 0,
    }),
  };
}

function context(timeoutMs?: number) {
  return {
    executorThreadId: EXECUTOR_THREAD,
    targetThreadId: TARGET_THREAD,
    hostId: HOST_ID,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

describe("DesktopCompletionObserver", () => {
  it("captures a minimal baseline from read_thread", async () => {
    const setupValue = setup([readPayload([turn(A, "completed")])]);

    await expect(setupValue.observer.captureBaseline(context())).resolves.toEqual({
      targetThreadId: TARGET_THREAD,
      hostId: HOST_ID,
      turnIds: [A],
    });
    expect(setupValue.calls).toHaveLength(1);
    expect(setupValue.calls[0]).toMatchObject({
      name: "read_thread",
      arguments: {
        threadId: TARGET_THREAD,
        hostId: HOST_ID,
        turnLimit: 10,
        includeOutputs: false,
      },
    });
  });

  it("returns immediately when the first post-dispatch read is completed", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "completed"), turn(A, "completed")]),
    ]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toEqual({
        status: "completed",
        targetThreadId: TARGET_THREAD,
        hostId: HOST_ID,
        turnId: B,
      });
    expect(setupValue.calls.map((call) => call.name)).toEqual(["read_thread", "read_thread"]);
  });

  it("waits only after an in-progress immediate read, then reads as authority", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "inProgress"), turn(A, "completed")]),
      readPayload([turn(B, "completed"), turn(A, "completed")]),
    ], [waitPayload()]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "completed", turnId: B });
    expect(setupValue.calls.map((call) => call.name)).toEqual([
      "read_thread",
      "read_thread",
      "wait_threads",
      "read_thread",
    ]);
  });

  it("waits when no new turn is in the immediate snapshot", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "completed"), turn(A, "completed")]),
    ], [waitPayload()]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "completed", turnId: B });
    expect(setupValue.calls.map((call) => call.name)).toEqual([
      "read_thread",
      "read_thread",
      "wait_threads",
      "read_thread",
    ]);
  });

  it("reuses the cursor returned by wait_threads for the next wait", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "inProgress")]),
      readPayload([turn(B, "inProgress")]),
      readPayload([turn(B, "completed")]),
    ], [
      waitPayload({ wake: { threadId: TARGET_THREAD, turnId: B } }),
      waitPayload({ wake: { threadId: TARGET_THREAD, turnId: B }, polls: [{ cursor: "wait-cursor-2" }] }),
    ]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "completed", turnId: B });
    const waits = setupValue.calls.filter((call) => call.name === "wait_threads");
    expect(waits).toHaveLength(2);
    expect(waits[0]?.arguments?.targets).toEqual([{
      threadId: TARGET_THREAD,
      hostId: HOST_ID,
    }]);
    expect(waits[1]?.arguments?.targets).toEqual([{
      threadId: TARGET_THREAD,
      hostId: HOST_ID,
      afterCursor: "wait-cursor-1",
    }]);
  });

  it("does not treat a stale completed baseline turn as completion", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(A, "completed")]),
    ], [waitPayload({ polls: [] })]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(1), baseline: captured }))
      .resolves.toMatchObject({ status: "timed_out" });
  });

  it("locks the first candidate turn even when another new turn appears later", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "inProgress"), turn(A, "completed")]),
      readPayload([turn(C, "inProgress"), turn(B, "completed"), turn(A, "completed")]),
    ], [waitPayload({ wake: { reason: "turnCompleted", threadId: TARGET_THREAD, turnId: B } })]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "completed", turnId: B });
  });

  it("fails closed when multiple new turns first appear", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "inProgress"), turn(C, "inProgress"), turn(A, "completed")]),
    ]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "unknown", reason: "ambiguous_new_turn" });
  });

  it.each([
    ["turn error", turn(B, "completed", { error: { code: "failed" } }), "tool_error"],
    ["missing completedAt", turn(B, "completed", { completedAt: null }), "malformed_response"],
    ["unknown status", turn(B, "failed"), "status_unrecognized"],
  ])("does not accept %s as completion", async (_label, candidate, reason) => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([candidate as Record<string, unknown>, turn(A, "completed")]),
    ]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "unknown", reason });
  });

  it.each([
    ["thread", readPayload([turn(A, "completed")], "other-thread", HOST_ID), "thread_identity_mismatch"],
    ["host", readPayload([turn(A, "completed")], TARGET_THREAD, "other-host"), "host_identity_mismatch"],
    ["malformed JSON", textResult("{not-json"), "malformed_response"],
    ["missing turn id", readPayload([{ status: "completed", error: null, completedAt: 2 }]), "turn_identity_unavailable"],
  ])("returns unknown for %s read payloads", async (_label, payload, reason) => {
    const setupValue = setup([payload as CallToolResult]);

    await expect(setupValue.observer.captureBaseline(context()))
      .rejects.toMatchObject({ reason });
  });

  it("falls back to bounded read polling when wait_threads is unavailable", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "inProgress")]),
      readPayload([turn(B, "completed")]),
    ], [], { wait: false });
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "completed", turnId: B });
    expect(setupValue.calls.every((call) => call.name === "read_thread")).toBe(true);
  });

  it("fails closed when only wait_threads is available", async () => {
    const setupValue = setup([], [], { read: false });
    const captured: DesktopCompletionBaseline = {
      targetThreadId: TARGET_THREAD,
      hostId: HOST_ID,
      turnIds: [A],
    };

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toEqual({
        status: "unknown",
        targetThreadId: TARGET_THREAD,
        hostId: HOST_ID,
        reason: "capability_unavailable",
      });
    expect(setupValue.calls).toHaveLength(0);
  });

  it("times out against a turn that remains in progress", async () => {
    const pending = readPayload([turn(B, "inProgress")]);
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      pending,
    ], [], { wait: false, pollIntervalMs: 1 });
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(5), baseline: captured }))
      .resolves.toMatchObject({ status: "timed_out" });
  });

  it("rejects with AbortError when the caller aborts", async () => {
    const controller = new AbortController();
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "inProgress")]),
    ], [new Promise<CallToolResult>(() => undefined) as unknown as CallToolResult]);
    const captured = await setupValue.observer.captureBaseline(context());
    const pending = setupValue.observer.waitForCompletion({
      ...context(10_000),
      baseline: captured,
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses executor metadata and target arguments separately", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "completed")]),
    ]);
    const captured = await setupValue.observer.captureBaseline(context());
    await setupValue.observer.waitForCompletion({ ...context(), baseline: captured });

    expect(setupValue.calls.every((call) => call._meta?.["openai/threadId"] === EXECUTOR_THREAD)).toBe(true);
    expect(setupValue.calls.every((call) => call.arguments?.threadId === TARGET_THREAD)).toBe(true);
    expect(setupValue.calls.every((call) => call.arguments?.hostId === HOST_ID)).toBe(true);
  });

  it("does not use arbitrary item text to determine completion", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([{
        ...turn(B, "completed"),
        items: [{ type: "agentMessage", text: "unrelated text" }],
      }]),
    ]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "completed", turnId: B });
  });

  it("fails closed when wait wake identity conflicts with the locked candidate", async () => {
    const setupValue = setup([
      readPayload([turn(A, "completed")]),
      readPayload([turn(B, "inProgress")]),
    ], [waitPayload({ wake: { reason: "turnCompleted", threadId: TARGET_THREAD, turnId: C } })]);
    const captured = await setupValue.observer.captureBaseline(context());

    await expect(setupValue.observer.waitForCompletion({ ...context(), baseline: captured }))
      .resolves.toMatchObject({ status: "unknown", reason: "turn_identity_unavailable" });
    expect(setupValue.calls.map((call) => call.name)).toEqual([
      "read_thread",
      "read_thread",
      "wait_threads",
    ]);
  });

  it("rejects a baseline that is not bound to the observation context", async () => {
    const setupValue = setup([readPayload([turn(B, "completed")])]);

    await expect(setupValue.observer.waitForCompletion({
      ...context(),
      baseline: { targetThreadId: "other-thread", hostId: HOST_ID, turnIds: [A] },
    })).resolves.toMatchObject({ status: "unknown", reason: "baseline_invalid" });
    expect(setupValue.calls).toHaveLength(0);
  });
});
