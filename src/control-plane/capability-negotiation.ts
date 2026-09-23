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

export const capabilityActionSchema = z.enum(["recheck", "standalone"]);
export type CapabilityAction = z.infer<typeof capabilityActionSchema>;

export type CapabilityFailureReason =
  | "desktop_disconnected"
  | "executor_identity_unavailable"
  | "desktop_tools_pipe_unavailable"
  | "desktop_handoff_failed"
  | "desktop_execution_failed"
  | "standalone_execution_failed";

export interface CapabilityNegotiationTimestamps {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly desktopDeadlineAt: string | null;
  readonly fallbackDeadlineAt: string | null;
}

export interface CapabilityNegotiationContext {
  readonly execution_id: string;
  readonly task_id: string;
  readonly actuation_id: string | null;
  readonly state: CapabilityState;
  readonly requestedAction: CapabilityAction | null;
  readonly source: CapabilitySource | null;
  readonly reason: CapabilityFailureReason | null;
  readonly actions: readonly CapabilityAction[];
  readonly timestamps: CapabilityNegotiationTimestamps;
}

export interface CapabilitySnapshot extends CapabilityNegotiationContext {
  readonly error_code: string | null;
  /** Compatibility alias for existing status consumers. */
  readonly updatedAt: string;
}

export interface CapabilityPreparation {
  readonly ready: boolean;
  readonly reason?: CapabilityFailureReason;
}

export interface CapabilityProvider extends ExecutionBackend {
  readonly source: CapabilitySource;
  prepare(): Promise<CapabilityPreparation>;
}

export interface DesktopCapabilityProviderOptions {
  readonly backend: ExecutionBackend;
  readonly readiness: () => DesktopInteractiveReadiness;
}

function readinessReason(readiness: DesktopInteractiveReadiness): CapabilityFailureReason {
  return readiness.reason ?? "desktop_tools_pipe_unavailable";
}

export class DesktopCapabilityProvider implements CapabilityProvider {
  public readonly source = "desktop" as const;

  public constructor(private readonly options: DesktopCapabilityProviderOptions) {}

