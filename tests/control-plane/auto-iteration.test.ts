import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoIterationService,
  autoIterationSchema,
  autoIterationStateFile,
  buildAutoIterationInstruction,
  type AutoIteration,
  type AutoIterationStartInput,
} from "../../src/control-plane/auto-iteration.js";
import {
  ControlledActuationService,
} from "../../src/control-plane/controlled-actuation.js";
import {
  CodexExecutionCompletionService,
  codexExecutionLogPaths,
} from "../../src/control-plane/codex-execution-completion.js";
import { ExtensionDeliveryService } from "../../src/control-plane/extension-delivery.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { ReviewRequestService } from "../../src/context/review-request-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { BrowserRouter } from "../../src/router/browser-router.js";
import { ReviewCompletionRouter } from "../../src/router/review-completion-router.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

function verdict(
  reviewRequestId: string,
  decision: "APPROVE" | "ITERATE" | "HUMAN_REQUIRED",
): string {
  return `<lrm-review-result>${JSON.stringify({
    schema_version: 1,
    review_request_id: reviewRequestId,
    decision,
    summary: `${decision} summary`,
    ...(decision === "ITERATE" ? {
      iteration: {
        goal: "Fix the blocking defect",
        requirements: ["Change the implementation"],
        acceptance_criteria: ["The focused test passes"],
      },
    } : {}),
  })}</lrm-review-result>`;
}

async function fixture(
  decisions: Array<"APPROVE" | "ITERATE" | "HUMAN_REQUIRED"> = ["APPROVE"],
  delivery: "delivered" | "failed" = "delivered",
): Promise<{
  readonly root: string;
  readonly registry: WorkspaceRegistry;
  readonly executionService: ExecutionContextService;
  readonly starts: Array<{ execution_id: string; instruction: string }>;
  readonly completionCalls: ReturnType<typeof vi.fn>;
  readonly auto: AutoIterationService;
}> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-auto-iteration-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-auto-workspace-"));
  temporaryDirectories.push(root, workspaceRoot);
  const registry = new WorkspaceRegistry([{
    id: "workspace-a",
    name: "Workspace A",
    path: workspaceRoot,
  }]);
  const taskService = new TaskContextService(root);
  const executionService = new ExecutionContextService(root);
  await taskService.createTaskContext({ task_id: "task-001", workspace_id: "workspace-a" });
  await executionService.createExecutionContext({
    execution_id: "execution-001",
    task_id: "task-001",
    workspace_id: "workspace-a",
    status: "passed",
  });

  const starts: Array<{ execution_id: string; instruction: string }> = [];
  const controlled = new ControlledActuationService(registry, {
    storageRoot: root,
    adapter: {
      start: vi.fn(async (request) => {
        starts.push({ execution_id: request.execution_id, instruction: request.instruction });
        const execution = await executionService.createExecutionContext({
          execution_id: request.execution_id,
          task_id: request.task_id,
          workspace_id: request.workspace_id,
          process_id: 7000 + starts.length,
          command: "codex exec --json -",
        });
        return {
          execution_id: execution.execution_id,
          process_id: execution.process_id!,
          started_at: execution.started_at,
          accepted: "new" as const,
        };
      }),
    },
  });
  const completionCalls = vi.fn();
  const completion = new ReviewCompletionRouter(root, {
    collectCompletion: vi.fn(async (_conversationId, reviewRequestId) => {
      completionCalls(reviewRequestId);
      const decision = decisions[Math.min(completionCalls.mock.calls.length - 1, decisions.length - 1)]!;
      return {
        conversationId: "conversation-001",
        status: "COMPLETED" as const,
        content: verdict(reviewRequestId, decision),
        extractedAt: new Date().toISOString(),
      };
    }),
  });
  const router = new BrowserRouter(root, {
    deliver: vi.fn(async () => delivery === "delivered"
      ? { status: "delivered" as const, delivered_at: new Date().toISOString() }
      : {
        status: "failed" as const,
        retryable: false,
        error: { code: "TEST_DELIVERY_FAILED", message: "delivery failed" },
      }),
  });
  const auto = new AutoIterationService(registry, {
    storageRoot: root,
    taskContextService: taskService,
    executionContextService: executionService,
    browserRouter: router,
    completionRouter: completion,
    controlledActuation: controlled,
  });
  return { root, registry, executionService, starts, completionCalls, auto };
}

