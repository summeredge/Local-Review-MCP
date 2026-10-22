import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { correlationKeySchema } from "../mcp/schema/common.js";
import { identityHash } from "./identity-trace.js";

export const EVIDENCE_TRANSPORT_TRACE_EVENTS = [
  "extension_evidence_created",
  "bridge_evidence_received",
  "bridge_evidence_forwarded",
  "bridge_evidence_rejected",
  "connector_evidence_received",
  "extension_evidence_received",
  "connector_resolve_called",
  "evidence_resolve_attempted",
  "evidence_resolve_success",
  "evidence_resolve_failed",
  "browser_identity_diagnostic",
] as const;

export const EVIDENCE_TRANSPORT_FAILURE_REASONS = [
  "pending_missing",
  "pending_expired",
  "correlation_missing",
  "goal_start_failed",
] as const;

export const evidenceTransportTraceEventNameSchema = z.enum(EVIDENCE_TRANSPORT_TRACE_EVENTS);
export const evidenceTransportTraceFailureReasonSchema = z.enum(EVIDENCE_TRANSPORT_FAILURE_REASONS);
const timestampSchema = z.string().datetime({ offset: true });
const hashSchema = z.string().regex(/^(?:[a-f0-9]{64})?$/u);
const bridgeStatusSchema = z.number().int().min(100).max(599);
const bridgeErrorSchema = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
const diagnosticCountSchema = z.union([z.number().int().min(0).max(100000), z.literal('unknown')]);
export const browserIdentityDiagnosticSchema = z.object({
  fiber_revision: z.enum(['0.1.5', 'unknown']).optional(),
  content_revision: z.enum(['0.1.5', 'unknown']).optional(),
  background_revision: z.enum(['0.1.5', 'unknown']).optional(),
  extension_version: z.string().max(32).regex(/^(?:\d+\.\d+\.\d+(?:\.\d+)?|unknown)$/u).optional(),
  snapshot_path: z.enum(['timeline', 'legacy', 'unknown']).optional(),
  candidate_turn_count: diagnosticCountSchema.optional(),
  searched_turn_count: diagnosticCountSchema.optional(),
  structured_tool_count: diagnosticCountSchema.optional(),
  recognized_submit_count: diagnosticCountSchema.optional(),
  excluded_tool_count: diagnosticCountSchema.optional(),
  most_recent: z.union([z.boolean(), z.literal('unknown')]).optional(),
  anchor_state: z.enum(['stable', 'unstable', 'absent', 'unknown']).optional(),
  selection_reason: z.enum(['tool_absent', 'tool_out_of_scope', 'tool_unsupported', 'selected',
    'invalid_submit_arguments', 'user_boundary', 'snapshot_unreadable', 'user_conflict',
    'historical_viewport', 'no_current_turn', 'scan_exception', 'unknown']).optional(),
  snapshot_selection_reason: z.enum(['selected', 'no_current_turn', 'historical_viewport',
    'snapshot_unreadable', 'user_conflict', 'user_boundary', 'no_submit_goal', 'scan_exception']).optional(),
  stage: z.enum(['scan_started', 'scan_busy', 'document_registered', 'fiber_scanned',
    'route_checked', 'deduplicated', 'worker_send_attempted', 'worker_send_finished',
    'background_received', 'document_authorized', 'bridge_send_attempted', 'bridge_send_finished']),
  scan_id: z.number().int().nonnegative().safe(),
  navigation_epoch: z.number().int().nonnegative().safe(),
  observed_at: timestampSchema,
  correlation_key_hash: hashSchema,
  conversation_id_hash: hashSchema,
  document_id_hash: hashSchema,
  flags: z.object(Object.fromEntries([
    'current_turn_present', 'fiber_root_detected', 'messages_found', 'submit_goal_found',
    'correlation_key_found', 'current_key_found', 'conversation_id_found', 'conversation_conflict',
    'conversation_unreadable', 'fiber_reply_received', 'navigation_epoch_unchanged',
    'fiber_route_match', 'register_document_ok', 'worker_reply_ok', 'bridge_reply_ok',
    'scan_in_flight', 'route_conversation_present', 'document_authorized', 'sender_source_valid',
    'evidence_generated',
  ].map(key => [key, z.boolean().optional()]))).strict(),
  assistant_tool_calls_found: z.number().int().min(0).max(100000).optional(),
  fiber_evidence_count: z.number().int().min(0).max(200).optional(),
}).strict();

const evidenceTransportTraceEventSchema = z.object({
  http_status: bridgeStatusSchema.optional(),
  error_code: bridgeErrorSchema.optional(),
  correlation_key_hash: hashSchema,
  conversation_id_hash: hashSchema,
  timestamp: timestampSchema,
  event: evidenceTransportTraceEventNameSchema,
  reason: evidenceTransportTraceFailureReasonSchema.optional(),
  diagnostic: browserIdentityDiagnosticSchema.optional(),
}).strict();

const evidenceTransportTraceQueryEventSchema = z.object({
  http_status: bridgeStatusSchema.optional(),
  error_code: bridgeErrorSchema.optional(),
  event: evidenceTransportTraceEventNameSchema,
  timestamp: timestampSchema,
  reason: evidenceTransportTraceFailureReasonSchema.optional(),
  diagnostic: browserIdentityDiagnosticSchema.optional(),
}).strict();

