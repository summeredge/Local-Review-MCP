import { localOrigin, type ResolvedSettings } from "../config/settings.js";
import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";
import { CODEX_APP_TOOLS_PIPE_ENV } from "./codex-app-runtime.js";

export const LAUNCHER_DESKTOP_TOOLS_PIPE_PATH = "/launcher/desktop-tools-pipe" as const;
export const LAUNCHER_DESKTOP_TOOLS_PIPE_PROBE_PATH = "/launcher/desktop-tools-pipe/probe" as const;
export const MAX_DESKTOP_TOOLS_PIPE_PATH_LENGTH = 256;

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

export class DesktopToolsPipeHandoff {
  private capability: DesktopToolsPipeCapability | undefined;
  private acceptedOnce = false;
  private readonly now: () => string;

  public constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
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
    this.capability = {
      pipePath: validatedPipePath,
      ownerClientId: boundOwner,
      receivedAt: this.now(),
      source: "desktop_environment",
    };
    this.acceptedOnce = true;
    return this.capability;
  }

  public pipePathFor(state: DesktopSyncState): string | undefined {
    const currentOwner = ownerClientId(state.ownerClientId);
    return state.connected
      && currentOwner !== undefined
      && this.capability?.ownerClientId === currentOwner
      ? this.capability.pipePath
      : undefined;
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
    if (this.capability === undefined) return;
    if (!state.connected || ownerClientId(state.ownerClientId) !== this.capability.ownerClientId) {
      this.clear();
    }
  }

  public clear(): void {
    this.capability = undefined;
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

export async function sendDesktopToolsPipeHandoff(
  settings: ResolvedSettings,
  options: DesktopToolsPipeHandoffSenderOptions = {},
): Promise<DesktopToolsPipeHandoffAcceptedResponse> {
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
  if (accepted === undefined) {
    throw new DesktopToolsPipeHandoffError(
      "desktop_tools_pipe_request_failed",
      "The local handoff response was invalid.",
    );
  }
  return accepted;
}
