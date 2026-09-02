import { describe, expect, it } from "vitest";
import {
  createTunnelManager,
  ManualEndpointProvider,
  NullTunnelProvider,
  TunnelManager,
} from "../../src/tunnel/manager.js";
import { resolveSettings } from "../../src/config/settings.js";

describe("tunnel abstraction", () => {
  it("keeps disabled remote mode local-only", async () => {
    const manager = new TunnelManager(new NullTunnelProvider(), false);

    expect(await manager.status()).toEqual({ state: "LOCAL_ONLY" });
    expect(await manager.start()).toEqual({ state: "LOCAL_ONLY" });
    await manager.stop();
    expect(await manager.status()).toEqual({ state: "LOCAL_ONLY" });
  });

  it("tracks a manual endpoint without owning a tunnel service", async () => {
    const provider = new ManualEndpointProvider("https://review.example/mcp");
    const manager = new TunnelManager(provider, true);

    expect(await manager.status()).toEqual({ state: "LOCAL_ONLY" });
    expect(await manager.start()).toEqual({
      state: "REMOTE_READY",
      endpoint: "https://review.example/mcp",
    });
    await manager.stop();
    expect(await manager.status()).toEqual({ state: "STOPPED" });
  });

  it("records provider failures as REMOTE_ERROR without exposing the cause", async () => {
    const provider = {
      start: async () => { throw new Error("secret-token"); },
      stop: async () => {},
      status: async () => ({ state: "LOCAL_ONLY" as const }),
    };
    const manager = new TunnelManager(provider, true);

    await expect(manager.start()).rejects.toMatchObject({
      message: "Tunnel failed to start",
      cause: expect.objectContaining({ message: "secret-token" }),
    });
    expect(await manager.status()).toEqual({ state: "REMOTE_ERROR" });
  });

  it("passes a configured Cloudflare token through the resolved remote settings", async () => {
    const settings = resolveSettings({
      configWorkspace: "workspace",
      configToken: "auth-token",
      configRemote: {
        enabled: true,
        provider: "cloudflare",
        token: "abc",
        endpoint: "https://review.example/mcp",
      },
    });

    expect(settings.remote).toEqual({
      enabled: true,
      provider: "cloudflare",
      token: "abc",
      endpoint: "https://review.example/mcp",
    });
    expect(resolveSettings({
      configWorkspace: "workspace",
      configToken: "auth-token",
      configRemote: {
        enabled: true,
        provider: "cloudflare",
        endpoint: "https://review.example/mcp",
      },
      envRemoteToken: "abc",
    }).remote).toEqual({
      enabled: true,
      provider: "cloudflare",
      token: "abc",
      endpoint: "https://review.example/mcp",
    });
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "auth-token",
      configRemote: {
        enabled: true,
        provider: "cloudflare",
        token: "remote-token",
        endpoint: "https://review.example/mcp",
      },
      envRemoteToken: "environment-token",
    })).toThrow("Cloudflare tunnel token configuration conflict");
    expect(() => createTunnelManager({
      enabled: true,
      provider: "cloudflare",
      token: "remote-token",
      endpoint: "https://review.example/mcp",
    }, {
      environment: {},
      cloudflare: { token: "option-token" },
    })).toThrow("Cloudflare tunnel token configuration conflict");
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "auth-token",
      configRemote: {
        enabled: true,
        provider: "cloudflare",
        token: "abc",
        tunnelName: "xxx",
        endpoint: "https://review.example/mcp",
      },
    })).toThrow("Cloudflare tunnel configuration invalid: token and tunnelName cannot both be set");
  });
});
