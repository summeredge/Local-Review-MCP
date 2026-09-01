import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isIP } from "node:net";
import type { ConnectionState, TunnelInfo, TunnelProvider, TunnelStatus } from "./types.js";

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;

export interface CloudflareTunnelOptions {
  readonly localEndpoint?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly command?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: typeof defaultSpawn;
  readonly readyTimeoutMs?: number;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  const address = isIP(host);
  return address === 4 && host.startsWith("127.");
}

function parseEndpoint(value: string, label: string): string {
  const endpoint = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${label} must be a public HTTPS URL`);
  }
  if (parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || isLoopbackHost(parsed.hostname)) {
    throw new Error(`${label} must be a public HTTPS URL`);
  }
  return endpoint;
}

function parseToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "" || /\s/u.test(value)) {
    throw new Error("CLOUDFLARE_TUNNEL_TOKEN must be a non-empty token without whitespace");
  }
  return value;
}

function outputText(chunk: string | Buffer): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function findEndpoint(output: string): string | undefined {
  const candidates = output.match(/https:\/\/[^\s"'<>]+/giu) ?? [];
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[),.;\]}]+$/u, "");
    try {
      return parseEndpoint(trimmed, "Cloudflare tunnel endpoint");
    } catch {
      continue;
    }
  }
  return undefined;
}

export class CloudflareTunnelProvider implements TunnelProvider {
  private readonly command: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: typeof defaultSpawn;
  private readonly localEndpoint: string | undefined;
  private readonly configuredEndpoint: string | undefined;
  private readonly token: string | undefined;
  private readonly readyTimeoutMs: number;
  private child: ChildProcess | undefined;
  private starting: Promise<TunnelInfo> | undefined;
  private cancelStart: (() => void) | undefined;
  private state: ConnectionState = "STOPPED";
  private endpoint: string | undefined;

  public constructor(options: CloudflareTunnelOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.command = options.command ?? this.environment.CLOUDFLARED_PATH ?? "cloudflared";
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.localEndpoint = options.localEndpoint;
    const endpoint = options.endpoint === undefined || options.endpoint.trim() === ""
      ? this.environment.CLOUDFLARE_TUNNEL_ENDPOINT
      : options.endpoint;
    this.configuredEndpoint = endpoint === undefined || endpoint.trim() === ""
      ? undefined
      : parseEndpoint(endpoint, "Cloudflare tunnel endpoint");
    this.token = parseToken(options.token ?? this.environment.CLOUDFLARE_TUNNEL_TOKEN);
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (!Number.isInteger(this.readyTimeoutMs) || this.readyTimeoutMs < 1) {
      throw new Error("Cloudflare tunnel ready timeout must be a positive integer");
    }
    if (this.localEndpoint !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(this.localEndpoint);
      } catch {
        throw new Error("Cloudflare tunnel local endpoint must be a valid HTTP(S) URL");
      }
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username !== ""
        || parsed.password !== "") {
        throw new Error("Cloudflare tunnel local endpoint must be a valid HTTP(S) URL");
      }
    }
  }

  private args(): string[] {
    if (this.token !== undefined) return ["tunnel", "run", "--token", this.token];
    if (this.configuredEndpoint !== undefined) {
      throw new Error("CLOUDFLARE_TUNNEL_TOKEN is required when a remote endpoint is configured");
    }
    if (this.localEndpoint === undefined) {
      throw new Error("Cloudflare tunnel local endpoint is required when no tunnel token is configured");
    }
    return ["tunnel", "--url", this.localEndpoint];
  }

  public start(): Promise<TunnelInfo> {
    if (this.state === "REMOTE_READY" && this.child !== undefined && this.endpoint !== undefined) {
      return Promise.resolve({ endpoint: this.endpoint });
    }
    if (this.starting !== undefined) return this.starting;

    this.state = "REMOTE_STARTING";
    this.endpoint = undefined;
    let args: string[];
    try {
      args = this.args();
    } catch (error: unknown) {
      this.state = "REMOTE_ERROR";
      return Promise.reject(error instanceof Error ? error : new Error("Invalid Cloudflare tunnel configuration"));
    }
    const promise = new Promise<TunnelInfo>((resolve, reject) => {
      let child: ChildProcess | undefined;
      let output = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const clearReadyTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
      };

      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearReadyTimer();
        if (this.child === child) {
          this.child = undefined;
          this.endpoint = undefined;
          this.state = "REMOTE_ERROR";
        }
        reject(new Error(message));
      };

      const ready = (endpoint: string): void => {
        if (settled || child === undefined || this.child !== child) return;
        settled = true;
        clearReadyTimer();
        this.endpoint = endpoint;
        this.state = "REMOTE_READY";
        resolve({ endpoint });
      };

      const inspectOutput = (chunk: string | Buffer): void => {
        if (this.configuredEndpoint !== undefined) return;
        output = (output + outputText(chunk)).slice(-MAX_PROCESS_OUTPUT_BYTES);
        const discovered = findEndpoint(output);
        if (discovered !== undefined) ready(discovered);
      };

      const onError = (): void => {
        if (settled) {
          if (this.child === child) {
            this.child = undefined;
            this.endpoint = undefined;
            this.state = "REMOTE_ERROR";
          }
          return;
        }
        fail("Cloudflare tunnel process failed to start");
      };

      const onClose = (): void => {
        if (!settled) {
          fail("Cloudflare tunnel exited before becoming ready");
          return;
        }
        if (this.child === child) {
          this.child = undefined;
          this.endpoint = undefined;
          this.state = "REMOTE_ERROR";
        }
      };

      const onSpawn = (): void => {
        if (this.configuredEndpoint !== undefined) {
          ready(this.configuredEndpoint);
          return;
        }
        const discovered = findEndpoint(output);
        if (discovered !== undefined) {
          ready(discovered);
          return;
        }
        timer = setTimeout(() => {
          if (child !== undefined) child.kill();
          fail("Cloudflare tunnel did not report a remote HTTPS endpoint");
        }, this.readyTimeoutMs);
      };

      try {
        child = this.spawnProcess(this.command, args, {
          env: { ...this.environment, NO_COLOR: "1" },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        } satisfies SpawnOptions);
        this.child = child;
        child.stdout?.on("data", inspectOutput);
        child.stderr?.on("data", inspectOutput);
        child.once("error", onError);
        child.once("close", onClose);
        child.once("spawn", onSpawn);
      } catch {
        fail("Cloudflare tunnel process failed to start");
      }

      this.cancelStart = () => fail("Cloudflare tunnel stopped");
    });

    this.starting = promise;
    promise.then(
      () => {
        if (this.starting === promise) this.starting = undefined;
        this.cancelStart = undefined;
      },
      () => {
        if (this.starting === promise) this.starting = undefined;
        this.cancelStart = undefined;
      },
    );
    return promise;
  }

  public async stop(): Promise<void> {
    this.cancelStart?.();
    this.cancelStart = undefined;
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    this.state = "STOPPED";
    if (child !== undefined && !child.killed) child.kill();
  }

  public async status(): Promise<TunnelStatus> {
    return {
      state: this.state,
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
    };
  }
}

export { CloudflareTunnelProvider as CloudflareProvider };
