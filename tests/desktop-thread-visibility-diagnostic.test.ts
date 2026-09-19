import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopThreadVisibilityDiagnosticClient,
  parseDesktopThreadVisibilityDiagnosticArgs,
} from "../src/desktop-sync/desktop-thread-visibility-diagnostic.js";
import type { DesktopIPCConnection } from "../src/desktop-sync/desktop-ipc-client.js";

class FakeConnection extends EventEmitter implements DesktopIPCConnection {
  public readonly writes: Buffer[] = [];
  public destroyed = false;

  public write(data: string | Uint8Array): boolean {
    this.writes.push(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
    return true;
  }

  public destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  public connect(): void {
    this.emit("connect");
  }

  public send(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.emit("data", frame);
  }

  public close(): void {
    this.emit("close");
  }
}

function writtenMessage(connection: FakeConnection, index: number): Record<string, unknown> {
  const frame = connection.writes[index]!;
  const length = frame.readUInt32LE(0);
  return JSON.parse(frame.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop thread visibility diagnostic", () => {
  it("records initialize, known broadcasts, unknown requests and notifications without responding", () => {
    const connection = new FakeConnection();
    const lines: Record<string, unknown>[] = [];
    const client = new DesktopThreadVisibilityDiagnosticClient({
      pipePath: "\\\\.\\pipe\\codex-ipc-test",
      targetThreadId: "thread-target",
      createConnection: () => connection,
      now: () => "2026-09-19T00:00:00.000Z",
    });
    client.onLine((line) => lines.push({ ...line }));

    client.start();
    connection.connect();
    const initialize = writtenMessage(connection, 0);
    expect(initialize).toMatchObject({
      type: "request",
      method: "initialize",
    });
    expect(lines).toContainEqual(expect.objectContaining({
      event: "ipc-message",
      direction: "out",
      method: "initialize",
      kind: "request",
    }));

    connection.send({
      type: "response",
      requestId: initialize.requestId,
      resultType: "success",
      method: "initialize",
      result: { currentConversationId: "thread-target", ownerClientId: "desktop-1" },
    });
    expect(lines).toContainEqual(expect.objectContaining({ event: "initialized", requestId: initialize.requestId }));

    connection.send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      params: {
        conversationId: "thread-target",
        threadId: "thread-target",
        following: true,
        sourceClientId: "desktop-1",
      },
    });
    expect(lines).toContainEqual(expect.objectContaining({
      event: "thread-stream-following-changed",
      kind: "broadcast",
      targetThreadMatch: true,
      conversationId: "thread-target",
      threadId: "thread-target",
      following: true,
    }));

    connection.send({
      type: "request",
      requestId: "unknown-request",
      method: "desktop/unknown",
      params: {
        text: "USER SECRET",
        authorization: "Bearer secret",
        nested: { content: "ASSISTANT SECRET", safe: true },
      },
    });
    connection.send({
      method: "new-notification",
      params: { message: "USER SECRET", nested: { safe: false } },
    });

    const unknownRequest = lines.find((line) => line.requestId === "unknown-request");
    expect(unknownRequest).toEqual(expect.objectContaining({
      event: "ipc-message",
      kind: "request",
      method: "desktop/unknown",
    }));
    expect(lines).toContainEqual(expect.objectContaining({
      event: "ipc-message",
      kind: "notification",
      method: "new-notification",
    }));
    expect(JSON.stringify(lines)).not.toMatch(/USER SECRET|ASSISTANT SECRET|Bearer secret|authorization|content|(?<!ipc-)\bmessage\b|\btext\b/iu);
    expect(connection.writes).toHaveLength(1);

    client.stop();
    expect(connection.destroyed).toBe(true);
    expect(lines).toContainEqual(expect.objectContaining({ event: "disconnected" }));
  });

  it("records reconnect lifecycle and sends only one initialize per connection", () => {
    vi.useFakeTimers();
    const first = new FakeConnection();
    const second = new FakeConnection();
    const connections = [first, second];
    const lines: Record<string, unknown>[] = [];
    const client = new DesktopThreadVisibilityDiagnosticClient({
      reconnectDelayMs: 10,
      connectTimeoutMs: 100,
      createConnection: () => connections.shift()!,
    });
    client.onLine((line) => lines.push({ ...line }));

    client.start();
    first.connect();
    const firstInitialize = writtenMessage(first, 0);
    first.send({ type: "response", requestId: firstInitialize.requestId, result: {} });
    first.close();
    vi.advanceTimersByTime(10);
    second.connect();
    const secondInitialize = writtenMessage(second, 0);
    second.send({ type: "response", requestId: secondInitialize.requestId, result: {} });

    expect(lines.map((line) => line.event).filter((event) => typeof event === "string"))
      .toEqual(["connected", "ipc-message", "ipc-message", "initialized", "disconnected", "reconnected", "ipc-message", "ipc-message", "initialized"]);
    expect(first.writes).toHaveLength(1);
    expect(second.writes).toHaveLength(1);
    client.stop();
  });

  it("fails closed when the pipe is absent and keeps retrying without throwing", () => {
    vi.useFakeTimers();
    const lines: Record<string, unknown>[] = [];
    const client = new DesktopThreadVisibilityDiagnosticClient({
      reconnectDelayMs: 10,
      createConnection: () => { throw new Error("ENOENT"); },
    });
    client.onLine((line) => lines.push({ ...line }));

    expect(() => client.start()).not.toThrow();
    expect(lines).toContainEqual(expect.objectContaining({ event: "disconnected" }));
    vi.advanceTimersByTime(10);
    expect(lines.filter((line) => line.event === "disconnected")).toHaveLength(2);
    client.stop();
  });

  it("parses the diagnostic flags", () => {
    expect(parseDesktopThreadVisibilityDiagnosticArgs([
      "--watch",
      "--thread",
      "thread-1",
      "--pipe",
      "pipe-1",
      "--wait-ms",
      "25",
    ])).toEqual({ watch: true, waitMs: 25, pipePath: "pipe-1", threadId: "thread-1" });
  });
});
