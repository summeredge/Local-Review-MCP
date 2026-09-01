import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildStartupCommand, WindowsStartupManager } from "../../src/supervisor/startup.js";
import { WindowsTrayApp, TRAY_ACTIONS, TRAY_SCRIPT } from "../../src/supervisor/tray.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public killed = false;

  public kill = vi.fn(() => {
    this.killed = true;
    this.emit("close", null, null);
    return true;
  });
}

function fakeSpawn(child: FakeChildProcess) {
  return vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
}

describe("Windows supervisor adapters", () => {
  it("uses the per-user Run key without exposing a token", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child as unknown as ChildProcess;
    });
    const manager = new WindowsStartupManager({
      platform: "win32",
      commandLine: buildStartupCommand("C:\\Program Files\\node.exe", ["app.js", "--config", "settings.json"]),
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });

    await manager.enable();
    await manager.disable();
    expect(await manager.isEnabled()).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[0]?.[0]).toBe("reg.exe");
    expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      "ADD",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/V",
      "LocalReviewMCP",
    ]));
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("token");
    expect(spawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ shell: false }));
  });

  it("renders only status and lifecycle actions in the tray script", () => {
    expect(TRAY_ACTIONS).toEqual([
      "start",
      "stop",
      "restart",
      "open-log-folder",
      "enable-startup",
      "disable-startup",
      "exit",
    ]);
    expect(TRAY_SCRIPT).toContain("Status:");
    expect(TRAY_SCRIPT).toContain("Workspace:");
    expect(TRAY_SCRIPT).toContain("Remote:");
    expect(TRAY_SCRIPT).toContain("Open Log Folder");
    expect(TRAY_SCRIPT).not.toContain("file browser");
    expect(TRAY_SCRIPT).not.toContain("code editor");
  });

  it("writes a safe tray state and starts PowerShell without inherited secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-tray-"));
    const child = new FakeChildProcess();
    const spawn = fakeSpawn(child);
    const supervisor = {
      logDirectory: directory,
      onStateChange: () => () => {},
      status: async () => ({
        state: "RUNNING" as const,
        workspace: "review-workspace",
        restartAttempts: 0,
        maxRestartAttempts: 3,
        healthFailures: 0,
        tunnel: { state: "REMOTE_READY" },
      }),
    } as unknown as Supervisor;
    const app = new WindowsTrayApp(supervisor, {
      platform: "win32",
      statePath: join(directory, "tray-state.json"),
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });

    try {
      await app.start();
      expect(JSON.parse(await readFile(app.statePath, "utf8"))).toEqual({
        state: "Running",
        workspace: "review-workspace",
        remote: "Ready",
      });
      expect(spawn.mock.calls[0]?.[0]).toBe("powershell.exe");
      expect(spawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ shell: false }));
      expect(spawn.mock.calls[0]?.[2].env).not.toHaveProperty("LOCAL_REVIEW_MCP_TOKEN");
    } finally {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
