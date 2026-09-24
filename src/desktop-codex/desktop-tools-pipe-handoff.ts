import { localOrigin, type ResolvedSettings } from "../config/settings.js";
import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";
import { CODEX_APP_TOOLS_PIPE_ENV } from "./codex-app-runtime.js";

export const LAUNCHER_DESKTOP_TOOLS_PIPE_PATH = "/launcher/desktop-tools-pipe" as const;
export const LAUNCHER_DESKTOP_TOOLS_PIPE_PROBE_PATH = "/launcher/desktop-tools-pipe/probe" as const;
export const MAX_DESKTOP_TOOLS_PIPE_PATH_LENGTH = 256;
export const DESKTOP_TOOLS_PIPE_PENDING_TTL_MS = 45_000;

const LOCAL_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

export type DesktopToolsPipeHandoffErrorCode =
  | "desktop_tools_pipe_invalid"
  | "desktop_tools_pipe_unavailable"
  | "desktop_tools_pipe_request_failed"
  | "desktop_tools_pipe_probe_failed";

export class DesktopToolsPipeHandoffError extends Error {
  public constructor(public readonly code: DesktopToolsPipeHandoffErrorCode, message: string) {
    super(message);
    this.name = "DesktopToolsPipeHandoffError";
  }
}

export function validateDesktopToolsPipePath(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_DESKTOP_TOOLS_PIPE_PATH_LENGTH
    || value.includes("\0")
    || !value.startsWith(LOCAL_NAMED_PIPE_PREFIX)
    || value.length === LOCAL_NAMED_PIPE_PREFIX.length
    || value.slice(LOCAL_NAMED_PIPE_PREFIX.length).includes("\\")
    || value.slice(LOCAL_NAMED_PIPE_PREFIX.length).includes("/")) {
    throw new DesktopToolsPipeHandoffError(
      "desktop_tools_pipe_invalid",
      "CODEX_APP_TOOLS_PIPE_PATH must be a local Windows named pipe.",
    );
  }
  return value;
}

function ownerClientId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export interface DesktopToolsPipeCapability {
  readonly pipePath: string;
  readonly ownerClientId: string;
  readonly receivedAt: string;
  readonly source: "desktop_environment";
}

export interface DesktopToolsPipePendingCapability {
  readonly pipePath: string;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly provenance: "authenticated_loopback";
}

export interface DesktopToolsPipeHandoffLifecycleEvent {
  readonly state: "pending_registered" | "owner_bound" | "promoted" | "discarded";
  readonly timestamp: string;
  readonly pendingRegisteredAt?: string;
  readonly ownerBindingAt?: string;
  readonly promotionAt?: string;
  readonly expiresAt?: string;
  readonly discardReason?: "expired" | "disconnected" | "owner_mismatch";
}

export type DesktopToolsPipeHandoffState = "active" | "pending" | "unavailable";

export interface DesktopToolsPipeHandoffPendingResponse {
  readonly accepted: false;
  readonly pending: true;
  readonly source: "desktop_environment";
  readonly received_at: string;
  readonly desktop_owner_bound: false;
}

export type DesktopToolsPipeHandoffResponse =
  | DesktopToolsPipeHandoffAcceptedResponse
  | DesktopToolsPipeHandoffPendingResponse;

export class DesktopToolsPipeHandoff {
  private capability: DesktopToolsPipeCapability | undefined;
  private pendingCapability: DesktopToolsPipePendingCapability | undefined;
  private acceptedOnce = false;
  private readonly now: () => string;
  private readonly onLifecycleEvent: ((event: DesktopToolsPipeHandoffLifecycleEvent) => void) | undefined;
  private pendingExpiryTimer: NodeJS.Timeout | undefined;
  private observedConnected = false;
  private observedOwnerClientId: string | undefined;

  public constructor(
    now: () => string = () => new Date().toISOString(),
    onLifecycleEvent?: (event: DesktopToolsPipeHandoffLifecycleEvent) => void,
  ) {
    this.now = now;
    this.onLifecycleEvent = onLifecycleEvent;
  }

  public accept(pipePath: unknown, owner: unknown): DesktopToolsPipeCapability {
    const validatedPipePath = validateDesktopToolsPipePath(pipePath);
    const boundOwner = ownerClientId(owner);
    if (boundOwner === undefined) {
      throw new DesktopToolsPipeHandoffError(
        "desktop_tools_pipe_unavailable",
        "Desktop owner evidence is unavailable.",
      );
    }
    this.clearPendingExpiryTimer();
    this.pendingCapability = undefined;
    this.capability = {
      pipePath: validatedPipePath,
      ownerClientId: boundOwner,
      receivedAt: this.now(),
      source: "desktop_environment",
    };
    this.acceptedOnce = true;
    return this.capability;
  }

