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

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_INTERVAL_MS = 20_000;
const WAIT_TIMEOUT_MARGIN_MS = 5_000;
const DEFAULT_TRANSIENT_RETRY_BACKOFF_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 50;
/** Bounded grace for the very first observation of a freshly created target thread. */
const DEFAULT_VISIBILITY_GRACE_MS = 15_000;
const DEFAULT_VISIBILITY_POLL_INTERVAL_MS = 500;

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
  | "baseline_invalid"
  | "first_turn_visibility_unavailable";

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
  /** Bound for retrying an unreadable (tool-error) first read of an empty-baseline target. */
  readonly visibilityGraceMs?: number;
  readonly visibilityPollIntervalMs?: number;
}

export class DesktopCompletionObserverError extends Error {
  public constructor(public readonly reason: DesktopCompletionUnknownReason, message?: string) {
    super(message ?? reason);
    this.name = "DesktopCompletionObserverError";
  }
}

/**
 * Raised only when a tool call returned CallToolResult.isError === true. It is kept distinct from
 * other failures so the first-turn visibility grace can retry a not-yet-visible thread without ever
 * retrying malformed payloads, identity mismatches, or turn-level errors.
 */
class ReadToolResultError extends Error {
  public constructor() {
    super("codex_app tool returned an error result.");
    this.name = "ReadToolResultError";
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
  | {
    readonly kind: "unknown";
    readonly reason: DesktopCompletionUnknownReason;
    readonly turnId?: string;
  };

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
  return context.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
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
  if (result.isError === true) throw new ReadToolResultError();
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
  if (turn.error !== null && turn.error !== undefined) {
    return { kind: "unknown", reason: "tool_error", turnId: candidate };
  }
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
  if (error instanceof ReadToolResultError) return "tool_error";
  if (error instanceof CodexAppRuntimeError) {
    if (error.code === "tool_contract_incompatible") return "tool_contract_incompatible";
    return "tool_error";
  }
  return "tool_error";
}

function transientObservationError(error: unknown): boolean {
  if (error instanceof ReadToolResultError) return true;
  return error instanceof CodexAppRuntimeError
    && (error.code === "tool_call_timeout"
      || error.code === "tool_call_failed"
      || error.code === "transport_failed"
      || error.code === "runtime_unavailable");
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
  private readonly visibilityGraceMs: number;
  private readonly visibilityPollIntervalMs: number;

  public constructor(private readonly options: DesktopCompletionObserverOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new Error("pollIntervalMs must be a non-negative integer.");
    }
    this.visibilityGraceMs = options.visibilityGraceMs ?? DEFAULT_VISIBILITY_GRACE_MS;
    if (!Number.isSafeInteger(this.visibilityGraceMs) || this.visibilityGraceMs < 0) {
      throw new Error("visibilityGraceMs must be a non-negative integer.");
    }
    this.visibilityPollIntervalMs = options.visibilityPollIntervalMs ?? DEFAULT_VISIBILITY_POLL_INTERVAL_MS;
    // A zero interval would make the bounded visibility retry a busy-loop, so it is rejected.
    if (!Number.isSafeInteger(this.visibilityPollIntervalMs) || this.visibilityPollIntervalMs < 1) {
      throw new Error("visibilityPollIntervalMs must be a positive integer.");
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
      timeoutMs: timeoutMs + (context.timeoutMs === undefined
        ? WAIT_TIMEOUT_MARGIN_MS
        : Math.min(WAIT_TIMEOUT_MARGIN_MS, 250)),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }

  private async retryTransient(signal: AbortSignal | undefined): Promise<void> {
    await sleep(DEFAULT_TRANSIENT_RETRY_BACKOFF_MS, signal);
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

    // An explicit timeout remains available to bounded diagnostic callers. The Desktop backend
    // intentionally omits it so a normal in-progress turn is not an execution-timeout failure.
    const deadline = context.timeoutMs === undefined ? undefined : Date.now() + timeoutFor(context);
    // The first-turn visibility grace only ever applies to a freshly created target whose baseline
    // is empty. It is a bounded, separate window and never consumes the full execution timeout.
    const visibilityDeadline = this.visibilityGraceMs > 0 && context.baseline.turnIds.length === 0
      ? Date.now() + this.visibilityGraceMs
      : 0;
    let candidateTurnId: string | undefined;
    let afterCursor: string | undefined;
    while (true) {
      if (context.signal?.aborted) throw abortError();
      const now = Date.now();
      const remainingBeforeRead = deadline === undefined ? undefined : deadline - now;
      if (remainingBeforeRead !== undefined && remainingBeforeRead <= 0) {
        return resultFor(context, "timed_out");
      }

      // The visibility grace only bounds reads while the target is still unreadable and no turn has
      // been locked yet. During that window a single read is bounded by both the remaining execution
      // timeout and the remaining visibility window, so a hanging read can never consume the full
      // execution timeout. No additional read/poll implementation is introduced here.
      const visibilityActive = visibilityDeadline > 0 && candidateTurnId === undefined;
      const visibilityRemaining = visibilityDeadline - now;
      if (visibilityActive && visibilityRemaining <= 0) {
        return deadline !== undefined && Date.now() >= deadline
          ? resultFor(context, "timed_out")
          : resultFor(context, "unknown", { reason: "first_turn_visibility_unavailable" });
      }
      const readTimeoutMs = visibilityActive
        ? Math.max(1, Math.min(remainingBeforeRead ?? visibilityRemaining, visibilityRemaining))
        : Math.max(1, Math.min(remainingBeforeRead ?? (DEFAULT_WAIT_INTERVAL_MS + WAIT_TIMEOUT_MARGIN_MS),
          DEFAULT_WAIT_INTERVAL_MS + WAIT_TIMEOUT_MARGIN_MS));

      let snapshot: ReadSnapshot;
      try {
        snapshot = readSnapshot(
          await this.read(context, readTimeoutMs),
          context,
        );
      } catch (error: unknown) {
        if (isAbort(error, context.signal)) throw abortError();
        if (visibilityActive && transientObservationError(error)) {
          const remainingGrace = Math.min(
            visibilityDeadline - Date.now(),
            deadline === undefined ? Number.MAX_SAFE_INTEGER : deadline - Date.now(),
          );
          if (remainingGrace > 0) {
            try {
              await sleep(Math.min(this.visibilityPollIntervalMs, remainingGrace), context.signal);
            } catch (sleepError: unknown) {
              if (isAbort(sleepError, context.signal)) throw abortError();
              throw sleepError;
            }
            continue;
          }
          return deadline !== undefined && Date.now() >= deadline
            ? resultFor(context, "timed_out")
            : resultFor(context, "unknown", { reason: "first_turn_visibility_unavailable" });
        }
        if (transientObservationError(error)) {
          if (this.visibilityGraceMs === 0 && context.baseline.turnIds.length === 0) {
            return resultFor(context, "unknown", { reason: "tool_error" });
          }
          if (deadline !== undefined && Date.now() >= deadline) {
            return resultFor(context, "timed_out");
          }
          try {
            await this.retryTransient(context.signal);
          } catch (retryError: unknown) {
            if (isAbort(retryError, context.signal)) throw abortError();
            throw retryError;
          }
          continue;
        }
        if (deadline !== undefined && Date.now() >= deadline) return resultFor(context, "timed_out");
        return resultFor(context, "unknown", { reason: errorReason(error) });
      }

      const evaluation = evaluate(snapshot, context.baseline, candidateTurnId);
      if (evaluation.kind === "completed") {
        return resultFor(context, "completed", { turnId: evaluation.turnId });
      }
      if (evaluation.kind === "unknown") {
        return resultFor(context, "unknown", {
          reason: evaluation.reason,
          ...(evaluation.turnId === undefined ? {} : { turnId: evaluation.turnId }),
        });
      }
      candidateTurnId = evaluation.candidateTurnId ?? candidateTurnId;

      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      if (remaining !== undefined && remaining <= 0) return resultFor(context, "timed_out");
      if (this.waitAvailable) {
        let observation: WaitObservation;
        try {
          observation = waitObservation(
            await this.wait(
              context,
              remaining === undefined ? DEFAULT_WAIT_INTERVAL_MS : Math.min(DEFAULT_WAIT_INTERVAL_MS, remaining),
              afterCursor,
            ),
            context,
            candidateTurnId,
          );
        } catch (error: unknown) {
          if (isAbort(error, context.signal)) throw abortError();
          if (transientObservationError(error)) {
            if (deadline !== undefined && Date.now() >= deadline) return resultFor(context, "timed_out");
            if (visibilityDeadline > 0 && Date.now() >= visibilityDeadline) {
              return resultFor(context, "unknown", { reason: "tool_error" });
            }
            // wait_threads is only a wake-up hint; the next read_thread is authoritative.
            try {
              await this.retryTransient(context.signal);
            } catch (retryError: unknown) {
              if (isAbort(retryError, context.signal)) throw abortError();
              throw retryError;
            }
            continue;
          }
          if (deadline !== undefined && Date.now() >= deadline) return resultFor(context, "timed_out");
          return resultFor(context, "unknown", { reason: errorReason(error) });
        }
        afterCursor = observation.afterCursor ?? afterCursor;
        // A fake or unhealthy provider may resolve immediately; yield once so an endless
        // observation loop cannot starve shutdown or other application work.
        await sleep(0, context.signal);
        continue;
      }

      try {
        await sleep(
          Math.min(this.pollIntervalMs, remaining ?? this.pollIntervalMs),
          context.signal,
        );
      } catch (error: unknown) {
        if (isAbort(error, context.signal)) throw abortError();
        throw error;
      }
    }
  }
}
