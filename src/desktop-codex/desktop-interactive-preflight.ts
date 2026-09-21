import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";
import type { DesktopToolsPipeHandoff } from "./desktop-tools-pipe-handoff.js";
import {
  DesktopToolsPipeResolver,
  type DesktopToolsPipeResolverOptions,
  type DesktopToolsPipeSource,
} from "./desktop-tools-pipe-resolver.js";

/**
 * Why an interactive Desktop execution cannot start on this LRM Host. Each reason mirrors the
 * existing Desktop execution error codes so the preflight stays honest about the blocker.
 */
export type DesktopInteractiveBlockReason =
  | "desktop_disconnected"
  | "executor_identity_unavailable"
  | "desktop_tools_pipe_unavailable";

export interface DesktopInteractiveReadiness {
  readonly ready: boolean;
  readonly reason?: DesktopInteractiveBlockReason;
  /** The pipe source that would be used, present only when the check passed. */
  readonly pipeSource?: DesktopToolsPipeSource;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Production preflight for the interactive Desktop route.
 *
 * It runs the same three conditions the Desktop execution path needs before it can start, in the
 * same order the backend enforces them: Desktop IPC connection, executor conversation identity,
 * and a pipe the resolver can currently resolve. It reads evidence only; it never enumerates
 * pipes, guesses names, or acquires a capability, so a failure here is the honest reason the
 * Desktop route is blocked rather than a silent binary failure after the Goal already started.
 */
export class DesktopInteractivePreflight {
  private readonly resolver: DesktopToolsPipeResolver;

  public constructor(
    handoff: DesktopToolsPipeHandoff,
    private readonly stateReader: () => DesktopSyncState,
    options: DesktopToolsPipeResolverOptions = {},
  ) {
    this.resolver = new DesktopToolsPipeResolver(handoff, stateReader, options);
  }

  public check(): DesktopInteractiveReadiness {
    const state = this.stateReader();
    if (state.connected !== true) return { ready: false, reason: "desktop_disconnected" };
    if (nonEmpty(state.currentConversationId) === undefined) {
      return { ready: false, reason: "executor_identity_unavailable" };
    }
    try {
      return { ready: true, pipeSource: this.resolver.resolve().source };
    } catch {
      // The resolver only fails closed when neither a verified handoff nor a host-provided
      // environment pipe is available, which is exactly the blocked Desktop pipe capability.
      return { ready: false, reason: "desktop_tools_pipe_unavailable" };
    }
  }
}
