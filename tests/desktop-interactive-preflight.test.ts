import { describe, expect, it } from "vitest";
import { DesktopToolsPipeHandoff } from "../src/desktop-codex/desktop-tools-pipe-handoff.js";
import { DesktopInteractivePreflight } from "../src/desktop-codex/desktop-interactive-preflight.js";
import type { DesktopSyncState } from "../src/desktop-sync/desktop-sync-state.js";

/**
 * P5.4.1 production Desktop pipe source correction.
 *
 * The preflight must report the honest reason an interactive Desktop Goal is blocked, using the
 * same evidence the Desktop backend enforces. It never enumerates or guesses a pipe.
 */

// String.raw keeps the local named-pipe prefix readable without escape noise.
const PIPE_PREFIX = "\\\\.\\pipe\\";
const HANDOFF_PIPE = PIPE_PREFIX + "codex-tools-handoff";
const ENV_PIPE = PIPE_PREFIX + "codex-tools-current-env";
const OWNER = "desktop-instance-1";

function connectedState(overrides: Partial<DesktopSyncState> = {}): DesktopSyncState {
  return {
    connected: true,
    currentConversationId: "conversation-1",
    ownerClientId: OWNER,
    followingThreads: new Set(),
    ...overrides,
  };
}

describe("DesktopInteractivePreflight", () => {
  it("blocks when the Desktop IPC is disconnected", () => {
    const preflight = new DesktopInteractivePreflight(
      new DesktopToolsPipeHandoff(),
      () => ({ connected: false, followingThreads: new Set() }),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(preflight.check()).toEqual({ ready: false, reason: "desktop_disconnected" });
  });

  it("blocks when the executor conversation identity is unavailable", () => {
    const preflight = new DesktopInteractivePreflight(
      new DesktopToolsPipeHandoff(),
      () => connectedState({ currentConversationId: undefined }),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(preflight.check()).toEqual({ ready: false, reason: "executor_identity_unavailable" });
  });

  it("blocks with desktop_tools_pipe_unavailable without a handoff and without a host env pipe", () => {
    const preflight = new DesktopInteractivePreflight(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      { environment: {} },
    );

    expect(preflight.check()).toEqual({ ready: false, reason: "desktop_tools_pipe_unavailable" });
  });

  it("stays blocked after a handoff is invalidated instead of downgrading to the host env", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(HANDOFF_PIPE, OWNER);
    handoff.observeDesktopState({ connected: false, followingThreads: new Set() });
    const preflight = new DesktopInteractivePreflight(
      handoff,
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(preflight.check()).toEqual({ ready: false, reason: "desktop_tools_pipe_unavailable" });
  });

  it("reports the handoff source when a verified handoff exists", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(HANDOFF_PIPE, OWNER);
    const preflight = new DesktopInteractivePreflight(
      handoff,
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(preflight.check()).toEqual({ ready: true, pipeSource: "handoff" });
  });

  it("reports the current_environment source only when the host already holds the pipe", () => {
    const preflight = new DesktopInteractivePreflight(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(preflight.check()).toEqual({ ready: true, pipeSource: "current_environment" });
  });

  it("never returns a pipe path in its result", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(HANDOFF_PIPE, OWNER);
    const preflight = new DesktopInteractivePreflight(handoff, () => connectedState());

    const result = preflight.check();
    expect(JSON.stringify(result)).not.toContain(HANDOFF_PIPE);
    expect(JSON.stringify(result)).not.toContain(PIPE_PREFIX);
  });
});
