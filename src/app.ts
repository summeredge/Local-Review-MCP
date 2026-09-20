import type { Server } from "node:http";
import { basename, dirname, join } from "node:path";
import { endpoint, localOrigin, type ResolvedSettings } from "./config/settings.js";
import { isPortInUse, startHttpServer, type HttpServerOptions } from "./mcp/http.js";
import { REGISTERED_TOOL_NAMES, type McpRuntimeContext } from "./mcp/server.js";
import { extensionDeliveryReadiness, startBridge, stopBridge } from "./control-plane/bridge.js";
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
import { CodexAppServerBackend } from "./backends/codex_app_server/backend.js";
import { AutoIterationService } from "./control-plane/auto-iteration.js";
import { GoalPreflightService } from "./control-plane/goal-preflight.js";
import { GoalOrchestrationService } from "./control-plane/goal-orchestration.js";
import { GoalSubmissionService } from "./control-plane/goal-submission.js";
import { PendingGoalSubmissionService } from "./control-plane/pending-goal-submission.js";
import { ExecutionRoutingService } from "./control-plane/execution-routing.js";
import {
  CliExecutionBackend,
  ExecutionBackendRouter,
  ExecutionService,
} from "./control-plane/execution-service.js";
import {
  LOCAL_CONTROL_BRIDGE_HOST,
  LOCAL_CONTROL_BRIDGE_PORTS,
  LOCAL_CONTROL_BRIDGE_PROTOCOL,
} from "./control-plane/bridge-protocol.js";
import { ExtensionReviewCompletionAdapter } from "./delivery/extension-review-completion-adapter.js";
import { ReviewCompletionRouter } from "./router/review-completion-router.js";
import {
  ChatGPTConnectorStore,
  migrateLegacyOAuthState,
} from "./control-plane/chatgpt-connector.js";
import type { ExtensionIdentityEvidence } from "./control-plane/extension-identity.js";
import { createTunnelManager, TunnelManager } from "./tunnel/manager.js";
import { defaultTaskContextStorageRoot } from "./context/task.js";
import { EventStore } from "./control-plane/events/index.js";
import { StatusQueryService } from "./control-plane/status-query.js";
import { validateWorkspaceIdentityConsistency } from "./workspace/identity.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { WorkspaceRegistry } from "./workspace/registry.js";
import {
  FileRuntimeDiagnosticLogger,
  writeRuntimeDiagnostic,
  type RuntimeDiagnosticLogger,
} from "./control-plane/runtime-diagnostic-logger.js";
import { IdentityTraceService } from "./control-plane/identity-trace.js";
import { EvidenceTransportTraceService } from "./control-plane/evidence-transport-trace.js";
import { DesktopIPCObserver } from "./desktop-sync/desktop-ipc-observer.js";
import { DesktopSyncManager } from "./desktop-sync/desktop-sync-manager.js";
import { DesktopToolsPipeHandoff } from "./desktop-codex/desktop-tools-pipe-handoff.js";
import { DesktopCodexRuntimeFactory } from "./desktop-codex/desktop-tools-pipe-probe.js";

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
  readonly codexAppServerBackend?: CodexAppServerBackend;
  readonly executionService?: ExecutionService;
  readonly eventStore?: EventStore;
  readonly statusQuery?: StatusQueryService;
  readonly controlledActuation?: ControlledActuationService;
  readonly autoIteration?: AutoIterationService;
  readonly goalPreflight?: GoalPreflightService;
  readonly goalOrchestration?: GoalOrchestrationService;
  readonly goalSubmission?: GoalSubmissionService;
  readonly pendingGoalSubmission?: PendingGoalSubmissionService;
  readonly identityTrace?: IdentityTraceService;
  readonly evidenceTransportTrace?: EvidenceTransportTraceService;
  readonly executionRouter?: ExecutionRoutingService;
}

