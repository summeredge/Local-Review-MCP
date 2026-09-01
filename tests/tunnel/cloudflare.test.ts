import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CloudflareTunnelProvider } from "../../src/tunnel/cloudflare.js";
import { TunnelManager } from "../../src/tunnel/manager.js";

class FakeTunnelProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 1;
  public killed = false;

  public kill = vi.fn(() => {
    this.killed = true;
    this.emit("close", null, null);
    return true;
  });
}

function spawnFake(process: FakeTunnelProcess) {
  return vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) =>
    process as unknown as ChildProcess);
}

describe("Cloudflare tunnel provider", () => {
  it("rejects invalid configuration and initializes a valid token provider", async () => {
    expect(() => new CloudflareTunnelProvider({ endpoint: "http://review.example/mcp" }))
      .toThrow("public HTTPS URL");
    expect(() => new CloudflareTunnelProvider({ token: "token with spaces" }))
      .toThrow("CLOUDFLARE_TUNNEL_TOKEN");
    await expect(new CloudflareTunnelProvider({ endpoint: "https://review.example/mcp" }).start())
      .rejects.toThrow("CLOUDFLARE_TUNNEL_TOKEN");

    const process = new FakeTunnelProcess();
    const spawn = spawnFake(process);
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      token: "test-tunnel-token",
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");

    await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
    expect(spawn).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "run", "--token", "test-tunnel-token"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("returns a URL reported by a quick tunnel and tracks its lifecycle", async () => {
    const endpoint = ["https:", "", ["review", "trycloudflare", "com"].join(".")].join("/");
    const process = new FakeTunnelProcess();
    const provider = new CloudflareTunnelProvider({
      localEndpoint: "http://127.0.0.1:12080",
      readyTimeoutMs: 100,
      spawn: spawnFake(process) as unknown as typeof import("node:child_process").spawn,
    });
    const manager = new TunnelManager(provider, true);
    const starting = manager.start();
    await expect(manager.status()).resolves.toEqual({ state: "REMOTE_STARTING" });
    process.stderr.emit("data", "Terms: https://www.cloudflare.com/website-terms/\n");
    process.stderr.emit("data", `Your quick Tunnel is ${endpoint}\n`);

    await expect(starting).resolves.toEqual({
      state: "REMOTE_READY",
      endpoint,
    });
    expect(await manager.status()).toEqual({
      state: "REMOTE_READY",
      endpoint,
    });

    await manager.stop();
    expect(await manager.status()).toEqual({ state: "STOPPED" });
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
