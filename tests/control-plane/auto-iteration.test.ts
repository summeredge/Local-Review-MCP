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
  controlledActuationStateFile,
} from "../../src/control-plane/controlled-actuation.js";
import {
  CodexExecutionCompletionService,
  codexExecutionLogPaths,
} from "../../src/control-plane/codex-execution-completion.js";
import { ExtensionDeliveryService } from "../../src/control-plane/extension-delivery.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { ConversationRoutingService } from "../../src/context/conversation-routing-service.js";
import { ReviewDeliveryService } from "../../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../../src/context/review-request-service.js";
import { ReviewResultService } from "../../src/context/review-result-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { BrowserRouter } from "../../src/router/browser-router.js";
import { ReviewCompletionRouter } from "../../src/router/review-completion-router.js";
import { BrowserWorkerReviewCompletionAdapter } from "../../src/delivery/browser-worker-review-completion-adapter.js";
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
  delivery: "delivered" | "failed" | "ambiguous" = "delivered",
): Promise<{
  readonly root: string;
  readonly registry: WorkspaceRegistry;
  readonly executionService: ExecutionContextService;
  readonly starts: Array<{ execution_id: string; instruction: string }>;
  readonly deliveryCalls: ReturnType<typeof vi.fn>;
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
  const completion = new ReviewCompletionRouter(root, new BrowserWorkerReviewCompletionAdapter({
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
  }));
  const deliveryCalls = vi.fn(async () => {
    if (delivery === "delivered") {
      return { status: "delivered" as const, delivered_at: new Date().toISOString() };
    }
    if (delivery === "ambiguous") {
      return {
        status: "ambiguous" as const,
        error: { code: "TEST_DELIVERY_AMBIGUOUS", message: "delivery outcome is ambiguous" },
      };
    }
    return {
      status: "failed" as const,
      retryable: false,
      error: { code: "TEST_DELIVERY_FAILED", message: "delivery failed" },
    };
  });
  const router = new BrowserRouter(root, { deliver: deliveryCalls });
  const auto = new AutoIterationService(registry, {
    storageRoot: root,
    taskContextService: taskService,
    executionContextService: executionService,
    browserRouter: router,
    completionRouter: completion,
    controlledActuation: controlled,
  });
  return { root, registry, executionService, starts, deliveryCalls, completionCalls, auto };
}