async function persistLoop(root: string, loop: AutoIteration): Promise<void> {
  const file = autoIterationStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    schema_version: 1,
    loops: [autoIterationSchema.parse(loop)],
  }, null, 2)}\n`, "utf8");
}

function startInput(overrides: Partial<AutoIterationStartInput> = {}): AutoIterationStartInput {
  return {
    loop_id: "loop-001",
    workspace_id: "workspace-a",
    task_id: "task-001",
    conversation_id: "conversation-001",
    execution_id: "execution-001",
    max_iterations: 2,
    ...overrides,
  };
}

describe("AutoIterationService", () => {
  it("completes an approved execution without starting another Codex process", async () => {
    const value = await fixture(["APPROVE"]);

    const loop = await value.auto.start(startInput());

    expect(loop).toMatchObject({
      loop_id: "loop-001",
      iteration: 1,
      stage: "completed",
      terminal_decision: "APPROVE",
      review_request_id: expect.any(String),
      routing_id: expect.any(String),
      delivery_id: expect.any(String),
      review_result_id: expect.any(String),
    });
    expect(value.starts).toHaveLength(0);
    await expect(new TaskContextService(value.root).getTaskContext("task-001"))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("maps ITERATE into one controlled next actuation and three-section instruction", async () => {
    const value = await fixture(["ITERATE", "APPROVE"]);

    const loop = await value.auto.start(startInput());

    expect(loop).toMatchObject({
      iteration: 2,
      stage: "execution",
      actuation_id: expect.any(String),
      authorization_id: expect.any(String),
    });
    expect(loop.execution_id).not.toBe("execution-001");
    expect(value.starts).toHaveLength(1);
    expect(value.starts[0]!.instruction).toBe(buildAutoIterationInstruction({
      goal: "Fix the blocking defect",
      requirements: ["Change the implementation"],
      acceptance_criteria: ["The focused test passes"],
    }));

    const completed = await value.executionService.updateExecutionContext(
      "workspace-a",
      "task-001",
      loop.execution_id,
      { status: "passed" },
    );
    await value.auto.onExecutionTerminal(completed);
    await expect(value.auto.getLoop("loop-001")).resolves.toMatchObject({
      iteration: 2,
      stage: "completed",
      terminal_decision: "APPROVE",
    });
    expect(value.starts).toHaveLength(1);
    expect(await new ReviewRequestService(value.root).listReviewRequests("workspace-a"))
      .toHaveLength(2);
  });

  it("stops for HUMAN_REQUIRED, max iterations, invalid verdicts, and delivery failures", async () => {
    const human = await fixture(["HUMAN_REQUIRED"]);
    await expect(human.auto.start(startInput())).resolves.toMatchObject({
      stage: "human_required",
      terminal_decision: "HUMAN_REQUIRED",
    });
    expect(human.starts).toHaveLength(0);

    const maxed = await fixture(["ITERATE"]);
    await expect(maxed.auto.start(startInput({ max_iterations: 1 }))).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: "MAX_ITERATIONS_REACHED",
    });
    expect(maxed.starts).toHaveLength(0);

    const invalid = await fixture(["APPROVE"]);
    const invalidCompletion = new ReviewCompletionRouter(invalid.root, {
      collectCompletion: vi.fn(async (_conversationId, reviewRequestId) => ({
        conversationId: "conversation-001",
        status: "COMPLETED" as const,
        content: "ordinary review prose without a machine block",
        extractedAt: new Date().toISOString(),
      })),
    });
    const invalidAuto = new AutoIterationService(invalid.registry, {
      storageRoot: invalid.root,
      completionRouter: invalidCompletion,
      browserRouter: invalid.auto.browserRouter,
      controlledActuation: invalid.auto.controlledActuation,
    });
    await expect(invalidAuto.start(startInput())).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: expect.stringContaining("VERDICT_BLOCK_MISSING"),
    });
    expect(invalid.starts).toHaveLength(0);

    const failedDelivery = await fixture(["APPROVE"], "failed");
    await expect(failedDelivery.auto.start(startInput())).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: "DELIVERY_FAILED",
    });
    expect(failedDelivery.starts).toHaveLength(0);
  });

  it("coalesces duplicate and concurrent advancement", async () => {
    const value = await fixture(["APPROVE"]);

    const [first, second, third] = await Promise.all([
      value.auto.start(startInput()),
      value.auto.start(startInput()),
      value.auto.advance("loop-001"),
    ]);

    expect(first.stage).toBe("completed");
    expect(second.stage).toBe("completed");
    expect(third.stage).toBe("completed");
    expect(await new ReviewRequestService(value.root).listReviewRequests("workspace-a"))
      .toHaveLength(1);
    expect(value.completionCalls).toHaveBeenCalledTimes(1);
  });

  it("uses the Extension outbox path for the default review BrowserRouter", async () => {
    const value = await fixture(["APPROVE"]);
    const extension = new ExtensionDeliveryService(value.root);
    const auto = new AutoIterationService(value.registry, {
      storageRoot: value.root,
      extensionDeliveries: extension,
      completionRouter: value.auto.completionRouter,
      controlledActuation: value.auto.controlledActuation,
    });
    const pending = auto.start(startInput());
    let command: { delivery_id: string } | undefined;
    for (let attempt = 0; attempt < 100 && command === undefined; attempt += 1) {
      try {
        const state = JSON.parse(await readFile(join(value.root, "control-plane", "extension-deliveries.json"), "utf8")) as {
          deliveries?: Array<{ delivery_id: string }>;
        };
        command = state.deliveries?.[0];
      } catch {
        // The outbox is created lazily by the delivery path.
      }
      if (command === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(command).toBeDefined();
    const owner = {
      conversation_id: "conversation-001",
      client_id: "client-auto",
      document_id: "document-auto",
      navigation_epoch: 0,
    };
    const claimed = await extension.claim(owner);
    expect(claimed?.delivery_id).toBe(command?.delivery_id);
    await extension.acknowledge({
      ...owner,
      delivery_id: command!.delivery_id,
      status: "sent",
      message_id: "message-auto",
    });
    await expect(pending).resolves.toMatchObject({ stage: "completed" });
  });

  it("stops when the bound execution fails and never creates a review", async () => {
    const value = await fixture(["APPROVE"]);
    await value.executionService.updateExecutionContext(
      "workspace-a",
      "task-001",
      "execution-001",
      { status: "failed", summary: "execution failed" },
    );

    await expect(value.auto.start(startInput())).resolves.toMatchObject({
      stage: "failed",
      terminal_decision: "FAILED",
      terminal_reason: "EXECUTION_FAILED",
    });
    expect(await new ReviewRequestService(value.root).listReviewRequests("workspace-a"))
      .toHaveLength(0);
  });

  it("starts the review chain from the live execution terminal notification", async () => {
    const value = await fixture(["APPROVE"]);
    await value.executionService.updateExecutionContext(
      "workspace-a",
      "task-001",
      "execution-001",
      { status: "running", process_id: 8201 },
    );
    await expect(value.auto.start(startInput())).resolves.toMatchObject({ stage: "execution" });
    const paths = codexExecutionLogPaths(value.root, "workspace-a", "task-001", "execution-001");
    await mkdir(dirname(paths.stdout), { recursive: true });
    await writeFile(paths.stdout, `${JSON.stringify({ type: "turn.completed" })}\n`, "utf8");

    const completion = new CodexExecutionCompletionService(value.root, {
      processProbe: () => "alive",
      onTerminal: (execution) => value.auto.onExecutionTerminal(execution),
    });
    await expect(completion.reconcile({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-001",
    })).resolves.toMatchObject({ status: "passed" });
    await expect(value.auto.getLoop("loop-001")).resolves.toMatchObject({ stage: "completed" });
  });

  it("uses the same durable loop after a restart", async () => {
    const value = await fixture(["APPROVE"]);
    const first = await value.auto.start(startInput());
    const restarted = new AutoIterationService(value.registry, {
      storageRoot: value.root,
      browserRouter: {
        deliver: vi.fn(async () => {
          throw new Error("must not deliver a completed loop");
        }),
      },
      completionRouter: {
        collect: vi.fn(async () => {
          throw new Error("must not collect a completed loop");
        }),
      },
      controlledActuation: value.auto.controlledActuation,
    });

    await expect(restarted.recover()).resolves.toBeUndefined();
    await expect(restarted.getLoop(first.loop_id)).resolves.toMatchObject({
      stage: "completed",
      terminal_decision: "APPROVE",
    });
    expect(await new ReviewRequestService(value.root).listReviewRequests("workspace-a"))
      .toHaveLength(1);
  });

  it("recovers an authorization and a started actuation by their stable actuation id", async () => {
    const value = await fixture(["APPROVE"]);
    const pendingIteration = {
      goal: "Recover the launch",
      requirements: ["Keep the launch idempotent"],
      acceptance_criteria: ["Only one process is started"],
    };
    const instruction = buildAutoIterationInstruction(pendingIteration);
    const authorization = await value.auto.controlledActuation.authorize({
      actuation_id: "actuation-recovery",
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-recovery",
      instruction,
    });
    const firstLoop = {
      loop_id: "loop-recovery",
      initial_execution_id: "execution-001",
      workspace_id: "workspace-a",
      task_id: "task-001",
      conversation_id: "conversation-001",
      max_iterations: 2,
      iteration: 2,
      execution_id: "execution-recovery",
      actuation_id: "actuation-recovery",
      pending_iteration: pendingIteration,
      stage: "actuation" as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await persistLoop(value.root, firstLoop);
    const starts: number[] = [];
    const recoveredControlled = new ControlledActuationService(value.registry, {
      storageRoot: value.root,
      adapter: {
        start: vi.fn(async (request) => {
          starts.push(request.execution_id.length);
          const execution = await value.executionService.createExecutionContext({
            execution_id: request.execution_id,
            task_id: request.task_id,
            workspace_id: request.workspace_id,
            process_id: 8101,
          });
          return {
            execution_id: execution.execution_id,
            process_id: execution.process_id!,
            started_at: execution.started_at,
            accepted: "new" as const,
          };
        }),
      },
    });
    const recovered = new AutoIterationService(value.registry, {
      storageRoot: value.root,
      controlledActuation: recoveredControlled,
    });

    await recovered.recover();

    await expect(recovered.getLoop("loop-recovery")).resolves.toMatchObject({
      stage: "execution",
      authorization_id: authorization.authorization_id,
    });
    expect(starts).toHaveLength(1);

    const startedAuthorization = await recoveredControlled.authorize({
      actuation_id: "actuation-started",
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-started",
      instruction,
    });
    await recoveredControlled.actuate({
      actuation_id: startedAuthorization.actuation_id,
      authorization_id: startedAuthorization.authorization_id,
    });
    await persistLoop(value.root, {
      ...firstLoop,
      loop_id: "loop-started",
      execution_id: "execution-started",
      actuation_id: "actuation-started",
      stage: "actuation",
      authorization_id: undefined,
    });
    const noSpawn = vi.fn(async () => {
      throw new Error("must not spawn a second process");
    });
    const restarted = new AutoIterationService(value.registry, {
      storageRoot: value.root,
      controlledActuation: new ControlledActuationService(value.registry, {
        storageRoot: value.root,
        adapter: { start: noSpawn },
      }),
    });

    await restarted.recover();

    await expect(restarted.getLoop("loop-started")).resolves.toMatchObject({ stage: "execution" });
    expect(noSpawn).not.toHaveBeenCalled();
  });
});
