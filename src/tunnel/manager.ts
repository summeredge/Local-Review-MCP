import type { RemoteSettings } from "../config/settings.js";
import { CloudflareTunnelProvider, type CloudflareTunnelOptions } from "./cloudflare.js";
import type { ConnectionState, TunnelInfo, TunnelProvider, TunnelStatus } from "./types.js";

export class NullTunnelProvider implements TunnelProvider {
  public async start(): Promise<TunnelInfo> {
    return { endpoint: "" };
  }

  public async stop(): Promise<void> {}

  public async status(): Promise<TunnelStatus> {
    return { state: "LOCAL_ONLY" };
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
      : { state: "STOPPED" };
  }
}

export interface TunnelManagerOptions {
  readonly localEndpoint?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cloudflare?: Pick<CloudflareTunnelOptions, "command" | "spawn" | "readyTimeoutMs">;
}

export class TunnelManager {
  private state: ConnectionState;
  private endpoint: string | undefined;

  public constructor(
    private readonly provider: TunnelProvider,
    private readonly enabled: boolean,
  ) {
    this.state = "LOCAL_ONLY";
  }

  public async start(): Promise<TunnelStatus> {
    if (!this.enabled) {
      this.state = "LOCAL_ONLY";
      this.endpoint = undefined;
      return this.status();
    }

    this.state = "REMOTE_STARTING";
    this.endpoint = undefined;
    try {
      const info = await this.provider.start();
      if (typeof info.endpoint !== "string" || info.endpoint.trim() === "") {
        throw new Error("Tunnel provider did not return an endpoint");
      }
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
      this.state = "LOCAL_ONLY";
      this.endpoint = undefined;
      return;
    }
    try {
      await this.provider.stop();
      this.state = "STOPPED";
      this.endpoint = undefined;
    } catch {
      this.state = "REMOTE_ERROR";
      this.endpoint = undefined;
      throw new Error("Tunnel failed to stop");
    }
  }

  public async status(): Promise<TunnelStatus> {
    try {
      const providerStatus = await this.provider.status();
      if (this.enabled
        && (this.state === "REMOTE_STARTING" || this.state === "REMOTE_READY")
        && providerStatus.state === "REMOTE_ERROR") {
        this.state = "REMOTE_ERROR";
        this.endpoint = undefined;
      }
    } catch {
      if (this.enabled) {
        this.state = "REMOTE_ERROR";
        this.endpoint = undefined;
      }
    }
    return {
      state: this.state,
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
    };
  }
}

export function createTunnelManager(
  remote: RemoteSettings,
  options: TunnelManagerOptions = {},
): TunnelManager {
  if (!remote.enabled) return new TunnelManager(new NullTunnelProvider(), false);
  if (remote.provider !== "cloudflare") {
    throw new Error("remote.provider must be cloudflare when remote is enabled");
  }
  const provider = new CloudflareTunnelProvider({
    localEndpoint: options.localEndpoint,
    endpoint: remote.endpoint,
    environment: options.environment,
    ...options.cloudflare,
  });
  return new TunnelManager(provider, remote.enabled);
}
