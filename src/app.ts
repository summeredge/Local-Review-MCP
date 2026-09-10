import type { Server } from "node:http";
import { basename, dirname, join } from "node:path";
import { endpoint, localOrigin, type ResolvedSettings } from "./config/settings.js";
import { isPortInUse, startHttpServer, type HttpServerOptions } from "./mcp/http.js";
import { REGISTERED_TOOL_NAMES, type McpRuntimeContext } from "./mcp/server.js";
import { startBridge, stopBridge } from "./control-plane/bridge.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
} from "./control-plane/controlled-actuation.js";
import { CodexExecutionAdapter } from "./control-plane/codex-execution-adapter.js";
import { ConversationCorrelationRegistry } from "./control-plane/conversation-correlation.js";
import {
  ExtensionDeliveryService,
  ExtensionDeliveryUnavailableError,
} from "./control-plane/extension-delivery.js";
import {
  ExtensionReviewCompletionService,
  ExtensionReviewCompletionUnavailableError,
} from "./control-plane/extension-review-completion.js";
import { CodexExecutionCompletionService } from "./control-plane/codex-execution-completion.js";
import { AutoIterationService } from "./control-plane/auto-iteration.js";
import { GoalOrchestrationService } from "./control-plane/goal-orchestration.js";
import {
  ChatGPTConnectorStore,
  migrateLegacyOAuthState,
} from "./control-plane/chatgpt-connector.js";
import type { ExtensionIdentityEvidence } from "./control-plane/extension-identity.js";
import { createTunnelManager, TunnelManager } from "./tunnel/manager.js";
import { defaultTaskContextStorageRoot } from "./context/task.js";
import { validateWorkspaceIdentityConsistency } from "./workspace/identity.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { WorkspaceRegistry } from "./workspace/registry.js";

export interface AppContext extends McpRuntimeContext {
  readonly storageRoot?: string;
  readonly settings: ResolvedSettings;
  readonly tunnel: TunnelManager;
  readonly correlations: ConversationCorrelationRegistry;
  readonly extensionDeliveries: ExtensionDeliveryService;
  readonly extensionReviewCompletions: ExtensionReviewCompletionService;
  readonly codexExecutionCompletion?: CodexExecutionCompletionService;
  readonly actuationAuthorizationStore?: ActuationAuthorizationStore;
  readonly codexExecutionAdapter?: CodexExecutionAdapter;
  readonly controlledActuation?: ControlledActuationService;
  readonly autoIteration?: AutoIterationService;
  readonly goalOrchestration?: GoalOrchestrationService;
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
  const storageRoot = defaultTaskContextStorageRoot(environment);
  const connectorEvidence = new ChatGPTConnectorStore(registry.active.id, storageRoot);
  const extensionDeliveries = new ExtensionDeliveryService(storageRoot);
  const extensionReviewCompletions = new ExtensionReviewCompletionService(storageRoot);
  const codexExecutionCompletion = new CodexExecutionCompletionService(storageRoot);
  const codexExecutionAdapter = new CodexExecutionAdapter(registry, {
    storageRoot,
    completionService: codexExecutionCompletion,
    environment,
  });
  const actuationAuthorizationStore = new ActuationAuthorizationStore(storageRoot);
  const controlledActuation = new ControlledActuationService(registry, {
    storageRoot,
    authorizationStore: actuationAuthorizationStore,
    adapter: codexExecutionAdapter,
  });
  const autoIteration = new AutoIterationService(registry, {
    storageRoot,
    extensionDeliveries,
    controlledActuation,
  });
  const goalOrchestration = new GoalOrchestrationService(registry, {
    storageRoot,
    authorizationStore: actuationAuthorizationStore,
    controlledActuation,
    autoIteration,
  });
  autoIteration.setTerminalListener((loop) => goalOrchestration.onAutoIterationTerminal(loop));
  codexExecutionCompletion.setTerminalListener((execution) => autoIteration.onExecutionTerminal(execution));
  return {
    settings,
    storageRoot,
    connectorEvidence,
    correlations: new ConversationCorrelationRegistry(),
    extensionDeliveries,
    extensionReviewCompletions,
    codexExecutionCompletion,
    actuationAuthorizationStore,
    codexExecutionAdapter,
    controlledActuation,
    autoIteration,
    goalOrchestration,
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
    const workspaceOAuth = context.storageRoot === undefined
      ? undefined
      : await migrateLegacyOAuthState({
          workspaceId: context.registry.active.id,
          storageRoot: context.storageRoot,
          singleWorkspace: context.registry.list().length === 1,
        });
    const server = await startHttpServer(settings, context, {
      oauthClientRegistryPath: options.oauthClientRegistryPath ?? workspaceOAuth?.clientRegistryPath,
      oauthTokenStorePath: options.oauthTokenStorePath
        ?? (options.oauthClientRegistryPath === undefined
          ? workspaceOAuth?.tokenStorePath
          : join(dirname(options.oauthClientRegistryPath), "tokens.json")),
    });
    try {
      const extensionDeliveries = context.extensionDeliveries;
      await context.correlations.restore();
      try {
        await (context.codexExecutionCompletion ?? new CodexExecutionCompletionService())
          .recoverRunningExecutions();
      } catch {
        console.warn("Codex execution completion recovery failed; local MCP remains available");
      }
      try {
        await context.controlledActuation?.restore();
      } catch {
        console.warn("Controlled Actuation unavailable; durable state could not be restored");
      }
      let deliveryAvailable = true;
      try {
        await extensionDeliveries.restore();
      } catch {
        deliveryAvailable = false;
        console.warn("Extension Delivery unavailable; durable state could not be restored");
      }
      const extensionReviewCompletions = context.extensionReviewCompletions;
      let completionAvailable = true;
      try {
        await extensionReviewCompletions.restore();
      } catch {
        completionAvailable = false;
        console.warn("Extension Review Completion unavailable; durable state could not be restored");
      }
      try {
        await context.autoIteration?.recover();
      } catch {
        console.warn("Auto Iterate recovery failed; local MCP remains available");
      }
      try {
        await context.goalOrchestration?.recover();
      } catch {
        console.warn("Goal Orchestration recovery failed; local MCP remains available");
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
        claimExtensionReviewCompletion: async (claim) => {
          if (!completionAvailable) {
            throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
          }
          return extensionReviewCompletions.claim(claim);
        },
        ackExtensionReviewCompletion: async (ack) => {
          if (!completionAvailable) {
            throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
          }
          return extensionReviewCompletions.acknowledge(ack);
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