  /**
   * Store authenticated loopback handoff evidence until Desktop IPC supplies the owner. The
   * pending value is deliberately not a DesktopToolsPipeCapability and is never visible to the
   * resolver until observeDesktopState() promotes it with a real owner identity.
   */
  public stagePending(pipePath: unknown): DesktopToolsPipePendingCapability {
    const validatedPipePath = validateDesktopToolsPipePath(pipePath);
    const existing = this.pendingCapability;
    if (existing !== undefined
      && existing.pipePath === validatedPipePath
      && !this.pendingExpired(existing)) {
      return existing;
    }
    if (existing !== undefined && existing.pipePath === validatedPipePath) {
      this.discardPending("expired");
    } else if (existing !== undefined) {
      this.pendingCapability = undefined;
    }

    this.capability = undefined;
    const receivedAt = this.now();
    const receivedAtMs = Date.parse(receivedAt);
    const expiresAt = Number.isFinite(receivedAtMs)
      ? new Date(receivedAtMs + DESKTOP_TOOLS_PIPE_PENDING_TTL_MS).toISOString()
      : new Date(Date.now() + DESKTOP_TOOLS_PIPE_PENDING_TTL_MS).toISOString();
    this.pendingCapability = {
      pipePath: validatedPipePath,
      receivedAt,
      expiresAt,
      provenance: "authenticated_loopback",
    };
    this.schedulePendingExpiry(this.pendingCapability);
    this.emitLifecycle({
      state: "pending_registered",
      timestamp: receivedAt,
      pendingRegisteredAt: receivedAt,
      expiresAt,
    });
    return this.pendingCapability;
  }

  public pipePathFor(state: DesktopSyncState): string | undefined {
    const currentOwner = ownerClientId(state.ownerClientId);
    return state.connected
      && currentOwner !== undefined
      && this.capability?.ownerClientId === currentOwner
      ? this.capability.pipePath
      : undefined;
  }

  /** Read-only status for diagnostics; it never returns the pipe path or changes ownership. */
  public stateFor(state: DesktopSyncState): DesktopToolsPipeHandoffState {
    if (this.pipePathFor(state) !== undefined) return "active";
    if (state.connected && this.pendingCapability !== undefined
      && !this.pendingExpired(this.pendingCapability)) {
      return "pending";
    }
    return "unavailable";
  }

  /**
   * Read-only evidence about this handoff instance, not about the current Desktop.
   *
   * It reports whether a capability has ever been accepted here, including after the existing
   * lifecycle invalidated and cleared it. The lifecycle, owner binding, and validity rules are
   * unchanged: this only lets a caller tell "no handoff was ever handed to this process" apart
   * from "the handoff is gone", so a stale handoff is never silently replaced by a weaker source.
   */
  public hasAcceptedCapability(): boolean {
    return this.acceptedOnce;
  }

  public observeDesktopState(state: DesktopSyncState): void {
    const currentOwner = ownerClientId(state.ownerClientId);
    const ownerWasLost = this.observedConnected
      && this.observedOwnerClientId !== undefined
      && currentOwner === undefined;
    const ownerChanged = this.observedConnected
      && this.observedOwnerClientId !== undefined
      && currentOwner !== undefined
      && currentOwner !== this.observedOwnerClientId;

    if (!state.connected) {
      this.discardPending("disconnected");
      this.clear();
      this.observedConnected = false;
      this.observedOwnerClientId = undefined;
      return;
    }

    if (this.capability !== undefined
      && currentOwner !== this.capability.ownerClientId) {
      this.capability = undefined;
    }
    if (this.pendingCapability !== undefined) {
      if (this.pendingExpired(this.pendingCapability)) {
        this.discardPending("expired");
      } else if (ownerWasLost || ownerChanged) {
        this.discardPending("owner_mismatch");
      } else if (currentOwner !== undefined) {
        const pending = this.pendingCapability;
        this.clearPendingExpiryTimer();
        this.pendingCapability = undefined;
        const ownerBindingAt = this.now();
        this.emitLifecycle({
          state: "owner_bound",
          timestamp: ownerBindingAt,
          pendingRegisteredAt: pending.receivedAt,
          ownerBindingAt,
        });
        const promotionAt = this.now();
        this.capability = {
          pipePath: pending.pipePath,
          ownerClientId: currentOwner,
          receivedAt: pending.receivedAt,
          source: "desktop_environment",
        };
        this.acceptedOnce = true;
        this.emitLifecycle({
          state: "promoted",
          timestamp: promotionAt,
          pendingRegisteredAt: pending.receivedAt,
          ownerBindingAt,
          promotionAt,
        });
      }
    }

    this.observedConnected = true;
    this.observedOwnerClientId = currentOwner;
  }

  public clear(): void {
    this.capability = undefined;
    this.clearPendingExpiryTimer();
    this.pendingCapability = undefined;
  }

