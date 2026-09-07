import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import type { ConversationRouting } from "../src/context/conversation-routing.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import type { ReviewDelivery } from "../src/context/review-delivery.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import type { ReviewRequestContext } from "../src/context/types.js";
import { ReviewResultService } from "../src/context/review-result-service.js";
import type { ReviewResult } from "../src/context/review-result.js";
import {
  executionContextSchema,
  taskContextSchema,
} from "../src/context/schema.js";
import {
  conversationRoutingSchema,
} from "../src/context/conversation-routing-schema.js";
import { reviewDeliverySchema } from "../src/context/review-delivery-schema.js";
import { reviewRequestContextSchema, reviewSnapshotSchema } from "../src/context/review-schema.js";
import { reviewResultSchema } from "../src/context/review-result-schema.js";
import { TaskContextService } from "../src/context/service.js";
import { IterationDirectiveBuilder } from "../src/control/iteration-directive-builder.js";
import { iterationDirectiveSchema } from "../src/control/iteration-directive-schema.js";
import { CodexHandoffRenderer } from "../src/control/codex-handoff-renderer.js";
import {
  LoopController,
  LoopControllerIdentityError,
  type LoopControllerFacts,
} from "../src/control/loop-controller.js";
import { loopDecisionSchema } from "../src/control/loop-decision-schema.js";
import { ReviewVerdictParser } from "../src/control/review-verdict-parser.js";
import { reviewVerdictSchema } from "../src/control/review-verdict-schema.js";
import type { ReviewVerdict } from "../src/control/review-verdict.js";
import { validateWorkspaceIdentity } from "../src/workspace/identity.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import type { WorkspaceIdentity } from "../src/workspace/types.js";
import type { ReviewSnapshot } from "../src/git/types.js";

const temporaryDirectories: string[] = [];
const snapshot: ReviewSnapshot = {
  branch: "main",
  head: "0123456789abcdef0123456789abcdef01234567",
  diff_sha256: "a".repeat(64),
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

interface CoreChain {
  readonly storageRoot: string;
  readonly workspace: WorkspaceIdentity;
  readonly task: Awaited<ReturnType<TaskContextService["createTaskContext"]>>;
  readonly execution: Awaited<ReturnType<ExecutionContextService["createExecutionContext"]>>;
  readonly request: ReviewRequestContext;
  readonly routing: ConversationRouting;
}

interface DeliveredChain extends CoreChain {
  readonly delivery: ReviewDelivery;
}

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-core-v1-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeChain(): Promise<CoreChain> {
  const storageRoot = await makeStorageRoot();
  const workspace: WorkspaceIdentity = {
    id: "workspace-a",
    name: "Workspace A",
    path: storageRoot,
  };
  const registry = new WorkspaceRegistry([workspace]);
  const resolved = registry.resolve(workspace.id);
  validateWorkspaceIdentity(resolved);

  const task = await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: workspace.id,
    conversation_id: "task-compat-conversation",
    status: "reviewing",
  });
  const execution = await new ExecutionContextService(storageRoot).createExecutionContext({
    execution_id: "execution-001",
    task_id: task.task_id,
    workspace_id: task.workspace_id,
    status: "passed",
  });
  const request = await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "review-001",
    task_id: task.task_id,
    execution_id: execution.execution_id,
    workspace_id: task.workspace_id,
    conversation_id: "request-compat-conversation",
    review_snapshot: snapshot,
  });
  const routing = await new ConversationRoutingService(storageRoot).createRouting({
    routing_id: "routing-001",
    workspace_id: task.workspace_id,
    task_id: task.task_id,
    review_request_id: request.review_request_id,
    conversation_id: "routed-conversation",
  });
  return { storageRoot, workspace, task, execution, request, routing };
}

async function makeDeliveredChain(): Promise<DeliveredChain> {
  const chain = await makeChain();
  const service = new ReviewDeliveryService(chain.storageRoot);
  const pending = await service.createDelivery({
    workspace_id: chain.routing.workspace_id,
    task_id: chain.routing.task_id,
    review_request_id: chain.routing.review_request_id,
    routing_id: chain.routing.routing_id,
    conversation_id: chain.routing.conversation_id,
  });
  await service.beginDeliveryAttempt(chain.workspace.id, pending.delivery_id);
  const delivery = await service.markDelivered(chain.workspace.id, pending.delivery_id);
  return { ...chain, delivery };
}

