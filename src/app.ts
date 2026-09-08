import type { Server } from "node:http";
import { basename } from "node:path";
import { endpoint, localOrigin, type ResolvedSettings } from "./config/settings.js";
import { isPortInUse, startHttpServer, type HttpServerOptions } from "./mcp/http.js";
import { REGISTERED_TOOL_NAMES, type McpRuntimeContext } from "./mcp/server.js";
import { startBridge, stopBridge } from "./control-plane/bridge.js";
import { ConversationCorrelationRegistry } from "./control-plane/conversation-correlation.js";
import {
  ExtensionDeliveryService,
  ExtensionDeliveryUnavailableError,
} from "./control-plane/extension-delivery.js";
import { CodexExecutionCompletionService } from "./control-plane/codex-execution-completion.js";
import type { ExtensionIdentityEvidence } from "./control-plane/extension-identity.js";
import { createTunnelManager, TunnelManager } from "./tunnel/manager.js";
import { validateWorkspaceIdentityConsistency } from "./workspace/identity.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { WorkspaceRegistry } from "./workspace/registry.js";

export interface AppContext extends McpRuntimeContext {
  readonly settings: ResolvedSettings;
  readonly tunnel: TunnelManager;
  readonly correlations: ConversationCorrelationRegistry;
  readonly extensionDeliveries: ExtensionDeliveryService;
  readonly codexExecutionCompletion?: CodexExecutionCompletionService;
}

export interface AppStartOptions extends HttpServerOptions {
  readonly bridgePorts?: readonly number[];
  readonly onIdentityEvidence?: (evidence: ExtensionIdentityEvidence) => void | Promise<void>;
}

export function createAppContext(
  settings: ResolvedSettings,
  environment: NodeJS.ProcessEnv = process.env,
): AppContext {
  const runtimeIdentity = settings.workspaceIdentity;
  if (runtimeIdentity !== undefined) {
    validateWorkspaceIdentityConsistency(runtimeIdentity, {
      ...runtimeIdentity,
      path: settings.workspace,
    });
  }
  const registry = settings.workspaces !== undefined
    ? new WorkspaceRegistry(settings.workspaces, runtimeIdentity === undefined
      ? { activeWorkspacePath: settings.workspace }
      : { activeWorkspaceIdentity: runtimeIdentity })
    : runtimeIdentity === undefined
      ? WorkspaceRegistry.fromManager(new WorkspaceManager(settings.workspace))
      : new WorkspaceRegistry([runtimeIdentity], {
        activeWorkspaceId: runtimeIdentity.id,
      });
  if (runtimeIdentity !== undefined) {
    validateWorkspaceIdentityConsistency(registry.active, runtimeIdentity);
  }
  return {
    settings,
    correlations: new ConversationCorrelationRegistry(),
    extensionDeliveries: new ExtensionDeliveryService(),
    codexExecutionCompletion: new CodexExecutionCompletionService(),
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
      const extensionDeliveries = context.extensionDeliveries;
      await context.correlations.restore();
      try {
        await (context.codexExecutionCompletion ?? new CodexExecutionCompletionService())
          .recoverRunningExecutions();
      } catch {
        console.warn("Codex execution completion recovery failed; local MCP remains available");
      }
      let deliveryAvailable = true;
      try {
        await extensionDeliveries.restore();
      } catch {
        deliveryAvailable = false;
        console.warn("Extension Delivery unavailable; durable state could not be restored");
      }
      const bridgePort = await startBridge({
        ports: options.bridgePorts,
        onIdentityEvidence: async (evidence) => {
          await context.correlations.observe(evidence);
          await options.onIdentityEvidence?.(evidence);
        },
        claimExtensionDelivery: async (claim) => {
          if (!deliveryAvailable) throw new ExtensionDeliveryUnavailableError("extension delivery unavailable");
          return extensionDeliveries.claim(claim);
        },
        ackExtensionDelivery: async (ack) => {
          if (!deliveryAvailable) throw new ExtensionDeliveryUnavailableError("extension delivery unavailable");
          return extensionDeliveries.acknowledge(ack);
        },
      });
      if (bridgePort === null) {
        console.warn("Local Control Bridge unavailable; local MCP remains available");
      }
    } catch {
      console.warn("Local Control Bridge failed to start; local MCP remains available");
    }
    server.once("close", () => {
      void stopBridge().catch(() => undefined);
      void context.tunnel.stop().catch(() => undefined);
    });
    try {
      await context.tunnel.start();
    } catch {
      console.error("Tunnel failed to start; local MCP remains available");
    }
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
  const selection = context?.registry?.active;
  const workspace = selection?.manager ?? context?.workspace;
  const workspaceId = selection?.id ?? workspace?.workspaceId ?? "unknown";
  const workspaceName = selection?.name ?? workspace?.workspaceName ?? basename(settings.workspace);
  return [
    "Local Review MCP started",
    `Endpoint: ${endpoint(settings)}`,
    `Workspace ID: ${workspaceId}`,
    `Workspace Name: ${workspaceName}`,
    `Workspace: ${workspace === undefined ? basename(settings.workspace) : basename(workspace.canonicalRoot)}`,
    `Tools: ${REGISTERED_TOOL_NAMES.length}`,
  ].join("\n");
}
