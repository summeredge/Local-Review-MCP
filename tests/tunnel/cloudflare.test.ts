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

function spawnSequence(processes: readonly FakeTunnelProcess[]) {
  let index = 0;
  return vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) =>
    processes[index++] as unknown as ChildProcess);
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
    expect(() => new CloudflareTunnelProvider({
      token: "configured-token",
      environment: { CLOUDFLARE_TUNNEL_TOKEN: "environment-token" },
    })).toThrow("Cloudflare tunnel token configuration conflict");
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
      healthCheck: async () => true,
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
      healthCheck: async () => true,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");
    process.stdout.emit("data", "Registered tunnel connection connIndex=0 protocol=quic\n");

    await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
    expect(spawn).toHaveBeenCalledWith(
      "cloudflared.exe",
      ["tunnel", "--no-autoupdate", "run", "--token", "tunnel-token"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("falls back to HTTP/2 after a default protocol connection failure", async () => {
    const defaultProcess = new FakeTunnelProcess();
    const fallbackProcess = new FakeTunnelProcess();
    const spawn = spawnSequence([defaultProcess, fallbackProcess]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = new CloudflareTunnelProvider({
        endpoint: "https://review.example/mcp",
        token: "tunnel-token",
        command: "cloudflared.exe",
        environment: {},
        readyTimeoutMs: 100,
        healthCheck: async () => true,
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
      });
      const starting = provider.start();
      defaultProcess.emit("spawn");
      defaultProcess.stderr.emit("data", "Failed to dial a quic connection\n");
      expect(spawn).toHaveBeenCalledOnce();

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      fallbackProcess.emit("spawn");
      fallbackProcess.stderr.emit("data", "Registered tunnel connection connIndex=0 protocol=http2\n");

      await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        "cloudflared.exe",
        ["tunnel", "--no-autoupdate", "run", "--token", "tunnel-token"],
        expect.objectContaining({ shell: false, windowsHide: true }),
      );
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        "cloudflared.exe",
        ["tunnel", "--no-autoupdate", "run", "--protocol", "http2", "--token", "tunnel-token"],
        expect.objectContaining({ shell: false, windowsHide: true }),
      );
      expect(log).toHaveBeenCalledWith("Starting Cloudflare Tunnel (default protocol)");
      expect(log).toHaveBeenCalledWith("Cloudflare Tunnel default protocol failed, retrying with HTTP/2");
      expect(log).toHaveBeenCalledWith("Starting Cloudflare Tunnel with HTTP/2 fallback");
      expect(log).toHaveBeenCalledWith("Cloudflare Tunnel registered successfully protocol=http2");
      expect(warn).toHaveBeenCalledWith("retryable tunnel connection error");
      expect(defaultProcess.kill).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("supports an explicit HTTP/2 protocol without a default attempt", async () => {
    const process = new FakeTunnelProcess();
    const spawn = spawnFake(process);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const provider = new CloudflareTunnelProvider({
        endpoint: "https://review.example/mcp",
        tunnelName: "review-tunnel",
        protocol: "http2",
        command: "cloudflared.exe",
        environment: {},
        healthCheck: async () => true,
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
      });
      const starting = provider.start();
      process.emit("spawn");
      process.stderr.emit("data", "Registered tunnel connection connIndex=0 protocol=http2\n");

      await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
      expect(spawn).toHaveBeenCalledWith(
        "cloudflared.exe",
        ["tunnel", "--no-autoupdate", "run", "--protocol", "http2", "review-tunnel"],
        expect.objectContaining({ shell: false, windowsHide: true }),
      );
      expect(log).toHaveBeenCalledWith("Starting Cloudflare Tunnel with HTTP/2");
      expect(log.mock.calls.flat().join(" ")).not.toContain("default protocol failed");
    } finally {
      log.mockRestore();
    }
  });

  it("runs an environment-token tunnel and reports a safe mode diagnostic", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const process = new FakeTunnelProcess();
      const spawn = spawnFake(process);
      const provider = new CloudflareTunnelProvider({
        endpoint: "https://review.example/mcp",
        command: "cloudflared.exe",
        environment: { CLOUDFLARE_TUNNEL_TOKEN: "environment-token" },
        healthCheck: async () => true,
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
      });
      const starting = provider.start();
      process.emit("spawn");
      process.stdout.emit("data", "Registered tunnel connection connIndex=0 protocol=quic\n");

      await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
      expect(spawn).toHaveBeenCalledWith(
        "cloudflared.exe",
        ["tunnel", "--no-autoupdate", "run", "--token", "environment-token"],
        expect.objectContaining({ shell: false, windowsHide: true }),
      );
      expect(log).toHaveBeenCalledWith("Cloudflare tunnel mode: token");
      expect(log.mock.calls.flat().join(" ")).not.toContain("environment-token");
    } finally {
      log.mockRestore();
    }
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
    expect(message).toContain("attempt 1 protocol=auto");
    expect(message).toContain("attempt 2 protocol=http2");
    expect(message).toContain("--protocol");
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

  it("waits for the public endpoint health check before reporting ready", async () => {
    const process = new FakeTunnelProcess();
    let healthCalls = 0;
    const healthCheck = vi.fn(async () => {
      healthCalls += 1;
      return healthCalls > 1;
    });
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      tunnelName: "review-tunnel",
      command: "cloudflared.exe",
      environment: {},
      readyTimeoutMs: 1_000,
      healthCheck,
      spawn: spawnFake(process) as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");
    process.stderr.emit("data", "Registered tunnel connection connIndex=0\n");

    await expect(starting).resolves.toEqual({ endpoint: "https://review.example/mcp" });
    expect(healthCheck).toHaveBeenCalledWith("https://review.example/health");
    expect(healthCalls).toBeGreaterThan(1);
  });

  it("fails startup when the public health endpoint never becomes healthy", async () => {
    const process = new FakeTunnelProcess();
    const healthCheck = vi.fn(async () => false);
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      tunnelName: "review-tunnel",
      command: "cloudflared.exe",
      environment: {},
      readyTimeoutMs: 100,
      healthCheck,
      spawn: spawnFake(process) as unknown as typeof import("node:child_process").spawn,
    });
    const starting = provider.start();
    process.emit("spawn");
    process.stderr.emit("data", "Registered tunnel connection connIndex=0\n");

    await expect(starting).rejects.toMatchObject({
      message: expect.stringContaining("public endpoint health check"),
    });
    expect(healthCheck).toHaveBeenCalled();
    expect(process.kill).toHaveBeenCalledOnce();
    await expect(provider.status()).resolves.toEqual({ state: "REMOTE_ERROR" });
  });

  it("stops a connected named tunnel and waits for its child to close", async () => {
    const process = new FakeTunnelProcess();
    const provider = new CloudflareTunnelProvider({
      endpoint: "https://review.example/mcp",
      tunnelName: "review-tunnel",
      localEndpoint: "http://127.0.0.1:12080",
      environment: {},
      healthCheck: async () => true,
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
