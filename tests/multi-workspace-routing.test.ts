import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolRequestParams, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppContext } from "../src/app.js";
import type { ResolvedSettings } from "../src/config/settings.js";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { ReviewResultService } from "../src/context/review-result-service.js";
import { TaskContextService } from "../src/context/service.js";
import {
  CapabilityNegotiator,
  type CapabilityPreparation,
} from "../src/control-plane/capability-negotiation.js";
import { ConversationCorrelationRegistry } from "../src/control-plane/conversation-correlation.js";
import { GoalPreflightService } from "../src/control-plane/goal-preflight.js";
import { GoalOrchestrationService } from "../src/control-plane/goal-orchestration.js";
import {
  GoalSubmissionService,
  type GoalSubmissionOrchestration,
} from "../src/control-plane/goal-submission.js";
import { PendingGoalSubmissionService } from "../src/control-plane/pending-goal-submission.js";
import type {
  ExecutionBackendStartRequest,
  ExecutionStartResult,
} from "../src/control-plane/execution-service.js";
import { DesktopCodexBackend } from "../src/desktop-codex/desktop-codex-backend.js";
import type { DesktopCodexRuntimeLike } from "../src/desktop-codex/desktop-tools-pipe-probe.js";
import type { ReviewCompletionRequest } from "../src/delivery/review-completion-adapter.js";
import { ReviewCompletionRouter } from "../src/router/review-completion-router.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
const KEY_A = "00000000-0000-4000-8000-000000000001";
const KEY_B = "00000000-0000-4000-8000-000000000002";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for multi-workspace state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function workspaceFixture(): Promise<{
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly workspaceD: string;
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly path: string }[];
  readonly registry: WorkspaceRegistry;
  readonly settings: ResolvedSettings;
}> {
  const workspaceA = await root("lrm-multi-a-");
  const workspaceB = await root("lrm-multi-b-");
  const workspaceC = await root("lrm-multi-c-");
  const workspaceD = await root("lrm-multi-d-");
  const workspaces = [
    { id: "workspace-a", name: "Workspace A", path: workspaceA },
    { id: "workspace-b", name: "Workspace B", path: workspaceB },
    { id: "workspace-c", name: "Workspace C", path: workspaceC },
    { id: "workspace-d", name: "Workspace D", path: workspaceD },
  ] as const;
  return {
    workspaceA,
    workspaceB,
    workspaceD,
    workspaces,
    registry: new WorkspaceRegistry(workspaces, { activeWorkspaceId: "workspace-a" }),
    settings: {
      host: "127.0.0.1",
      port: 12080,
      workspace: workspaceA,
      workspaceIdentity: workspaces[0],
      workspaces,
      auth: { token: "token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    },
  };
}

function connectorDiagnostic(
  workspaceId: string,
  workspaceName: string,
  overrides: Partial<{
    ok: boolean;
    status: "unconfigured" | "repair_required" | "verified";
    action: "none" | "create" | "update";
    reason: string;
    remote_ready: boolean;
    oauth_ready: boolean;
    migration: "not_needed" | "migrated" | "reauthorization_required";
    reauthorization_required: boolean;
  }> = {},
) {
  return {
    ok: overrides.ok ?? true,
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    remote: {
      ready: overrides.remote_ready ?? true,
      mcp_url: "https://mcp.example.test/mcp",
      readiness: { attempts: 1, timeline: [], final_state: "ready" as const },
    },
    oauth: {
      ready: overrides.oauth_ready ?? true,
      pkce_s256: true,
      dynamic_registration: true,
      refresh_token: true,
      migration: overrides.migration ?? "not_needed" as const,
      reauthorization_required: overrides.reauthorization_required ?? false,
    },
    connector: {
      name: workspaceName,
      status: overrides.status ?? "verified" as const,
      action: overrides.action ?? "none" as const,
      mcp_url: "https://mcp.example.test/mcp",
      verified_mcp_url: "https://mcp.example.test/mcp",
      reason: overrides.reason ?? "verified_endpoint_matches",
    },
    pages: {
      plugins: "https://chatgpt.com/admin/plugins",
      create_connector: "https://chatgpt.com/gpts/editor",
    },
  };
}

function request(workspaceId: string, suffix: string): ExecutionBackendStartRequest {
  return {
    goal_id: `goal-${suffix}`,
    workspace_id: workspaceId,
    task_id: `task-${suffix}`,
    execution_id: `execution-${suffix}`,
    instruction: `Run ${suffix}`,
    execution_mode: "interactive",
  };
}

async function deliveredReview(
  storageRoot: string,
  registry: WorkspaceRegistry,
  workspaceId: string,
  suffix: string,
) {
  const identity = registry.resolve(workspaceId);
  const taskId = `review-task-${suffix}`;
  const executionId = `review-execution-${suffix}`;
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: taskId,
    workspace_id: workspaceId,
    status: "reviewing",
  });
  await new ExecutionContextService(storageRoot).createExecutionContext({
    execution_id: executionId,
    task_id: taskId,
    workspace_id: workspaceId,
    status: "passed",
  });
  const reviewRequest = await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: `review-${suffix}`,
    task_id: taskId,
    execution_id: executionId,
    workspace_id: workspaceId,
  });
  const routing = await new ConversationRoutingService(storageRoot, identity).createRouting({
    routing_id: `routing-${suffix}`,
    workspace_id: workspaceId,
    task_id: taskId,
    review_request_id: reviewRequest.review_request_id,
    conversation_id: `conversation-${suffix}`,
  });
  const deliveries = new ReviewDeliveryService(storageRoot, identity);
  const created = await deliveries.createDelivery({
    workspace_id: workspaceId,
    task_id: taskId,
    review_request_id: reviewRequest.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: routing.conversation_id,
  });
  await deliveries.beginDeliveryAttempt(workspaceId, created.delivery_id);
  const delivery = await deliveries.markDelivered(workspaceId, created.delivery_id);
  return { reviewRequest, routing, delivery };
}