export type EvidenceTransportTraceEvent = z.infer<typeof evidenceTransportTraceEventSchema>;
export type EvidenceTransportTraceEventName = typeof EVIDENCE_TRANSPORT_TRACE_EVENTS[number];

export interface EvidenceTransportTraceRecordInput {
  readonly http_status?: number;
  readonly error_code?: string;
  readonly diagnostic?: z.infer<typeof browserIdentityDiagnosticSchema>;
  readonly event: EvidenceTransportTraceEventName;
  readonly reason?: z.infer<typeof evidenceTransportTraceFailureReasonSchema>;
  readonly correlation_key?: string | null;
  readonly conversation_id?: string | null;
}

export const evidenceTransportTraceQueryInputSchema = z.object({
  correlation_key: correlationKeySchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const evidenceTransportTraceOutputSchema = z.object({
  events: z.array(evidenceTransportTraceQueryEventSchema).max(10_000),
}).strict();

export type EvidenceTransportTraceQueryInput = z.input<typeof evidenceTransportTraceQueryInputSchema>;
export type EvidenceTransportTraceOutput = z.infer<typeof evidenceTransportTraceOutputSchema>;

export function evidenceTransportTraceStateFile(storageRoot: string): string {
  return join(resolve(storageRoot), "control-plane", "evidence-transport-trace.jsonl");
}

// ponytail: two constants, not a retention policy engine. Raise maxBytes when a real
// correlation window needs more; keepBytes bounds what rotation keeps after trimming.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP_BYTES = 4 * 1024 * 1024;

function optionalHash(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? "" : identityHash(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function timestamp(now: number): string {
  return timestampSchema.parse(new Date(now).toISOString());
}

export class EvidenceTransportTraceService {
  public readonly storageRoot: string;
  public readonly file: string;
  public readonly maxBytes: number;
  public readonly keepBytes: number;
  private readonly now: () => number;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    options: {
      readonly now?: () => number;
      readonly maxBytes?: number;
      readonly keepBytes?: number;
    } = {},
  ) {
    this.storageRoot = resolve(storageRoot);
    this.file = evidenceTransportTraceStateFile(this.storageRoot);
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keepBytes = options.keepBytes ?? DEFAULT_KEEP_BYTES;
  }

  public record(input: EvidenceTransportTraceRecordInput): void {
    try {
      const event = evidenceTransportTraceEventSchema.parse({
        ...(input.http_status === undefined ? {} : { http_status: input.http_status }),
        ...(input.error_code === undefined ? {} : { error_code: input.error_code }),
        correlation_key_hash: input.diagnostic?.correlation_key_hash ?? optionalHash(input.correlation_key),
        conversation_id_hash: input.diagnostic?.conversation_id_hash ?? optionalHash(input.conversation_id),
        ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        timestamp: timestamp(this.now()),
        event: input.event,
      });
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      chmodSync(dirname(this.file), 0o700);
      this.rotateIfNeeded();
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch {
      // Diagnostic tracing is observational and must never affect runtime behavior.
    }
  }

  /** Trim the JSONL file in place to the newest whole lines that fit keepBytes. */
  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (size <= this.maxBytes) return;

    const keep = Math.min(this.keepBytes, size);
    if (keep >= size) return;
    const buffer = Buffer.alloc(keep);
    const descriptor = openSync(this.file, "r");
    try {
      readSync(descriptor, buffer, 0, keep, size - keep);
    } finally {
      closeSync(descriptor);
    }
    const newline = buffer.indexOf(0x0a);
    // Drop the partial leading line so the file only ever holds whole JSONL records.
    const retained = newline === -1 ? "" : buffer.subarray(newline + 1).toString("utf8");
    writeFileSync(this.file, retained, { encoding: "utf8", mode: 0o600 });
  }

  public async getEvidenceTransportTrace(
    input: EvidenceTransportTraceQueryInput | string,
  ): Promise<EvidenceTransportTraceOutput> {
    const parsed = evidenceTransportTraceQueryInputSchema.parse(
      typeof input === "string" ? { correlation_key: input } : input,
    );
    let contents: string;
    try {
      contents = await readFile(this.file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return { events: [] };
      throw new Error("Evidence transport trace could not be read.", { cause: error });
    }

    const correlationHash = parsed.correlation_key === undefined ? null : identityHash(parsed.correlation_key);
    const events: z.infer<typeof evidenceTransportTraceQueryEventSchema>[] = [];
    for (const line of contents.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const candidate = evidenceTransportTraceEventSchema.safeParse(value);
      if (!candidate.success) continue;
      if (correlationHash === null
        ? candidate.data.event !== "browser_identity_diagnostic"
        : candidate.data.correlation_key_hash !== correlationHash) continue;
      events.push({
        ...(candidate.data.http_status === undefined ? {} : { http_status: candidate.data.http_status }),
        ...(candidate.data.error_code === undefined ? {} : { error_code: candidate.data.error_code }),
        event: candidate.data.event,
        timestamp: candidate.data.timestamp,
        ...(candidate.data.reason === undefined ? {} : { reason: candidate.data.reason }),
        ...(candidate.data.diagnostic === undefined ? {} : { diagnostic: candidate.data.diagnostic }),
      });
    }
    return evidenceTransportTraceOutputSchema.parse({
      events: events.slice(-(parsed.limit ?? (correlationHash === null ? 100 : 10_000))),
    });
  }
}
