import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppRuntime,
  type CodexAppRuntimeMetadata,
  type CodexAppRuntimeDiscoveryOptions,
} from "./codex-app-runtime.js";
import type { DesktopToolsPipeHandoff } from "./desktop-tools-pipe-handoff.js";
import {
  DesktopToolsPipeResolver,
  type DesktopToolsPipeResolverOptions,
  type DesktopToolsPipeSource,
} from "./desktop-tools-pipe-resolver.js";
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
  private readonly resolver: DesktopToolsPipeResolver;
  private resolvedSource: DesktopToolsPipeSource | undefined;

  public constructor(
    handoff: DesktopToolsPipeHandoff,
    stateReader: () => DesktopSyncState,
    connect: DesktopCodexRuntimeConnector = connectRuntime,
    options: DesktopToolsPipeResolverOptions = {},
  ) {
    this.connectRuntime = connect;
    this.resolver = new DesktopToolsPipeResolver(handoff, stateReader, options);
  }

  public async connect(): Promise<DesktopCodexRuntimeLike> {
    const resolved = this.resolver.resolve();
    this.resolvedSource = resolved.source;
    return this.connectRuntime({ pipePath: resolved.pipePath });
  }

  /**
   * The pipe source used by the most recent connect, or undefined before any successful
   * resolution. It never re-resolves, so a probe reports the source it actually connected with.
   */
  public pipeSource(): DesktopToolsPipeSource | undefined {
    return this.resolvedSource;
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
  readonly pipeSource: DesktopToolsPipeSource;
  readonly toolCount: number;
  readonly requiredToolsPresent: RequiredDesktopToolsPresent;
}

export interface DesktopCodexRuntimeProvider {
  connect(): Promise<DesktopCodexRuntimeLike>;
  /** The pipe source the provider last resolved from; omitted providers report "handoff". */
  pipeSource?(): DesktopToolsPipeSource | undefined;
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
      pipeSource: provider.pipeSource?.() ?? "handoff",
      toolCount: listed.tools.length,
      requiredToolsPresent,
    };
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}
