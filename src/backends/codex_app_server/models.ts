import { jsonRecord } from "./protocol.js";

export type AppServerTransport = "stdio";
export type AppServerStatus = "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface CodexAppServerProcessInfo {
  readonly process_id: number;
  readonly codex_version: string;
  readonly transport: AppServerTransport;
  readonly status: AppServerStatus;
}

export interface CodexAppServerClientOptions {
  readonly cwd: string;
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onStderr?: (chunk: string) => void;
}

export interface AppServerInitializeResult {
  readonly user_agent: string;
  readonly codex_home?: string;
  readonly platform_family?: string;
  readonly platform_os?: string;
}

export interface AppServerModel {
  readonly model: string;
  readonly label: string;
  readonly efforts: readonly string[];
  readonly default_effort?: string;
  readonly is_default?: boolean;
}

export interface AppServerThread {
  readonly thread_id: string;
  readonly session_id: string;
  readonly model?: string;
  readonly cwd?: string;
}

export type AppServerTurnStatus = "completed" | "interrupted" | "failed" | "in_progress" | "unknown";

export interface AppServerTurn {
  readonly turn_id: string;
  readonly status: AppServerTurnStatus;
  readonly error?: string;
}

export interface StartThreadInput {
  readonly cwd?: string;
  readonly model?: string;
}

export interface StartTurnInput {
  readonly threadId: string;
  readonly text: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface CodexAppServerExit {
  readonly process_id: number;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ModelListPage {
  readonly models: readonly AppServerModel[];
  readonly next_cursor: string | null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Codex app-server response is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  const record = jsonRecord(value);
  if (record === undefined) throw new Error(`Codex app-server response has an invalid ${field}.`);
  return record;
}

export function codexVersionFromUserAgent(userAgent: string): string {
  return userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/u)?.[0] ?? userAgent;
}

export function parseInitializeResult(value: unknown): AppServerInitializeResult {
  const record = requiredRecord(value, "initialize result");
  return {
    user_agent: requiredString(record.userAgent, "userAgent"),
    ...(optionalString(record.codexHome) === undefined ? {} : { codex_home: record.codexHome as string }),
    ...(optionalString(record.platformFamily) === undefined ? {} : { platform_family: record.platformFamily as string }),
    ...(optionalString(record.platformOs) === undefined ? {} : { platform_os: record.platformOs as string }),
  };
}

export function parseModelListPage(value: unknown): ModelListPage {
  const record = requiredRecord(value, "model/list result");
  if (!Array.isArray(record.data)) throw new Error("Codex app-server model/list result has invalid data.");
  const models = record.data.map((entry, index) => {
    const model = requiredRecord(entry, `model/list data[${index}]`);
    const supported = model.supportedReasoningEfforts;
    if (!Array.isArray(supported)) {
      throw new Error(`Codex app-server model/list data[${index}] has invalid reasoning efforts.`);
    }
    const efforts = supported.map((effort, effortIndex) => {
      const option = requiredRecord(effort, `model/list data[${index}].supportedReasoningEfforts[${effortIndex}]`);
      return requiredString(option.reasoningEffort, "reasoningEffort");
    });
    const selection = requiredString(model.model, `model/list data[${index}].model`);
    const label = optionalString(model.displayName) ?? selection;
    const defaultEffort = optionalString(model.defaultReasoningEffort);
    return {
      model: selection,
      label,
      efforts,
      ...(defaultEffort === undefined ? {} : { default_effort: defaultEffort }),
      ...(typeof model.isDefault === "boolean" ? { is_default: model.isDefault } : {}),
    } satisfies AppServerModel;
  });
  const nextCursor = record.nextCursor === null
    ? null
    : requiredString(record.nextCursor, "nextCursor");
  return { models, next_cursor: nextCursor };
}

export function parseThreadStartResult(value: unknown): AppServerThread {
  const record = requiredRecord(value, "thread/start result");
  const thread = requiredRecord(record.thread, "thread/start thread");
  const model = optionalString(record.model);
  const cwd = optionalString(record.cwd);
  return {
    thread_id: requiredString(thread.id, "thread.id"),
    session_id: requiredString(thread.sessionId, "thread.sessionId"),
    ...(model === undefined ? {} : { model }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

export function parseTurnStartResult(value: unknown): AppServerTurn {
  const record = requiredRecord(value, "turn/start result");
  const turn = requiredRecord(record.turn, "turn/start turn");
  const status = optionalString(turn.status);
  return {
    turn_id: requiredString(turn.id, "turn.id"),
    status: status === "completed" || status === "interrupted" || status === "failed"
      ? status
      : status === "inProgress"
        ? "in_progress"
        : "unknown",
  };
}
