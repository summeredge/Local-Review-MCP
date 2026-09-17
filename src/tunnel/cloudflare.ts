import { existsSync } from "node:fs";
import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { win32 as win32Path } from "node:path";
import { HEALTH_PATH, SERVICE_NAME } from "../config/settings.js";
import type { ConnectionState, TunnelInfo, TunnelProvider, TunnelStatus } from "./types.js";

const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 20_000;
const HTTP2_TUNNEL_READY_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const STOP_TIMEOUT_MS = 5_000;
const REMOTE_HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const REMOTE_HEALTH_RETRY_DELAY_MS = 250;
const MAX_REMOTE_HEALTH_RESPONSE_BYTES = 16 * 1024;

export interface CloudflareTunnelOptions {
  readonly localEndpoint?: string;
  readonly endpoint?: string;
  readonly tunnelName?: string;
  readonly token?: string;
  readonly command?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof defaultSpawn;
  readonly protocol?: CloudflareTunnelProtocol;
  readonly readyTimeoutMs?: number;
  readonly healthAuthToken?: string;
  readonly healthCheck?: (endpoint: string) => Promise<boolean>;
}

export type CloudflareTunnelProtocol = "auto" | "http2";

interface TunnelAttemptFailure {
  readonly protocol: CloudflareTunnelProtocol;
  readonly args: readonly string[];
  readonly reason: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null | undefined;
  readonly exitSignal: NodeJS.Signals | null | undefined;
  readonly cause?: unknown;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isValidServiceHealth(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const health = payload as Record<string, unknown>;
  return health.service === SERVICE_NAME && health.status === "ok";
}

function requestPublicHealth(endpoint: string, authToken: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpsRequest(new URL(endpoint), {
      method: "GET",
      timeout: REMOTE_HEALTH_REQUEST_TIMEOUT_MS,
      ...(authToken === undefined ? {} : { headers: { authorization: `Bearer ${authToken}` } }),
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(false);
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > MAX_REMOTE_HEALTH_RESPONSE_BYTES) {
          response.destroy();
          resolve(false);
        }
      });
      response.on("error", () => resolve(false));
      response.on("end", () => {
        if (text.length <= MAX_REMOTE_HEALTH_RESPONSE_BYTES) {
          try {
            resolve(isValidServiceHealth(JSON.parse(text) as unknown));
          } catch {
            resolve(false);
          }
        }
      });
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

function hasReadySignal(output: string): boolean {
  const normalized = output.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, " ");
  return /\bregistered\s+tunnel\s+connection\b/iu.test(normalized);
}

