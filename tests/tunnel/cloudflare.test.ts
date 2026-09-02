import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CloudflareTunnelProvider } from "../../src/tunnel/cloudflare.js";

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
  it("rejects invalid configuration", async () => {
    expect(() => new CloudflareTunnelProvider({ endpoint: "http://review.example/mcp" }))
      .toThrow("public HTTPS URL");
    expect(() => new CloudflareTunnelProvider({ token: "token with spaces" }))
      .toThrow("CLOUDFLARE_TUNNEL_TOKEN");
    expect(() => new CloudflareTunnelProvider({ tunnelName: "review-tunnel", token: "tunnel-token" }))
      .toThrow("Cloudflare tunnel configuration invalid: token and tunnelName cannot both be set");
    expect(() => new CloudflareTunnelProvider({
      tunnelName: "review-tunnel",
      environment: { CLOUDFLARE_TUNNEL_TOKEN: "environment-token" },
    })).toThrow("Cloudflare tunnel configuration invalid: token and tunnelName cannot both be set");
    await expect(new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      localEndpoint: "http://127.0.0.1:12080",
      environment: {},
    }).start()).rejects.toThrow("tunnel name or CLOUDFLARE_TUNNEL_TOKEN");
  });

  it("runs a configured named tunnel and waits for a registered connection", async () => {
    const process = new FakeTunnelProcess();
    const spawn = spawnFake(process);
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      tunnelName: "review-tunnel",
      command: "cloudflared.exe",
      environment: {},
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");

    process.stderr.emit("data", "Starting tunnel tunnelID=review-tunnel\n");
    await expect(Promise.race([
      starting.then(() => "ready"),
      Promise.resolve("waiting"),
    ])).resolves.toBe("waiting");
    process.stderr.emit("data", "Registered tunnel connection connIndex=0 protocol=quic\n");

    await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
    expect(spawn).toHaveBeenCalledWith(
      "cloudflared.exe",
      ["tunnel", "--no-autoupdate", "run", "review-tunnel"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("runs a token tunnel without adding a local URL", async () => {
    const process = new FakeTunnelProcess();
    const spawn = spawnFake(process);
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      token: "tunnel-token",
      command: "cloudflared.exe",
      environment: {},
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");
    process.stdout.emit("data", "INF Connection established to the Cloudflare edge\n");

    await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
    expect(spawn).toHaveBeenCalledWith(
      "cloudflared.exe",
      ["tunnel", "--no-autoupdate", "run", "--token", "tunnel-token"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("preserves stderr, exit status, and startup parameters on failure", async () => {
    const process = new FakeTunnelProcess();
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      token: "secret-tunnel-token",
      localEndpoint: "http://127.0.0.1:12080",
      environment: {},
      readyTimeoutMs: 100,
      command: "C:\\Program Files\\cloudflared\\cloudflared.exe",
      spawn: spawnFake(process) as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");
    process.stdout.emit("data", "cloudflared stdout diagnostic\n");
    process.stderr.emit("data", "ERR failed to authenticate with the edge\n");
    process.emit("close", 23, null);

    let error: unknown;
    try {
      await starting;
    } catch (reason: unknown) {
      error = reason;
    }
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("exit code: 23");
    expect(message).toContain("failed to authenticate with the edge");
    expect(message).toContain("cloudflared.exe");
    expect(message).toContain("cloudflared stdout diagnostic");
    expect(message).toContain("<redacted>");
    expect(message).toContain("stderr:");
    expect(message).toContain("stdout:");
    expect(message).toContain("original error: none");
    expect(message).not.toContain("secret-tunnel-token");
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("stops a connected named tunnel and waits for its child to close", async () => {
    const process = new FakeTunnelProcess();
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      tunnelName: "review-tunnel",
      localEndpoint: "http://127.0.0.1:12080",
      environment: {},
      spawn: spawnFake(process) as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");
    process.stdout.emit("data", "Registered tunnel connection connIndex=0\n");
    await starting;

    await provider.stop();
    expect(await provider.status()).toEqual({ state: "STOPPED" });
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
