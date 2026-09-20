import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  callCodexAppTool,
  CodexAppRuntimeError,
  type CodexAppMcpClient,
} from "./codex-app-runtime.js";
import type {
  CodexAppToolContracts,
  ReadThreadArguments,
  WaitThreadsArguments,
} from "./codex-app-contracts.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export type DesktopCompletionStatus = "completed" | "timed_out" | "unknown";

export type DesktopCompletionUnknownReason =
  | "capability_unavailable"
  | "tool_contract_incompatible"
  | "tool_error"
  | "malformed_response"
  | "thread_identity_mismatch"
  | "host_identity_mismatch"
  | "turn_identity_unavailable"
  | "ambiguous_new_turn"
  | "status_unrecognized"
  | "baseline_invalid";

export interface DesktopCompletionContext {
  readonly executorThreadId: string;
  readonly targetThreadId: string;
  readonly hostId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DesktopCompletionBaseline {
  readonly targetThreadId: string;
  readonly hostId: string;
  readonly turnIds: readonly string[];
}

export interface DesktopCompletionResult {
  readonly status: DesktopCompletionStatus;
  readonly targetThreadId: string;
  readonly hostId: string;
  readonly turnId?: string;
  readonly reason?: DesktopCompletionUnknownReason;
}

export interface DesktopCompletionObserverOptions {
  readonly client: Pick<CodexAppMcpClient, "callTool">;
  readonly contracts: Pick<CodexAppToolContracts, "readThreadArguments" | "waitThreadsArguments">;
  readonly pollIntervalMs?: number;
}

export class DesktopCompletionObserverError extends Error {
  public constructor(public readonly reason: DesktopCompletionUnknownReason, message?: string) {
    super(message ?? reason);
    this.name = "DesktopCompletionObserverError";
  }
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface CompletionTurn {
  readonly id: string;
  readonly status: unknown;
  readonly error: unknown;
  readonly completedAt: unknown;
}

interface ReadSnapshot {
  readonly turns: readonly CompletionTurn[];
}

interface WaitObservation {
  readonly afterCursor?: string;
}

type Evaluation =
  | { readonly kind: "pending"; readonly candidateTurnId?: string }
  | { readonly kind: "completed"; readonly turnId: string }
  | { readonly kind: "unknown"; readonly reason: DesktopCompletionUnknownReason };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function assertContext(context: DesktopCompletionContext): void {
  if (!nonEmpty(context.executorThreadId)
    || !nonEmpty(context.targetThreadId)
    || !nonEmpty(context.hostId)) {
    throw new DesktopCompletionObserverError("baseline_invalid", "Completion context is incomplete.");
  }
  if (context.timeoutMs !== undefined
    && (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs < 1)) {
    throw new DesktopCompletionObserverError("baseline_invalid", "timeoutMs must be a positive integer.");
  }
}

function timeoutFor(context: DesktopCompletionContext): number {
  return context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function resultFor(
  context: DesktopCompletionContext,
  status: DesktopCompletionStatus,
  values: Pick<DesktopCompletionResult, "turnId" | "reason"> = {},
): DesktopCompletionResult {
  return {
    status,
    targetThreadId: context.targetThreadId,
    hostId: context.hostId,
    ...(values.turnId === undefined ? {} : { turnId: values.turnId }),
    ...(values.reason === undefined ? {} : { reason: values.reason }),
  };
}

function fail(reason: DesktopCompletionUnknownReason): never {
  throw new DesktopCompletionObserverError(reason);
}

function embeddedJson(result: CallToolResult): JsonRecord {
  if (result.isError === true) fail("tool_error");
  const content = (result as unknown as JsonRecord).content;
  if (!Array.isArray(content)) fail("malformed_response");
  const first = content[0];
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") {
    fail("malformed_response");
  }
  try {
    const parsed: unknown = JSON.parse(first.text);
    if (!isRecord(parsed)) fail("malformed_response");
    return parsed;
  } catch {
    fail("malformed_response");
  }
}

function readSnapshot(result: CallToolResult, context: DesktopCompletionContext): ReadSnapshot {
  const payload = embeddedJson(result);
  const thread = payload.thread;
  if (!isRecord(thread)) fail("malformed_response");
  if (!nonEmpty(thread.id) || thread.id !== context.targetThreadId) {
    fail("thread_identity_mismatch");
  }
  if (!nonEmpty(thread.hostId) || thread.hostId !== context.hostId) {
    fail("host_identity_mismatch");
  }
  if (!isRecord(thread.status) || !nonEmpty(thread.status.type)) fail("malformed_response");

  const turns = payload.turns;
  if (!Array.isArray(turns)) fail("malformed_response");
  const parsedTurns: CompletionTurn[] = [];
  for (const value of turns) {
    if (!isRecord(value)) fail("malformed_response");
    if (!nonEmpty(value.id)) fail("turn_identity_unavailable");
    parsedTurns.push({
      id: value.id,
      status: value.status,
      error: value.error,
      completedAt: value.completedAt,
    });
  }
  return { turns: parsedTurns };
}

function waitObservation(
  result: CallToolResult,
  context: DesktopCompletionContext,
  candidateTurnId: string | undefined,
): WaitObservation {
  const payload = embeddedJson(result);
  const wake = payload.wake;
  if (wake !== undefined && wake !== null && !isRecord(wake)) fail("malformed_response");
  if (isRecord(wake)) {
    if (wake.threadId !== undefined) {
      if (!nonEmpty(wake.threadId)) fail("thread_identity_mismatch");
      if (wake.threadId !== context.targetThreadId) fail("thread_identity_mismatch");
    }
    if (wake.hostId !== undefined) {
      if (!nonEmpty(wake.hostId)) fail("host_identity_mismatch");
      if (wake.hostId !== context.hostId) fail("host_identity_mismatch");
    }
    if (wake.turnId !== undefined) {
      if (!nonEmpty(wake.turnId)) fail("turn_identity_unavailable");
      if (candidateTurnId !== undefined && wake.turnId !== candidateTurnId) {
        fail("turn_identity_unavailable");
      }
    }
  }

  const polls = payload.polls;
  if (polls === undefined) return {};
  if (!Array.isArray(polls)) fail("malformed_response");
  for (const poll of polls) {
    if (!isRecord(poll)) fail("malformed_response");
    if (nonEmpty(poll.cursor)) return { afterCursor: poll.cursor };
  }
  return {};
}

function validateBaseline(
  context: DesktopCompletionContext,
  baseline: DesktopCompletionBaseline,
): boolean {
  if (!isRecord(baseline)
    || baseline.targetThreadId !== context.targetThreadId
    || baseline.hostId !== context.hostId
    || !Array.isArray(baseline.turnIds)) {
    return false;
  }
  const ids = new Set<string>();
  for (const value of baseline.turnIds) {
    if (!nonEmpty(value) || ids.has(value)) return false;
    ids.add(value);
  }
  return true;
}

function evaluate(
  snapshot: ReadSnapshot,
  baseline: DesktopCompletionBaseline,
  candidateTurnId: string | undefined,
): Evaluation {
  let candidate = candidateTurnId;
  if (candidate === undefined) {
    const baselineIds = new Set(baseline.turnIds);
    const newIds: string[] = [];
    for (const turn of snapshot.turns) {
      if (!baselineIds.has(turn.id) && !newIds.includes(turn.id)) newIds.push(turn.id);
    }
    if (newIds.length > 1) return { kind: "unknown", reason: "ambiguous_new_turn" };
    candidate = newIds[0];
    if (candidate === undefined) return { kind: "pending" };
  }

  const turn = snapshot.turns.find((value) => value.id === candidate);
  if (turn === undefined) return { kind: "unknown", reason: "turn_identity_unavailable" };
  if (turn.error !== null && turn.error !== undefined) return { kind: "unknown", reason: "tool_error" };
  if (turn.status === "completed") {
    if (turn.error === null && turn.completedAt !== null && turn.completedAt !== undefined) {
      return { kind: "completed", turnId: candidate };
    }
    return { kind: "unknown", reason: "malformed_response" };
  }
  if (turn.status === "inProgress") return { kind: "pending", candidateTurnId: candidate };
  return { kind: "unknown", reason: "status_unrecognized" };
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (error instanceof CodexAppRuntimeError && error.code === "tool_call_aborted");
}

function errorReason(error: unknown): DesktopCompletionUnknownReason {
  if (error instanceof DesktopCompletionObserverError) return error.reason;
  if (error instanceof CodexAppRuntimeError) {
    if (error.code === "tool_contract_incompatible") return "tool_contract_incompatible";
    return "tool_error";
  }
  return "tool_error";
}

function timeoutError(error: unknown): boolean {
  return error instanceof CodexAppRuntimeError && error.code === "tool_call_timeout";
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

export class DesktopCompletionObserver {
  private readonly readAvailable: boolean;
  private readonly waitAvailable: boolean;
  private readonly pollIntervalMs: number;

  public constructor(private readonly options: DesktopCompletionObserverOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new Error("pollIntervalMs must be a non-negative integer.");
    }
    this.readAvailable = this.contractAvailable((contracts) => {
      contracts.readThreadArguments("observer-probe", "observer-probe");
    });
    this.waitAvailable = this.contractAvailable((contracts) => {
      contracts.waitThreadsArguments("observer-probe", "observer-probe", 1);
    });
  }

  private contractAvailable(
    check: (contracts: DesktopCompletionObserverOptions["contracts"]) => void,
  ): boolean {
    try {
      check(this.options.contracts);
      return true;
    } catch {
      return false;
    }
  }

  private async read(
    context: DesktopCompletionContext,
    timeoutMs?: number,
  ): Promise<CallToolResult> {
    const arguments_: ReadThreadArguments = this.options.contracts.readThreadArguments(
      context.targetThreadId,
      context.hostId,
    );
    return callCodexAppTool({
      client: this.options.client,
      tool: "read_thread",
      arguments: arguments_,
      executorThreadId: context.executorThreadId,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }

  private async wait(
    context: DesktopCompletionContext,
    timeoutMs: number,
    afterCursor?: string,
  ): Promise<CallToolResult> {
    const arguments_: WaitThreadsArguments = this.options.contracts.waitThreadsArguments(
      context.targetThreadId,
      context.hostId,
      timeoutMs,
      afterCursor,
    );
    return callCodexAppTool({
      client: this.options.client,
      tool: "wait_threads",
      arguments: arguments_,
      executorThreadId: context.executorThreadId,
      timeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }

  /** Capture immediately before the caller dispatches the corresponding turn. */
  public async captureBaseline(
    context: DesktopCompletionContext,
  ): Promise<DesktopCompletionBaseline> {
    assertContext(context);
    if (context.signal?.aborted) throw abortError();
    if (!this.readAvailable) {
      throw new DesktopCompletionObserverError("capability_unavailable");
    }
    try {
      const result = await this.read(context, timeoutFor(context));
      const snapshot = readSnapshot(result, context);
      return {
        targetThreadId: context.targetThreadId,
        hostId: context.hostId,
        turnIds: [...new Set(snapshot.turns.map((turn) => turn.id))],
      };
    } catch (error: unknown) {
      if (isAbort(error, context.signal)) throw abortError();
      if (error instanceof DesktopCompletionObserverError) throw error;
      throw new DesktopCompletionObserverError(errorReason(error));
    }
  }

  /** The caller must have successfully dispatched the turn before calling this method. */
  public async waitForCompletion(
    context: DesktopCompletionContext & { readonly baseline: DesktopCompletionBaseline },
  ): Promise<DesktopCompletionResult> {
    assertContext(context);
    if (context.signal?.aborted) throw abortError();
    if (!validateBaseline(context, context.baseline)) {
      return resultFor(context, "unknown", { reason: "baseline_invalid" });
    }
    if (!this.readAvailable) {
      return resultFor(context, "unknown", { reason: "capability_unavailable" });
    }

    const deadline = Date.now() + timeoutFor(context);
    let candidateTurnId: string | undefined;
    let afterCursor: string | undefined;
    while (true) {
      if (context.signal?.aborted) throw abortError();
      const remainingBeforeRead = deadline - Date.now();
      if (remainingBeforeRead <= 0) return resultFor(context, "timed_out");

      let snapshot: ReadSnapshot;
      try {
        snapshot = readSnapshot(
          await this.read(context, remainingBeforeRead),
          context,
        );
      } catch (error: unknown) {
        if (isAbort(error, context.signal)) throw abortError();
        if (timeoutError(error) || Date.now() >= deadline) return resultFor(context, "timed_out");
        return resultFor(context, "unknown", { reason: errorReason(error) });
      }

      const evaluation = evaluate(snapshot, context.baseline, candidateTurnId);
      if (evaluation.kind === "completed") {
        return resultFor(context, "completed", { turnId: evaluation.turnId });
      }
      if (evaluation.kind === "unknown") {
        return resultFor(context, "unknown", { reason: evaluation.reason });
      }
      candidateTurnId = evaluation.candidateTurnId ?? candidateTurnId;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return resultFor(context, "timed_out");
      if (this.waitAvailable) {
        let observation: WaitObservation;
        try {
          observation = waitObservation(
            await this.wait(context, remaining, afterCursor),
            context,
            candidateTurnId,
          );
        } catch (error: unknown) {
          if (isAbort(error, context.signal)) throw abortError();
          if (timeoutError(error) || Date.now() >= deadline) return resultFor(context, "timed_out");
          return resultFor(context, "unknown", { reason: errorReason(error) });
        }
        afterCursor = observation.afterCursor ?? afterCursor;
        continue;
      }

      try {
        await sleep(Math.min(this.pollIntervalMs, remaining), context.signal);
      } catch (error: unknown) {
        if (isAbort(error, context.signal)) throw abortError();
        throw error;
      }
    }
  }
}