function desktopTools(): Tool[] {
  return [
    { name: "list_projects", inputSchema: { type: "object", properties: {} } },
    {
      name: "create_thread",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          target: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["project"] },
              projectId: { type: "string" },
              environment: {
                type: "object",
                properties: { type: { type: "string", enum: ["local"] } },
                required: ["type"],
              },
            },
            required: ["type", "projectId", "environment"],
          },
        },
        required: ["prompt", "target"],
      },
    },
    {
      name: "read_thread",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          hostId: { type: "string" },
          turnLimit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["threadId"],
      },
    },
    {
      name: "wait_threads",
      inputSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                threadId: { type: "string" },
                hostId: { type: "string" },
                afterCursor: { type: "string" },
              },
              required: ["threadId"],
            },
          },
          timeoutMs: { type: "integer", minimum: 0, maximum: 120000 },
        },
        required: ["targets"],
      },
    },
  ];
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

describe("multi-workspace execution routing", () => {
  it("accepts a registered non-active Workspace and diagnoses its own connector", async () => {
    const fixture = await workspaceFixture();
    const diagnoseConnector = vi.fn(async (settings: ResolvedSettings) =>
      connectorDiagnostic(settings.workspaceIdentity!.id, settings.workspaceIdentity!.name));
    const service = new GoalPreflightService({
      settings: fixture.settings,
      registry: fixture.registry,
      runtimeReady: () => true,
      diagnoseConnector,
      extensionReadiness: async () => ({ ready: true }),
      extensionReadyTimeoutMs: 0,
    });

    await expect(service.checkGoalPreflight({
      workspace_id: "workspace-b",
      conversation_id: "conversation-b",
    })).resolves.toMatchObject({
      ready: true,
      workspace: { valid: true, workspace_id: "workspace-b" },
    });
    expect(diagnoseConnector).toHaveBeenCalledWith(expect.objectContaining({
      workspace: fixture.workspaceB,
      workspaceIdentity: expect.objectContaining({ id: "workspace-b", path: fixture.workspaceB }),
    }));

    await expect(service.checkGoalPreflight({
      workspace_id: "workspace-missing",
      conversation_id: "conversation-x",
    })).resolves.toMatchObject({
      ready: false,
      failure_stage: "workspace",
      failure_reason: "workspace_id is not registered",
    });
  });

  it("starts a non-active registered Goal from authenticated MCP provenance without migrating Workspace OAuth state", async () => {
    const fixture = await workspaceFixture();
    const diagnoseConnector = vi.fn(async () => connectorDiagnostic("workspace-d", "Workspace D", {
      oauth_ready: false,
      migration: "reauthorization_required",
      reauthorization_required: true,
      reason: "legacy_oauth_reauthorization_required",
    }));
    const preflight = new GoalPreflightService({
      settings: fixture.settings,
      registry: fixture.registry,
      runtimeReady: () => true,
      diagnoseConnector,
      extensionReadiness: async () => ({ ready: true }),
      extensionReadyTimeoutMs: 0,
    });
    const createGoal = vi.fn(async () => ({ goal_id: "goal-d" } as never));
    const startGoal = vi.fn(async () => ({
      execution_id: "execution-d",
      current_phase_id: "phase-d",
      current_task_id: "task-d",
      status: "running",
    } as never));
    const orchestration: GoalSubmissionOrchestration = { createGoal, startGoal };
    const submission = new GoalSubmissionService(orchestration, preflight);
    const request = {
      workspace_id: "workspace-d",
      conversation_id: "conversation-d",
      title: "Run Workspace D Goal",
      goal: "Start the requested Goal in Workspace D.",
      requirements: ["Keep Workspace ownership immutable."],
      acceptance_criteria: ["The Goal starts in Workspace D."],
      max_iterations: 1,
    };
    const proof = { source: "authenticated_mcp_invocation" as const };

    await expect(submission.submitGoal(request, proof)).resolves.toMatchObject({
      execution_id: "execution-d",
      status: "running",
    });
    expect(diagnoseConnector).not.toHaveBeenCalled();
    expect(createGoal).toHaveBeenCalledTimes(1);
    expect(startGoal).toHaveBeenCalledTimes(1);
    expect(startGoal).toHaveBeenCalledWith({ goal_id: "goal-d" });

    await expect(submission.submitGoal(request)).rejects.toMatchObject({
      result: {
        failure_stage: "connector",
        failure_reason: "legacy_oauth_reauthorization_required",
      },
    });
    expect(diagnoseConnector).toHaveBeenCalledTimes(1);
    expect(createGoal).toHaveBeenCalledTimes(1);

    await expect(preflight.checkGoalPreflight({
      workspace_id: "workspace-missing",
      conversation_id: "conversation-missing",
    }, proof)).resolves.toMatchObject({
      ready: false,
      failure_stage: "workspace",
      failure_reason: "workspace_id is not registered",
    });
  });

  it("resolves interleaved identity evidence to each Pending Goal's immutable Workspace", async () => {
    const storageRoot = await root("lrm-multi-pending-");
    const correlations = new ConversationCorrelationRegistry(storageRoot);
    const starts = vi.fn(async (input: { workspace_id: string; conversation_id: string }) => ({
      goal_id: `goal-${input.workspace_id}`,
      phase_id: `phase-${input.workspace_id}`,
      task_id: `task-${input.workspace_id}`,
      execution_id: `execution-${input.workspace_id}`,
      status: "running" as const,
    }));
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal: starts }, {
      storageRoot,
      browserReadiness: () => ({ ready: true }),
    });
    const input = (correlation_key: string, workspace_id: string) => ({
      correlation_key,
      workspace_id,
      title: `Goal ${workspace_id}`,
      goal: "Run in the bound Workspace.",
      requirements: ["Keep Workspace ownership immutable."],
      acceptance_criteria: ["Only the correlated Goal starts."],
      max_iterations: 1,
    });

    await pending.accept(input(KEY_A, "workspace-a"));
    await pending.accept(input(KEY_B, "workspace-b"));
    await correlations.observe({
      request_id: KEY_B,
      conversation_id: "conversation-b",
      document_id: "document-b",
      navigation_epoch: 1,
    });
    await waitFor(async () => (await pending.get(KEY_B))?.state === "started");
    expect(starts).toHaveBeenCalledTimes(1);
    expect(starts).toHaveBeenLastCalledWith(expect.objectContaining({
      workspace_id: "workspace-b",
      conversation_id: "conversation-b",
    }));
    await expect(pending.get(KEY_A)).resolves.toMatchObject({
      state: "pending_identity",
      workspace_id: "workspace-a",
    });

    await correlations.observe({
      request_id: KEY_A,
      conversation_id: "conversation-a",
      document_id: "document-a",
      navigation_epoch: 1,
    });
    await waitFor(async () => (await pending.get(KEY_A))?.state === "started");
    expect(starts).toHaveBeenLastCalledWith(expect.objectContaining({
      workspace_id: "workspace-a",
      conversation_id: "conversation-a",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("stores connector evidence under the requested Workspace instead of the active one", async () => {
    const fixture = await workspaceFixture();
    const localAppData = await root("lrm-multi-state-");
    const context = createAppContext(fixture.settings, { LOCALAPPDATA: localAppData });
    const storageRoot = join(localAppData, "LocalReviewMCP");
    const evidence = (workspace_id: string, request_id: string) => ({
      request_id,
      tool_name: "workspace_info",
      workspace_id,
      mcp_resource: "https://mcp.example.test/mcp",
      authentication: "oauth" as const,
      success: true,
      completed_at: new Date().toISOString(),
    });

    await context.connectorEvidence!.recordEvidence(evidence("workspace-a", "request-a"));
    await context.connectorEvidence!.recordEvidence(evidence("workspace-b", "request-b"));
    const stateA = JSON.parse(await readFile(
      join(storageRoot, "workspaces", "ws-workspace-a", "control-plane", "chatgpt-connector.json"),
      "utf8",
    )) as { evidence: Array<{ request_id: string; workspace_id: string }> };
    const stateB = JSON.parse(await readFile(
      join(storageRoot, "workspaces", "ws-workspace-b", "control-plane", "chatgpt-connector.json"),
      "utf8",
    )) as { evidence: Array<{ request_id: string; workspace_id: string }> };
    expect(stateA.evidence).toEqual([expect.objectContaining({ request_id: "request-a", workspace_id: "workspace-a" })]);
    expect(stateB.evidence).toEqual([expect.objectContaining({ request_id: "request-b", workspace_id: "workspace-b" })]);
    await expect(context.connectorEvidence!.recordEvidence(evidence("workspace-missing", "request-x")))
      .rejects.toThrow("Unknown workspace_id");
  });

  it("keeps Desktop and standalone capability requests scoped to each Execution Workspace", async () => {
    const standaloneStarts: ExecutionBackendStartRequest[] = [];
    const blocked: CapabilityPreparation = { ready: false, reason: "desktop_handoff_failed" };
    const negotiator = new CapabilityNegotiator({
      desktop: {
        source: "desktop",
        prepare: async () => blocked,
        start: async () => { throw new Error("Desktop must not start"); },
      },
      standalone: {
        source: "standalone",
        prepare: async () => ({ ready: true }),
        start: async (input): Promise<ExecutionStartResult> => {
          standaloneStarts.push(input);
          return {
            execution_id: input.execution_id,
            accepted: "new",
            started_at: new Date().toISOString(),
          };
        },
      },
      fallbackTimeoutMs: 0,
      workspaceId: "workspace-a",
    });

    await Promise.all([
      negotiator.start(request("workspace-a", "a")),
      negotiator.start(request("workspace-b", "b")),
    ]);
    expect(standaloneStarts.map((input) => input.workspace_id).sort())
      .toEqual(["workspace-a", "workspace-b"]);
    expect(negotiator.context("execution-a")).toMatchObject({ workspace_id: "workspace-a" });
    expect(negotiator.context("execution-b")).toMatchObject({ workspace_id: "workspace-b" });
  });

  it("keeps Review A/B isolated after the active Workspace changes and rejects unknown Workspaces", async () => {
    const fixture = await workspaceFixture();
    const storageRoot = await root("lrm-multi-review-");
    const goalService = new GoalOrchestrationService(fixture.registry, { storageRoot });
    const goalPlan = (workspace_id: string, suffix: string) => ({
      goal_id: `goal-${suffix}`,
      workspace_id,
      conversation_id: `conversation-${suffix}`,
      phases: [{
        phase_id: `phase-${suffix}`,
        objective: `Keep ${workspace_id} immutable`,
        tasks: [{
          task_id: `goal-task-${suffix}`,
          goal: `Review ${workspace_id}`,
          requirements: ["Do not switch ownership"],
          acceptance_criteria: [`Workspace remains ${workspace_id}`],
          max_iterations: 1,
        }],
      }],
    });
    await goalService.createGoal(goalPlan("workspace-a", "a"));
    const goalB = await goalService.createGoal(goalPlan("workspace-b", "b"));
    const reviewA = await deliveredReview(storageRoot, fixture.registry, "workspace-a", "a");
    const reviewB = await deliveredReview(storageRoot, fixture.registry, "workspace-b", "b");

    const activeB = new WorkspaceRegistry(fixture.workspaces, { activeWorkspaceId: "workspace-b" });
    const collect = vi.fn(async (input: ReviewCompletionRequest) => ({
      status: "COMPLETED" as const,
      content: `${input.workspace_id} approved`,
    }));
    const router = new ReviewCompletionRouter(storageRoot, { collect }, activeB);
    const resultA = await router.collect("workspace-a", reviewA.routing.routing_id);

    expect(resultA).toMatchObject({
      workspace_id: "workspace-a",
      review_request_id: reviewA.reviewRequest.review_request_id,
      delivery_id: reviewA.delivery.delivery_id,
      status: "COMPLETED",
    });
    await expect(new GoalOrchestrationService(activeB, { storageRoot }).getGoal("goal-a"))
      .resolves.toMatchObject({ workspace_id: "workspace-a" });
    await expect(new GoalOrchestrationService(activeB, { storageRoot }).getGoal("goal-b"))
      .resolves.toEqual(goalB);
    await expect(new ExecutionContextService(storageRoot).getExecutionContext(
      "workspace-a",
      "review-task-a",
      "review-execution-a",
    )).resolves.toMatchObject({ workspace_id: "workspace-a" });
    await expect(new ReviewRequestService(storageRoot).getReviewRequest(
      "workspace-b",
      reviewB.reviewRequest.review_request_id,
    )).resolves.not.toMatchObject({ status: "completed" });
    await expect(new ReviewResultService(storageRoot).listReviewResults("workspace-b"))
      .resolves.toEqual([]);

    await expect(router.collect("workspace-missing", reviewA.routing.routing_id))
      .rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE_ID" });
    await expect(router.collect("workspace-b", reviewA.routing.routing_id))
      .rejects.toThrow("was not found");
    expect(collect).toHaveBeenCalledTimes(1);

    const resultB = await router.collect("workspace-b", reviewB.routing.routing_id);
    expect(resultB).toMatchObject({
      workspace_id: "workspace-b",
      review_request_id: reviewB.reviewRequest.review_request_id,
      status: "COMPLETED",
    });
    await expect(new ReviewResultService(storageRoot).listReviewResults("workspace-a"))
      .resolves.toEqual([resultA]);
  });

  it("routes each Goal through its Workspace project and creates a distinct Thread", async () => {
    const fixture = await workspaceFixture();
    const storageRoot = await root("lrm-multi-desktop-");
    const tasks = new TaskContextService(storageRoot);
    const requests = [
      request("workspace-a", "a1"),
      request("workspace-a", "a2"),
      request("workspace-b", "b1"),
    ];
    for (const value of requests) {
      await tasks.createTaskContext({ task_id: value.task_id, workspace_id: value.workspace_id });
    }

    const projectByPath = new Map([
      [fixture.registry.resolve("workspace-a").manager.canonicalRoot, "project-a"],
      [fixture.registry.resolve("workspace-b").manager.canonicalRoot, "project-b"],
    ]);
    const createCalls: Array<{ projectId: string; threadId: string }> = [];
    let threadNumber = 0;
    const client = {
      callTool: async (params: CallToolRequestParams): Promise<CallToolResult> => {
        if (params.name === "list_projects") {
          return jsonResult({ projects: [...projectByPath].map(([path, projectId]) => ({
            projectId,
            hostId: "local",
            projectKind: "local",
            path,
          })) });
        }
        if (params.name === "create_thread") {
          threadNumber += 1;
          const target = (params.arguments as { target: { projectId: string } }).target;
          const threadId = `thread-${threadNumber}`;
          createCalls.push({ projectId: target.projectId, threadId });
          return jsonResult({ threadId, hostId: "local" });
        }
        if (params.name === "read_thread") {
          const threadId = (params.arguments as { threadId: string }).threadId;
          return jsonResult({ thread: { id: threadId, hostId: "local", status: { type: "idle" } }, turns: [] });
        }
        return jsonResult({ timedOut: true, polls: [] });
      },
    };
    const runtime = (): DesktopCodexRuntimeLike & { readonly mcpClient: typeof client } => ({
      info: {
        desktopDetected: true,
        bundleDetected: true,
        mcpTransport: "stdio",
        nativeDesktopTransport: "windows_named_pipe",
      },
      listTools: async () => ({ tools: desktopTools() as never }),
      mcpClient: client,
      close: async () => undefined,
    });
    const backend = new DesktopCodexBackend(fixture.registry, {
      storageRoot,
      runtimeFactory: { connect: async () => runtime() },
      desktopState: () => ({
        connected: true,
        currentConversationId: "executor-thread",
        followingThreads: new Set<string>(),
        ownerClientId: "desktop-owner",
      }),
      completionTimeoutMs: 60_000,
    });

    try {
      const results = [];
      for (const value of requests) results.push(await backend.start(value));
      expect(createCalls).toEqual([
        { projectId: "project-a", threadId: "thread-1" },
        { projectId: "project-a", threadId: "thread-2" },
        { projectId: "project-b", threadId: "thread-3" },
      ]);
      expect(results.map((result) => result.thread_id)).toEqual(["thread-1", "thread-2", "thread-3"]);
    } finally {
      await backend.close();
    }
  });
});