function verdictContent(
  reviewRequestId: string,
  decision: "APPROVE" | "ITERATE",
): string {
  return `<lrm-review-result>${JSON.stringify({
    schema_version: 1,
    review_request_id: reviewRequestId,
    decision,
    summary: `${decision} summary`,
    ...(decision === "ITERATE" ? {
      iteration: {
        goal: "Fix the blocking issue.",
        requirements: ["Keep the change inside the current task."],
        acceptance_criteria: ["The blocking issue is fixed."],
      },
    } : {}),
  })}</lrm-review-result>`;
}

async function makeResult(
  chain: DeliveredChain,
  decision: "APPROVE" | "ITERATE" = "ITERATE",
): Promise<ReviewResult> {
  return new ReviewResultService(chain.storageRoot).createReviewResult({
    review_request_id: chain.request.review_request_id,
    delivery_id: chain.delivery.delivery_id,
    workspace_id: chain.workspace.id,
    status: "COMPLETED",
    content: verdictContent(chain.request.review_request_id, decision),
  });
}

function facts(
  chain: DeliveredChain,
  result: ReviewResult,
  currentReviewSnapshot?: ReviewSnapshot,
): LoopControllerFacts {
  return {
    task: chain.task,
    execution: chain.execution,
    review_request: chain.request,
    review_delivery: chain.delivery,
    review_result: result,
    ...(currentReviewSnapshot === undefined ? {} : { current_review_snapshot: currentReviewSnapshot }),
  };
}

