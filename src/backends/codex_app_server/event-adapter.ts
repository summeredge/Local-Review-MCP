import {
  parseCodexAppServerNotification,
  type CodexAppServerEvent,
} from "./events.js";
import type { RpcNotification } from "./protocol.js";
import { lrmEventInputSchema, type LrmEvent } from "../../control-plane/events/model.js";

const MAX_MESSAGE_CHARS = 4_000;

export interface CodexEventAdapterOptions {
  readonly session_id: string;
  readonly execution_id: string;
  readonly thread_id: string;
  readonly turn_id?: string;
  readonly now?: () => string;
}

interface CamelCaseOptions {
  readonly sessionId: string;
  readonly executionId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly now?: () => string;
}

type AdapterOptions = CodexEventAdapterOptions | CamelCaseOptions;
export type CodexEventInput = CodexAppServerEvent | RpcNotification;

function option<T>(options: AdapterOptions, snake: keyof CodexEventAdapterOptions, camel: keyof CamelCaseOptions): T {
  const value = (options as unknown as Record<string, unknown>)[snake]
    ?? (options as unknown as Record<string, unknown>)[camel];
  return value as T;
}

function bounded(value: string): string {
  return value.slice(0, MAX_MESSAGE_CHARS);
}

export class CodexEventAdapter {
  private readonly sessionId: string;
  private readonly executionId: string;
  private readonly threadId: string;
  private readonly turnId: string | undefined;
  private readonly now: () => string;
  private readonly messageDeltas = new Map<string, string>();

  public constructor(options: AdapterOptions) {
    this.sessionId = option<string>(options, "session_id", "sessionId");
    this.executionId = option<string>(options, "execution_id", "executionId");
    this.threadId = option<string>(options, "thread_id", "threadId");
    this.turnId = option<string | undefined>(options, "turn_id", "turnId");
    this.now = option<(() => string) | undefined>(options, "now", "now") ?? (() => new Date().toISOString());
  }

  public adapt(input: CodexEventInput): LrmEvent | undefined {
    const event = "method" in input
      ? parseCodexAppServerNotification(input)
      : input;
    if (event === undefined || event.thread_id !== this.threadId) return undefined;

    switch (event.type) {
      case "thread_started":
        return this.event({ event_type: "session_started", payload: {} });
      case "turn_started":
        if (!this.acceptsTurn(event.turn_id)) return undefined;
        return this.event({ event_type: "turn_started", turn_id: event.turn_id, payload: {} });
      case "agent_message_delta":
        if (!this.acceptsTurn(event.turn_id)) return undefined;
        this.messageDeltas.set(event.item_id, bounded(
          (this.messageDeltas.get(event.item_id) ?? "") + event.content,
        ));
        return this.event({
          event_type: "agent_message_delta",
          turn_id: event.turn_id,
          item_id: event.item_id,
          payload: { content: bounded(event.content) },
        });
      case "agent_message_completed": {
        if (!this.acceptsTurn(event.turn_id)) return undefined;
        const completed = bounded(event.content);
        const emitted = this.messageDeltas.get(event.item_id) ?? "";
        const suffix = emitted !== "" && completed.startsWith(emitted)
          ? completed.slice(emitted.length)
          : completed;
        this.messageDeltas.delete(event.item_id);
        return this.event({
          event_type: "agent_message_completed",
          turn_id: event.turn_id,
          item_id: event.item_id,
          payload: { content: bounded(suffix) },
        });
      }
      case "turn_completed":
        if (!this.acceptsTurn(event.turn_id)) return undefined;
        return this.event({ event_type: "turn_completed", turn_id: event.turn_id, payload: {} });
      case "turn_failed":
        if (!this.acceptsTurn(event.turn_id)) return undefined;
        return this.event({
          event_type: "execution_failed",
          turn_id: event.turn_id,
          payload: event.reason === undefined ? {} : { reason: bounded(event.reason) },
        });
    }
  }

  public convert(input: CodexEventInput): LrmEvent | undefined {
    return this.adapt(input);
  }

  private acceptsTurn(turnId: string): boolean {
    return this.turnId === undefined || turnId === this.turnId;
  }

  private event(event: {
    readonly event_type: LrmEvent["event_type"];
    readonly turn_id?: string;
    readonly item_id?: string;
    readonly payload: Record<string, string>;
  }): LrmEvent {
    return lrmEventInputSchema.parse({
      ...event,
      session_id: this.sessionId,
      execution_id: this.executionId,
      thread_id: this.threadId,
      timestamp: this.now(),
    });
  }
}

export function adaptCodexEvent(
  event: CodexEventInput,
  options: AdapterOptions,
): LrmEvent | undefined {
  return new CodexEventAdapter(options).adapt(event);
}
