import { existsSync } from "node:fs";
import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isIP } from "node:net";
import { win32 as win32Path } from "node:path";
import type { ConnectionState, TunnelInfo, TunnelProvider, TunnelStatus } from "./types.js";

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const STOP_TIMEOUT_MS = 5_000;

export interface CloudflareTunnelOptions {
  readonly localEndpoint?: string;
  readonly endpoint?: string;
  readonly tunnelName?: string;
  readonly token?: string;
  readonly command?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
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

function parseTunnelName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (name === "" || /\s/u.test(name)) {
    throw new Error("Cloudflare tunnel name must be non-empty and without whitespace");
  }
  return name;
}

function outputText(chunk: string | Buffer): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function hasReadySignal(output: string): boolean {
  const normalized = output.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, " ");
  return [
    /\bregistered\s+tunnel\s+connection\b/iu,
    /\btunnel\s+connection\b[^\r\n]*\b(?:registered|connected|established)\b/iu,
    /\bconnection\b[^\r\n]*\b(?:registered|connected|established)\b/iu,
    /\bconnected\b[^\r\n]*\b(?:cloudflare|edge|tunnel)\b/iu,
    /\btunnel\b[^\r\n]*\b(?:started|running|ready|connected|established)\b/iu,
  ].some((pattern) => pattern.test(normalized));
}

function lastErrorLine(output: string): string | undefined {
  return output.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\b(?:error|err|failed|fatal|timeout|unable)\b/iu.test(line))
    .at(-1);
}

function commandLine(command: string, args: readonly string[]): string {
  const safeArgs = args.map((arg, index) => args[index - 1] === "--token" ? "<redacted>" : arg);
  return [command, ...safeArgs].map((value) => JSON.stringify(value)).join(" ");
}

function terminate(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      child.removeListener("close", finish);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    child.once("close", finish);
    child.once("exit", finish);
    child.once("error", finish);
    timer = setTimeout(finish, STOP_TIMEOUT_MS);
    try {
      if (!child.killed) child.kill();
    } catch {
      finish();
    }
  });
}