function hasRetryableConnectionError(output: string): boolean {
  return [
    /failed\s+to\s+dial\s+a\s+quic\s+connection/iu,
    /tls\s+handshake\s+with\s+edge\s+error:\s*eof/iu,
    /quic\s+connection\s+failed/iu,
    /http\/?2\s+connection\s+(?:is\s+)?(?:blocked|unreachable)/iu,
  ].some((pattern) => pattern.test(output));
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

function formatAttemptFailure(
  command: string,
  attempt: TunnelAttemptFailure,
  index: number,
): string {
  const lastError = lastErrorLine(attempt.stderr) ?? lastErrorLine(attempt.stdout);
  const originalError = attempt.cause instanceof Error
    ? attempt.cause.message
    : attempt.cause === undefined ? "none" : String(attempt.cause);
  return [
    `attempt ${index + 1} protocol=${attempt.protocol}`,
    `reason: ${attempt.reason}`,
    `command: ${commandLine(command, attempt.args)}`,
    `exit code: ${attempt.exitCode === undefined ? "not available" : String(attempt.exitCode)}`,
    `signal: ${attempt.exitSignal ?? "none"}`,
    `last error: ${lastError ?? "none reported"}`,
    `original error: ${originalError}`,
    `stderr:\n${attempt.stderr.trim() || "(empty)"}`,
    `stdout:\n${attempt.stdout.trim() || "(empty)"}`,
  ].join("\n");
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
  private readonly protocol: CloudflareTunnelProtocol;
  private readonly readyTimeoutMs: number;
  private readonly http2ReadyTimeoutMs: number;
  private readonly healthAuthToken: string | undefined;
  private readonly healthCheck: (endpoint: string) => Promise<boolean>;
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
    const configuredToken = parseToken(options.token);
    const environmentToken = parseToken(this.environment.CLOUDFLARE_TUNNEL_TOKEN);
    if (configuredToken !== undefined && environmentToken !== undefined
      && configuredToken !== environmentToken) {
      throw new Error("Cloudflare tunnel token configuration conflict");
    }
    this.token = configuredToken ?? environmentToken;
    if (this.tunnelName !== undefined && this.token !== undefined) {
      throw new Error("Cloudflare tunnel configuration invalid: token and tunnelName cannot both be set");
    }
    this.protocol = options.protocol ?? "auto";
    if (this.protocol !== "auto" && this.protocol !== "http2") {
      throw new Error("Cloudflare tunnel protocol must be auto or http2");
    }
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS;
    this.http2ReadyTimeoutMs = options.readyTimeoutMs ?? HTTP2_TUNNEL_READY_TIMEOUT_MS;
    if (!Number.isInteger(this.readyTimeoutMs) || this.readyTimeoutMs < 1) {
      throw new Error("Cloudflare tunnel ready timeout must be a positive integer");
    }
    this.healthAuthToken = options.healthAuthToken;
    this.healthCheck = options.healthCheck
      ?? ((endpoint: string) => requestPublicHealth(endpoint, this.healthAuthToken));
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

  private args(protocol: CloudflareTunnelProtocol = this.protocol): string[] {
    if (this.configuredEndpoint === undefined) {
      throw new Error("Cloudflare tunnel endpoint is required");
    }
    const protocolArgs = protocol === "http2" ? ["--protocol", "http2"] : [];
    if (this.tunnelName !== undefined) {
      return ["tunnel", "--no-autoupdate", "run", ...protocolArgs, this.tunnelName];
    }
    if (this.token !== undefined) {
      return ["tunnel", "--no-autoupdate", "run", ...protocolArgs, "--token", this.token];
    }
    throw new Error("Cloudflare tunnel name or CLOUDFLARE_TUNNEL_TOKEN is required");
  }

  public start(): Promise<TunnelInfo> {
    if (this.state === "REMOTE_READY" && this.child !== undefined && this.endpoint !== undefined) {
      return Promise.resolve({ endpoint: this.endpoint });
    }
    if (this.starting !== undefined) return this.starting;

    this.state = "REMOTE_STARTING";
    this.endpoint = undefined;
    const protocols: readonly CloudflareTunnelProtocol[] = this.protocol === "auto"
      ? ["auto", "http2"]
      : ["http2"];
    try {
      this.args(protocols[0]);
    } catch (error: unknown) {
      this.state = "REMOTE_ERROR";
      return Promise.reject(error instanceof Error ? error : new Error("Invalid Cloudflare tunnel configuration"));
    }
    console.log(`Cloudflare tunnel mode: ${this.tunnelName === undefined ? "token" : "named"}`);
    const healthUrl = this.configuredEndpoint === undefined
      ? undefined
      : new URL(HEALTH_PATH, this.configuredEndpoint).href;
    const promise = new Promise<TunnelInfo>((resolve, reject) => {
      let cancelled = false;
      let cancelAttempt: (() => void) | undefined;
      const failures: TunnelAttemptFailure[] = [];

      const runAttempt = (protocol: CloudflareTunnelProtocol): Promise<TunnelInfo> => {
        const args = this.args(protocol);
        let cancelCurrentAttempt: (() => void) | undefined;
        const attempt = new Promise<TunnelInfo>((resolveAttempt, rejectAttempt) => {
          let child: ChildProcess | undefined;
          let stdout = "";
          let stderr = "";
          let settled = false;
          let successful = false;
          let registered = false;
          let retryableErrorLogged = false;
          let timer: NodeJS.Timeout | undefined;
          let exitCode: number | null | undefined;
          let exitSignal: NodeJS.Signals | null | undefined;
          let healthPolling = false;

          const clearReadyTimer = (): void => {
            if (timer !== undefined) clearTimeout(timer);
          };

          const failAttempt = (reason: string, cause?: unknown, terminateChild = false): void => {
            if (settled) return;
            settled = true;
            clearReadyTimer();
            if (this.child === child) {
              this.child = undefined;
              this.endpoint = undefined;
            }
            const failure: TunnelAttemptFailure = {
              protocol,
              args,
              reason,
              stdout,
              stderr,
              exitCode,
              exitSignal,
              ...(cause === undefined ? {} : { cause }),
            };
            const finish = (): void => rejectAttempt(failure);
            if (terminateChild && child !== undefined && !child.killed) {
              void terminate(child).finally(finish);
            } else {
              finish();
            }
          };

          const ready = (): void => {
            if (settled || child === undefined || this.child !== child) return;
            settled = true;
            successful = true;
            clearReadyTimer();
            if (this.configuredEndpoint === undefined) return;
            this.endpoint = this.configuredEndpoint;
            this.state = "REMOTE_READY";
            resolveAttempt({ endpoint: this.configuredEndpoint });
          };

          const pollPublicHealth = async (): Promise<void> => {
            if (settled || healthPolling || healthUrl === undefined) return;
            if (this.configuredEndpoint === undefined) return;
            healthPolling = true;
            try {
              while (!settled) {
                if (this.child !== child) return;
                let healthy = false;
                try {
                  healthy = await this.healthCheck(healthUrl);
                } catch {
                  // A failed probe is an unavailable endpoint, not a settled tunnel.
                }
                if (healthy) {
                  ready();
                  return;
                }
                if (settled) return;
                await delay(REMOTE_HEALTH_RETRY_DELAY_MS);
              }
            } finally {
              healthPolling = false;
            }
          };

          const inspectOutput = (stream: "stdout" | "stderr", chunk: string | Buffer): void => {
            const value = outputText(chunk);
            if (stream === "stdout") stdout = (stdout + value).slice(-MAX_PROCESS_OUTPUT_BYTES);
            else stderr = (stderr + value).slice(-MAX_PROCESS_OUTPUT_BYTES);
            const output = `${stdout}\n${stderr}`;
            if (!retryableErrorLogged && hasRetryableConnectionError(output)) {
              retryableErrorLogged = true;
              console.warn("retryable tunnel connection error");
            }
            if (!registered && hasReadySignal(output)) {
              registered = true;
              void pollPublicHealth();
            }
          };

          const onError = (error: unknown): void => {
            if (settled) {
              if (successful && this.child === child) {
                this.child = undefined;
                this.endpoint = undefined;
                this.state = "REMOTE_ERROR";
              }
              return;
            }
            failAttempt("cloudflared process error", error, true);
          };

          const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
            exitCode = code;
            exitSignal = signal;
            if (!settled) {
              failAttempt(
                registered
                  ? "cloudflared exited before the public endpoint health check became ready"
                  : "cloudflared exited before registering a tunnel connection",
              );
              return;
            }
            if (successful && this.child === child) {
              this.child = undefined;
              this.endpoint = undefined;
              this.state = "REMOTE_ERROR";
            }
          };

          const startReadyTimer = (): void => {
            if (settled || timer !== undefined) return;
            const timeoutMs = protocol === "http2"
              ? this.http2ReadyTimeoutMs
              : this.readyTimeoutMs;
            timer = setTimeout(() => {
              failAttempt(
                registered
                  ? "timed out waiting for the public endpoint health check"
                  : "timed out waiting for a registered tunnel connection",
                undefined,
                true,
              );
            }, timeoutMs);
          };

          cancelCurrentAttempt = () => failAttempt("Cloudflare tunnel stopped");
          cancelAttempt = cancelCurrentAttempt;
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
            child.once("spawn", startReadyTimer);
            startReadyTimer();
          } catch (error: unknown) {
            failAttempt("cloudflared process failed to spawn", error);
          }
        });
        return attempt.finally(() => {
          if (cancelAttempt === cancelCurrentAttempt) cancelAttempt = undefined;
        });
      };

      void (async (): Promise<void> => {
        try {
          for (let index = 0; index < protocols.length; index += 1) {
            if (cancelled) throw new Error("Cloudflare tunnel stopped");
            const protocol = protocols[index];
            if (protocol === "auto") {
              console.log("Starting Cloudflare Tunnel (default protocol)");
            } else if (index > 0) {
              console.log("Starting Cloudflare Tunnel with HTTP/2 fallback");
            } else {
              console.log("Starting Cloudflare Tunnel with HTTP/2");
            }
            try {
              const info = await runAttempt(protocol);
              if (cancelled) throw new Error("Cloudflare tunnel stopped");
              console.log(`Cloudflare Tunnel registered successfully protocol=${protocol}`);
              resolve(info);
              return;
            } catch (error: unknown) {
              if (cancelled) throw new Error("Cloudflare tunnel stopped", { cause: error });
              const failure = error as TunnelAttemptFailure;
              failures.push(failure);
              if (index + 1 < protocols.length) {
                console.log("Cloudflare Tunnel default protocol failed, retrying with HTTP/2");
              }
            }
          }
          this.child = undefined;
          this.endpoint = undefined;
          this.state = "REMOTE_ERROR";
          console.log("Cloudflare Tunnel startup failed after fallback attempts");
          const details = [
            "Cloudflare tunnel failed: startup failed after fallback attempts",
            ...failures.map((failure, index) => formatAttemptFailure(this.command, failure, index)),
          ].join("\n");
          const cause = failures.at(-1)?.cause;
          reject(cause === undefined ? new Error(details) : new Error(details, { cause }));
        } catch (error: unknown) {
          if (cancelled) {
            reject(error instanceof Error ? error : new Error("Cloudflare tunnel stopped"));
            return;
          }
          this.child = undefined;
          this.endpoint = undefined;
          this.state = "REMOTE_ERROR";
          reject(error instanceof Error ? error : new Error("Cloudflare tunnel failed to start"));
        }
      })();

      this.cancelStart = () => {
        cancelled = true;
        cancelAttempt?.();
      };
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
