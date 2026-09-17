import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { workspaceIdSchema } from "../context/schema.js";
import { correlationKeySchema } from "../mcp/schema/common.js";
import { extensionDeliveryReadiness } from "./bridge.js";
import {
  goalSubmissionAcceptedSchema,
  goalSubmissionRequestSchema,
  goalSubmissionResultSchema,
  type GoalSubmissionAccepted,
  type GoalSubmissionService,
} from "./goal-submission.js";
import {
  GoalPreflightError,
  goalPreflightResultSchema,
  type GoalPreflightResult,
} from "./goal-preflight.js";
import type { ConversationCorrelationRegistry } from "./conversation-correlation.js";
import type { ExtensionIdentityEvidence } from "./extension-identity.js";
import { executionModeSchema } from "./execution-service.js";
import type {
  IdentityTraceRecordInput,
  IdentityTraceService,
} from "./identity-trace.js";
import type {
  EvidenceTransportTraceRecordInput,
  EvidenceTransportTraceService,
} from "./evidence-transport-trace.js";

export const PENDING_GOAL_SUBMISSION_TTL_MS = 2 * 60 * 1000;
const PENDING_IDENTITY_TIMEOUT_ENV = "LRM_PENDING_IDENTITY_TIMEOUT_MS";

const STATE_SCHEMA_VERSION = 1;
const MAX_PENDING_GOAL_SUBMISSIONS = 10_000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const timestampSchema = z.string().datetime({ offset: true });
const terminalErrorSchema = z.string().min(1).max(4_000);
const pendingPayloadSchema = goalSubmissionRequestSchema.pick({
  title: true,
  goal: true,
  requirements: true,
  acceptance_criteria: true,
  max_iterations: true,
}).extend({
  workspace_id: workspaceIdSchema,
  execution_mode: executionModeSchema.optional(),
  model: z.string().min(1).max(256).optional(),
  reasoning_effort: z.string().min(1).max(64).optional(),
}).strict();

export const pendingGoalSubmissionInputSchema = pendingPayloadSchema.extend({
  correlation_key: correlationKeySchema,
}).strict();

const pendingBaseSchema = pendingPayloadSchema.extend({
  correlation_key: correlationKeySchema,
  accepted_at: timestampSchema,
  expires_at: timestampSchema,
}).strict();

export const pendingGoalSubmissionSchema = z.discriminatedUnion("state", [
  pendingBaseSchema.extend({ state: z.literal("pending_identity") }).strict(),
  pendingBaseSchema.extend({ state: z.literal("starting") }).strict(),
  pendingBaseSchema.extend({
    state: z.literal("started"),
    resolved_at: timestampSchema,
    ...goalSubmissionResultSchema.shape,
  }).strict(),
  pendingBaseSchema.extend({
    state: z.literal("failed"),
    resolved_at: timestampSchema,
    error: terminalErrorSchema,
    preflight: goalPreflightResultSchema.optional(),
  }).strict(),
  pendingBaseSchema.extend({
    state: z.literal("indeterminate"),
    resolved_at: timestampSchema,
    error: terminalErrorSchema,
  }).strict(),
]).superRefine((record, context) => {
  const acceptedAt = Date.parse(record.accepted_at);
  const expiresAt = Date.parse(record.expires_at);
  if (!Number.isFinite(acceptedAt) || !Number.isFinite(expiresAt) || expiresAt <= acceptedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pending submission time window is invalid" });
  }
});

const stateSchema = z.object({
  schema_version: z.literal(STATE_SCHEMA_VERSION),
  submissions: z.array(z.unknown()).max(MAX_PENDING_GOAL_SUBMISSIONS),
}).strict();

export type PendingGoalSubmissionInput = z.input<typeof pendingGoalSubmissionInputSchema>;
export type PendingGoalSubmission = z.infer<typeof pendingGoalSubmissionSchema>;
export type PendingGoalSubmissionState = PendingGoalSubmission["state"];
type TerminalPendingGoalSubmission = Extract<
  PendingGoalSubmission,
  { state: "started" | "failed" | "indeterminate" }
>;

export interface PendingGoalSubmissionServiceOptions {
  readonly browserReadiness?: typeof extensionDeliveryReadiness;
  readonly storageRoot?: string;
  readonly now?: () => number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly identityTrace?: Pick<IdentityTraceService, "record">;
  readonly evidenceTransportTrace?: Pick<EvidenceTransportTraceService, "record">;
}

