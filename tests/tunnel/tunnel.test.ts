import { describe, expect, it } from "vitest";
import {
  ManualEndpointProvider,
  NullTunnelProvider,
  TunnelManager,
} from "../../src/tunnel/manager.js";

describe("tunnel abstraction", () => {
  it("keeps disabled remote mode disabled", async () => {
    const manager = new TunnelManager(new NullTunnelProvider(), false);

    expect(await manager.status()).toEqual({ state: "DISABLED" });
    expect(await manager.start()).toEqual({ state: "DISABLED" });
    await manager.stop();
    expect(await manager.status()).toEqual({ state: "DISABLED" });
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
    expect(await manager.status()).toEqual({ state: "LOCAL_ONLY" });
  });

  it("records provider failures as REMOTE_ERROR without exposing the cause", async () => {
    const provider = {
      start: async () => { throw new Error("secret-token"); },
      stop: async () => {},
      status: async () => ({ state: "LOCAL_ONLY" as const }),
    };
    const manager = new TunnelManager(provider, true);

    await expect(manager.start()).rejects.toThrow("Tunnel failed to start");
    expect(await manager.status()).toEqual({ state: "REMOTE_ERROR" });
  });
});
