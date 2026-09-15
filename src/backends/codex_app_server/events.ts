import type { RpcNotification } from "./protocol.js";
import { jsonRecord } from "./protocol.js";

export interface ThreadStartedEvent {
  readonly type: "thread_started";
  readonly thread_id: string;
  readonly session_id: string;
}

export interface TurnStartedEvent {
  readonly type: "turn_started";
  readonly thread_id: string;
  readonly turn_id: string;
}

export interface AgentMessageDeltaEvent {
  readonly type: "agent_message_delta";
  readonly thread_id: string;
  readonly turn_id: string;
  readonly item_id: string;
  readonly content: string;
}

export interface AgentMessageCompletedEvent {
  readonly type: "agent_message_completed";
  readonly thread_id: string;
  readonly turn_id: string;
  readonly item_id: string;
  readonly content: string;
}

export interface TurnCompletedEvent {
  readonly type: "turn_completed";
  readonly thread_id: string;
  readonly turn_id: string;
}

export interface TurnFailedEvent {
  readonly type: "turn_failed";
  readonly thread_id: string;
  readonly turn_id: string;
  readonly reason?: string;
}

export type CodexAppServerEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | AgentMessageDeltaEvent
  | AgentMessageCompletedEvent
  | TurnCompletedEvent
  | TurnFailedEvent;

function requiredRecord(value: unknown, method: string): Record<string, unknown> {
  const record = jsonRecord(value);
  if (record === undefined) throw new Error(`Invalid ${method} event payload.`);
  return record;
}

function requiredString(record: Record<string, unknown>, field: string, method: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${method} event field: ${field}.`);
  }
  return value;
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.slice(0, 4_000);
  const record = jsonRecord(value);
  return typeof record?.message === "string" && record.message.trim() !== ""
    ? record.message.slice(0, 4_000)
    : undefined;
}

export function parseCodexAppServerNotification(
  notification: RpcNotification,
): CodexAppServerEvent | undefined {
  const method = notification.method;
  if (!new Set([
    "thread/started",
    "turn/started",
    "item/agentMessage/delta",
    "item/completed",
    "turn/completed",
    "error",
  ]).has(method)) return undefined;
  const params = requiredRecord(notification.params, method);

  switch (method) {
    case "thread/started": {
      const thread = requiredRecord(params.thread, method);
      return {
        type: "thread_started",
        thread_id: requiredString(thread, "id", method),
        session_id: requiredString(thread, "sessionId", method),
      };
    }
    case "turn/started": {
      const turn = requiredRecord(params.turn, method);
      return {
        type: "turn_started",
        thread_id: requiredString(params, "threadId", method),
        turn_id: requiredString(turn, "id", method),
      };
    }
    case "item/agentMessage/delta":
      return {
        type: "agent_message_delta",
        thread_id: requiredString(params, "threadId", method),
        turn_id: requiredString(params, "turnId", method),
        item_id: requiredString(params, "itemId", method),
        content: requiredString(params, "delta", method),
      };
    case "item/completed": {
      const item = requiredRecord(params.item, method);
      if (item.type !== "agentMessage") return undefined;
      return {
        type: "agent_message_completed",
        thread_id: requiredString(params, "threadId", method),
        turn_id: requiredString(params, "turnId", method),
        item_id: requiredString(item, "id", method),
        content: typeof item.text === "string" ? item.text : "",
      };
    }
    case "turn/completed": {
      const turn = requiredRecord(params.turn, method);
      const threadId = requiredString(params, "threadId", method);
      const turnId = requiredString(turn, "id", method);
      switch (turn.status) {
        case "completed":
          return { type: "turn_completed", thread_id: threadId, turn_id: turnId };
        case "failed":
        case "interrupted":
          return {
            type: "turn_failed",
            thread_id: threadId,
            turn_id: turnId,
            ...(messageOf(turn.error) === undefined ? {} : { reason: messageOf(turn.error) }),
          };
        default:
          return undefined;
      }
    }
    case "error": {
      if (params.willRetry === true) return undefined;
      return {
        type: "turn_failed",
        thread_id: requiredString(params, "threadId", method),
        turn_id: requiredString(params, "turnId", method),
        ...(messageOf(params.error) === undefined ? {} : { reason: messageOf(params.error) }),
      };
    }
    default:
      return undefined;
  }
}
