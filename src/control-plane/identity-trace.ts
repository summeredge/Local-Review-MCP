import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { correlationKeySchema } from "../mcp/schema/common.js";

export const IDENTITY_TRACE_EVENTS = [
  "pending_created",
  "submit_goal_received",
  "extension_evidence_received",
  "evidence_match_success",
  "evidence_match_failed",
  "pending_expired",
  "goal_started",
] as const;

export const IDENTITY_TRACE_FAILURE_REASONS = [
  "missing_evidence",
  "correlation_mismatch",
  "conversation_mismatch",
  "expired",
] as const;

export const identityTraceEventNameSchema = z.enum(IDENTITY_TRACE_EVENTS);
export const identityTraceFailureReasonSchema = z.enum(IDENTITY_TRACE_FAILURE_REASONS);
const timestampSchema = z.string().datetime({ offset: true });
const hashSchema = z.string().regex(/^(?:[a-f0-9]{64})?$/u);
const traceIdSchema = z.string().min(1).max(256);

const identityTraceEventSchema = z.object({
  // These fields contain SHA-256 digests, never the raw identity values.
  correlation_key: z.string().regex(/^[a-f0-9]{64}$/u),
  conversation_id: hashSchema,
  workspace_id: z.string().min(1).max(128),
  event: identityTraceEventNameSchema,
  timestamp: timestampSchema,
  received_at: timestampSchema.optional(),
  reason: identityTraceFailureReasonSchema.optional(),
  created_at: timestampSchema.optional(),
  expires_at: timestampSchema.optional(),
  timeout_ms: z.number().int().nonnegative().safe().optional(),
  execution_mode: z.string().min(1).max(64).optional(),
  observed_correlation_key_hash: hashSchema.optional(),
  expected_conversation_id_hash: hashSchema.optional(),
  goal_id: traceIdSchema.optional(),
  phase_id: traceIdSchema.optional(),
  task_id: traceIdSchema.optional(),
  execution_id: traceIdSchema.optional(),
}).strict();

export type IdentityTraceEvent = z.infer<typeof identityTraceEventSchema>;
export type IdentityTraceEventName = typeof IDENTITY_TRACE_EVENTS[number];
export type IdentityTraceFailureReason = typeof IDENTITY_TRACE_FAILURE_REASONS[number];

export interface IdentityTraceRecordInput {
  readonly correlation_key: string;
  readonly conversation_id?: string | null;
  readonly workspace_id: string;
  readonly event: IdentityTraceEventName;
  readonly reason?: IdentityTraceFailureReason;
  readonly created_at?: string;
  readonly expires_at?: string;
  readonly timeout_ms?: number;
  readonly execution_mode?: string;
  readonly observed_correlation_key?: string;
  readonly expected_conversation_id?: string;
  readonly goal_id?: string;
  readonly phase_id?: string;
  readonly task_id?: string;
  readonly execution_id?: string;
}

const identityTraceQueryEventSchema = z.object({
  event: identityTraceEventNameSchema,
  timestamp: timestampSchema,
  received_at: timestampSchema.optional(),
  correlation_key_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  conversation_id_hash: hashSchema,
  workspace_id: z.string().min(1).max(128),
  reason: identityTraceFailureReasonSchema.optional(),
  created_at: timestampSchema.optional(),
  expires_at: timestampSchema.optional(),
  timeout_ms: z.number().int().nonnegative().safe().optional(),
  execution_mode: z.string().min(1).max(64).optional(),
  observed_correlation_key_hash: hashSchema.optional(),
  expected_conversation_id_hash: hashSchema.optional(),
  goal_id: traceIdSchema.optional(),
  phase_id: traceIdSchema.optional(),
  task_id: traceIdSchema.optional(),
  execution_id: traceIdSchema.optional(),
}).strict();

export const identityTraceQueryInputSchema = z.object({
  correlation_key: correlationKeySchema,
}).strict();

export const identityTraceOutputSchema = z.object({
  events: z.array(identityTraceQueryEventSchema).max(10_000),
}).strict();

export type IdentityTraceQueryInput = z.input<typeof identityTraceQueryInputSchema>;
export type IdentityTraceOutput = z.infer<typeof identityTraceOutputSchema>;

export function identityTraceStateFile(storageRoot: string): string {
  return join(resolve(storageRoot), "control-plane", "identity-trace.jsonl");
}

export function identityHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function optionalIdentityHash(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? "" : identityHash(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function timestamp(now: number): string {
  return timestampSchema.parse(new Date(now).toISOString());
}

export class IdentityTraceService {
  public readonly storageRoot: string;
  public readonly file: string;
  private readonly now: () => number;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    options: { readonly now?: () => number } = {},
  ) {
    this.storageRoot = resolve(storageRoot);
    this.file = identityTraceStateFile(this.storageRoot);
    this.now = options.now ?? Date.now;
  }

  public record(input: IdentityTraceRecordInput): void {
    try {
      const at = timestamp(this.now());
      const event = identityTraceEventSchema.parse({
        correlation_key: identityHash(input.correlation_key),
        conversation_id: optionalIdentityHash(input.conversation_id),
        workspace_id: input.workspace_id,
        event: input.event,
        timestamp: at,
        ...(input.event === "extension_evidence_received" ? { received_at: at } : {}),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.created_at === undefined ? {} : { created_at: input.created_at }),
        ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
        ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
        ...(input.execution_mode === undefined ? {} : { execution_mode: input.execution_mode }),
        ...(input.observed_correlation_key === undefined
          ? {}
          : { observed_correlation_key_hash: identityHash(input.observed_correlation_key) }),
        ...(input.expected_conversation_id === undefined
          ? {}
          : { expected_conversation_id_hash: optionalIdentityHash(input.expected_conversation_id) }),
        ...(input.goal_id === undefined ? {} : { goal_id: input.goal_id }),
        ...(input.phase_id === undefined ? {} : { phase_id: input.phase_id }),
        ...(input.task_id === undefined ? {} : { task_id: input.task_id }),
        ...(input.execution_id === undefined ? {} : { execution_id: input.execution_id }),
      });
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      chmodSync(dirname(this.file), 0o700);
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch {
      // Diagnostic tracing is observational and must never affect runtime behavior.
    }
  }

  public async getIdentityTrace(
    input: IdentityTraceQueryInput | string,
  ): Promise<IdentityTraceOutput> {
    const parsed = identityTraceQueryInputSchema.parse(
      typeof input === "string" ? { correlation_key: input } : input,
    );
    let contents: string;
    try {
      contents = await readFile(this.file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return { events: [] };
      throw new Error("Identity trace could not be read.", { cause: error });
    }

    const correlationHash = identityHash(parsed.correlation_key);
    const events: z.infer<typeof identityTraceQueryEventSchema>[] = [];
    for (const line of contents.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const candidate = identityTraceEventSchema.safeParse(value);
      if (!candidate.success || candidate.data.correlation_key !== correlationHash) continue;
      const {
        correlation_key,
        conversation_id,
        ...event
      } = candidate.data;
      events.push({
        ...event,
        correlation_key_hash: correlation_key,
        conversation_id_hash: conversation_id,
      });
    }
    return identityTraceOutputSchema.parse({ events: events.slice(-10_000) });
  }
}
