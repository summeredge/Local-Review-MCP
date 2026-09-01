import type { RemoteSettings } from "../config/settings.js";
import type { ConnectionState, TunnelInfo, TunnelProvider, TunnelStatus } from "./types.js";

export class NullTunnelProvider implements TunnelProvider {
  public async start(): Promise<TunnelInfo> {
    return { endpoint: "" };
  }

  public async stop(): Promise<void> {}

  public async status(): Promise<TunnelStatus> {
    return { state: "DISABLED" };
  }
}

export class ManualEndpointProvider implements TunnelProvider {
  private running = false;

  public constructor(private readonly endpoint: string) {}

  public async start(): Promise<TunnelInfo> {
    if (this.endpoint === "") throw new Error("Tunnel endpoint is required");
    this.running = true;
    return { endpoint: this.endpoint };
  }

  public async stop(): Promise<void> {
    this.running = false;
  }

  public async status(): Promise<TunnelStatus> {
    return this.running
      ? { state: "REMOTE_READY", endpoint: this.endpoint }
      : { state: "LOCAL_ONLY" };
  }
}

export class TunnelManager {
  private state: ConnectionState;
  private endpoint: string | undefined;

  public constructor(
    private readonly provider: TunnelProvider,
    private readonly enabled: boolean,
  ) {
    this.state = enabled ? "LOCAL_ONLY" : "DISABLED";
  }

  public async start(): Promise<TunnelStatus> {
    if (!this.enabled) {
      this.state = "DISABLED";
      this.endpoint = undefined;
      return this.status();
    }

    try {
      const info = await this.provider.start();
      this.state = "REMOTE_READY";
      this.endpoint = info.endpoint;
    } catch {
      this.state = "REMOTE_ERROR";
      this.endpoint = undefined;
      throw new Error("Tunnel failed to start");
    }
    return this.status();
  }

  public async stop(): Promise<void> {
    if (!this.enabled) {
      this.state = "DISABLED";
      this.endpoint = undefined;
      return;
    }
    await this.provider.stop();
    this.state = "LOCAL_ONLY";
    this.endpoint = undefined;
  }

  public async status(): Promise<TunnelStatus> {
    return {
      state: this.state,
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
    };
  }
}

export function createTunnelManager(remote: RemoteSettings): TunnelManager {
  const provider = remote.enabled
    ? new ManualEndpointProvider(remote.endpoint)
    : new NullTunnelProvider();
  return new TunnelManager(provider, remote.enabled);
}