  public async prepare(): Promise<CapabilityPreparation> {
    try {
      const readiness = this.options.readiness();
      return readiness.ready
        ? { ready: true }
        : { ready: false, reason: readinessReason(readiness) };
    } catch {
      return { ready: false, reason: "desktop_handoff_failed" };
    }
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

export class CapabilityExecutionError extends Error {
  public readonly provider: CapabilitySource;
  public readonly code: string | undefined;

  public constructor(provider: CapabilitySource, cause: unknown) {
    const message = cause instanceof Error && cause.message !== ""
      ? cause.message
      : `${provider} execution failed.`;
    super(message, { cause });
    this.name = "CapabilityExecutionError";
    this.provider = provider;
    this.code = typeof cause === "object"
      && cause !== null
      && "code" in cause
      && typeof cause.code === "string"
      ? cause.code
      : undefined;
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
  | { readonly action: "recheck" }
  | { readonly action: "standalone" }
  | { readonly action: "failed"; readonly reason: CapabilityFailureReason };

interface StoredCapabilityNegotiationContext {
  execution_id: string;
  task_id: string;
  actuation_id: string | null;
  state: CapabilityState;
  requestedAction: CapabilityAction | null;
  source: CapabilitySource | null;
  reason: CapabilityFailureReason | null;
  actions: readonly CapabilityAction[];
  timestamps: CapabilityNegotiationTimestamps;
  lastError: unknown;
}

function requestKey(request: ExecutionBackendStartRequest): string {
  return `${request.workspace_id}\0${request.task_id}\0${request.execution_id}`;
}

function errorReason(source: CapabilitySource): CapabilityFailureReason {
  return source === "desktop" ? "desktop_execution_failed" : "standalone_execution_failed";
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
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
  private readonly contexts = new Map<string, StoredCapabilityNegotiationContext>();

  public constructor(options: CapabilityNegotiatorOptions) {
    this.desktop = options.desktop;
    this.standalone = options.standalone;
    this.desktopTimeoutMs = options.desktopTimeoutMs ?? 30_000;
    this.fallbackTimeoutMs = options.fallbackTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onStateChanged = options.onStateChanged;
  }

  public snapshot(executionId?: string): CapabilitySnapshot | null {
    const context = executionId === undefined || executionId === "current"
      ? this.currentContext()
      : this.contexts.get(executionId);
    return context === undefined ? null : this.snapshotOf(context);
  }

  public currentSnapshot(): CapabilitySnapshot | null {
    return this.snapshot("current");
  }

  public context(executionId: string): CapabilityNegotiationContext | null {
    const context = this.contexts.get(executionId);
    return context === undefined ? null : this.publicContext(context);
  }

  public recheckDesktop(executionId: string): CapabilitySnapshot | null {
    const context = this.contexts.get(executionId);
    if (context === undefined || !context.actions.includes("recheck")) {
      return context === undefined ? null : this.snapshotOf(context);
    }
    context.requestedAction = "recheck";
    this.setState(context, "initializing", null, null, ["recheck", "standalone"]);
    return this.snapshotOf(context);
  }

  public selectStandalone(executionId: string): CapabilitySnapshot | null {
    const context = this.contexts.get(executionId);
    if (context === undefined || !context.actions.includes("standalone")) {
      return context === undefined ? null : this.snapshotOf(context);
    }
    context.requestedAction = "standalone";
    this.setState(context, "fallback_ready", "standalone", null, ["recheck"]);
    return this.snapshotOf(context);
  }

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const parsed = executionBackendStartRequestSchema.parse(request);
    const key = requestKey(parsed);
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending.then((result) => ({ ...result, accepted: "existing" as const }));

    const context = this.ensureContext(parsed);
    const operation = this.startOnce(parsed, context);
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

  private ensureContext(request: ExecutionBackendStartRequest): StoredCapabilityNegotiationContext {
    const existing = this.contexts.get(request.execution_id);
    if (existing !== undefined) {
      if (existing.task_id !== request.task_id
        || existing.actuation_id !== (request.actuation_id ?? null)) {
        throw new Error(`Execution "${request.execution_id}" is already bound to another capability context.`);
      }
      return existing;
    }

    const timestamp = this.timestamp(this.now());
    const context: StoredCapabilityNegotiationContext = {
      execution_id: request.execution_id,
      task_id: request.task_id,
      actuation_id: request.actuation_id ?? null,
      state: "initializing",
      requestedAction: null,
      source: null,
      reason: null,
      actions: ["recheck", "standalone"],
      timestamps: {
        createdAt: timestamp,
        updatedAt: timestamp,
        desktopDeadlineAt: null,
        fallbackDeadlineAt: null,
      },
      lastError: undefined,
    };
    this.contexts.set(context.execution_id, context);
    this.emit(context);
    return context;
  }

  private async startOnce(
    request: ExecutionBackendStartRequest,
    context: StoredCapabilityNegotiationContext,
  ): Promise<ExecutionStartResult> {
    if (this.consumeAction(context, "standalone")) return this.startStandalone(request, context);

    while (true) {
      const result = await this.waitForDesktop(context);
      if (result.action === "standalone") return this.startStandalone(request, context);
      if (result.action === "recheck") continue;
      if (result.action === "failed") {
        this.setState(context, "desktop_failed", "desktop", result.reason, ["recheck", "standalone"]);
        const choice = await this.waitForFallbackChoice(context);
        if (choice === "recheck") continue;
        return this.startStandalone(request, context);
      }

      this.setState(context, "desktop_ready", "desktop", null, []);
      try {
        return await this.desktop.start(request);
      } catch (error: unknown) {
        const wrapped = new CapabilityExecutionError("desktop", error);
        this.setState(context, "desktop_failed", "desktop", errorReason("desktop"), ["recheck", "standalone"], wrapped);
        throw wrapped;
      }
    }
  }

  private async waitForDesktop(context: StoredCapabilityNegotiationContext): Promise<DesktopWaitResult> {
    const deadline = this.now() + this.desktopTimeoutMs;
    this.setDeadline(context, "desktopDeadlineAt", deadline);
    this.setState(context, "desktop_pending", "desktop", null, ["recheck", "standalone"]);
    while (true) {
      if (this.consumeAction(context, "standalone")) return { action: "standalone" };
      if (this.consumeAction(context, "recheck")) return { action: "recheck" };

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
      if (this.consumeAction(context, "standalone")) return { action: "standalone" };
      if (this.consumeAction(context, "recheck")) return { action: "recheck" };
      const remaining = deadline - this.now();
      if (remaining <= 0) return { action: "failed", reason: "desktop_tools_pipe_unavailable" };
      await this.wait(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private async waitForFallbackChoice(context: StoredCapabilityNegotiationContext): Promise<"recheck" | "standalone"> {
    const deadline = this.now() + this.fallbackTimeoutMs;
    this.setDeadline(context, "fallbackDeadlineAt", deadline);
    while (true) {
      if (this.consumeAction(context, "recheck")) return "recheck";
      if (this.consumeAction(context, "standalone")) return "standalone";
      const remaining = deadline - this.now();
      if (remaining <= 0) return "standalone";
      await this.wait(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private async startStandalone(
    request: ExecutionBackendStartRequest,
    context: StoredCapabilityNegotiationContext,
  ): Promise<ExecutionStartResult> {
    context.requestedAction = null;
    this.setState(context, "fallback_ready", "standalone", null, ["recheck"]);
    try {
      const preparation = await this.standalone.prepare();
      if (!preparation.ready) {
        const cause = new Error(preparation.reason ?? "Standalone capability is unavailable.");
        const wrapped = new CapabilityExecutionError("standalone", cause);
        this.setState(context, "fallback_ready", "standalone", "standalone_execution_failed", ["recheck", "standalone"], wrapped);
        throw wrapped;
      }
      const result = await this.standalone.start(request);
      this.setState(context, "fallback_running", "standalone", null, []);
      return result;
    } catch (error: unknown) {
      if (error instanceof CapabilityExecutionError) throw error;
      const wrapped = new CapabilityExecutionError("standalone", error);
      this.setState(context, "fallback_ready", "standalone", errorReason("standalone"), ["recheck", "standalone"], wrapped);
      throw wrapped;
    }
  }

  private consumeAction(context: StoredCapabilityNegotiationContext, action: CapabilityAction): boolean {
    if (context.requestedAction !== action) return false;
    context.requestedAction = null;
    return true;
  }

  private setDeadline(
    context: StoredCapabilityNegotiationContext,
    field: "desktopDeadlineAt" | "fallbackDeadlineAt",
    deadline: number,
  ): void {
    const timestamp = this.timestamp(this.now());
    context.timestamps = {
      ...context.timestamps,
      updatedAt: timestamp,
      [field]: this.timestamp(deadline),
    };
    this.emit(context);
  }

  private setState(
    context: StoredCapabilityNegotiationContext,
    state: CapabilityState,
    source: CapabilitySource | null,
    reason: CapabilityFailureReason | null,
    actions: readonly CapabilityAction[],
    lastError?: unknown,
  ): void {
    context.state = state;
    context.source = source;
    context.reason = reason;
    context.actions = actions;
    context.lastError = lastError;
    context.timestamps = {
      ...context.timestamps,
      updatedAt: this.timestamp(this.now()),
      ...(state !== "desktop_pending" ? { desktopDeadlineAt: null } : {}),
      ...(state !== "desktop_failed" ? { fallbackDeadlineAt: null } : {}),
    };
    this.emit(context);
  }

  private emit(context: StoredCapabilityNegotiationContext): void {
    try {
      this.onStateChanged?.(this.snapshotOf(context));
    } catch {
      // Status reporting must never change provider selection.
    }
  }

  private snapshotOf(context: StoredCapabilityNegotiationContext): CapabilitySnapshot {
    return {
      ...this.publicContext(context),
      error_code: errorCode(context.lastError),
      updatedAt: context.timestamps.updatedAt,
    };
  }

  private publicContext(context: StoredCapabilityNegotiationContext): CapabilityNegotiationContext {
    return {
      execution_id: context.execution_id,
      task_id: context.task_id,
      actuation_id: context.actuation_id,
      state: context.state,
      requestedAction: context.requestedAction,
      source: context.source,
      reason: context.reason,
      actions: context.actions,
      timestamps: context.timestamps,
    };
  }

  private currentContext(): StoredCapabilityNegotiationContext | undefined {
    let current: StoredCapabilityNegotiationContext | undefined;
    for (const candidate of this.contexts.values()) {
      if (current === undefined || candidate.timestamps.updatedAt >= current.timestamps.updatedAt) {
        current = candidate;
      }
    }
    return current;
  }

  private timestamp(value: number): string {
    return new Date(value).toISOString();
  }
}
