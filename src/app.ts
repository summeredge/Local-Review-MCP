import type { Server } from "node:http";
import { basename } from "node:path";
import { endpoint, localOrigin, type ResolvedSettings } from "./config/settings.js";
import { isPortInUse, startHttpServer, type HttpServerOptions } from "./mcp/http.js";
import { REGISTERED_TOOL_NAMES, type McpRuntimeContext } from "./mcp/server.js";
import { createTunnelManager, TunnelManager } from "./tunnel/manager.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { WorkspaceRegistry } from "./workspace/registry.js";

export interface AppContext extends McpRuntimeContext {
  readonly settings: ResolvedSettings;
  readonly tunnel: TunnelManager;
}

export type AppStartOptions = HttpServerOptions;

export function createAppContext(
  settings: ResolvedSettings,
  environment: NodeJS.ProcessEnv = process.env,
): AppContext {
  const registry = settings.workspaces === undefined
    ? WorkspaceRegistry.fromManager(new WorkspaceManager(settings.workspace))
    : new WorkspaceRegistry(settings.workspaces, { activeWorkspacePath: settings.workspace });
  return {
    settings,
    tunnel: createTunnelManager(settings.remote, {
      localEndpoint: localOrigin(settings),
      authToken: settings.auth.token,
      environment,
    }),
    workspace: registry.active.manager,
    registry,
  };
}

export async function startApp(
  settings: ResolvedSettings,
  context: AppContext = createAppContext(settings),
  options: AppStartOptions = {},
): Promise<Server> {
  try {
    const server = await startHttpServer(settings, context, options);
    try {
      await context.tunnel.start();
    } catch {
      console.error("Tunnel failed to start; local MCP remains available");
    }
    server.once("close", () => { void context.tunnel.stop().catch(() => undefined); });
    return server;
  } catch (error: unknown) {
    if (isPortInUse(error)) {
      throw new Error(
        `Local Review MCP cannot start because ${settings.host}:${settings.port} is already in use. `
        + "Choose another port in the Local Review MCP configuration.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function startupMessage(settings: ResolvedSettings, context?: McpRuntimeContext): string {
  const workspace = context?.registry?.active.manager ?? context?.workspace;
  return [
    "Local Review MCP started",
    `Endpoint: ${endpoint(settings)}`,
    `Workspace: ${workspace === undefined ? basename(settings.workspace) : basename(workspace.canonicalRoot)}`,
    `Tools: ${REGISTERED_TOOL_NAMES.length}`,
  ].join("\n");
}
