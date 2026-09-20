import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  callCodexAppTool,
  CodexAppRuntimeError,
  type CallCodexAppToolInput,
  type CodexAppMcpClient,
} from "./codex-app-runtime.js";
import {
  CodexAppToolContracts,
  type CreateThreadArguments,
} from "./codex-app-contracts.js";

export interface DesktopCodexCommandContext {
  readonly client: Pick<CodexAppMcpClient, "callTool">;
  readonly contracts: CodexAppToolContracts;
}

export interface DesktopCodexCommandOptions {
  readonly executorThreadId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CreateThreadInput extends DesktopCodexCommandOptions {
  readonly projectId: string;
  readonly prompt: string;
}

export interface SendMessageToThreadInput extends DesktopCodexCommandOptions {
  readonly targetThreadId: string;
  readonly hostId: string;
  readonly prompt: string;
}

export interface DesktopThreadIdentity {
  readonly targetThreadId: string;
  readonly hostId: string;
}

function nonEmpty(
  value: unknown,
  code: "executor_thread_missing" | "thread_identity_missing" | "tool_call_failed",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CodexAppRuntimeError(code, `${code} is required.`);
  }
  return value.trim();
}

function safeIdentity(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.trim())
    ? value.trim()
    : undefined;
}

function requiredPrompt(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CodexAppRuntimeError("tool_call_failed", "prompt is required.");
  }
  return value;
}

function throwToolResultError(result: CallToolResult, tool: string): void {
  if (result.isError === true) {
    throw new CodexAppRuntimeError("tool_call_failed", `${tool} returned an error.`, { cause: result });
  }
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityRecord(result: CallToolResult): Record<string, unknown> | undefined {
  const record = isRecord(result) ? result : undefined;
  if (record === undefined) return undefined;
  if (typeof record.threadId === "string" || typeof record.hostId === "string") return record;
  if (isRecord(record.structuredContent)
    && (typeof record.structuredContent.threadId === "string"
      || typeof record.structuredContent.hostId === "string")) {
    return record.structuredContent;
  }
  if (!Array.isArray(record.content)) return undefined;
  for (const item of record.content) {
    const content = isRecord(item) ? item : undefined;
    if (content === undefined) continue;
    if (content.type !== "text") continue;
    const parsed = parseJsonText(content.text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

function parseThreadIdentity(result: CallToolResult): DesktopThreadIdentity {
  throwToolResultError(result, "create_thread");
  const record = identityRecord(result);
  const targetThreadId = safeIdentity(record?.threadId);
  const hostId = safeIdentity(record?.hostId);
  if (targetThreadId === undefined || hostId === undefined) {
    throw new CodexAppRuntimeError("thread_identity_missing", "create_thread returned incomplete thread identity.");
  }
  return { targetThreadId, hostId };
}

function assertDistinctThreadIdentity(executorThreadId: string, targetThreadId: string): void {
  if (executorThreadId === targetThreadId) {
    throw new CodexAppRuntimeError(
      "thread_identity_conflict",
      "executorThreadId and targetThreadId must remain distinct.",
    );
  }
}

function callInput(
  client: Pick<CodexAppMcpClient, "callTool">,
  tool: string,
  args: Record<string, unknown>,
  options: DesktopCodexCommandOptions,
): CallCodexAppToolInput {
  return {
    client,
    tool,
    arguments: args,
    executorThreadId: options.executorThreadId,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export class DesktopCodexThreadCommands {
  public constructor(private readonly context: DesktopCodexCommandContext) {}

  public async listProjects(options: DesktopCodexCommandOptions): Promise<CallToolResult> {
    this.context.contracts.requireListProjects();
    const result = await callCodexAppTool(callInput(
      this.context.client,
      "list_projects",
      {},
      options,
    ));
    throwToolResultError(result, "list_projects");
    return result;
  }

  public async createThread(input: CreateThreadInput): Promise<DesktopThreadIdentity> {
    const executorThreadId = nonEmpty(input.executorThreadId, "executor_thread_missing");
    const projectId = nonEmpty(input.projectId, "tool_call_failed");
    const args: CreateThreadArguments = this.context.contracts.createThreadArguments(
      requiredPrompt(input.prompt),
      projectId,
    );
    const result = await callCodexAppTool(callInput(
      this.context.client,
      "create_thread",
      args,
      { ...input, executorThreadId },
    ));
    const identity = parseThreadIdentity(result);
    assertDistinctThreadIdentity(executorThreadId, identity.targetThreadId);
    return identity;
  }

  public async sendMessageToThread(input: SendMessageToThreadInput): Promise<CallToolResult> {
    const executorThreadId = nonEmpty(input.executorThreadId, "executor_thread_missing");
    const targetThreadId = nonEmpty(input.targetThreadId, "thread_identity_missing");
    const hostId = nonEmpty(input.hostId, "thread_identity_missing");
    assertDistinctThreadIdentity(executorThreadId, targetThreadId);
    const args = this.context.contracts.sendMessageToThreadArguments(
      targetThreadId,
      hostId,
      requiredPrompt(input.prompt),
    );
    const result = await callCodexAppTool(callInput(
      this.context.client,
      "send_message_to_thread",
      args,
      { ...input, executorThreadId },
    ));
    throwToolResultError(result, "send_message_to_thread");
    return result;
  }
}
