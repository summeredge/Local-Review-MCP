import { describe, expect, it } from "vitest";
import {
  ManualEndpointProvider,
  NullTunnelProvider,
  TunnelManager,
} from "../../src/tunnel/manager.js";

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
});
