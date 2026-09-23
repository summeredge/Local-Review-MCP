import { z } from "zod";
import type { DesktopInteractiveReadiness } from "../desktop-codex/desktop-interactive-preflight.js";
import {
  executionBackendStartRequestSchema,
  type ExecutionBackend,
  type ExecutionBackendStartRequest,
  type ExecutionStartResult,
  type ExecutionTerminalListener,
} from "./execution-service.js";

export const capabilityStateSchema = z.enum([
  "initializing",
  "desktop_pending",
  "desktop_ready",
  "desktop_failed",
  "fallback_ready",
  "fallback_running",
]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const capabilitySourceSchema = z.enum(["desktop", "standalone"]);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

export const capabilityActionSchema = z.enum(["retry", "standalone"]);
export type CapabilityAction = z.infer<typeof capabilityActionSchema>;

export type CapabilityFailureReason =
  | "desktop_disconnected"
  | "executor_identity_unavailable"
  | "desktop_tools_pipe_unavailable"
  | "desktop_handoff_failed"
  | "desktop_execution_failed"
  | "standalone_execution_failed";

export interface CapabilitySnapshot {
  readonly state: CapabilityState;
  readonly source: CapabilitySource | null;
  readonly reason: CapabilityFailureReason | null;
  readonly actions: readonly CapabilityAction[];
  readonly updatedAt: string;
}

export interface CapabilityPreparation {
  readonly ready: boolean;
  readonly reason?: CapabilityFailureReason;
}

export interface CapabilityProvider extends ExecutionBackend {
  readonly source: CapabilitySource;
  prepare(): Promise<CapabilityPreparation>;
  reset?(): void | Promise<void>;
}

export interface DesktopCapabilityProviderOptions {
  readonly backend: ExecutionBackend;
  readonly readiness: () => DesktopInteractiveReadiness;
  /** Existing DesktopBootstrapTrampoline handoff seam. */
  readonly trampolineHandoff?: () => void | Promise<void>;
  /** Existing SessionStart handoff seam used when the trampoline did not establish capability. */
  readonly sessionStartHandoff?: () => void | Promise<void>;
}

function readinessReason(readiness: DesktopInteractiveReadiness): CapabilityFailureReason {
  return readiness.reason ?? "desktop_tools_pipe_unavailable";
}

export class DesktopCapabilityProvider implements CapabilityProvider {
  public readonly source = "desktop" as const;
  private handoffAttempted = false;

  public constructor(private readonly options: DesktopCapabilityProviderOptions) {}

  public async prepare(): Promise<CapabilityPreparation> {
    let first: DesktopInteractiveReadiness;
    try {
      first = this.options.readiness();
    } catch {
      return { ready: false, reason: "desktop_handoff_failed" };
    }
    if (first.ready) return { ready: true };
    if (first.reason !== "desktop_tools_pipe_unavailable") {
      return { ready: false, reason: readinessReason(first) };
    }

    if (!this.handoffAttempted) {
      this.handoffAttempted = true;
      let handoffFailed = false;
      for (const handoff of [this.options.trampolineHandoff, this.options.sessionStartHandoff]) {
        if (handoff === undefined) continue;
        try {
          await handoff();
        } catch {
          handoffFailed = true;
        }
        let afterHandoff: DesktopInteractiveReadiness;
        try {
          afterHandoff = this.options.readiness();
        } catch {
          handoffFailed = true;
          continue;
        }
        if (afterHandoff.ready) return { ready: true };
        if (afterHandoff.reason !== "desktop_tools_pipe_unavailable") {
          return { ready: false, reason: readinessReason(afterHandoff) };
        }
      }
      if (handoffFailed) return { ready: false, reason: "desktop_handoff_failed" };
    }

    let latest: DesktopInteractiveReadiness;
    try {
      latest = this.options.readiness();
    } catch {
      return { ready: false, reason: "desktop_handoff_failed" };
    }
    return latest.ready
      ? { ready: true }
      : { ready: false, reason: readinessReason(latest) };
  }

  public reset(): void {
    this.handoffAttempted = false;
  }

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    return this.options.backend.start(request);
  }

  public setTerminalListener(listener: ExecutionTerminalListener | undefined): void {
    this.options.backend.setTerminalListener?.(listener);
  }

  public close(): Promise<void> {
    return this.options.backend.close?.() ?? Promise.resolve();
  }
}

export class StandaloneCapabilityProvider implements CapabilityProvider {
  public readonly source = "standalone" as const;

  public constructor(private readonly backend: ExecutionBackend) {}

  public prepare(): Promise<CapabilityPreparation> {
    return Promise.resolve({ ready: true });
  }

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    return this.backend.start(request);
  }

  public setTerminalListener(listener: ExecutionTerminalListener | undefined): void {
    this.backend.setTerminalListener?.(listener);
  }

  public close(): Promise<void> {
    return this.backend.close?.() ?? Promise.resolve();
  }
}

export interface CapabilityNegotiatorOptions {
  readonly desktop: CapabilityProvider;
  readonly standalone: CapabilityProvider;
  readonly desktopTimeoutMs?: number;
  readonly fallbackTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly onStateChanged?: (snapshot: CapabilitySnapshot) => void;
}

type DesktopWaitResult =
  | { readonly action: "ready" }
  | { readonly action: "retry" }
  | { readonly action: "standalone" }
  | { readonly action: "failed"; readonly reason: CapabilityFailureReason };

function requestKey(request: ExecutionBackendStartRequest): string {
  return `${request.workspace_id}\0${request.task_id}\0${request.execution_id}`;
}