async function persistLoop(root: string, loop: AutoIteration): Promise<void> {
  const file = autoIterationStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    schema_version: 1,
    loops: [autoIterationSchema.parse(loop)],
  }, null, 2)}\n`, "utf8");
}

async function createDurableReviewChain(root: string, suffix: string): Promise<{
  readonly request: Awaited<ReturnType<ReviewRequestService["createReviewRequest"]>>;
  readonly routing: Awaited<ReturnType<ConversationRoutingService["createRouting"]>>;
  readonly delivery: Awaited<ReturnType<ReviewDeliveryService["createDelivery"]>>;
}> {
  const request = await new ReviewRequestService(root).createReviewRequest({
    review_request_id: `review-${suffix}-request`,
    task_id: "task-001",
    execution_id: "execution-001",
    workspace_id: "workspace-a",
    conversation_id: "conversation-001",
  });
  const routing = await new ConversationRoutingService(root).createRouting({
    routing_id: `routing-${suffix}`,
    workspace_id: "workspace-a",
    task_id: "task-001",
    execution_id: "execution-001",
    review_request_id: request.review_request_id,
    conversation_id: "conversation-001",
  });
  const delivery = await new ReviewDeliveryService(root).createDelivery({
    delivery_id: `delivery-${suffix}`,
    workspace_id: "workspace-a",
    task_id: "task-001",
    review_request_id: request.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: "conversation-001",
  });
  return { request, routing, delivery };
}

function checkpoint(overrides: Partial<AutoIteration> = {}): AutoIteration {
  const timestamp = new Date().toISOString();
  return autoIterationSchema.parse({
    loop_id: "loop-checkpoint",
    initial_execution_id: "execution-001",
    workspace_id: "workspace-a",
    task_id: "task-001",
    conversation_id: "conversation-001",
    max_iterations: 2,
    iteration: 1,
    execution_id: "execution-001",
    stage: "review_request",
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  });
}

async function optionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "<absent>";
  }
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
  it("notifies only after terminal persistence and replays terminal notifications on recovery", async () => {
    const f = await fixture();
    const listener = vi.fn(async (loop: AutoIteration) => {
      expect(await f.auto.getLoop(loop.loop_id)).toEqual(loop);
      throw new Error("listener unavailable");
    });
    f.auto.setTerminalListener(listener);

    const terminal = await f.auto.start(startInput());
    expect(terminal.stage).toBe("completed");
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect((await f.auto.getLoop(terminal.loop_id))!.stage).toBe("completed");

    const recoveredListener = vi.fn();
    const restarted = new AutoIterationService(f.registry, {
      storageRoot: f.root,
      terminalListener: recoveredListener,
    });
    await restarted.recover();
    await vi.waitFor(() => expect(recoveredListener).toHaveBeenCalledWith(terminal));
  });

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

  it("maps HUMAN_REQUIRED verdicts to human_required without starting another execution", async () => {
    const human = await fixture(["HUMAN_REQUIRED"]);
    await expect(human.auto.start(startInput())).resolves.toMatchObject({
      stage: "human_required",
      terminal_decision: "HUMAN_REQUIRED",
    });
    expect(human.starts).toHaveLength(0);
    expect((await new TaskContextService(human.root).getTaskContext("task-001"))!.status)
      .toBe("human_required");
  });

  it("maps max_iterations reached to human_required without starting another execution", async () => {
    const maxed = await fixture(["ITERATE"]);
    await expect(maxed.auto.start(startInput({ max_iterations: 1 }))).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: "MAX_ITERATIONS_REACHED",
    });
    expect(maxed.starts).toHaveLength(0);
  });

  it.each([
    {
      name: "machine verdict missing",
      content: "ordinary review prose without a machine block",
      reason: "INVALID_VERDICT_VERDICT_BLOCK_MISSING",
    },
    {
      name: "malformed JSON",
      content: "<lrm-review-result>{not-json}</lrm-review-result>",
      reason: "INVALID_VERDICT_VERDICT_JSON_INVALID",
    },
    {
      name: "invalid schema",
      content: `<lrm-review-result>${JSON.stringify({
        schema_version: 1,
        review_request_id: "review-schema-invalid",
        decision: "ITERATE",
        summary: "missing iteration payload",
      })}</lrm-review-result>`,
      reason: "INVALID_VERDICT_VERDICT_SCHEMA_INVALID",
    },
    {
      name: "wrong review_request_id",
      content: verdict("review-request-does-not-match", "APPROVE"),
      reason: "INVALID_VERDICT_REVIEW_REQUEST_MISMATCH",
    },
  ])("maps $name to human_required without starting another execution", async ({ content, reason }) => {
    const invalid = await fixture(["APPROVE"]);
    const invalidCompletion = new ReviewCompletionRouter(invalid.root, new BrowserWorkerReviewCompletionAdapter({
      collectCompletion: vi.fn(async () => ({
        conversationId: "conversation-001",
        status: "COMPLETED" as const,
        content,
        extractedAt: new Date().toISOString(),
      })),
    }));
    const invalidAuto = new AutoIterationService(invalid.registry, {
      storageRoot: invalid.root,
      completionRouter: invalidCompletion,
      browserRouter: invalid.auto.browserRouter,
      controlledActuation: invalid.auto.controlledActuation,
    });
    await expect(invalidAuto.start(startInput())).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: reason,
    });
    expect(invalid.starts).toHaveLength(0);
  });

  it.each(["TIMEOUT", "FAILED"] as const)(
    "maps Review Result %s to human_required without retrying completion",
    async (status) => {
      const value = await fixture(["APPROVE"]);
      const collectCompletion = vi.fn(async () => ({
        conversationId: "conversation-001",
        status,
        error: `review completion ${status.toLowerCase()}`,
      }));
      const completion = new ReviewCompletionRouter(
        value.root,
        new BrowserWorkerReviewCompletionAdapter({ collectCompletion }),
      );
      const auto = new AutoIterationService(value.registry, {
        storageRoot: value.root,
        completionRouter: completion,
        browserRouter: value.auto.browserRouter,
        controlledActuation: value.auto.controlledActuation,
      });

      await expect(auto.start(startInput())).resolves.toMatchObject({
        stage: "human_required",
        terminal_reason: `REVIEW_COMPLETION_${status}`,
      });
      expect(value.starts).toHaveLength(0);
      expect(collectCompletion).toHaveBeenCalledTimes(1);
      expect(await new ReviewResultService(value.root).listReviewResults("workspace-a"))
        .toHaveLength(1);

      await auto.recover();
      expect(collectCompletion).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["failed", "ambiguous"] as const)(
    "maps Review Delivery %s to human_required without retrying delivery",
    async (delivery) => {
      const value = await fixture(["APPROVE"], delivery);
      await expect(value.auto.start(startInput())).resolves.toMatchObject({
        stage: "human_required",
        terminal_reason: "DELIVERY_FAILED",
      });
      expect(value.starts).toHaveLength(0);
      expect(value.deliveryCalls).toHaveBeenCalledTimes(1);

      await value.auto.recover();
      expect(value.deliveryCalls).toHaveBeenCalledTimes(1);
    },
  );

  it("does not duplicate a Review Request created before the loop checkpoint advanced", async () => {
    const value = await fixture(["APPROVE"]);
    const chain = await createDurableReviewChain(value.root, "request-crash");
    await persistLoop(value.root, checkpoint({
      loop_id: "loop-request-crash",
      review_request_id: chain.request.review_request_id,
      stage: "review_request",
    }));

    const restarted = new AutoIterationService(value.registry, {
      storageRoot: value.root,
      browserRouter: value.auto.browserRouter,
      completionRouter: value.auto.completionRouter,
      controlledActuation: value.auto.controlledActuation,
    });
    await restarted.recover();

    await expect(restarted.getLoop("loop-request-crash")).resolves.toMatchObject({
      stage: "completed",
      review_request_id: chain.request.review_request_id,
    });
    expect(await new ReviewRequestService(value.root).listReviewRequests("workspace-a"))
      .toHaveLength(1);
    expect(value.starts).toHaveLength(0);
  });

  it("skips delivery after a delivered checkpoint and continues into completion", async () => {
    const value = await fixture(["APPROVE"]);
    const chain = await createDurableReviewChain(value.root, "delivery-crash");
    const deliveries = new ReviewDeliveryService(value.root);
    await deliveries.beginDeliveryAttempt("workspace-a", chain.delivery.delivery_id);
    const delivered = await deliveries.markDelivered("workspace-a", chain.delivery.delivery_id);
    const delivery = vi.fn(async () => {
      throw new Error("must not retry a delivered review");
    });
    const collectCompletion = vi.fn(async (_conversationId: string, reviewRequestId: string) => ({
      conversationId: "conversation-001",
      status: "COMPLETED" as const,
      content: verdict(reviewRequestId, "APPROVE"),
      extractedAt: new Date().toISOString(),
    }));
    const completion = new ReviewCompletionRouter(
      value.root,
      new BrowserWorkerReviewCompletionAdapter({ collectCompletion }),
    );
    const restarted = new AutoIterationService(value.registry, {
      storageRoot: value.root,
      browserRouter: { deliver: delivery },
      completionRouter: completion,
      controlledActuation: value.auto.controlledActuation,
    });
    await persistLoop(value.root, checkpoint({
      loop_id: "loop-delivery-crash",
      review_request_id: chain.request.review_request_id,
      routing_id: chain.routing.routing_id,
      delivery_id: delivered.delivery_id,
      stage: "delivery",
    }));

    await restarted.recover();

    await expect(restarted.getLoop("loop-delivery-crash")).resolves.toMatchObject({
      stage: "completed",
      delivery_id: delivered.delivery_id,
    });
    expect(delivery).not.toHaveBeenCalled();
    expect(collectCompletion).toHaveBeenCalledTimes(1);
    expect(await new ReviewResultService(value.root).listReviewResults("workspace-a"))
      .toHaveLength(1);
  });

  it("reuses a completed Review Result without collecting completion again", async () => {
    const value = await fixture(["APPROVE"]);
    const chain = await createDurableReviewChain(value.root, "result-crash");
    const deliveries = new ReviewDeliveryService(value.root);
    await deliveries.beginDeliveryAttempt("workspace-a", chain.delivery.delivery_id);
    const delivered = await deliveries.markDelivered("workspace-a", chain.delivery.delivery_id);
    const result = await new ReviewResultService(value.root).createReviewResult({
      result_id: "result-result-crash",
      review_request_id: chain.request.review_request_id,
      delivery_id: delivered.delivery_id,
      workspace_id: "workspace-a",
      task_id: "task-001",
      status: "COMPLETED",
      content: verdict(chain.request.review_request_id, "APPROVE"),
    });
    const collect = vi.fn(async () => {
      throw new Error("must not recollect a completed review");
    });
    const restarted = new AutoIterationService(value.registry, {
      storageRoot: value.root,
      browserRouter: { deliver: vi.fn(async () => {
        throw new Error("must not redeliver a completed review");
      }) },
      completionRouter: { collect },
      controlledActuation: value.auto.controlledActuation,
    });
    await persistLoop(value.root, checkpoint({
      loop_id: "loop-result-crash",
      review_request_id: chain.request.review_request_id,
      routing_id: chain.routing.routing_id,
      delivery_id: delivered.delivery_id,
      review_result_id: result.result_id,
      stage: "review_completion",
    }));

    await restarted.recover();

    await expect(restarted.getLoop("loop-result-crash")).resolves.toMatchObject({
      stage: "completed",
      review_result_id: result.result_id,
    });
    await expect(new ReviewRequestService(value.root)
      .getReviewRequest("workspace-a", chain.request.review_request_id))
      .resolves.toMatchObject({ status: "completed" });
    expect(collect).not.toHaveBeenCalled();
    expect(await new ReviewResultService(value.root).listReviewResults("workspace-a"))
      .toHaveLength(1);
  });

  it("fails closed for incomplete or ambiguous recovery evidence", async () => {
    const incomplete = await fixture(["APPROVE"]);
    await persistLoop(incomplete.root, checkpoint({
      loop_id: "loop-incomplete-recovery",
      actuation_id: "actuation-incomplete-recovery",
      stage: "actuation",
    }));
    await incomplete.auto.recover();
    await expect(incomplete.auto.getLoop("loop-incomplete-recovery")).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: "ITERATION_PAYLOAD_MISSING",
    });
    expect(incomplete.starts).toHaveLength(0);

    const ambiguous = await fixture(["APPROVE"]);
    const chain = await createDurableReviewChain(ambiguous.root, "ambiguous-recovery");
    const deliveries = new ReviewDeliveryService(ambiguous.root);
    await deliveries.beginDeliveryAttempt("workspace-a", chain.delivery.delivery_id);
    const delivery = vi.fn(async () => {
      throw new Error("must not retry an ambiguous delivery");
    });
    const restarted = new AutoIterationService(ambiguous.registry, {
      storageRoot: ambiguous.root,
      browserRouter: { deliver: delivery },
      completionRouter: ambiguous.auto.completionRouter,
      controlledActuation: ambiguous.auto.controlledActuation,
    });
    await persistLoop(ambiguous.root, checkpoint({
      loop_id: "loop-ambiguous-recovery",
      review_request_id: chain.request.review_request_id,
      routing_id: chain.routing.routing_id,
      delivery_id: chain.delivery.delivery_id,
      stage: "delivery",
    }));
    await restarted.recover();
    await expect(restarted.getLoop("loop-ambiguous-recovery")).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: "DELIVERY_UNCERTAIN",
    });
    expect(delivery).not.toHaveBeenCalled();

    const uncertain = await fixture(["APPROVE"]);
    const pendingIteration = {
      goal: "Recover the uncertain launch",
      requirements: ["Do not spawn twice"],
      acceptance_criteria: ["An ambiguous launch stops for a human"],
    };
    const noSpawn = vi.fn(async () => {
      throw new Error("must not spawn when actuation outcome is uncertain");
    });
    const controlled = new ControlledActuationService(uncertain.registry, {
      storageRoot: uncertain.root,
      adapter: { start: noSpawn },
    });
    const authorization = await controlled.authorize({
      actuation_id: "actuation-uncertain-recovery",
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-uncertain-recovery",
      instruction: buildAutoIterationInstruction(pendingIteration),
    });
    await controlled.authorizationStore.reserveActuation({
      actuation_id: authorization.actuation_id,
      authorization_id: authorization.authorization_id,
    });
    const uncertainAuto = new AutoIterationService(uncertain.registry, {
      storageRoot: uncertain.root,
      controlledActuation: controlled,
    });
    await persistLoop(uncertain.root, checkpoint({
      loop_id: "loop-uncertain-actuation",
      iteration: 2,
      execution_id: "execution-uncertain-recovery",
      actuation_id: authorization.actuation_id,
      authorization_id: authorization.authorization_id,
      pending_iteration: pendingIteration,
      stage: "actuation",
    }));
    await uncertainAuto.recover();
    await expect(uncertainAuto.getLoop("loop-uncertain-actuation")).resolves.toMatchObject({
      stage: "human_required",
      terminal_reason: "ACTUATION_UNCERTAIN",
    });
    expect(noSpawn).not.toHaveBeenCalled();
  });

  it("fails closed for Review, Routing, Delivery, and Result identity conflicts", async () => {
    const reviewConflict = await fixture(["APPROVE"]);
    const request = await new ReviewRequestService(reviewConflict.root).createReviewRequest({
      review_request_id: "review-identity-conflict",
      task_id: "task-001",
      execution_id: "execution-001",
      workspace_id: "workspace-a",
      conversation_id: "conversation-other",
    });
    await persistLoop(reviewConflict.root, checkpoint({
      loop_id: "loop-review-identity-conflict",
      review_request_id: request.review_request_id,
      stage: "review_request",
    }));
    await reviewConflict.auto.recover();
    await expect(reviewConflict.auto.getLoop("loop-review-identity-conflict"))
      .resolves.toMatchObject({ stage: "human_required" });

    const routingConflict = await fixture(["APPROVE"]);
    const routingChain = await createDurableReviewChain(routingConflict.root, "routing-conflict");
    await persistLoop(routingConflict.root, checkpoint({
      loop_id: "loop-routing-identity-conflict",
      review_request_id: routingChain.request.review_request_id,
      routing_id: routingChain.routing.routing_id,
      conversation_id: "conversation-other",
      stage: "routing",
    }));
    await routingConflict.auto.recover();
    await expect(routingConflict.auto.getLoop("loop-routing-identity-conflict"))
      .resolves.toMatchObject({ stage: "human_required" });

    const deliveryConflict = await fixture(["APPROVE"]);
    const deliveryChain = await createDurableReviewChain(deliveryConflict.root, "delivery-conflict");
    await persistLoop(deliveryConflict.root, checkpoint({
      loop_id: "loop-delivery-identity-conflict",
      review_request_id: deliveryChain.request.review_request_id,
      routing_id: deliveryChain.routing.routing_id,
      delivery_id: deliveryChain.delivery.delivery_id,
      conversation_id: "conversation-other",
      stage: "delivery",
    }));
    await deliveryConflict.auto.recover();
    await expect(deliveryConflict.auto.getLoop("loop-delivery-identity-conflict"))
      .resolves.toMatchObject({ stage: "human_required" });
    expect(deliveryConflict.deliveryCalls).not.toHaveBeenCalled();

    const resultConflict = await fixture(["APPROVE"]);
    const first = await createDurableReviewChain(resultConflict.root, "result-conflict-first");
    const second = await createDurableReviewChain(resultConflict.root, "result-conflict-second");
    const resultDeliveries = new ReviewDeliveryService(resultConflict.root);
    await resultDeliveries.beginDeliveryAttempt("workspace-a", first.delivery.delivery_id);
    const firstDelivery = await resultDeliveries.markDelivered(
      "workspace-a",
      first.delivery.delivery_id,
    );
    await resultDeliveries.beginDeliveryAttempt("workspace-a", second.delivery.delivery_id);
    const secondDelivery = await resultDeliveries.markDelivered(
      "workspace-a",
      second.delivery.delivery_id,
    );
    const otherResult = await new ReviewResultService(resultConflict.root).createReviewResult({
      result_id: "result-identity-conflict",
      review_request_id: second.request.review_request_id,
      delivery_id: secondDelivery.delivery_id,
      workspace_id: "workspace-a",
      task_id: "task-001",
      status: "COMPLETED",
      content: verdict(second.request.review_request_id, "APPROVE"),
    });
    await persistLoop(resultConflict.root, checkpoint({
      loop_id: "loop-result-identity-conflict",
      review_request_id: first.request.review_request_id,
      routing_id: first.routing.routing_id,
      delivery_id: firstDelivery.delivery_id,
      review_result_id: otherResult.result_id,
      stage: "review_completion",
    }));
    await resultConflict.auto.recover();
    await expect(resultConflict.auto.getLoop("loop-result-identity-conflict"))
      .resolves.toMatchObject({ stage: "human_required" });
  });

  it("keeps all terminal states stable across advance and recover", async () => {
    const approved = await fixture(["APPROVE"]);
    const approvedLoop = await approved.auto.start(startInput());
    const approvedSnapshot = {
      loop: await approved.auto.getLoop(approvedLoop.loop_id),
      requests: await new ReviewRequestService(approved.root).listReviewRequests("workspace-a"),
      delivery: await new ReviewDeliveryService(approved.root).getDeliveryByReviewRequest(
        "workspace-a",
        approvedLoop.review_request_id!,
      ),
      results: await new ReviewResultService(approved.root).listReviewResults("workspace-a"),
      executions: await approved.executionService.listExecutions("workspace-a", "task-001"),
      actuation: await optionalFile(controlledActuationStateFile(approved.root)),
    };
    await approved.auto.advance(approvedLoop.loop_id);
    await approved.auto.recover();
    expect(await approved.auto.getLoop(approvedLoop.loop_id)).toEqual(approvedSnapshot.loop);
    expect(await new ReviewRequestService(approved.root).listReviewRequests("workspace-a"))
      .toEqual(approvedSnapshot.requests);
    await expect(new ReviewDeliveryService(approved.root).getDeliveryByReviewRequest(
      "workspace-a",
      approvedLoop.review_request_id!,
    )).resolves.toEqual(approvedSnapshot.delivery);
    expect(await new ReviewResultService(approved.root).listReviewResults("workspace-a"))
      .toEqual(approvedSnapshot.results);
    expect(await approved.executionService.listExecutions("workspace-a", "task-001"))
      .toEqual(approvedSnapshot.executions);
    await expect(optionalFile(controlledActuationStateFile(approved.root)))
      .resolves.toBe(approvedSnapshot.actuation);

    const failed = await fixture(["APPROVE"]);
    await failed.executionService.updateExecutionContext(
      "workspace-a",
      "task-001",
      "execution-001",
      { status: "failed", summary: "execution failed" },
    );
    const failedLoop = await failed.auto.start(startInput());
    await failed.auto.advance(failedLoop.loop_id);
    await failed.auto.recover();
    await expect(failed.auto.getLoop(failedLoop.loop_id)).resolves.toEqual(failedLoop);
    expect(await new ReviewRequestService(failed.root).listReviewRequests("workspace-a"))
      .toHaveLength(0);
    expect(failed.starts).toHaveLength(0);

    const human = await fixture(["HUMAN_REQUIRED"]);
    const humanLoop = await human.auto.start(startInput());
    const humanRequests = await new ReviewRequestService(human.root).listReviewRequests("workspace-a");
    const humanDelivery = await new ReviewDeliveryService(human.root).getDeliveryByReviewRequest(
      "workspace-a",
      humanLoop.review_request_id!,
    );
    const humanResults = await new ReviewResultService(human.root).listReviewResults("workspace-a");
    const humanExecutions = await human.executionService.listExecutions("workspace-a", "task-001");
    const humanActuation = await optionalFile(controlledActuationStateFile(human.root));
    await human.auto.advance(humanLoop.loop_id);
    await human.auto.recover();
    await expect(human.auto.getLoop(humanLoop.loop_id)).resolves.toEqual(humanLoop);
    expect(await new ReviewRequestService(human.root).listReviewRequests("workspace-a"))
      .toEqual(humanRequests);
    await expect(new ReviewDeliveryService(human.root).getDeliveryByReviewRequest(
      "workspace-a",
      humanLoop.review_request_id!,
    )).resolves.toEqual(humanDelivery);
    expect(await new ReviewResultService(human.root).listReviewResults("workspace-a"))
      .toEqual(humanResults);
    expect(await human.executionService.listExecutions("workspace-a", "task-001"))
      .toEqual(humanExecutions);
    await expect(optionalFile(controlledActuationStateFile(human.root)))
      .resolves.toBe(humanActuation);
    expect(human.deliveryCalls).toHaveBeenCalledTimes(1);
    expect(human.completionCalls).toHaveBeenCalledTimes(1);
    expect(human.starts).toHaveLength(0);
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
      extensionDeliveryReadiness: () => ({ ready: true }),
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
