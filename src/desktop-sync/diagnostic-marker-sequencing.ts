import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  callCodexAppTool,
  type CodexAppMcpClient,
} from "../desktop-codex/codex-app-runtime.js";
import type { CodexAppToolContracts } from "../desktop-codex/codex-app-contracts.js";

interface JsonRecord {
  readonly [key: string]: unknown;
}

export interface DiagnosticMarkerSequencingOptions {
  readonly client: Pick<CodexAppMcpClient, "callTool">;
  readonly contracts: Pick<CodexAppToolContracts, "readThreadArguments">;
  readonly executorThreadId: string;
  readonly targetThreadId: string;
  readonly hostId: string;
  readonly marker: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function embeddedJson(result: CallToolResult): JsonRecord | undefined {
  if (result.isError === true) return undefined;
  const content = (result as unknown as JsonRecord).content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0];
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Marker evidence is diagnostic-only: only turns[].items[].agentMessage.text counts. */
export function hasAgentMessageMarker(result: CallToolResult, marker: string): boolean {
  const payload = embeddedJson(result);
  if (payload === undefined) return false;
  const turns = payload.turns;
  if (!Array.isArray(turns)) return false;
  return turns.some((turn) => {
    if (!isRecord(turn) || !Array.isArray(turn.items)) return false;
    return turn.items.some((item) => isRecord(item)
      && item.type === "agentMessage"
      && typeof item.text === "string"
      && item.text.includes(marker));
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateOptions(options: DiagnosticMarkerSequencingOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  if (options.marker === "") throw new Error("marker is required.");
}

async function readMarker(
  options: DiagnosticMarkerSequencingOptions,
  timeoutMs: number,
): Promise<boolean> {
  const result = await callCodexAppTool({
    client: options.client,
    tool: "read_thread",
    arguments: options.contracts.readThreadArguments(options.targetThreadId, options.hostId),
    executorThreadId: options.executorThreadId,
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return hasAgentMessageMarker(result, options.marker);
}

export async function readAgentMessageMarker(
  options: DiagnosticMarkerSequencingOptions,
): Promise<boolean> {
  validateOptions(options);
  if (options.signal?.aborted) throw abortError();
  return readMarker(options, options.timeoutMs);
}

export async function waitForAgentMessageMarker(
  options: DiagnosticMarkerSequencingOptions,
): Promise<boolean> {
  validateOptions(options);

  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    if (options.signal?.aborted) throw abortError();
    const remaining = Math.floor(deadline - Date.now());
    if (remaining < 1) return false;
    if (await readMarker(options, remaining)) return true;
    const delay = Math.min(50, Math.floor(deadline - Date.now()));
    if (delay < 1) return false;
    await sleep(delay, options.signal);
  }
}
