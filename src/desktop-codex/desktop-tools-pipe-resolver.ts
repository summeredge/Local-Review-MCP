import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";
import { CODEX_APP_TOOLS_PIPE_ENV } from "./codex-app-runtime.js";
import {
  DesktopToolsPipeHandoff,
  DesktopToolsPipeHandoffError,
  validateDesktopToolsPipePath,
} from "./desktop-tools-pipe-handoff.js";

/**
 * The only pipe sources LRM accepts. Both are evidence, never a guess:
 *
 * - "handoff": a DesktopToolsPipeHandoff capability, already verified against the current
 *   Desktop owner.
 * - "current_environment": CODEX_APP_TOOLS_PIPE_PATH inherited by this process, trusted only
 *   while the existing Desktop connection constraint still holds.
 */
export type DesktopToolsPipeSource = "handoff" | "current_environment";

export interface ResolvedDesktopToolsPipe {
  readonly pipePath: string;
  readonly source: DesktopToolsPipeSource;
}

export interface DesktopToolsPipeResolverOptions {
  /** Test/diagnostic seam; production reads process.env. */
  readonly environment?: NodeJS.ProcessEnv;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function unavailable(): DesktopToolsPipeHandoffError {
  return new DesktopToolsPipeHandoffError(
    "desktop_tools_pipe_unavailable",
    "Desktop tools pipe is unavailable.",
  );
}

/**
 * Unified Desktop tools pipe resolution.
 *
 * Priority is fixed and exhaustive: a verified handoff capability first, then the current
 * environment value, otherwise fail closed. Pipe enumeration and pipe name guessing are never
 * used, and the handoff capability keeps its own lifecycle and owner binding.
 */
export class DesktopToolsPipeResolver {
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(
    private readonly handoff: DesktopToolsPipeHandoff,
    private readonly stateReader: () => DesktopSyncState,
    options: DesktopToolsPipeResolverOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
  }

  public resolve(): ResolvedDesktopToolsPipe {
    const state = this.stateReader();
    // 1. A handed-off capability already proves the pipe belongs to the current Desktop owner.
    const handedOff = this.handoff.pipePathFor(state);
    if (handedOff !== undefined) return { pipePath: handedOff, source: "handoff" };
    // A handoff that was accepted and then invalidated (Desktop disconnect, owner change) is
    // stale evidence, not missing evidence: once this process has been handed a Desktop tools
    // pipe it must never silently downgrade to the weaker current_environment source.
    if (this.handoff.hasAcceptedCapability()) throw unavailable();
    // 2. The current environment value is only trusted while the existing Desktop connection
    //    constraint holds; a disconnected Desktop fails closed instead of using a stale pipe.
    if (state.connected !== true) throw unavailable();
    const inherited = nonEmpty(this.environment[CODEX_APP_TOOLS_PIPE_ENV]);
    if (inherited === undefined) throw unavailable();
    return { pipePath: validateDesktopToolsPipePath(inherited), source: "current_environment" };
  }
}