export interface AppStartOptions extends HttpServerOptions {
  readonly bridgePorts?: readonly number[];
  readonly onIdentityEvidence?: (evidence: ExtensionIdentityEvidence) => void | Promise<void>;
  readonly runtimeDiagnosticLogger?: RuntimeDiagnosticLogger;
  readonly desktopSyncObserver?: Pick<DesktopIPCObserver, "start" | "stop" | "dispose" | "getState">;
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
  const eventStore = new EventStore(storageRoot);
  const codexExecutionAdapter = new CodexExecutionAdapter(registry, {
    storageRoot,
    completionService: codexExecutionCompletion,
    environment,
  });
  const codexAppServerBackend = new CodexAppServerBackend(registry, {
    storageRoot,
    environment,
    eventStore,
  });
  const executionService = new ExecutionService(new ExecutionBackendRouter({
    batch: new CliExecutionBackend(codexExecutionAdapter),
    interactive: codexAppServerBackend,
  }));
  const actuationAuthorizationStore = new ActuationAuthorizationStore(storageRoot);
  const controlledActuation = new ControlledActuationService(registry, {
    storageRoot,
    authorizationStore: actuationAuthorizationStore,
    adapter: executionService,
  });
  const completionRouter = new ReviewCompletionRouter(
    storageRoot,
    new ExtensionReviewCompletionAdapter(extensionDeliveries, extensionReviewCompletions),
    runtimeIdentity,
  );
  const autoIteration = new AutoIterationService(registry, {
    storageRoot,
    extensionDeliveries,
    completionRouter,
    controlledActuation,
  });
  const goalOrchestration = new GoalOrchestrationService(registry, {
    storageRoot,
    authorizationStore: actuationAuthorizationStore,
    controlledActuation,
    autoIteration,
  });
  const goalPreflight = new GoalPreflightService({ settings, registry, storageRoot });
  const goalSubmission = new GoalSubmissionService(goalOrchestration, goalPreflight);
  const correlations = new ConversationCorrelationRegistry(storageRoot);
  const identityTrace = new IdentityTraceService(storageRoot);
  const evidenceTransportTrace = new EvidenceTransportTraceService(storageRoot);
  const pendingGoalSubmission = new PendingGoalSubmissionService(correlations, goalSubmission, {
    storageRoot,
    identityTrace,
    evidenceTransportTrace,
  });
  const executionRouter = new ExecutionRoutingService(registry, {
    storageRoot,
    autoIteration,
    goalOrchestration,
  });
  autoIteration.setTerminalListener((loop) => goalOrchestration.onAutoIterationTerminal(loop));
  codexExecutionCompletion.setTerminalListener((execution) => executionRouter.onExecutionTerminal(execution));
  executionService.setTerminalListener((execution) => executionRouter.onExecutionTerminal(execution));
  const statusQuery = new StatusQueryService({
    storageRoot,
    goals: goalOrchestration,
    eventStore,
  });
  return {
    settings,
    storageRoot,
    connectorEvidence,
    correlations,
    extensionDeliveries,
    extensionReviewCompletions,
    codexExecutionCompletion,
    actuationAuthorizationStore,
    codexExecutionAdapter,
    codexAppServerBackend,
    executionService,
    eventStore,
    statusQuery,
    controlledActuation,
    autoIteration,
    goalPreflight,
    goalOrchestration,
    goalSubmission,
    pendingGoalSubmission,
    identityTrace,
    evidenceTransportTrace,
    executionRouter,
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
  const runtimeDiagnosticLogger = options.runtimeDiagnosticLogger ?? new FileRuntimeDiagnosticLogger();
  const desktopSyncObserver = options.desktopSyncObserver
    ?? new DesktopIPCObserver();
  const desktopSyncManager = new DesktopSyncManager({
    observer: desktopSyncObserver,
    sessions: context.statusQuery === undefined
      ? undefined
      : {
          listSessionSummaries: (workspaceId) => context.statusQuery!.listSessionSummaries(workspaceId),
        },
    workspaceId: context.registry.active.id,
  });
  const desktopToolsPipeHandoff = new DesktopToolsPipeHandoff();
  const desktopCodexRuntimeFactory = new DesktopCodexRuntimeFactory(
    desktopToolsPipeHandoff,
    () => desktopSyncObserver.getState(),
  );
  try {
    const workspaceOAuth = context.storageRoot === undefined
      ? undefined
      : await migrateLegacyOAuthState({
          workspaceId: context.registry.active.id,
          storageRoot: context.storageRoot,
          singleWorkspace: context.registry.list().length === 1,
        });
    const server = await startHttpServer(settings, {
      ...context,
      browserReadiness: extensionDeliveryReadiness,
      desktopSyncObserver,
      desktopSyncManager,
      desktopToolsPipeHandoff,
      desktopCodexRuntimeFactory,
    }, {
      oauthClientRegistryPath: options.oauthClientRegistryPath ?? workspaceOAuth?.clientRegistryPath,
      oauthTokenStorePath: options.oauthTokenStorePath
        ?? (options.oauthClientRegistryPath === undefined
          ? workspaceOAuth?.tokenStorePath
          : join(dirname(options.oauthClientRegistryPath), "tokens.json")),
      silent: options.silent,
    });
    try {
      const extensionDeliveries = context.extensionDeliveries;
      await context.correlations.restore();
      try {
        await context.pendingGoalSubmission?.restore();
      } catch {
        console.warn("Pending Goal submission unavailable; durable state could not be restored");
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
      const bridgePort = await startBridge({
        ports: options.bridgePorts,
        evidenceTransportTrace: context.evidenceTransportTrace,
        onIdentityEvidence: async (evidence) => {
          context.evidenceTransportTrace?.record({
            event: "connector_evidence_received",
            correlation_key: evidence.request_id,
            conversation_id: evidence.conversation_id,
          });
          context.evidenceTransportTrace?.record({
            event: "extension_evidence_received",
            correlation_key: evidence.request_id,
            conversation_id: evidence.conversation_id,
          });
          context.identityTrace?.record({
            event: "extension_evidence_received",
            correlation_key: evidence.request_id,
            conversation_id: evidence.conversation_id,
            workspace_id: context.registry.active.id,
          });
          const previous = context.correlations.correlation(evidence.request_id);
          const result = await context.correlations.observe(evidence);
          if (result === "refused") {
            context.identityTrace?.record({
              event: "evidence_match_failed",
              correlation_key: evidence.request_id,
              conversation_id: evidence.conversation_id,
              workspace_id: context.registry.active.id,
              reason: "conversation_mismatch",
              ...(previous === null ? {} : { expected_conversation_id: previous.conversation_id }),
            });
          }
          void context.pendingGoalSubmission?.diagnoseEvidence(
            evidence,
            context.registry.active.id,
          ).catch(() => undefined);
          if (result !== "refused") context.pendingGoalSubmission?.scheduleResolve(evidence.request_id);
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
        console.warn(
          `Local Control Bridge discovery exhausted ${LOCAL_CONTROL_BRIDGE_HOST}:${(options.bridgePorts ?? LOCAL_CONTROL_BRIDGE_PORTS).join(", ")} (protocol ${LOCAL_CONTROL_BRIDGE_PROTOCOL})`,
        );
      } else {
        writeRuntimeDiagnostic(runtimeDiagnosticLogger, {
          event: "bridge_started",
          timestamp: new Date().toISOString(),
          host: LOCAL_CONTROL_BRIDGE_HOST,
          port: bridgePort,
          protocol: LOCAL_CONTROL_BRIDGE_PROTOCOL,
        });
        console.info(
          `Local Control Bridge started on ${LOCAL_CONTROL_BRIDGE_HOST}:${bridgePort} (protocol ${LOCAL_CONTROL_BRIDGE_PROTOCOL})`,
        );
      }
    } catch (error: unknown) {
      console.warn("Local Control Bridge failed to start; local MCP remains available");
      console.warn(
        "Local Control Bridge startup error:",
        error instanceof Error ? error.message : String(error),
      );
    }
    server.once("close", () => {
      try {
        desktopSyncObserver.dispose();
      } catch {
        // Desktop observation must not affect runtime shutdown.
      }
      context.goalPreflight?.setRuntimeReady(false);
      void context.executionService?.close().catch(() => undefined);
      void stopBridge().catch(() => undefined);
      void context.tunnel.stop().catch(() => undefined);
    });
    try {
      await context.tunnel.start();
    } catch {
      console.error("Tunnel failed to start; local MCP remains available");
    }
    try {
      await (context.codexExecutionCompletion ?? new CodexExecutionCompletionService())
        .recoverRunningExecutions();
    } catch {
      console.warn("Codex execution completion recovery failed; local MCP remains available");
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
    try {
      await context.executionRouter?.recoverCompletedExecutions();
    } catch {
      console.warn("Execution Routing recovery failed; local MCP remains available");
    }
    context.goalPreflight?.setRuntimeReady(true);
    try {
      await context.pendingGoalSubmission?.recover();
    } catch {
      console.warn("Pending Goal submission recovery failed; local MCP remains available");
    }
    try {
      desktopSyncObserver.start();
    } catch {
      console.warn("Desktop IPC Observer unavailable; local MCP remains available");
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
