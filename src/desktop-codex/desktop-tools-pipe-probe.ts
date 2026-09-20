import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppRuntime,
  type CodexAppRuntimeMetadata,
  type CodexAppRuntimeDiscoveryOptions,
} from "./codex-app-runtime.js";
import {
  DesktopToolsPipeHandoff,
  DesktopToolsPipeHandoffError,
} from "./desktop-tools-pipe-handoff.js";
import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";

export interface DesktopCodexRuntimeLike {
  readonly info: CodexAppRuntimeMetadata;
  listTools(signal?: AbortSignal): Promise<ListToolsResult>;
  close(): Promise<void>;
}

export type DesktopCodexRuntimeConnector = (
  options: Pick<CodexAppRuntimeDiscoveryOptions, "pipePath">,
) => Promise<DesktopCodexRuntimeLike>;

const connectRuntime: DesktopCodexRuntimeConnector = (options) => CodexAppRuntime.connect(options);

export class DesktopCodexRuntimeFactory {
  private readonly connectRuntime: DesktopCodexRuntimeConnector;

  public constructor(
    private readonly handoff: DesktopToolsPipeHandoff,
    private readonly stateReader: () => DesktopSyncState,
    connect: DesktopCodexRuntimeConnector = connectRuntime,
  ) {
    this.connectRuntime = connect;
  }

  public async connect(): Promise<DesktopCodexRuntimeLike> {
    const pipePath = this.handoff.pipePathFor(this.stateReader());
    if (pipePath === undefined) {
      throw new DesktopToolsPipeHandoffError(
        "desktop_tools_pipe_unavailable",
        "Desktop tools pipe handoff is unavailable.",
      );
    }
    return this.connectRuntime({ pipePath });
  }
}

export const REQUIRED_DESKTOP_TOOLS = [
  "list_projects",
  "create_thread",
  "send_message_to_thread",
  "read_thread",
  "wait_threads",
] as const;

export type RequiredDesktopToolsPresent = {
  readonly [name in typeof REQUIRED_DESKTOP_TOOLS[number]]: boolean;
};

export interface DesktopToolsPipeProbeResult {
  readonly connected: true;
  readonly desktopDetected: boolean;
  readonly bundleDetected: boolean;
  readonly mcpTransport?: "stdio";
  readonly nativeDesktopTransport?: "windows_named_pipe" | "unknown";
  readonly desktopVersion?: string;
  readonly codexAppToolsVersion?: string;
  readonly pipeSource: "handoff";
  readonly toolCount: number;
  readonly requiredToolsPresent: RequiredDesktopToolsPresent;
}

export interface DesktopCodexRuntimeProvider {
  connect(): Promise<DesktopCodexRuntimeLike>;
}

export async function probeDesktopToolsPipe(
  provider: DesktopCodexRuntimeProvider,
): Promise<DesktopToolsPipeProbeResult> {
  let runtime: DesktopCodexRuntimeLike | undefined;
  try {
    runtime = await provider.connect();
    const listed = await runtime.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    const requiredToolsPresent = Object.fromEntries(
      REQUIRED_DESKTOP_TOOLS.map((name) => [name, names.has(name)]),
    ) as RequiredDesktopToolsPresent;
    return {
      connected: true,
      desktopDetected: runtime.info.desktopDetected,
      bundleDetected: runtime.info.bundleDetected,
      ...(runtime.info.mcpTransport === undefined ? {} : { mcpTransport: runtime.info.mcpTransport }),
      ...(runtime.info.nativeDesktopTransport === undefined
        ? {}
        : { nativeDesktopTransport: runtime.info.nativeDesktopTransport }),
      ...(runtime.info.desktopVersion === undefined ? {} : { desktopVersion: runtime.info.desktopVersion }),
      ...(runtime.info.codexAppToolsVersion === undefined
        ? {}
        : { codexAppToolsVersion: runtime.info.codexAppToolsVersion }),
      pipeSource: "handoff",
      toolCount: listed.tools.length,
      requiredToolsPresent,
    };
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}
