import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { CodexAppServerClient } from "../src/backends/codex_app_server/client.js";
import { parseCodexAppServerNotification } from "../src/backends/codex_app_server/events.js";
import { parseRpcLine } from "../src/backends/codex_app_server/protocol.js";

type FakeRequest = Record<string, unknown>;
type FakeRequestHandler = (request: FakeRequest, process: FakeAppServerProcess) => void;

class FakeAppServerProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 4811;
  public readonly requests: FakeRequest[] = [];
  public readonly kill = vi.fn(() => {
    this.closeProcess(null, "SIGTERM");
    return true;
  });

  private input = "";
  private closed = false;

  public constructor(private readonly handleRequest: FakeRequestHandler) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.input += chunk.toString();
      let newline = this.input.indexOf("\n");
      while (newline >= 0) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (line.trim() !== "") {
          const request = JSON.parse(line) as FakeRequest;
          this.requests.push(request);
          this.handleRequest(request, this);
        }
        newline = this.input.indexOf("\n");
      }
    });
    this.stdin.once("finish", () => this.closeProcess(null, null));
  }

  public respond(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  public closeProcess(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

const clients: CodexAppServerClient[] = [];
const processes: FakeAppServerProcess[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const process of processes.splice(0)) process.closeProcess(null, null);
  spawnMock.mockReset();
});

async function startFakeServer(
  handleRequest: FakeRequestHandler,
  requestTimeoutMs = 100,
): Promise<{ readonly client: CodexAppServerClient; readonly process: FakeAppServerProcess }> {
  const fakeProcess = new FakeAppServerProcess(handleRequest);
  processes.push(fakeProcess);
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => fakeProcess.emit("spawn"));
    return fakeProcess;
  });
  const client = await CodexAppServerClient.start({
    cwd: globalThis.process.cwd(),
    executable: "fake-codex",
    requestTimeoutMs,
  });
  clients.push(client);
  return { client, process: fakeProcess };
}

function initializeResult(): Record<string, unknown> {
  return { userAgent: "codex-cli 0.151.0" };
}

describe("CodexAppServerClient protocol handling", () => {
  it("resolves a matching response and records initialized process state", async () => {
    const { client, process } = await startFakeServer((request, fakeProcess) => {
      if (request.method === "initialize") {
        fakeProcess.respond({ id: request.id, result: initializeResult() });
      }
    });

    await expect(client.initialize()).resolves.toMatchObject({ user_agent: "codex-cli 0.151.0" });
    expect(process.requests[0]).toMatchObject({ id: 0, method: "initialize" });
    expect(process.requests[1]).toEqual({ method: "initialized" });
    expect(client.processInfo).toMatchObject({
      process_id: 4811,
      codex_version: "0.151.0",
      transport: "stdio",
      status: "ready",
    });
  });

  it("rejects a response with an unmatched request id", async () => {
    const { client } = await startFakeServer((request, fakeProcess) => {
      if (request.method === "initialize") {
        fakeProcess.respond({ id: 999, result: initializeResult() });
      }
    });

    await expect(client.initialize()).rejects.toThrow(/unexpected .* response id/iu);
    expect(client.processInfo.status).toBe("failed");
  });

  it("handles RPC errors and request timeouts", async () => {
    const rpcError = await startFakeServer((request, fakeProcess) => {
      if (request.method === "initialize") {
        fakeProcess.respond({ id: request.id, result: initializeResult() });
      } else if (request.method === "model/list") {
        fakeProcess.respond({ id: request.id, error: { code: -32001, message: "model list unavailable" } });
      }
    });
    await expect(rpcError.client.listModels()).rejects.toMatchObject({
      name: "CodexAppServerRpcError",
      code: -32001,
      message: "model list unavailable",
    });

    const timeout = await startFakeServer((request, fakeProcess) => {
      if (request.method === "initialize") {
        fakeProcess.respond({ id: request.id, result: initializeResult() });
      }
    }, 20);
    await expect(timeout.client.listModels()).rejects.toThrow(/request timed out: model\/list/iu);
  });

  it("keeps model and effort in their respective thread and turn payloads", async () => {
    const { client, process } = await startFakeServer((request, fakeProcess) => {
      if (request.method === "initialize") {
        fakeProcess.respond({ id: request.id, result: initializeResult() });
      } else if (request.method === "model/list") {
        fakeProcess.respond({
          id: request.id,
          result: {
            data: [{
              model: "model-a",
              displayName: "Model A",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              defaultReasoningEffort: "high",
            }],
            nextCursor: null,
          },
        });
      } else if (request.method === "thread/start") {
        fakeProcess.respond({
          id: request.id,
          result: { thread: { id: "thread-1", sessionId: "session-1" }, model: "model-a" },
        });
      } else if (request.method === "turn/start") {
        fakeProcess.respond({
          id: request.id,
          result: { turn: { id: "turn-1", status: "inProgress" } },
        });
      }
    });

    await expect(client.listModels()).resolves.toMatchObject([{ model: "model-a", efforts: ["high"] }]);
    await client.startThread({ cwd: globalThis.process.cwd(), model: "model-a" });
    await client.startTurn({ threadId: "thread-1", text: "hello", model: "model-a", effort: "high" });

    expect(process.requests.find((request) => request.method === "thread/start")?.params).toEqual({
      cwd: globalThis.process.cwd(),
      model: "model-a",
    });
    expect(process.requests.find((request) => request.method === "turn/start")?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: "model-a",
      effort: "high",
    });
  });

  it("fails closed for an invalid response and an abnormal process exit", async () => {
    const invalid = await startFakeServer((request, fakeProcess) => {
      if (request.method === "initialize") {
        fakeProcess.stdout.write(JSON.stringify({ id: request.id, error: { code: "invalid" } }) + "\n");
      }
    });
    await expect(invalid.client.initialize()).rejects.toThrow(/invalid RPC error/iu);
    expect(invalid.client.processInfo.status).toBe("failed");

    const exited = await startFakeServer((request, fakeProcess) => {
      if (request.method === "initialize") queueMicrotask(() => fakeProcess.closeProcess(7, null));
    });
    await expect(exited.client.initialize()).rejects.toThrow(/exited before completion/iu);
    expect(exited.client.processInfo.status).toBe("failed");
  });
});

describe("Codex app-server event parser", () => {
  it("normalizes the supported provider events", () => {
    const notifications = [
      { method: "thread/started", params: { thread: { id: "thread-1", sessionId: "session-1" } } },
      { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
      },
      {
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello" } },
      },
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      },
    ];

    expect(notifications.map((notification) => parseCodexAppServerNotification(notification))).toEqual([
      { type: "thread_started", thread_id: "thread-1", session_id: "session-1" },
      { type: "turn_started", thread_id: "thread-1", turn_id: "turn-1" },
      { type: "agent_message_delta", thread_id: "thread-1", turn_id: "turn-1", item_id: "item-1", content: "hello" },
      { type: "agent_message_completed", thread_id: "thread-1", turn_id: "turn-1", item_id: "item-1", content: "hello" },
      { type: "turn_completed", thread_id: "thread-1", turn_id: "turn-1" },
    ]);
  });

  it("ignores unknown notifications and rejects invalid protocol responses", () => {
    expect(parseCodexAppServerNotification({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1" },
    })).toBeUndefined();
    expect(() => parseRpcLine(JSON.stringify({ id: 1, error: { code: "bad", message: "no" } }))).toThrow(
      /invalid RPC error/iu,
    );
  });
});
