import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateWorkspaceIdentityConsistency } from "../workspace/identity.js";
import { WorkspacePathError } from "../workspace/path.js";
import type { WorkspaceIdentity } from "../workspace/types.js";
import { defaultTaskContextStorageRoot } from "./task.js";
import {
  conversationRoutingFile,
  conversationRoutingsDirectory,
  createRoutingId,
  type ConversationRouting,
  type CreateConversationRoutingInput,
} from "./conversation-routing.js";
import {
  conversationRoutingSchema,
  createConversationRoutingInputSchema,
} from "./conversation-routing-schema.js";
import { ExecutionContextService } from "./execution-service.js";
import { REVIEW_REQUESTS_DIRECTORY } from "./review-request.js";
import { ReviewRequestService } from "./review-request-service.js";
import { reviewRequestIdSchema } from "./review-schema.js";
import { TaskContextService } from "./service.js";
import { workspaceIdSchema } from "./schema.js";
import type { ReviewRequestContext } from "./types.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(routing: ConversationRouting): string {
  return `${JSON.stringify(routing, null, 2)}\n`;
}

function workspaceMismatch(message: string): WorkspacePathError {
  return new WorkspacePathError("WORKSPACE_IDENTITY_MISMATCH", `WORKSPACE_IDENTITY_MISMATCH: ${message}`);
}

export class ConversationRoutingService {
  public readonly storageRoot: string;
  private readonly runtimeIdentity: WorkspaceIdentity | undefined;
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly reviewRequests: ReviewRequestService;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    runtimeIdentity?: WorkspaceIdentity,
  ) {
    this.storageRoot = resolve(storageRoot);
    this.runtimeIdentity = runtimeIdentity;
    this.tasks = new TaskContextService(this.storageRoot);
    this.executions = new ExecutionContextService(this.storageRoot);
    this.reviewRequests = new ReviewRequestService(this.storageRoot);
  }

  public async createRouting(
    input: CreateConversationRoutingInput,
    runtimeIdentity: WorkspaceIdentity | undefined = this.runtimeIdentity,
  ): Promise<ConversationRouting> {
    const parsed = createConversationRoutingInputSchema.parse({
      ...input,
      routing_id: input.routing_id ?? createRoutingId(),
    });
    this.validateRuntimeIdentity(parsed.workspace_id, runtimeIdentity);
    const reviewRequest = await this.reviewRequestForRouting(
      parsed.workspace_id,
      parsed.review_request_id,
    );
    const timestamp = new Date().toISOString();
    const routing = conversationRoutingSchema.parse({
      ...parsed,
      ...(parsed.execution_id === undefined ? { execution_id: reviewRequest.execution_id } : {}),
      created_at: timestamp,
      updated_at: timestamp,
    });
    await this.validateRouting(routing, runtimeIdentity);

    const directory = conversationRoutingsDirectory(this.storageRoot, routing.workspace_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        conversationRoutingFile(this.storageRoot, routing.workspace_id, routing.routing_id),
        json(routing),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Conversation routing "${routing.routing_id}" already exists.`, { cause: error });
      }
      throw new Error("Conversation routing could not be saved.", { cause: error });
    }
    return routing;
  }

  public async getRouting(
    workspaceId: string,
    routingId: string,
  ): Promise<ConversationRouting | null> {
    const file = conversationRoutingFile(this.storageRoot, workspaceId, routingId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Conversation routing could not be read.", { cause: error });
    }

    try {
      return conversationRoutingSchema.parse(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
      throw new Error(`Conversation routing "${routingId}" is invalid.`, { cause: error });
    }
  }

  public async validateRouting(
    routing: ConversationRouting,
    runtimeIdentity: WorkspaceIdentity | undefined = this.runtimeIdentity,
  ): Promise<void> {
    const parsed = conversationRoutingSchema.parse(routing);
    this.validateRuntimeIdentity(parsed.workspace_id, runtimeIdentity);

    const task = await this.tasks.getTaskContext(parsed.task_id);
    if (task === null) throw new Error(`Task context "${parsed.task_id}" was not found.`);
    if (task.workspace_id !== parsed.workspace_id) {
      throw workspaceMismatch("Task context does not belong to the routed workspace.");
    }

    const reviewRequest = await this.reviewRequestForRouting(
      parsed.workspace_id,
      parsed.review_request_id,
    );
    if (reviewRequest.task_id !== parsed.task_id) {
      throw new Error("Conversation routing task does not match the review request.");
    }
    if (reviewRequest.workspace_id !== parsed.workspace_id) {
      throw workspaceMismatch("Review request does not belong to the routed workspace.");
    }
    if (parsed.execution_id === undefined) return;
    if (reviewRequest.execution_id !== parsed.execution_id) {
      throw new Error("Conversation routing execution does not match the review request.");
    }

    const execution = await this.executions.getExecutionContext(
      parsed.workspace_id,
      parsed.task_id,
      parsed.execution_id,
    );
    if (execution === null) {
      throw new Error(`Execution context "${parsed.execution_id}" was not found.`);
    }
    if (execution.workspace_id !== parsed.workspace_id) {
      throw workspaceMismatch("Execution context does not belong to the routed workspace.");
    }
    if (execution.task_id !== parsed.task_id) {
      throw new Error("Execution context does not match the routed task.");
    }
  }

  private validateRuntimeIdentity(
    workspaceId: string,
    runtimeIdentity: WorkspaceIdentity | undefined,
  ): void {
    if (runtimeIdentity === undefined) return;
    validateWorkspaceIdentityConsistency(
      { ...runtimeIdentity, id: workspaceId },
      runtimeIdentity,
    );
  }

  private async reviewRequestForRouting(
    workspaceId: string,
    reviewRequestId: string,
  ): Promise<ReviewRequestContext> {
    const reviewRequest = await this.reviewRequests.getReviewRequest(workspaceId, reviewRequestId);
    if (reviewRequest !== null) return reviewRequest;

    const elsewhere = await this.findReviewRequest(reviewRequestId);
    if (elsewhere !== null && elsewhere.workspace_id !== workspaceId) {
      throw workspaceMismatch("Review request belongs to another workspace.");
    }
    throw new Error(`Review request "${reviewRequestId}" was not found.`);
  }

  private async findReviewRequest(reviewRequestId: string): Promise<ReviewRequestContext | null> {
    reviewRequestIdSchema.parse(reviewRequestId);
    const root = join(this.storageRoot, REVIEW_REQUESTS_DIRECTORY);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Review requests could not be inspected.", { cause: error });
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !workspaceIdSchema.safeParse(entry.name).success) continue;
      const reviewRequest = await this.reviewRequests.getReviewRequest(entry.name, reviewRequestId);
      if (reviewRequest !== null) return reviewRequest;
    }
    return null;
  }
}
