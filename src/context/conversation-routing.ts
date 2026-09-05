import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { conversationRoutingIdSchema } from "./conversation-routing-schema.js";
import { workspaceIdSchema } from "./schema.js";
import { TASK_DIRECTORY } from "./task.js";

export interface ConversationRouting {
  readonly routing_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id?: string;
  readonly review_request_id: string;
  readonly conversation_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateConversationRoutingInput {
  readonly routing_id?: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id?: string;
  readonly review_request_id: string;
  readonly conversation_id: string;
}

export const CONVERSATION_ROUTINGS_DIRECTORY = join(TASK_DIRECTORY, "conversation_routings");

export function conversationRoutingsDirectory(storageRoot: string, workspaceId: string): string {
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  return join(resolve(storageRoot), CONVERSATION_ROUTINGS_DIRECTORY, safeWorkspaceId);
}

export function conversationRoutingFile(
  storageRoot: string,
  workspaceId: string,
  routingId: string,
): string {
  const safeRoutingId = conversationRoutingIdSchema.parse(routingId);
  return join(conversationRoutingsDirectory(storageRoot, workspaceId), `${safeRoutingId}.json`);
}

export function createRoutingId(): string {
  return `routing-${randomUUID()}`;
}
