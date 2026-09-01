import { basename } from "node:path";
import {
  DEFAULT_HEALTH_INTERVAL_SECONDS,
  DEFAULT_MAX_RESTART_ATTEMPTS,
  HEALTH_PATH,
  localOrigin,
  type ResolvedSettings,
} from "../config/settings.js";
import { createTunnelManager } from "../tunnel/manager.js";
import { HealthMonitor } from "./health-monitor.js";
import { FileSupervisorLogger, NullSupervisorLogger, defaultLogDirectory } from "./logger.js";
import { ProcessManager } from "./process-manager.js";
import { RuntimeStateStore, type RuntimeState } from "./state.js";
import type {
  HealthMonitorLike,
  RuntimeProcessExitListener,
  RuntimeProcessManager,
  SupervisorLogger,
  SupervisorOptions,
  SupervisorStatus,
  SupervisorTunnel,
} from "./types.js";

export interface SupervisorFactoryOptions {
  readonly processManager?: RuntimeProcessManager;
  readonly healthMonitor?: HealthMonitorLike;
  readonly tunnel?: SupervisorTunnel;
  readonly logger?: SupervisorLogger;
  readonly logDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeCommand?: string;
  readonly runtimeScript?: string;
  readonly runtimeArgs?: readonly string[];
}

export type SupervisorStateListener = (state: RuntimeState) => void;

function workspaceLabel(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return basename(normalized === "" ? "workspace" : normalized) || "workspace";
}

export class Supervisor {
  private readonly stateStore = new RuntimeStateStore();
  private readonly processManager: RuntimeProcessManager;
  private readonly healthMonitor: HealthMonitorLike;
  private readonly tunnel: SupervisorTunnel;
  private readonly logger: SupervisorLogger;
  private readonly workspace: string;
  private readonly logDirectoryValue: string | undefined;
  private readonly maxRestartAttempts: number;
  private readonly stateListeners = new Set<SupervisorStateListener>();
  private removeExitListener: (() => void) | undefined;
  private lifecycle: Promise<void> | undefined;
  private recovery: Promise<void> | undefined;
  private runtimeStarted = false;
  private tunnelStarted = false;
  private lastTunnelState: string | undefined;
  private restartAttempts = 0;
  private healthFailures = 0;

  public constructor(options: SupervisorOptions) {
    if (!Number.isSafeInteger(options.maxRestartAttempts) || options.maxRestartAttempts < 0) {
      throw new Error("Supervisor max restart attempts must be a non-negative integer");
    }
    this.processManager = options.processManager;
    this.healthMonitor = options.healthMonitor;
    this.tunnel = options.tunnel;
    this.logger = options.logger ?? new NullSupervisorLogger();
    this.workspace = workspaceLabel(options.workspace ?? "workspace");
    this.logDirectoryValue = options.logDirectory;
    this.maxRestartAttempts = options.maxRestartAttempts;
    if (this.processManager.onExit !== undefined) {
      const listener: RuntimeProcessExitListener = () => this.handleRuntimeExit();
      this.removeExitListener = this.processManager.onExit(listener);
    }
  }

  public get state(): RuntimeState {
    return this.stateStore.value;
  }

  public get logDirectory(): string | undefined {
    return this.logDirectoryValue;
  }