function resolveCommand(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  configured?: string,
): string {
  if (configured !== undefined) return configured;
  const environmentPath = environment.CLOUDFLARED_PATH?.trim();
  if (environmentPath !== undefined && environmentPath !== "") return environmentPath;
  if (platform !== "win32") return "cloudflared";

  const candidates = [
    environment.ProgramW6432,
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
  ].filter((value): value is string => value !== undefined && value !== "")
    .map((directory) => win32Path.join(directory, "cloudflared", "cloudflared.exe"));
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData !== "") {
    candidates.push(win32Path.join(localAppData, "cloudflared", "cloudflared.exe"));
  }
  const userProfile = environment.USERPROFILE;
  if (userProfile !== undefined && userProfile !== "") {
    candidates.push(win32Path.join(userProfile, ".local", "bin", "cloudflared.exe"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? "cloudflared";
}

export class CloudflareTunnelProvider implements TunnelProvider {
  private readonly command: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: typeof defaultSpawn;
  private readonly platform: NodeJS.Platform;
  private readonly localEndpoint: string | undefined;
  private readonly configuredEndpoint: string | undefined;
  private readonly tunnelName: string | undefined;
  private readonly token: string | undefined;
  private readonly readyTimeoutMs: number;
  private child: ChildProcess | undefined;
  private starting: Promise<TunnelInfo> | undefined;
  private cancelStart: (() => void) | undefined;
  private state: ConnectionState = "STOPPED";
  private endpoint: string | undefined;

  public constructor(options: CloudflareTunnelOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.command = resolveCommand(this.environment, this.platform, options.command);
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.localEndpoint = options.localEndpoint;
    const endpoint = options.endpoint === undefined || options.endpoint.trim() === ""
      ? this.environment.CLOUDFLARE_TUNNEL_ENDPOINT
      : options.endpoint;
    this.configuredEndpoint = endpoint === undefined || endpoint.trim() === ""
      ? undefined
      : parseEndpoint(endpoint, "Cloudflare tunnel endpoint");
    this.tunnelName = parseTunnelName(options.tunnelName);
    this.token = parseToken(options.token ?? this.environment.CLOUDFLARE_TUNNEL_TOKEN);
    if (this.tunnelName !== undefined && this.token !== undefined) {
      throw new Error("Cloudflare tunnel configuration invalid: token and tunnelName cannot both be set");
    }
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
    if (this.configuredEndpoint === undefined) {
      throw new Error("Cloudflare tunnel endpoint is required");
    }
    if (this.tunnelName !== undefined) {
      if (this.localEndpoint === undefined) {
        throw new Error("Cloudflare tunnel local endpoint is required for a named tunnel");
      }
      return ["tunnel", "--no-autoupdate", "--url", this.localEndpoint, "run", this.tunnelName];
    }
    if (this.token !== undefined) return ["tunnel", "--no-autoupdate", "run", "--token", this.token];
    throw new Error("Cloudflare tunnel name or CLOUDFLARE_TUNNEL_TOKEN is required");
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
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let exitCode: number | null | undefined;
      let exitSignal: NodeJS.Signals | null | undefined;

      const clearReadyTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
      };

      const fail = (message: string, cause?: unknown): void => {
        if (settled) return;
        settled = true;
        clearReadyTimer();
        if (this.child === child) {
          this.child = undefined;
          this.endpoint = undefined;
          this.state = "REMOTE_ERROR";
        }
        if (child !== undefined && !child.killed) {
          try {
            child.kill();
          } catch {
            // The original startup error is more useful than a cleanup error.
          }
        }
        const lastError = lastErrorLine(stderr) ?? lastErrorLine(stdout);
        const originalError = cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
        const details = [
          `Cloudflare tunnel failed: ${message}`,
          `command: ${commandLine(this.command, args)}`,
          `exit code: ${exitCode === undefined ? "not available" : String(exitCode)}`,
          `signal: ${exitSignal ?? "none"}`,
          `last error: ${lastError ?? "none reported"}`,
          `original error: ${originalError ?? "none"}`,
          `stderr:\n${stderr.trim() || "(empty)"}`,
          `stdout:\n${stdout.trim() || "(empty)"}`,
        ].join("\n");
        reject(cause === undefined ? new Error(details) : new Error(details, { cause }));
      };

      const ready = (endpoint: string): void => {
        if (settled || child === undefined || this.child !== child) return;
        settled = true;
        clearReadyTimer();
        this.endpoint = endpoint;
        this.state = "REMOTE_READY";
        resolve({ endpoint });
      };

      const inspectOutput = (stream: "stdout" | "stderr", chunk: string | Buffer): void => {
        const value = outputText(chunk);
        if (stream === "stdout") stdout = (stdout + value).slice(-MAX_PROCESS_OUTPUT_BYTES);
        else stderr = (stderr + value).slice(-MAX_PROCESS_OUTPUT_BYTES);
        if (this.configuredEndpoint !== undefined && hasReadySignal(`${stdout}\n${stderr}`)) {
          ready(this.configuredEndpoint);
        }
      };

      const onError = (error: unknown): void => {
        if (settled) {
          if (this.child === child) {
            this.child = undefined;
            this.endpoint = undefined;
            this.state = "REMOTE_ERROR";
          }
          return;
        }
        fail("cloudflared process error", error);
      };

      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        exitCode = code;
        exitSignal = signal;
        if (!settled) {
          fail("cloudflared exited before registering a tunnel connection");
          return;
        }
        if (this.child === child) {
          this.child = undefined;
          this.endpoint = undefined;
          this.state = "REMOTE_ERROR";
        }
      };

      const onSpawn = (): void => {
        if (settled) return;
        if (this.configuredEndpoint !== undefined && hasReadySignal(`${stdout}\n${stderr}`)) {
          ready(this.configuredEndpoint);
          return;
        }
        timer = setTimeout(() => {
          fail("timed out waiting for a registered tunnel connection");
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
        child.stdout?.on("data", (chunk) => inspectOutput("stdout", chunk));
        child.stderr?.on("data", (chunk) => inspectOutput("stderr", chunk));
        child.once("error", onError);
        child.once("close", onClose);
        child.once("spawn", onSpawn);
      } catch (error: unknown) {
        fail("cloudflared process failed to spawn", error);
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
    const child = this.child;
    this.cancelStart?.();
    this.cancelStart = undefined;
    this.child = undefined;
    this.endpoint = undefined;
    this.state = "STOPPED";
    if (child !== undefined) await terminate(child);
  }

  public async status(): Promise<TunnelStatus> {
    return {
      state: this.state,
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
    };
  }
}

export { CloudflareTunnelProvider as CloudflareProvider };
