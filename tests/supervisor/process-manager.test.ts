import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../../src/supervisor/process-manager.js";

class FakeRuntimeProcess extends EventEmitter {
  public readonly pid = 4321;
  public killed = false;

  public kill = vi.fn(() => {
    this.killed = true;
    this.emit("close", null, null);
    return true;
  });
}

describe("runtime process manager", () => {
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
