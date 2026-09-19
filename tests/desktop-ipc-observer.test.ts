import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopIPCClient,
  type DesktopIPCConnection,
} from "../src/desktop-sync/desktop-ipc-client.js";
import {
  DesktopIPCFrameParser,
  parseDesktopIPCMessage,
} from "../src/desktop-sync/desktop-ipc-protocol.js";
import { DesktopIPCObserver } from "../src/desktop-sync/desktop-ipc-observer.js";

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

  public sendRaw(frame: string): void {
    this.emit("data", Buffer.from(frame, "utf8"));
  }

  public close(): void {
    this.emit("close");
  }
}

function writtenMessage(connection: FakeConnection, index: number): Record<string, unknown> {
  const frame = connection.writes[index]!;
  const length = frame.readUInt32LE(0);
  return JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Desktop IPC protocol", () => {
  it("parses the supported following broadcast payloads", () => {
    expect(parseDesktopIPCMessage({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: "desktop-1",
      version: 1,
      params: {
        conversationId: "conversation-1",
        threadId: "thread-1",
        following: true,
      },
    })).toEqual({
      kind: "broadcast",
      event: "thread-stream-following-changed",
      payload: {
        conversationId: "conversation-1",
        threadId: "thread-1",
        following: true,
      },
      sourceClientId: "desktop-1",
      conversationId: "conversation-1",
      threadId: "thread-1",
      following: true,
      ownerClientId: "desktop-1",
    });

    expect(parseDesktopIPCMessage({
      type: "event",
      event: "thread-stream-following-status-requested",
      data: { thread_id: "thread-1" },
    })).toMatchObject({
      kind: "broadcast",
      event: "thread-stream-following-status-requested",
      threadId: "thread-1",
    });
  });

  it("ignores unknown methods and supports fragmented JSON-RPC frames", () => {
    expect(parseDesktopIPCMessage({ method: "unknown-event", params: {} })).toBeUndefined();
    const parser = new DesktopIPCFrameParser();
    expect(parser.push('{"method":"broadcast","params":{"event":"thread-stream-following-changed",')).toEqual([]);
    expect(parser.push('"payload":{"conversationId":"conversation-1","following":true}}}\n')).toHaveLength(1);

    const framed = new DesktopIPCFrameParser();
    const body = JSON.stringify({ method: "initialized" });
    expect(framed.push(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)).toEqual([body]);

    const binary = new DesktopIPCFrameParser();
    const binaryBody = JSON.stringify({
      type: "broadcast",
      method: "thread-stream-following-status-requested",
      version: 1,
      params: {},
    });
    const binaryFrame = Buffer.alloc(4 + Buffer.byteLength(binaryBody));
    binaryFrame.writeUInt32LE(Buffer.byteLength(binaryBody), 0);
    binaryFrame.write(binaryBody, 4, "utf8");
    expect(binary.push(binaryFrame.subarray(0, 3))).toEqual([]);
    expect(binary.push(binaryFrame.subarray(3))).toEqual([binaryBody]);
  });
});