function errorReason(source: CapabilitySource): CapabilityFailureReason {
  return source === "desktop" ? "desktop_execution_failed" : "standalone_execution_failed";
}

export class CapabilityNegotiator implements ExecutionBackend {
  private readonly desktop: CapabilityProvider;
  private readonly standalone: CapabilityProvider;
  private readonly desktopTimeoutMs: number;
  private readonly fallbackTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly onStateChanged: ((snapshot: CapabilitySnapshot) => void) | undefined;
  private readonly inFlight = new Map<string, Promise<ExecutionStartResult>>();
  private requestedAction: CapabilityAction | undefined;
  private snapshotValue: CapabilitySnapshot;

  public constructor(options: CapabilityNegotiatorOptions) {
    this.desktop = options.desktop;
    this.standalone = options.standalone;
    this.desktopTimeoutMs = options.desktopTimeoutMs ?? 30_000;
    this.fallbackTimeoutMs = options.fallbackTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onStateChanged = options.onStateChanged;
    this.snapshotValue = {
      state: "initializing",
      source: null,
      reason: null,
      actions: ["retry", "standalone"],
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  public snapshot(): CapabilitySnapshot {
    return this.snapshotValue;
  }

  public retryDesktop(): CapabilitySnapshot {
    this.requestedAction = "retry";
    this.setState("initializing", null, null, ["retry", "standalone"]);
    return this.snapshotValue;
  }

  public selectStandalone(): CapabilitySnapshot {
    this.requestedAction = "standalone";
    this.setState("fallback_ready", "standalone", null, ["retry"]);
    return this.snapshotValue;
  }

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const parsed = executionBackendStartRequestSchema.parse(request);
    const key = requestKey(parsed);
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending.then((result) => ({ ...result, accepted: "existing" as const }));

    const operation = this.startOnce(parsed);
    this.inFlight.set(key, operation);
    void operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  public setTerminalListener(listener: ExecutionTerminalListener | undefined): void {
    this.desktop.setTerminalListener?.(listener);
    this.standalone.setTerminalListener?.(listener);
  }

  public async close(): Promise<void> {
    await Promise.all([
      this.desktop.close?.(),
      this.standalone.close?.(),
    ]);
  }

  private async startOnce(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    if (this.consumeAction("standalone") === true) return this.startStandalone(request);

    while (true) {
      await this.desktop.reset?.();
      const result = await this.waitForDesktop();
      if (result.action === "standalone") return this.startStandalone(request);
      if (result.action === "retry") continue;
      if (result.action === "failed") {
        this.setState("desktop_failed", "desktop", result.reason, ["retry", "standalone"]);
        const choice = await this.waitForFallbackChoice();
        if (choice === "retry") continue;
        return this.startStandalone(request);
      }

      this.setState("desktop_ready", "desktop", null, []);
      try {
        return await this.desktop.start(request);
      } catch {
        this.setState("desktop_failed", "desktop", errorReason("desktop"), ["retry", "standalone"]);
        throw new Error("Desktop execution failed.");
      }
    }
  }

  private async waitForDesktop(): Promise<DesktopWaitResult> {
    this.setState("desktop_pending", "desktop", null, ["retry", "standalone"]);
    const deadline = this.now() + this.desktopTimeoutMs;
    while (true) {
      if (this.consumeAction("standalone") === true) return { action: "standalone" };
      if (this.consumeAction("retry") === true) return { action: "retry" };

      let preparation: CapabilityPreparation;
      try {
        preparation = await this.desktop.prepare();
      } catch {
        return { action: "failed", reason: "desktop_handoff_failed" };
      }
      if (preparation.ready) return { action: "ready" };
      if (preparation.reason !== "desktop_tools_pipe_unavailable") {
        return { action: "failed", reason: preparation.reason ?? "desktop_handoff_failed" };
      }
      if (this.consumeAction("standalone") === true) return { action: "standalone" };
      if (this.consumeAction("retry") === true) return { action: "retry" };
      const remaining = deadline - this.now();
      if (remaining <= 0) return { action: "failed", reason: "desktop_tools_pipe_unavailable" };
      await this.wait(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private async waitForFallbackChoice(): Promise<"retry" | "standalone"> {
    const deadline = this.now() + this.fallbackTimeoutMs;
    while (true) {
      if (this.consumeAction("retry") === true) return "retry";
      if (this.consumeAction("standalone") === true) return "standalone";
      const remaining = deadline - this.now();
      if (remaining <= 0) return "standalone";
      await this.wait(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private async startStandalone(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    this.requestedAction = undefined;
    this.setState("fallback_ready", "standalone", null, ["retry"]);
    this.setState("fallback_running", "standalone", null, []);
    try {
      return await this.standalone.start(request);
    } catch {
      this.setState("fallback_ready", "standalone", errorReason("standalone"), ["retry", "standalone"]);
      throw new Error("Standalone execution failed.");
    }
  }

  private consumeAction(action: CapabilityAction): boolean {
    if (this.requestedAction !== action) return false;
    this.requestedAction = undefined;
    return true;
  }

  private setState(
    state: CapabilityState,
    source: CapabilitySource | null,
    reason: CapabilityFailureReason | null,
    actions: readonly CapabilityAction[],
  ): void {
    this.snapshotValue = {
      state,
      source,
      reason,
      actions,
      updatedAt: new Date(this.now()).toISOString(),
    };
    try {
      this.onStateChanged?.(this.snapshotValue);
    } catch {
      // Status reporting must never change provider selection.
    }
  }
}
