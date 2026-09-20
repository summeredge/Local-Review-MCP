import { describe, expect, it, vi } from "vitest";
import {
  DesktopToolsPipeHandoff,
  validateDesktopToolsPipePath,
} from "../src/desktop-codex/desktop-tools-pipe-handoff.js";
import {
  DesktopToolsPipeResolver,
  type DesktopToolsPipeSource,
} from "../src/desktop-codex/desktop-tools-pipe-resolver.js";
import {
  DesktopCodexRuntimeFactory,
  probeDesktopToolsPipe,
  REQUIRED_DESKTOP_TOOLS,
  type DesktopCodexRuntimeLike,
} from "../src/desktop-codex/desktop-tools-pipe-probe.js";
import type { CodexAppRuntimeMetadata } from "../src/desktop-codex/codex-app-runtime.js";
import type { DesktopSyncState } from "../src/desktop-sync/desktop-sync-state.js";

/**
 * P5.4.1 Desktop runtime pipe resolution.
 *
 * The resolver is the single place that turns Desktop evidence into a pipe path. These tests fix
 * the three resolution paths: verified handoff, current_environment, and fail closed. Pipe
 * enumeration, pipe name guessing, handoff lifecycle, and owner binding are never exercised here
 * because the resolver must not implement them.
 */

const HANDOFF_PIPE = "\\\\.\\pipe\\codex-tools-handoff";
const ENV_PIPE = "\\\\.\\pipe\\codex-tools-current-env";
const OWNER = "desktop-instance-1";

function connectedState(owner = OWNER): DesktopSyncState {
  return {
    connected: true,
    currentConversationId: "conversation-1",
    ownerClientId: owner,
    followingThreads: new Set(),
  };
}

function disconnectedState(): DesktopSyncState {
  return { connected: false, followingThreads: new Set() };
}

function runtimeMetadata(): CodexAppRuntimeMetadata {
  return {
    desktopDetected: true,
    bundleDetected: true,
    mcpTransport: "stdio",
    nativeDesktopTransport: "windows_named_pipe",
  };
}

function fakeRuntime(): DesktopCodexRuntimeLike {
  return {
    info: runtimeMetadata(),
    async listTools() {
      return {
        tools: REQUIRED_DESKTOP_TOOLS.map((name) => ({
          name,
          description: "test",
          inputSchema: { type: "object" },
        })),
      };
    },
    async close() {},
  };
}

describe("Desktop tools pipe resolver", () => {
  it("prefers a verified handoff capability over the current environment", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(HANDOFF_PIPE, OWNER);
    const resolver = new DesktopToolsPipeResolver(
      handoff,
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(resolver.resolve()).toEqual({ pipePath: HANDOFF_PIPE, source: "handoff" });
  });

  it("uses the current environment when no handoff capability exists", () => {
    const resolver = new DesktopToolsPipeResolver(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(resolver.resolve()).toEqual({ pipePath: ENV_PIPE, source: "current_environment" });
  });

  it("fails closed when neither source can supply a pipe", () => {
    const emptyEnvironment = new DesktopToolsPipeResolver(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      { environment: {} },
    );
    expect(() => emptyEnvironment.resolve())
      .toThrowError(expect.objectContaining({ code: "desktop_tools_pipe_unavailable" }));

    const blankEnvironment = new DesktopToolsPipeResolver(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: "   " } },
    );
    expect(() => blankEnvironment.resolve())
      .toThrowError(expect.objectContaining({ code: "desktop_tools_pipe_unavailable" }));
  });

  it("never downgrades to the current environment when the handoff is stale", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(HANDOFF_PIPE, OWNER);

    // Disconnected Desktop: the handed-off capability is invalid and the environment must not
    // be used as a substitute.
    const disconnected = new DesktopToolsPipeResolver(
      handoff,
      () => disconnectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );
    expect(() => disconnected.resolve())
      .toThrowError(expect.objectContaining({ code: "desktop_tools_pipe_unavailable" }));

    // Owner change: the capability no longer matches this Desktop.
    const otherOwner = new DesktopToolsPipeResolver(
      handoff,
      () => connectedState("desktop-instance-2"),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );
    expect(() => otherOwner.resolve())
      .toThrowError(expect.objectContaining({ code: "desktop_tools_pipe_unavailable" }));
  });

  it("requires the existing Desktop connection constraint before trusting the environment", () => {
    const resolver = new DesktopToolsPipeResolver(
      new DesktopToolsPipeHandoff(),
      () => disconnectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    expect(() => resolver.resolve())
      .toThrowError(expect.objectContaining({ code: "desktop_tools_pipe_unavailable" }));
  });

  it("rejects an environment value that is not a local named pipe", () => {
    const resolver = new DesktopToolsPipeResolver(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: "C:\\temp\\pipe" } },
    );

    expect(() => resolver.resolve())
      .toThrowError(expect.objectContaining({ code: "desktop_tools_pipe_invalid" }));
    expect(() => validateDesktopToolsPipePath("C:\\temp\\pipe"))
      .toThrowError(expect.objectContaining({ code: "desktop_tools_pipe_invalid" }));
  });
});

describe("Desktop runtime factory pipe resolution", () => {
  it("connects with the handed-off pipe and reports the handoff source", async () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(HANDOFF_PIPE, OWNER);
    const seen: string[] = [];
    const factory = new DesktopCodexRuntimeFactory(
      handoff,
      () => connectedState(),
      async ({ pipePath }) => {
        seen.push(pipePath!);
        return fakeRuntime();
      },
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    const probe = await probeDesktopToolsPipe(factory);
    expect(seen).toEqual([HANDOFF_PIPE]);
    expect(probe.pipeSource).toBe("handoff");
  });

  it("connects with the current environment pipe when the handoff is absent", async () => {
    const seen: string[] = [];
    const factory = new DesktopCodexRuntimeFactory(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      async ({ pipePath }) => {
        seen.push(pipePath!);
        return fakeRuntime();
      },
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );

    const probe = await probeDesktopToolsPipe(factory);
    expect(seen).toEqual([ENV_PIPE]);
    expect(probe).toMatchObject({
      connected: true,
      pipeSource: "current_environment",
      requiredToolsPresent: Object.fromEntries(REQUIRED_DESKTOP_TOOLS.map((name) => [name, true])),
    });
    expect(JSON.stringify(probe)).not.toContain(ENV_PIPE);
  });

  it("fails closed without connecting when neither source exists", async () => {
    const connect = vi.fn(async () => fakeRuntime());
    const factory = new DesktopCodexRuntimeFactory(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      connect,
      { environment: {} },
    );

    await expect(factory.connect())
      .rejects.toMatchObject({ code: "desktop_tools_pipe_unavailable" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("exposes the resolved source only after a successful resolution", async () => {
    const sources: Array<DesktopToolsPipeSource | undefined> = [];
    const factory = new DesktopCodexRuntimeFactory(
      new DesktopToolsPipeHandoff(),
      () => connectedState(),
      async () => fakeRuntime(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: ENV_PIPE } },
    );
    sources.push(factory.pipeSource());
    await factory.connect();
    sources.push(factory.pipeSource());

    expect(sources).toEqual([undefined, "current_environment"]);
  });
});