describe("Desktop IPC observer", () => {
  it("handshakes, invalidates session state, and reconnects without touching execution", () => {
    vi.useFakeTimers();
    const first = new FakeConnection();
    const second = new FakeConnection();
    const connections = [first, second];
    const client = new DesktopIPCClient({
      pipePath: "\\\\.\\pipe\\codex-ipc-test",
      reconnectDelayMs: 10,
      connectTimeoutMs: 100,
      createConnection: () => connections.shift()!,
    });
    const warn = vi.fn();
    const observer = new DesktopIPCObserver({
      client,
      logger: { warn },
      now: () => "2026-09-18T00:00:00.000Z",
    });
    const states: Array<{ connected: boolean; following: string[] }> = [];
    observer.onStateChanged((state) => states.push({
      connected: state.connected,
      following: [...state.followingThreads],
    }));

    observer.start();
    first.connect();
    const initialize = writtenMessage(first, 0);
    expect(initialize).toMatchObject({
      type: "request",
      method: "initialize",
      params: { clientType: "local-review-mcp-desktop-ipc-observer" },
    });
    first.send({
      type: "response",
      requestId: initialize.requestId,
      resultType: "success",
      result: { currentConversationId: "conversation-1", ownerClientId: "desktop-1" },
    });
    first.send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      params: {
        conversationId: "conversation-1",
        following: true,
      },
    });
    expect(observer.getState()).toMatchObject({
      connected: true,
      currentConversationId: "conversation-1",
      ownerClientId: "desktop-1",
      lastEventTime: "2026-09-18T00:00:00.000Z",
    });
    expect(observer.getState().followingThreads).toEqual(new Set(["conversation-1"]));

    first.close();
    expect(observer.getState()).toMatchObject({
      connected: false,
      lastEventTime: "2026-09-18T00:00:00.000Z",
    });
    expect(observer.getState().currentConversationId).toBeUndefined();
    expect(observer.getState().ownerClientId).toBeUndefined();
    expect(observer.getState().followingThreads).toEqual(new Set());
    vi.advanceTimersByTime(10);
    second.connect();
    expect(observer.getState()).toMatchObject({
      connected: true,
      lastEventTime: "2026-09-18T00:00:00.000Z",
    });
    expect(observer.getState().currentConversationId).toBeUndefined();
    expect(observer.getState().ownerClientId).toBeUndefined();
    expect(observer.getState().followingThreads).toEqual(new Set());
    expect(warn).not.toHaveBeenCalled();
    second.send({ method: "unknown-event", params: { sensitive: "ignored" } });
    second.send({
      type: "request",
      requestId: "ignored-request",
      method: "desktop/unsupported-request",
      params: { sensitive: "ignored" },
    });
    expect(observer.getState()).toMatchObject({ connected: true });
    expect(observer.getState().currentConversationId).toBeUndefined();
    expect(observer.getState().ownerClientId).toBeUndefined();
    expect(observer.getState().followingThreads).toEqual(new Set());
    expect(warn).not.toHaveBeenCalled();

    const secondInitialize = writtenMessage(second, 0);
    second.send({
      type: "response",
      requestId: secondInitialize.requestId,
      resultType: "success",
      method: "initialize",
      result: { currentConversationId: "conversation-2", ownerClientId: "desktop-2" },
    });
    expect(observer.getState()).toMatchObject({
      connected: true,
      currentConversationId: "conversation-2",
      ownerClientId: "desktop-2",
    });
    second.send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      params: { conversationId: "conversation-2", following: true },
    });
    expect(observer.getState().followingThreads).toEqual(new Set(["conversation-2"]));
    const connectedTransitions = states
      .map((state) => state.connected)
      .filter((connected, index, values) => index === 0 || connected !== values[index - 1]);
    expect(connectedTransitions).toEqual([true, false, true]);

    observer.stop();
    expect(observer.getState().connected).toBe(false);
  });

  it("only applies the response matching the current initialize request", () => {
    const connection = new FakeConnection();
    const warn = vi.fn();
    const client = new DesktopIPCClient({
      pipePath: "\\\\.\\pipe\\codex-ipc-test",
      createConnection: () => connection,
    });
    const observer = new DesktopIPCObserver({ client, logger: { warn } });

    observer.start();
    connection.connect();
    const initialize = writtenMessage(connection, 0);
    connection.send({
      type: "response",
      requestId: "unrelated-error",
      resultType: "error",
      method: "initialize",
      error: { code: -1, message: "unrelated failure" },
    });
    expect(observer.getState().connected).toBe(true);
    expect(observer.getState().currentConversationId).toBeUndefined();
    expect(observer.getState().ownerClientId).toBeUndefined();
    expect(observer.getState().followingThreads).toEqual(new Set());
    expect(warn).not.toHaveBeenCalled();

    connection.send({
      type: "response",
      requestId: initialize.requestId,
      resultType: "success",
      result: {
        currentConversationId: "conversation-1",
        ownerClientId: "desktop-1",
        followingThreads: ["thread-1"],
      },
    });
    expect(observer.getState()).toMatchObject({
      connected: true,
      currentConversationId: "conversation-1",
      ownerClientId: "desktop-1",
    });
    expect(observer.getState().followingThreads).toEqual(new Set(["thread-1"]));

    connection.send({
      type: "response",
      requestId: "unrelated-success",
      resultType: "success",
      result: {
        currentConversationId: "wrong-conversation",
        ownerClientId: "wrong-client",
        followingThreads: ["wrong-thread"],
      },
    });
    expect(observer.getState()).toMatchObject({
      connected: true,
      currentConversationId: "conversation-1",
      ownerClientId: "desktop-1",
    });
    expect(observer.getState().followingThreads).toEqual(new Set(["thread-1"]));
    expect(warn).not.toHaveBeenCalled();

    observer.stop();
  });

  it("keeps an absent pipe fail-closed and does not throw from start", () => {
    const warn = vi.fn();
    const client = new DesktopIPCClient({
      reconnectDelayMs: 10,
      createConnection: () => { throw new Error("ENOENT"); },
    });
    const observer = new DesktopIPCObserver({ client, logger: { warn } });
    expect(() => observer.start()).not.toThrow();
    expect(observer.getState()).toMatchObject({ connected: false });
    expect(warn).toHaveBeenCalledWith("Desktop IPC message or connection was ignored.", expect.any(Error));
    observer.stop();
  });

  it("keeps malformed message diagnostics", () => {
    const connection = new FakeConnection();
    const warn = vi.fn();
    const client = new DesktopIPCClient({
      pipePath: "\\\\.\\pipe\\codex-ipc-test",
      createConnection: () => connection,
    });
    const observer = new DesktopIPCObserver({ client, logger: { warn } });

    observer.start();
    connection.connect();
    connection.sendRaw("not-json\n");

    expect(observer.getState().connected).toBe(true);
    expect(warn).toHaveBeenCalledWith("Desktop IPC message or connection was ignored.", expect.any(Error));
    observer.stop();
  });

  it("keeps initialize failure diagnostics and disconnects", () => {
    const connection = new FakeConnection();
    const warn = vi.fn();
    const client = new DesktopIPCClient({
      pipePath: "\\\\.\\pipe\\codex-ipc-test",
      createConnection: () => connection,
    });
    const observer = new DesktopIPCObserver({ client, logger: { warn } });

    observer.start();
    connection.connect();
    const initialize = writtenMessage(connection, 0);
    connection.send({
      type: "response",
      requestId: initialize.requestId,
      resultType: "error",
      method: "initialize",
      error: { code: -1, message: "initialize denied" },
    });

    expect(observer.getState().connected).toBe(false);
    expect(warn).toHaveBeenCalledWith("Desktop IPC message or connection was ignored.", expect.any(Error));
    expect(warn.mock.calls.some(([, error]) => error?.message === "Desktop IPC initialize failed: initialize denied")).toBe(true);
    observer.stop();
  });
});
