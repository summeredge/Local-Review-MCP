import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
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
] as const;

export const evidenceTransportTraceEventNameSchema = z.enum(EVIDENCE_TRANSPORT_TRACE_EVENTS);
const timestampSchema = z.string().datetime({ offset: true });
const hashSchema = z.string().regex(/^(?:[a-f0-9]{64})?$/u);

const evidenceTransportTraceEventSchema = z.object({
  correlation_key_hash: hashSchema,
  conversation_id_hash: hashSchema,
  timestamp: timestampSchema,
  event: evidenceTransportTraceEventNameSchema,
}).strict();

const evidenceTransportTraceQueryEventSchema = z.object({
  event: evidenceTransportTraceEventNameSchema,
  timestamp: timestampSchema,
}).strict();

export type EvidenceTransportTraceEvent = z.infer<typeof evidenceTransportTraceEventSchema>;
export type EvidenceTransportTraceEventName = typeof EVIDENCE_TRANSPORT_TRACE_EVENTS[number];

export interface EvidenceTransportTraceRecordInput {
  readonly event: EvidenceTransportTraceEventName;
  readonly correlation_key?: string | null;
  readonly conversation_id?: string | null;
}

export const evidenceTransportTraceQueryInputSchema = z.object({
  correlation_key: correlationKeySchema,
}).strict();

export const evidenceTransportTraceOutputSchema = z.object({
  events: z.array(evidenceTransportTraceQueryEventSchema).max(10_000),
}).strict();

export type EvidenceTransportTraceQueryInput = z.input<typeof evidenceTransportTraceQueryInputSchema>;
export type EvidenceTransportTraceOutput = z.infer<typeof evidenceTransportTraceOutputSchema>;

export function evidenceTransportTraceStateFile(storageRoot: string): string {
  return join(resolve(storageRoot), "control-plane", "evidence-transport-trace.jsonl");
}

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
  private readonly now: () => number;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    options: { readonly now?: () => number } = {},
  ) {
    this.storageRoot = resolve(storageRoot);
    this.file = evidenceTransportTraceStateFile(this.storageRoot);
    this.now = options.now ?? Date.now;
  }

  public record(input: EvidenceTransportTraceRecordInput): void {
    try {
      const event = evidenceTransportTraceEventSchema.parse({
        correlation_key_hash: optionalHash(input.correlation_key),
        conversation_id_hash: optionalHash(input.conversation_id),
        timestamp: timestamp(this.now()),
        event: input.event,
      });
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      chmodSync(dirname(this.file), 0o700);
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch {
      // Diagnostic tracing is observational and must never affect runtime behavior.
    }
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

    const correlationHash = identityHash(parsed.correlation_key);
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
      if (!candidate.success || candidate.data.correlation_key_hash !== correlationHash) continue;
      events.push({ event: candidate.data.event, timestamp: candidate.data.timestamp });
    }
    return evidenceTransportTraceOutputSchema.parse({ events: events.slice(-10_000) });
  }
}