export function pendingGoalSubmissionStateFile(storageRoot: string): string {
  return join(resolve(storageRoot), "control-plane", "pending-goal-submissions.json");
}

export class PendingGoalSubmissionConflictError extends Error {}

export class BrowserReadinessError extends Error {
  public constructor(public readonly readiness: ReturnType<typeof extensionDeliveryReadiness>) {
    super(`Browser identity channel is not ready (${readiness.readiness_state}). ${readiness.reason} ${readiness.action}`);
    this.name = "BrowserReadinessError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error && error.message !== "" ? error.message : String(error);
  return message.slice(0, 4_000) || "pending Goal submission failed";
}

function pendingIdentityTimeoutMs(environment: NodeJS.ProcessEnv): number {
  const raw = environment[PENDING_IDENTITY_TIMEOUT_ENV]?.trim();
  if (raw === undefined || raw === "" || !/^\d+$/u.test(raw)) return PENDING_GOAL_SUBMISSION_TTL_MS;
  const timeoutMs = Number(raw);
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : PENDING_GOAL_SUBMISSION_TTL_MS;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(now: number): string {
  const value = new Date(now).toISOString();
  return timestampSchema.parse(value);
}

function payloadFingerprint(value: PendingGoalSubmission | z.output<typeof pendingGoalSubmissionInputSchema>): string {
  return JSON.stringify({
    workspace_id: value.workspace_id,
    title: value.title,
    goal: value.goal,
    requirements: value.requirements,
    acceptance_criteria: value.acceptance_criteria,
    max_iterations: value.max_iterations,
    execution_mode: value.execution_mode ?? "batch",
    model: value.model ?? null,
    reasoning_effort: value.reasoning_effort ?? null,
  });
}

function samePayload(
  current: PendingGoalSubmission,
  input: z.output<typeof pendingGoalSubmissionInputSchema>,
): boolean {
  return payloadFingerprint(current) === payloadFingerprint(input);
}

function isTerminal(
  record: PendingGoalSubmission,
): record is Extract<PendingGoalSubmission, { state: "started" | "failed" | "indeterminate" }> {
  return record.state === "started" || record.state === "failed" || record.state === "indeterminate";
}

function isExpired(record: PendingGoalSubmission, now: number): boolean {
  return record.state === "pending_identity" && Date.parse(record.expires_at) <= now;
}

function terminalAge(record: TerminalPendingGoalSubmission, now: number): number {
  return now - Date.parse(record.resolved_at);
}

function terminalResolvedAt(record: PendingGoalSubmission): number {
  return isTerminal(record) ? Date.parse(record.resolved_at) : Number.MAX_SAFE_INTEGER;
}

function prune(records: Map<string, PendingGoalSubmission>, now: number): void {
  for (const [key, record] of records) {
    if (isTerminal(record) && terminalAge(record, now) >= TERMINAL_RETENTION_MS) records.delete(key);
  }
  if (records.size <= MAX_PENDING_GOAL_SUBMISSIONS) return;
  const terminal = [...records.entries()]
    .filter(([, record]) => isTerminal(record))
    .sort(([, left], [, right]) => terminalResolvedAt(left) - terminalResolvedAt(right));
  for (const [key] of terminal) {
    if (records.size <= MAX_PENDING_GOAL_SUBMISSIONS) break;
    records.delete(key);
  }
}

export class PendingGoalSubmissionService {
  public readonly storageRoot: string;
  private readonly file: string;
  private readonly correlations: Pick<ConversationCorrelationRegistry, "correlation">;
  private readonly goalSubmission: Pick<GoalSubmissionService, "submitGoal">;
  private readonly now: () => number;
  private readonly identityTimeoutMs: number;
  private readonly browserReadiness: typeof extensionDeliveryReadiness;
  private readonly identityTrace: Pick<IdentityTraceService, "record"> | undefined;
  private readonly evidenceTransportTrace: Pick<EvidenceTransportTraceService, "record"> | undefined;
  private submissions = new Map<string, PendingGoalSubmission>();
  private restorePromise: Promise<void> | null = null;
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  // ponytail: process-local serialization; add an inter-process lock only if multiple runtimes share one state root.
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly scheduled = new Map<string, Promise<void>>();

  public constructor(
    correlations: Pick<ConversationCorrelationRegistry, "correlation">,
    goalSubmission: Pick<GoalSubmissionService, "submitGoal">,
    options: PendingGoalSubmissionServiceOptions = {},
  ) {
    this.storageRoot = resolve(options.storageRoot ?? defaultTaskContextStorageRoot());
    this.file = pendingGoalSubmissionStateFile(this.storageRoot);
    this.correlations = correlations;
    this.goalSubmission = goalSubmission;
    this.now = options.now ?? Date.now;
    this.browserReadiness = options.browserReadiness ?? extensionDeliveryReadiness;
    this.identityTimeoutMs = pendingIdentityTimeoutMs(options.environment ?? process.env);
    this.identityTrace = options.identityTrace;
    this.evidenceTransportTrace = options.evidenceTransportTrace;
  }

  public restore(): Promise<void> {
    this.restorePromise ??= this.exclusive(() => this.restoreOnce());
    return this.restorePromise;
  }

  public async accept(input: PendingGoalSubmissionInput): Promise<GoalSubmissionAccepted> {
    const parsed = pendingGoalSubmissionInputSchema.parse(input);
    await this.restore();
    const receipt = await this.exclusive(async () => {
      const now = this.currentTime();
      const current = this.submissions.get(parsed.correlation_key);
      if (current !== undefined) {
        if (!samePayload(current, parsed)) {
          throw new PendingGoalSubmissionConflictError(
            "correlation_key already targets a different pending Goal submission",
          );
        }
        if (isExpired(current, now)) {
          const next = new Map(this.submissions);
          const expired = this.failedRecord(current, now, "pending_identity_expired");
          next.set(parsed.correlation_key, expired);
          await this.persist(next);
          this.submissions = next;
          this.tracePendingExpired(current);
          this.cancelExpiry(parsed.correlation_key);
          return this.receipt(expired);
        }
        return this.receipt(current);
      }

      // Global channel readiness only; exact conversation identity is still required below.
      const readiness = this.browserReadiness();
      if (!readiness.ready) throw new BrowserReadinessError(readiness);
      const next = new Map(this.submissions);
      prune(next, now);
      if (next.size >= MAX_PENDING_GOAL_SUBMISSIONS) {
        throw new Error("pending Goal submission queue is full");
      }
      const acceptedAt = nowIso(now);
      const record = pendingGoalSubmissionSchema.parse({
        ...parsed,
        accepted_at: acceptedAt,
        expires_at: nowIso(now + this.identityTimeoutMs),
        state: "pending_identity",
      });
      next.set(record.correlation_key, record);
      await this.persist(next);
      this.submissions = next;
      this.trace({
        event: "pending_created",
        correlation_key: record.correlation_key,
        workspace_id: record.workspace_id,
        created_at: record.accepted_at,
        expires_at: record.expires_at,
        timeout_ms: Date.parse(record.expires_at) - Date.parse(record.accepted_at),
        execution_mode: record.execution_mode ?? "batch",
      });
      return this.receipt(record);
    });

    const stored = this.submissions.get(parsed.correlation_key);
    if (stored?.state === "pending_identity") this.scheduleExpiry(stored);
    if (this.correlations.correlation(parsed.correlation_key) !== null) {
      this.scheduleResolve(parsed.correlation_key);
    }
    return receipt;
  }

  public async expire(correlationKey: string): Promise<void> {
    const key = correlationKeySchema.parse(correlationKey);
    await this.restore();
    await this.exclusive(async () => {
      const current = this.submissions.get(key);
      if (current === undefined || current.state !== "pending_identity") {
        this.cancelExpiry(key);
        return;
      }
      const now = this.currentTime();
      if (!isExpired(current, now)) {
        this.scheduleExpiry(current);
        return;
      }
      const next = new Map(this.submissions);
      next.set(key, this.failedRecord(current, now, "pending_identity_expired"));
      await this.persist(next);
      this.submissions = next;
      this.tracePendingExpired(current);
      this.cancelExpiry(key);
    });
  }

  public scheduleResolve(correlationKey: string): void {
    const parsed = correlationKeySchema.safeParse(correlationKey);
    if (!parsed.success || this.scheduled.has(parsed.data)) return;
    this.traceTransport({
      event: "connector_resolve_called",
      correlation_key: parsed.data,
      conversation_id: this.correlations.correlation(parsed.data)?.conversation_id,
    });
    const work = this.resolve(parsed.data)
      .catch((error: unknown) => {
        console.warn("Pending Goal submission resolution failed:", errorMessage(error));
      })
      .finally(() => {
        this.scheduled.delete(parsed.data);
      });
    this.scheduled.set(parsed.data, work);
  }

  public async resolve(correlationKey: string): Promise<void> {
    const key = correlationKeySchema.parse(correlationKey);
    await this.restore();
    this.traceTransport({
      event: "evidence_resolve_attempted",
      correlation_key: key,
      conversation_id: this.correlations.correlation(key)?.conversation_id,
    });
    const claimed = await this.exclusive(async () => {
      const current = this.submissions.get(key);
      if (current === undefined || current.state !== "pending_identity") {
        this.traceTransport({
          event: "evidence_resolve_failed",
          correlation_key: key,
          conversation_id: this.correlations.correlation(key)?.conversation_id,
        });
        return null;
      }
      const now = this.currentTime();
      if (isExpired(current, now)) {
        const next = new Map(this.submissions);
        next.set(key, this.failedRecord(current, now, "pending_identity_expired"));
        await this.persist(next);
        this.submissions = next;
        this.tracePendingExpired(current);
        this.traceMatchFailed(current, "expired");
        this.traceTransport({
          event: "evidence_resolve_failed",
          correlation_key: key,
          conversation_id: this.correlations.correlation(key)?.conversation_id,
        });
        this.cancelExpiry(key);
        return null;
      }
      const correlation = this.correlations.correlation(key);
      if (correlation === null) {
        this.traceMatchFailed(current, "missing_evidence");
        this.traceTransport({ event: "evidence_resolve_failed", correlation_key: key });
        return null;
      }

      const next = new Map(this.submissions);
      const starting = pendingGoalSubmissionSchema.parse({
        ...current,
        state: "starting",
      });
      next.set(key, starting);
      await this.persist(next);
      this.submissions = next;
      this.trace({
        event: "evidence_match_success",
        correlation_key: starting.correlation_key,
        conversation_id: correlation.conversation_id,
        workspace_id: starting.workspace_id,
      });
      this.traceTransport({
        event: "evidence_resolve_success",
        correlation_key: starting.correlation_key,
        conversation_id: correlation.conversation_id,
      });
      this.cancelExpiry(key);
      return {
        record: starting,
        conversation_id: correlation.conversation_id,
      };
    });
    if (claimed === null) return;

    try {
      const result = await this.goalSubmission.submitGoal({
        workspace_id: claimed.record.workspace_id,
        conversation_id: claimed.conversation_id,
        title: claimed.record.title,
        goal: claimed.record.goal,
        requirements: claimed.record.requirements,
        acceptance_criteria: claimed.record.acceptance_criteria,
        max_iterations: claimed.record.max_iterations,
        ...(claimed.record.execution_mode === undefined
          ? {}
          : { execution_mode: claimed.record.execution_mode }),
        ...(claimed.record.model === undefined ? {} : { model: claimed.record.model }),
        ...(claimed.record.reasoning_effort === undefined
          ? {}
          : { reasoning_effort: claimed.record.reasoning_effort }),
      });
      await this.finishStarted(key, result);
    } catch (error: unknown) {
      await this.finishTerminal(
        key,
        error instanceof GoalPreflightError ? "failed" : "indeterminate",
        errorMessage(error),
        error instanceof GoalPreflightError ? error.result : undefined,
      );
    }
  }

  public async recover(): Promise<void> {
    await this.restore();
    const keys = await this.exclusive(async () => {
      const now = this.currentTime();
      const next = new Map(this.submissions);
      let changed = false;
      for (const [key, record] of next) {
        if (!isExpired(record, now)) continue;
        next.set(key, this.failedRecord(record, now, "pending_identity_expired"));
        this.tracePendingExpired(record);
        changed = true;
      }
      prune(next, now);
      if (changed || next.size !== this.submissions.size) {
        await this.persist(next);
        this.submissions = next;
      }
      return [...this.submissions.values()]
        .filter((record) => record.state === "pending_identity")
        .filter((record) => this.correlations.correlation(record.correlation_key) !== null)
        .map((record) => record.correlation_key);
    });
    for (const key of keys) this.scheduleResolve(key);
  }

  public async get(correlationKey: string): Promise<PendingGoalSubmission | null> {
    const key = correlationKeySchema.parse(correlationKey);
    await this.restore();
    return this.exclusive(async () => {
      const record = this.submissions.get(key);
      return record === undefined ? null : clone(record);
    });
  }

  public async list(): Promise<PendingGoalSubmission[]> {
    await this.restore();
    return this.exclusive(async () => [...this.submissions.values()].map(clone));
  }

  public async diagnoseEvidence(
    evidence: ExtensionIdentityEvidence,
    workspaceId: string,
  ): Promise<void> {
    if (this.identityTrace === undefined) return;
    await this.restore();
    const candidates = await this.exclusive(async () => [...this.submissions.values()]
      .filter((record) => record.workspace_id === workspaceId)
      .filter((record) => record.state === "pending_identity"
        || (record.state === "failed" && record.error === "pending_identity_expired"))
      .map((record) => ({
        correlation_key: record.correlation_key,
        conversation_id: evidence.conversation_id,
        workspace_id: record.workspace_id,
        state: record.state,
        evidence_request_id: evidence.request_id,
      })));
    for (const candidate of candidates) {
      if (candidate.correlation_key === candidate.evidence_request_id) {
        if (candidate.state === "failed") {
          this.trace({
            event: "evidence_match_failed",
            correlation_key: candidate.correlation_key,
            conversation_id: candidate.conversation_id,
            workspace_id: candidate.workspace_id,
            reason: "expired",
          });
        }
        continue;
      }
      if (candidate.state === "pending_identity") {
        this.trace({
          event: "evidence_match_failed",
          correlation_key: candidate.correlation_key,
          conversation_id: candidate.conversation_id,
          workspace_id: candidate.workspace_id,
          reason: "correlation_mismatch",
          observed_correlation_key: candidate.evidence_request_id,
        });
      }
    }
  }

  private async restoreOnce(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
      console.warn("Pending Goal submission state could not be restored; starting without restored pending work");
      return;
    }

    let state: z.infer<typeof stateSchema>;
    try {
      state = stateSchema.parse(JSON.parse(raw));
    } catch {
      console.warn("Pending Goal submission state could not be restored; starting without restored pending work");
      return;
    }

    const restored = new Map<string, PendingGoalSubmission>();
    let invalid = false;
    for (const entry of state.submissions) {
      const parsed = pendingGoalSubmissionSchema.safeParse(entry);
      if (!parsed.success || restored.has(parsed.success ? parsed.data.correlation_key : "")) {
        invalid = true;
        continue;
      }
      restored.set(parsed.data.correlation_key, parsed.data);
    }
    this.submissions = restored;

    const now = this.currentTime();
    let changed = false;
    for (const [key, record] of restored) {
      if (record.state === "starting") {
        restored.set(key, this.indeterminateRecord(
          record,
          now,
          "pending submission was in starting state during runtime recovery",
        ));
        changed = true;
      } else if (isExpired(record, now)) {
        restored.set(key, this.failedRecord(record, now, "pending_identity_expired"));
        this.tracePendingExpired(record);
        changed = true;
      }
    }
    const beforeSize = restored.size;
    prune(restored, now);
    changed ||= restored.size !== beforeSize;
    if (changed) {
      try {
        await this.persist(restored);
        this.submissions = restored;
      } catch {
        console.warn("Pending Goal submission cleanup could not be saved; keeping fail-closed in-memory state");
      }
    }
    for (const record of this.submissions.values()) {
      if (record.state === "pending_identity") this.scheduleExpiry(record);
    }
    if (invalid) console.warn("Invalid pending Goal submission entries were ignored");
  }

  private failedRecord(
    record: PendingGoalSubmission,
    now: number,
    error: string,
    preflight?: GoalPreflightResult,
  ): Extract<PendingGoalSubmission, { state: "failed" }> {
    return pendingGoalSubmissionSchema.parse({
      ...record,
      state: "failed",
      resolved_at: nowIso(now),
      error,
      ...(preflight === undefined ? {} : { preflight }),
    }) as Extract<PendingGoalSubmission, { state: "failed" }>;
  }

  private indeterminateRecord(
    record: PendingGoalSubmission,
    now: number,
    error: string,
  ): Extract<PendingGoalSubmission, { state: "indeterminate" }> {
    return pendingGoalSubmissionSchema.parse({
      ...record,
      state: "indeterminate",
      resolved_at: nowIso(now),
      error,
    }) as Extract<PendingGoalSubmission, { state: "indeterminate" }>;
  }

  private receipt(record: PendingGoalSubmission): GoalSubmissionAccepted {
    return goalSubmissionAcceptedSchema.parse({
      accepted: true,
      correlation_key: record.correlation_key,
      accepted_at: record.accepted_at,
      expires_at: record.expires_at,
    });
  }

  private async finishStarted(
    key: string,
    result: z.infer<typeof goalSubmissionResultSchema>,
  ): Promise<void> {
    await this.exclusive(async () => {
      const current = this.submissions.get(key);
      if (current === undefined || current.state !== "starting") return;
      const next = new Map(this.submissions);
      next.set(key, pendingGoalSubmissionSchema.parse({
        ...current,
        state: "started",
        resolved_at: nowIso(this.currentTime()),
        ...goalSubmissionResultSchema.parse(result),
      }));
      await this.persist(next);
      this.submissions = next;
      this.trace({
        event: "goal_started",
        correlation_key: current.correlation_key,
        workspace_id: current.workspace_id,
        goal_id: result.goal_id,
        phase_id: result.phase_id,
        task_id: result.task_id,
        execution_id: result.execution_id,
      });
      this.cancelExpiry(key);
    });
  }

  private async finishTerminal(
    key: string,
    state: "failed" | "indeterminate",
    error: string,
    preflight?: GoalPreflightResult,
  ): Promise<void> {
    await this.exclusive(async () => {
      const current = this.submissions.get(key);
      if (current === undefined || current.state !== "starting") return;
      const next = new Map(this.submissions);
      next.set(key, state === "failed"
        ? this.failedRecord(current, this.currentTime(), error, preflight)
        : this.indeterminateRecord(current, this.currentTime(), error));
      await this.persist(next);
      this.submissions = next;
      this.cancelExpiry(key);
    });
  }

  private currentTime(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("pending Goal submission clock is invalid");
    return now;
  }

  private trace(input: IdentityTraceRecordInput): void {
    try {
      this.identityTrace?.record(input);
    } catch {
      // Diagnostic tracing is observational and must not affect submission behavior.
    }
  }

  private traceTransport(input: EvidenceTransportTraceRecordInput): void {
    try {
      this.evidenceTransportTrace?.record(input);
    } catch {
      // Diagnostic tracing is observational and must not affect submission behavior.
    }
  }

  private tracePendingExpired(record: PendingGoalSubmission): void {
    this.trace({
      event: "pending_expired",
      correlation_key: record.correlation_key,
      workspace_id: record.workspace_id,
      created_at: record.accepted_at,
      expires_at: record.expires_at,
      timeout_ms: Date.parse(record.expires_at) - Date.parse(record.accepted_at),
    });
  }

  private traceMatchFailed(
    record: PendingGoalSubmission,
    reason: "missing_evidence" | "expired",
  ): void {
    this.trace({
      event: "evidence_match_failed",
      correlation_key: record.correlation_key,
      workspace_id: record.workspace_id,
      reason,
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private scheduleExpiry(record: Extract<PendingGoalSubmission, { state: "pending_identity" }>): void {
    this.cancelExpiry(record.correlation_key);
    const delay = Math.max(0, Date.parse(record.expires_at) - this.currentTime());
    const timer = setTimeout(() => {
      this.expiryTimers.delete(record.correlation_key);
      void this.expire(record.correlation_key).catch((error: unknown) => {
        console.warn("Pending Goal submission expiry failed:", errorMessage(error));
      });
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(record.correlation_key, timer);
  }

  private cancelExpiry(correlationKey: string): void {
    const timer = this.expiryTimers.get(correlationKey);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.expiryTimers.delete(correlationKey);
  }

  private async persist(records: Map<string, PendingGoalSubmission>): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.pending-goal-submissions-${process.pid}-${randomUUID()}.tmp`);
    const snapshot = `${JSON.stringify({
      schema_version: STATE_SCHEMA_VERSION,
      submissions: [...records.values()],
    }, null, 2)}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