  public onStateChange(listener: SupervisorStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public async start(): Promise<SupervisorStatus> {
    if (this.state === "RUNNING") return this.status();
    if (this.state === "STOPPING") throw new Error("Supervisor is stopping");
    if (this.lifecycle !== undefined) {
      await this.lifecycle;
      return this.status();
    }
    if (this.recovery !== undefined) {
      await this.recovery;
      if (this.stateStore.value === "RUNNING") return this.status();
    }

    const operation = this.startInternal();
    this.lifecycle = operation;
    try {
      await operation;
      return this.status();
    } finally {
      if (this.lifecycle === operation) this.lifecycle = undefined;
    }
  }

  public async stop(): Promise<SupervisorStatus> {
    if (this.state === "STOPPED") return this.status();
    if (this.lifecycle !== undefined) await this.lifecycle.catch(() => undefined);
    if (this.recovery !== undefined) await this.recovery.catch(() => undefined);

    this.setState("STOPPING");
    this.healthMonitor.stop();
    let failure = false;
    try {
      await this.stopResources();
    } catch {
      failure = true;
    }
    this.restartAttempts = 0;
    this.healthFailures = 0;
    this.setState(failure ? "ERROR" : "STOPPED");
    if (failure) throw new Error("Supervisor failed to stop");
    return this.status();
  }

  public async restart(): Promise<SupervisorStatus> {
    await this.stop();
    return this.start();
  }

  public async status(): Promise<SupervisorStatus> {
    let tunnel: { state: string; endpoint?: string } = { state: "UNKNOWN" };
    try {
      tunnel = await this.tunnel.status();
    } catch {
      tunnel = { state: "ERROR" };
    }
    const process = this.processManager.status();
    return {
      state: this.state,
      workspace: this.workspace,
      ...(process.pid === undefined ? {} : { pid: process.pid }),
      restartAttempts: this.restartAttempts,
      maxRestartAttempts: this.maxRestartAttempts,
      healthFailures: this.healthFailures,
      tunnel,
    };
  }

  public dispose(): void {
    this.removeExitListener?.();
    this.removeExitListener = undefined;
    this.healthMonitor.stop();
  }

  private setState(state: RuntimeState): void {
    if (this.stateStore.value === state) return;
    this.stateStore.set(state);
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // UI observers must not affect runtime lifecycle management.
      }
    }
  }

  private async startInternal(): Promise<void> {
    this.restartAttempts = 0;
    this.healthFailures = 0;
    this.setState("STARTING");
    try {
      await this.startResources();
      this.healthMonitor.start((healthy) => this.handleHealth(healthy));
    } catch {
      await this.stopResources().catch(() => undefined);
      this.setState("ERROR");
      throw new Error("Supervisor failed to start");
    }
  }

  private async startResources(): Promise<void> {
    this.setState("STARTING");
    const process = await this.processManager.start().catch(() => {
      throw new Error("Runtime process failed to start");
    });
    if (!process.running) throw new Error("Runtime process failed to start");
    this.runtimeStarted = true;
    this.logger.info("runtime started");

    if (!await this.healthMonitor.check()) {
      this.healthFailures += 1;
      this.setState("DEGRADED");
      this.logger.info("health failed");
      throw new Error("Runtime health check failed");
    }

    await this.tunnel.start().catch(() => {
      throw new Error("Tunnel failed to start");
    });
    this.tunnelStarted = true;
    await this.recordTunnelState();
    this.restartAttempts = 0;
    this.healthFailures = 0;
    this.setState("RUNNING");
  }

  private async stopResources(): Promise<void> {
    this.healthMonitor.stop();
    let failure = false;

    const shouldStopTunnel = this.tunnelStarted;
    this.tunnelStarted = false;
    if (shouldStopTunnel) {
      try {
        await this.tunnel.stop();
      } catch {
        failure = true;
      }
      await this.recordTunnelState();
    }

    const shouldStopRuntime = this.runtimeStarted || this.processManager.status().running;
    this.runtimeStarted = false;
    if (shouldStopRuntime) {
      try {
        await this.processManager.stop();
      } catch {
        failure = true;
      }
      this.logger.info("runtime stopped");
    }

    if (failure) throw new Error("Supervisor failed to stop");
  }

  private async handleHealth(healthy: boolean): Promise<void> {
    if (this.state !== "RUNNING" && this.state !== "DEGRADED") return;
    if (healthy) {
      this.healthFailures = 0;
      this.restartAttempts = 0;
      this.setState("RUNNING");
      return;
    }

    this.healthFailures += 1;
    this.setState("DEGRADED");
    this.logger.info("health failed");
    if (this.recovery !== undefined) return;
    if (this.restartAttempts >= this.maxRestartAttempts) {
      await this.enterError();
      return;
    }

    const recovery = this.recover();
    this.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.recovery === recovery) this.recovery = undefined;
    }
  }

  private async recover(): Promise<void> {
    this.restartAttempts += 1;
    this.logger.info("restart triggered");
    await this.stopResources().catch(() => undefined);
    try {
      await this.startResources();
      this.healthMonitor.start((healthy) => this.handleHealth(healthy));
    } catch {
      await this.stopResources().catch(() => undefined);
      this.setState(this.restartAttempts >= this.maxRestartAttempts ? "ERROR" : "DEGRADED");
      if (this.state === "ERROR") this.healthMonitor.stop();
    }
  }

  private async enterError(): Promise<void> {
    this.healthMonitor.stop();
    await this.stopResources().catch(() => undefined);
    this.setState("ERROR");
  }

  private handleRuntimeExit(): void {
    if (!this.runtimeStarted || this.state === "STOPPED" || this.state === "STOPPING") return;
    this.runtimeStarted = false;
    this.logger.info("runtime stopped");
    void this.handleHealth(false).catch(() => undefined);
  }

  private async recordTunnelState(): Promise<void> {
    try {
      const status = await this.tunnel.status();
      if (this.lastTunnelState !== status.state) {
        this.lastTunnelState = status.state;
        this.logger.info("tunnel state changed");
      }
    } catch {
      // Tunnel status is reflected in status(); it is not allowed to break cleanup.
    }
  }
}

export function createSupervisor(
  settings: ResolvedSettings,
  options: SupervisorFactoryOptions = {},
): Supervisor {
  const supervisor = settings.supervisor ?? {
    enabled: false,
    healthIntervalSeconds: DEFAULT_HEALTH_INTERVAL_SECONDS,
    maxRestartAttempts: DEFAULT_MAX_RESTART_ATTEMPTS,
  };
  const environment = options.environment ?? process.env;
  const runtimeScript = options.runtimeScript ?? process.argv[1] ?? "local-review-mcp";
  const runtimeArgs = options.runtimeArgs ?? [
    runtimeScript,
    "--runtime",
    "--port",
    String(settings.port),
    "--workspace",
    settings.workspace,
  ];
  const logDirectory = options.logDirectory ?? defaultLogDirectory(environment);
  const logger = options.logger ?? new FileSupervisorLogger(logDirectory);
  const processManager = options.processManager ?? new ProcessManager({
    command: options.runtimeCommand ?? process.execPath,
    args: runtimeArgs,
    environment: { ...environment, LOCAL_REVIEW_MCP_TOKEN: settings.auth.token },
  });
  const healthMonitor = options.healthMonitor ?? new HealthMonitor({
    healthUrl: `${localOrigin(settings)}${HEALTH_PATH}`,
    intervalSeconds: supervisor.healthIntervalSeconds,
    authToken: settings.auth.token,
  });
  const tunnel = options.tunnel ?? createTunnelManager(settings.remote, {
    localEndpoint: localOrigin(settings),
    environment,
  });
  return new Supervisor({
    processManager,
    healthMonitor,
    tunnel,
    logger,
    logDirectory,
    maxRestartAttempts: supervisor.maxRestartAttempts,
    workspace: settings.workspace,
  });
}