describe("LRM Core v1 contract", () => {
  it("keeps the complete identity chain schema-valid", async () => {
    const chain = await makeDeliveredChain();
    const result = await makeResult(chain);
    const verdict = new ReviewVerdictParser().parse(result);
    const decision = new LoopController().decide({
      ...facts(chain, result, snapshot),
      review_verdict: verdict,
    });
    const directive = new IterationDirectiveBuilder().build(decision, verdict);

    expect(chain.workspace.id).toBe(chain.task.workspace_id);
    expect(chain.task.task_id).toBe(chain.execution.task_id);
    expect(chain.execution.execution_id).toBe(chain.request.execution_id);
    expect(chain.request.review_request_id).toBe(chain.routing.review_request_id);
    expect(chain.routing.routing_id).toBe(chain.delivery.routing_id);
    expect(chain.routing.conversation_id).toBe(chain.delivery.conversation_id);
    expect(result.delivery_id).toBe(chain.delivery.delivery_id);
    expect(verdict.review_request_id).toBe(result.review_request_id);
    expect(decision.review_request_id).toBe(verdict.review_request_id);
    expect(directive.loop_decision_id).toBe(decision.decision_id);
    expect(directive.review_result_id).toBe(result.result_id);
    expect(directive.source_execution_id).toBe(chain.execution.execution_id);
    expect(decision).toMatchObject({
      action: "ITERATE",
      reason_code: "REVIEW_REQUIRES_ITERATION",
    });

    expect(() => taskContextSchema.parse(chain.task)).not.toThrow();
    expect(() => executionContextSchema.parse(chain.execution)).not.toThrow();
    expect(() => reviewRequestContextSchema.parse(chain.request)).not.toThrow();
    expect(() => reviewSnapshotSchema.parse(chain.request.review_snapshot)).not.toThrow();
    expect(() => conversationRoutingSchema.parse(chain.routing)).not.toThrow();
    expect(() => reviewDeliverySchema.parse(chain.delivery)).not.toThrow();
    expect(() => reviewResultSchema.parse(result)).not.toThrow();
    expect(() => reviewVerdictSchema.parse(verdict)).not.toThrow();
    expect(() => loopDecisionSchema.parse(decision)).not.toThrow();
    expect(() => iterationDirectiveSchema.parse(directive)).not.toThrow();
  });

  it("uses ConversationRouting as the only delivery conversation source", async () => {
    const chain = await makeChain();
    const service = new ReviewDeliveryService(chain.storageRoot);
    const input = {
      workspace_id: chain.routing.workspace_id,
      task_id: chain.routing.task_id,
      review_request_id: chain.routing.review_request_id,
      routing_id: chain.routing.routing_id,
    };

    await expect(service.createDelivery({
      ...input,
      conversation_id: chain.request.conversation_id!,
    })).rejects.toThrow(/conversation/iu);

    const delivery = await service.createDelivery({
      ...input,
      conversation_id: chain.routing.conversation_id,
    });
    await new TaskContextService(chain.storageRoot).updateTaskContext(chain.task.task_id, {
      conversation_id: "changed-task-compat-conversation",
    });
    await new ReviewRequestService(chain.storageRoot).updateReviewRequest(
      chain.workspace.id,
      chain.request.review_request_id,
      { conversation_id: "changed-request-compat-conversation" },
    );

    await expect(service.validateDelivery(delivery)).resolves.toBeUndefined();
    expect(delivery.conversation_id).toBe("routed-conversation");
  });

  it("keeps the ReviewSnapshot stale gate fail-closed", async () => {
    const chain = await makeDeliveredChain();
    const result = await makeResult(chain, "APPROVE");
    const controller = new LoopController();

    expect(controller.decide({
      ...facts(chain, result, snapshot),
      review_request: { ...chain.request, review_snapshot: undefined },
    })).toMatchObject({
      action: "RETRY_REVIEW",
      reason_code: "REVIEW_SNAPSHOT_MISSING",
    });
    expect(controller.decide(facts(chain, result))).toMatchObject({
      action: "RETRY_REVIEW",
      reason_code: "REVIEW_SNAPSHOT_UNAVAILABLE",
    });
    expect(controller.decide(facts(chain, result, {
      ...snapshot,
      diff_sha256: "b".repeat(64),
    }))).toMatchObject({
      action: "RETRY_REVIEW",
      reason_code: "STALE_REVIEW",
    });
  });

  it("rejects broken identity chains and invalid iteration directives", async () => {
    const chain = await makeDeliveredChain();
    const result = await makeResult(chain);
    const verdict = new ReviewVerdictParser().parse(result);
    const controller = new LoopController();
    const decision = controller.decide({
      ...facts(chain, result, snapshot),
      review_verdict: verdict,
    });
    const base = facts(chain, result, snapshot);
    const brokenChains: LoopControllerFacts[] = [
      { ...base, task: { ...chain.task, workspace_id: "workspace-b" } },
      { ...base, task: { ...chain.task, task_id: "task-002" } },
      { ...base, execution: { ...chain.execution, execution_id: "execution-002" } },
      { ...base, review_request: { ...chain.request, review_request_id: "review-002" } },
      { ...base, review_delivery: { ...chain.delivery, task_id: "task-002" } },
      { ...base, review_result: { ...result, delivery_id: "delivery-002" } },
    ];

    for (const candidate of brokenChains) {
      expect(() => controller.decide(candidate)).toThrow(LoopControllerIdentityError);
    }

    const builder = new IterationDirectiveBuilder();
    expect(() => builder.build({ ...decision, action: "COMPLETE", reason_code: "REVIEW_APPROVED" }, verdict))
      .toThrow();
    expect(() => builder.build(decision, {
      ...verdict,
      iteration: { ...verdict.iteration!, requirements: [] },
    })).toThrow();
    expect(() => builder.build(decision, {
      ...verdict,
      review_request_id: "review-002",
    })).toThrow();
    expect(() => builder.build(decision, {
      ...verdict,
      schema_version: 2,
    } as unknown as ReviewVerdict)).toThrow();
  });

  it("keeps the contract document and neutral adapter free of control-plane imports", async () => {
    const document = await readFile(join("docs", "core-v1.md"), "utf8");
    expect(document).toContain("# LRM Core v1 Contract");
    expect(document).toContain("ConversationRouting.conversation_id");
    expect(document).toContain("# 修改目标");
    expect(document).toContain("MCP Request Origin Capture");

    async function findTypeScriptFiles(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const groups = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? findTypeScriptFiles(path)
          : entry.isFile() && entry.name.endsWith(".ts")
            ? [path]
            : [];
      }));
      return groups.flat();
    }

    const sourceFiles = [
      ...(await Promise.all(["context", "control", "git"].map((directory) =>
        findTypeScriptFiles(join("src", directory)))).then((groups) => groups.flat())),
      join("src", "delivery", "review-delivery-adapter.ts"),
    ];
    const forbiddenImport = /(?:from|import)\s*(?:type\s+)?["'][^"']*(?:playwright|browser-worker|extension|dom|selector|dispatcher|codex-execution)[^"']*["']/iu;
    const sources = await Promise.all(sourceFiles.map((path) => readFile(path, "utf8")));
    expect(sources.every((source) => !forbiddenImport.test(source))).toBe(true);
  });
});
