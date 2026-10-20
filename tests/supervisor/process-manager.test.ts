import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../../src/supervisor/process-manager.js";

class FakeRuntimeProcess extends EventEmitter {
  public readonly pid = 4321;
  public killed = false;
  public readonly stderr = new PassThrough();

  public kill = vi.fn(() => {
    this.killed = true;
    this.emit("close", null, null);
    return true;
  });
}

describe("runtime process manager", () => {
  it("waits for exit before starting a replacement and records an intentional signal", async () => {
    const children = [new FakeRuntimeProcess(), new FakeRuntimeProcess()];
    children[0]!.kill.mockImplementation(() => { children[0]!.killed = true; return true; });
    const spawn = vi.fn(() => {
      const child = children[spawn.mock.calls.length - 1]!;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    });
    const manager = new ProcessManager({ spawn: spawn as unknown as typeof import("node:child_process").spawn });
    const listener = vi.fn();
    manager.onExit(listener);
    await manager.start();
    const stopped = manager.stop();
    const replacement = manager.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0]!.emit("exit", null, "SIGTERM");
    await stopped;
    await replacement;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith({ code: null, signal: "SIGTERM", pid: 4321, expected: true });
    await manager.stop();
  });

  it("times out without allowing replacement while the old child is alive", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeRuntimeProcess();
      child.kill.mockImplementation(() => { child.killed = true; return true; });
      const spawn = vi.fn(() => child as unknown as ChildProcess);
      const manager = new ProcessManager({ spawn: spawn as unknown as typeof import("node:child_process").spawn });
      const starting = manager.start();
      child.emit("spawn");
      await starting;
      const stopped = expect(manager.stop()).rejects.toThrow("timed out");
      const replacement = expect(manager.start()).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
      await replacement;
      expect(spawn).toHaveBeenCalledOnce();
      child.emit("exit", 1, null);
    } finally { vi.useRealTimers(); }
  });

  it("records safe bounded stderr on unexpected exit and handles spawn errors", async () => {
    const child = new FakeRuntimeProcess();
    const manager = new ProcessManager({ spawn: (() => child) as unknown as typeof import("node:child_process").spawn });
    const listener = vi.fn();
    manager.onExit(listener);
    const starting = manager.start();
    child.emit("spawn");
    await starting;
    child.stderr.write("Authorization: Bearer private-secret " + "x".repeat(5000) + " EADDRINUSE");
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ code: 1, signal: null, pid: 4321, expected: false, stderr: "EADDRINUSE" });
    const failedChild = new EventEmitter();
    const failedManager = new ProcessManager({ spawn: (() => failedChild) as unknown as typeof import("node:child_process").spawn });
    const failure = expect(failedManager.start()).rejects.toThrow("failed to start");
    failedChild.emit("error", new Error("ENOENT"));
    await failure;
    await failedManager.stop();
  });
  it("starts and stops a child without a shell", async () => {
    const child = new FakeRuntimeProcess();
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    });
    const manager = new ProcessManager({
      command: "node.exe",
      args: ["runtime.js", "--runtime"],
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });

    await expect(manager.start()).resolves.toEqual({ running: true, pid: 4321 });
    expect(spawn).toHaveBeenCalledWith(
      "node.exe",
      ["runtime.js", "--runtime"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(manager.status()).toEqual({ running: true, pid: 4321 });

    await manager.stop();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(manager.status()).toEqual({ running: false });
  });
});