  private discardPending(reason: "expired" | "disconnected" | "owner_mismatch"): void {
    const pending = this.pendingCapability;
    if (pending === undefined) return;
    this.clearPendingExpiryTimer();
    this.pendingCapability = undefined;
    this.emitLifecycle({
      state: "discarded",
      timestamp: this.now(),
      pendingRegisteredAt: pending.receivedAt,
      expiresAt: pending.expiresAt,
      discardReason: reason,
    });
  }

  private schedulePendingExpiry(pending: DesktopToolsPipePendingCapability): void {
    this.clearPendingExpiryTimer();
    const timer = setTimeout(() => {
      if (this.pendingCapability === pending) this.discardPending("expired");
    }, DESKTOP_TOOLS_PIPE_PENDING_TTL_MS);
    timer.unref?.();
    this.pendingExpiryTimer = timer;
  }

  private clearPendingExpiryTimer(): void {
    if (this.pendingExpiryTimer === undefined) return;
    clearTimeout(this.pendingExpiryTimer);
    this.pendingExpiryTimer = undefined;
  }

  private emitLifecycle(event: DesktopToolsPipeHandoffLifecycleEvent): void {
    try {
      this.onLifecycleEvent?.(event);
    } catch {
      // Handoff diagnostics must never affect owner binding or capability validity.
    }
  }

  private pendingExpired(pending: DesktopToolsPipePendingCapability): boolean {
    const nowMs = Date.parse(this.now());
    const expiresAtMs = Date.parse(pending.expiresAt);
    return !Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs;
  }
}

export interface DesktopToolsPipeHandoffAcceptedResponse {
  readonly accepted: true;
  readonly source: "desktop_environment";
  readonly received_at: string;
  readonly desktop_owner_bound: true;
}

export interface DesktopToolsPipeHandoffSenderOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(value: unknown): DesktopToolsPipeHandoffErrorCode {
  const code = isRecord(value) && typeof value.error === "string" ? value.error : undefined;
  return code === "desktop_tools_pipe_invalid"
    || code === "desktop_tools_pipe_unavailable"
    || code === "desktop_tools_pipe_probe_failed"
    ? code
    : "desktop_tools_pipe_request_failed";
}

function acceptedResponse(value: unknown): DesktopToolsPipeHandoffAcceptedResponse | undefined {
  if (!isRecord(value)
    || value.accepted !== true
    || value.source !== "desktop_environment"
    || typeof value.received_at !== "string"
    || value.desktop_owner_bound !== true) {
    return undefined;
  }
  return {
    accepted: true,
    source: "desktop_environment",
    received_at: value.received_at,
    desktop_owner_bound: true,
  };
}

function pendingResponse(value: unknown): DesktopToolsPipeHandoffPendingResponse | undefined {
  if (!isRecord(value)
    || value.accepted !== false
    || value.pending !== true
    || value.source !== "desktop_environment"
    || typeof value.received_at !== "string"
    || value.desktop_owner_bound !== false) {
    return undefined;
  }
  return {
    accepted: false,
    pending: true,
    source: "desktop_environment",
    received_at: value.received_at,
    desktop_owner_bound: false,
  };
}

export async function sendDesktopToolsPipeHandoff(
  settings: ResolvedSettings,
  options: DesktopToolsPipeHandoffSenderOptions = {},
): Promise<DesktopToolsPipeHandoffResponse> {
  const environment = options.environment ?? process.env;
  const rawPipePath = environment[CODEX_APP_TOOLS_PIPE_ENV];
  if (rawPipePath === undefined) {
    throw new DesktopToolsPipeHandoffError(
      "desktop_tools_pipe_unavailable",
      "CODEX_APP_TOOLS_PIPE_PATH is unavailable in this execution context.",
    );
  }
  const pipePath = validateDesktopToolsPipePath(rawPipePath);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (fetchImpl === undefined) {
    throw new DesktopToolsPipeHandoffError(
      "desktop_tools_pipe_request_failed",
      "The local handoff request could not be sent.",
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(`${localOrigin(settings)}${LAUNCHER_DESKTOP_TOOLS_PIPE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.auth.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pipePath }),
    });
  } catch {
    throw new DesktopToolsPipeHandoffError(
      "desktop_tools_pipe_request_failed",
      "The local handoff request could not be sent.",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DesktopToolsPipeHandoffError(
      "desktop_tools_pipe_request_failed",
      "The local handoff response was invalid.",
    );
  }
  if (!response.ok) {
    const code = responseError(body);
    throw new DesktopToolsPipeHandoffError(code, "The local desktop tools pipe handoff was not accepted.");
  }
  const accepted = acceptedResponse(body);
  if (accepted !== undefined) return accepted;
  const pending = pendingResponse(body);
  if (pending !== undefined) return pending;
  throw new DesktopToolsPipeHandoffError(
    "desktop_tools_pipe_request_failed",
    "The local handoff response was invalid.",
  );
}
