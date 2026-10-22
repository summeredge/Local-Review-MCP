import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { atomicWriteRecord, serializeRecord } from "../context/record-store.js";
import { workspaceIdSchema } from "../context/schema.js";
import { reviewRequestIdSchema } from "../context/review-schema.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { ReviewResultService } from "../context/review-result-service.js";
import { reviewVerdictSchema } from "../control/review-verdict-schema.js";
import { correlationKeySchema } from "../mcp/schema/common.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { AutoIteration } from "./auto-iteration.js";
import type { ExtensionDeliveryService } from "./extension-delivery.js";
import { extensionIdentityEvidenceSchema } from "./extension-identity.js";
import { goalConnectorProvenanceSchema, type GoalConnectorProvenance } from "./goal-preflight.js";
import { identityEvidenceAck } from "./identity-evidence-inbox.js";

export const REVIEW_VERDICT_CONFIRMATION_TIMEOUT_MS = 120_000;
export const submitReviewVerdictInputSchema = z.object({
  workspace_id: workspaceIdSchema,
  correlation_key: correlationKeySchema,
  verdict: reviewVerdictSchema,
}).strict();
export const submitReviewVerdictAcceptedSchema = z.object({
  accepted: z.literal(true),
  state: z.literal("pending_confirmation"),
  review_request_id: reviewRequestIdSchema,
  correlation_key: correlationKeySchema,
}).strict();
export const reviewVerdictIdentityEvidenceSchema = extensionIdentityEvidenceSchema.required({
  tool_name: true, connector: true, workspace_id: true, review_request_id: true,
  expected_user_message_id: true, tool_call_id: true,
}).extend({ request_id: correlationKeySchema, verdict: reviewVerdictSchema }).strict();

const submissionSchema = z.object({
  correlation_key: correlationKeySchema,
  verdict_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  connector_provenance: goalConnectorProvenanceSchema,
  accepted_at: z.number().int().nonnegative(),
}).strict();

function verdictHash(verdict: z.infer<typeof reviewVerdictSchema>): string {
  // Both callers use Schema-normalized objects, including property order.
  return createHash("sha256").update(JSON.stringify(verdict)).digest("hex");
}

const recordSchema = z.object({
  schema_version: z.literal(1),
  workspace_id: workspaceIdSchema,
  review_request_id: reviewRequestIdSchema,
  task_id: z.string().min(1),
  execution_id: z.string().min(1),
  conversation_id: z.string().min(1),
  routing_id: z.string().min(1),
  delivery_id: z.string().min(1),
  expected_user_message_id: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  submissions: z.array(submissionSchema).max(1_000),
  evidence: reviewVerdictIdentityEvidenceSchema.optional(),
  confirmed_at: z.number().int().nonnegative().optional(),
}).strict();
type VerdictRecord = z.infer<typeof recordSchema>;

export class ReviewVerdictSubmissionError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); }
}

export interface ReviewVerdictSubmissionOptions {
  readonly storageRoot: string;
  readonly extensionDeliveries: Pick<ExtensionDeliveryService, "getByLogicalDeliveryId">;
  readonly listLoops: () => Promise<AutoIteration[]>;
  readonly now?: () => number;
}

export class ReviewVerdictSubmissionService {
  public readonly storageRoot: string;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Set<() => void>>();
  private disposed = false;

  public constructor(private readonly registry: WorkspaceRegistry, private readonly options: ReviewVerdictSubmissionOptions) {
    this.storageRoot = resolve(options.storageRoot);
    this.now = options.now ?? Date.now;
  }

  public async accept(input: z.infer<typeof submitReviewVerdictInputSchema>, provenance?: GoalConnectorProvenance) {
    if (provenance === undefined) this.fail("VERDICT_AUTHENTICATION_REQUIRED");
    const parsed = submitReviewVerdictInputSchema.parse(input);
    const authenticated = goalConnectorProvenanceSchema.parse(provenance);
    const file = this.file(parsed.workspace_id, parsed.verdict.review_request_id);
    await serializeRecord(file, async () => {
      let record = await this.read(parsed.workspace_id, parsed.verdict.review_request_id);
      const duplicate = record?.submissions.find((candidate) => candidate.correlation_key === parsed.correlation_key);
      if (record !== null && duplicate !== undefined) {
        if (duplicate.verdict_sha256 !== verdictHash(parsed.verdict)) this.fail("VERDICT_SUBMISSION_CONFLICT");
        if (record.confirmed_at === undefined) {
          this.assertBinding(record, await this.binding(parsed.workspace_id, parsed.verdict.review_request_id));
          await this.assertUnexpired(record);
        }
        // A retry acknowledges the same durable receipt, including after the loop finishes.
        return;
      }
      if (record?.confirmed_at !== undefined) this.fail("VERDICT_SUBMISSION_CONFLICT");
      const binding = await this.binding(parsed.workspace_id, parsed.verdict.review_request_id);
      record ??= { schema_version: 1, ...binding, created_at: this.now(), submissions: [] };
      this.assertBinding(record, binding);
      await this.assertUnexpired(record);
      if (record.evidence !== undefined && (record.evidence.request_id !== parsed.correlation_key
        || !isDeepStrictEqual(record.evidence.verdict, parsed.verdict))) this.fail("VERDICT_SUBMISSION_CONFLICT");
      // Unproved calls cannot reserve the Review: only independently verified evidence selects a candidate.
      record = { ...record, submissions: [...record.submissions,
        { correlation_key: parsed.correlation_key, verdict_sha256: verdictHash(parsed.verdict),
          connector_provenance: authenticated, accepted_at: this.now() }] };
      if (record.submissions.length > 1_000) this.fail("VERDICT_PENDING_CAPACITY_REACHED");
      await this.save(file, this.confirm(record));
    });
    this.wake(file);
    return submitReviewVerdictAcceptedSchema.parse({ accepted: true, state: "pending_confirmation",
      review_request_id: parsed.verdict.review_request_id, correlation_key: parsed.correlation_key });
  }

  public async receiveIdentityEvidence(input: unknown) {
    const evidence = reviewVerdictIdentityEvidenceSchema.parse(input);
    if (evidence.verdict.review_request_id !== evidence.review_request_id) this.fail("VERDICT_EVIDENCE_IDENTITY_INVALID");
    const file = this.file(evidence.workspace_id, evidence.review_request_id);
    await serializeRecord(file, async () => {
      let record = await this.read(evidence.workspace_id, evidence.review_request_id);
      if (record?.evidence !== undefined) {
        if (!isDeepStrictEqual(record.evidence, evidence)) this.fail("VERDICT_EVIDENCE_CONFLICT");
        if (record.confirmed_at === undefined) {
          this.assertBinding(record, await this.binding(evidence.workspace_id, evidence.review_request_id));
          await this.assertUnexpired(record);
        }
        return;
      }
      const binding = await this.binding(evidence.workspace_id, evidence.review_request_id);
      record ??= { schema_version: 1, ...binding, created_at: this.now(), submissions: [] };
      this.assertBinding(record, binding);
      await this.assertUnexpired(record);
      const delivery = await this.options.extensionDeliveries.getByLogicalDeliveryId(binding.delivery_id);
      const receipt = delivery?.receipt;
      if (evidence.conversation_id !== binding.conversation_id
        || evidence.expected_user_message_id !== binding.expected_user_message_id
        || receipt?.document_id !== evidence.document_id
        || receipt.navigation_epoch !== evidence.navigation_epoch) this.fail("VERDICT_EVIDENCE_IDENTITY_INVALID");
      await this.save(file, this.confirm({ ...record, evidence }));
    });
    this.wake(file);
    return identityEvidenceAck;
  }

  public async getConfirmed(workspaceId: string, reviewRequestId: string) {
    const record = await this.read(workspaceId, reviewRequestId);
    if (record?.confirmed_at === undefined) return null;
    this.assertBinding(record, await this.binding(workspaceId, reviewRequestId));
    return record.evidence!.verdict;
  }

  public async confirmationDiagnostic(workspaceId: string, reviewRequestId: string): Promise<string> {
    const record = await this.read(workspaceId, reviewRequestId);
    if (!record?.submissions.length) return "TOOL_VERDICT_NOT_SUBMITTED";
    if (record.evidence === undefined) return "TOOL_VERDICT_IDENTITY_UNCONFIRMED";
    return "TOOL_VERDICT_CONFIRMATION_TIMEOUT";
  }

  public dispose(): void {
    this.disposed = true;
    for (const file of this.waiters.keys()) this.wake(file);
  }

  /** One bounded event wait; the durable Completion timestamp owns the deadline. */
  public async awaitConfirmed(workspaceId: string, reviewRequestId: string, deadline: number) {
    const file = this.file(workspaceId, reviewRequestId);
    while (!this.disposed) {
      let wake!: () => void;
      const changed = new Promise<void>((done) => { wake = done; });
      const held = this.waiters.get(file) ?? new Set<() => void>();
      held.add(wake);
      this.waiters.set(file, held);
      let timer: NodeJS.Timeout | undefined;
      try {
        const confirmed = await this.getConfirmed(workspaceId, reviewRequestId);
        if (confirmed !== null) return confirmed;
        const remaining = deadline - this.now();
        if (remaining <= 0) return null;
        timer = setTimeout(wake, remaining);
        timer.unref();
        await changed;
      } finally {
        clearTimeout(timer);
        held.delete(wake);
        if (held.size === 0 && this.waiters.get(file) === held) this.waiters.delete(file);
      }
    }
    return null;
  }

  private async binding(workspaceId: string, requestId: string) {
    this.registry.resolve(workspaceId);
    const request = await new ReviewRequestService(this.storageRoot).getReviewRequest(workspaceId, requestId);
    if (request?.verdict_protocol !== "tool_v1") this.fail("VERDICT_REVIEW_NOT_TOOL_PROTOCOL");
    const matches = (await this.options.listLoops()).filter((loop) => loop.workspace_id === workspaceId
      && loop.review_request_id === requestId && ["delivery", "review_completion", "verdict"].includes(loop.stage));
    if (matches.length !== 1) this.fail("VERDICT_REVIEW_NOT_ACTIVE");
    const loop = matches[0]!;
    if (request.task_id !== loop.task_id || request.execution_id !== loop.execution_id
      || request.conversation_id !== loop.conversation_id || loop.routing_id === undefined
      || loop.delivery_id === undefined) this.fail("VERDICT_REVIEW_IDENTITY_INVALID");
    const execution = await new ExecutionContextService(this.storageRoot).getExecutionContext(workspaceId, loop.task_id, loop.execution_id);
    if (execution?.status !== "passed") this.fail("VERDICT_EXECUTION_NOT_PASSED");
    const routing = await new ConversationRoutingService(this.storageRoot).getRouting(workspaceId, loop.routing_id);
    const deliveries = new ReviewDeliveryService(this.storageRoot);
    const delivery = await deliveries.getDelivery(workspaceId, loop.delivery_id);
    if (routing === null || routing.review_request_id !== requestId || routing.task_id !== loop.task_id
      || routing.execution_id !== loop.execution_id || routing.conversation_id !== loop.conversation_id
      || delivery === null || delivery.review_request_id !== requestId || delivery.routing_id !== routing.routing_id
      || delivery.conversation_id !== loop.conversation_id || delivery.task_id !== loop.task_id
      || !["delivering", "delivered"].includes(delivery.status)) this.fail("VERDICT_DELIVERY_IDENTITY_INVALID");
    await deliveries.validateDelivery(delivery);
    const transport = await this.options.extensionDeliveries.getByLogicalDeliveryId(delivery.delivery_id);
    if (transport?.logical_delivery_id !== delivery.delivery_id || transport.conversation_id !== loop.conversation_id
      || transport.phase !== "delivered" || transport.receipt?.status !== "delivered"
      || transport.receipt.delivery_id !== transport.delivery_id
      || transport.receipt.conversation_id !== loop.conversation_id || !transport.receipt.message_id) this.fail("VERDICT_DELIVERY_NOT_CONFIRMED");
    return { workspace_id: workspaceId, review_request_id: requestId, task_id: loop.task_id,
      execution_id: loop.execution_id, conversation_id: loop.conversation_id, routing_id: routing.routing_id,
      delivery_id: delivery.delivery_id, expected_user_message_id: transport.receipt.message_id };
  }

  private confirm(record: VerdictRecord): VerdictRecord {
    if (record.evidence === undefined) return record;
    const selected = record.submissions.find((candidate) => candidate.correlation_key === record.evidence!.request_id);
    if (selected === undefined) return record;
    if (selected.verdict_sha256 !== verdictHash(record.evidence.verdict)) this.fail("VERDICT_SUBMISSION_CONFLICT");
    return { ...record, confirmed_at: this.now() };
  }

  private assertBinding(record: VerdictRecord, binding: Awaited<ReturnType<ReviewVerdictSubmissionService["binding"]>>) {
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      if (record[key] !== binding[key]) this.fail("VERDICT_REVIEW_IDENTITY_INVALID");
    }
  }

  private async assertUnexpired(record: VerdictRecord) {
    const result = await new ReviewResultService(this.storageRoot).getReviewResultByRequest(record.workspace_id, record.review_request_id);
    if (result?.status === "COMPLETED"
      && this.now() >= Date.parse(result.created_at) + REVIEW_VERDICT_CONFIRMATION_TIMEOUT_MS) this.fail("VERDICT_CONFIRMATION_EXPIRED");
  }

  private file(workspaceId: string, requestId: string) {
    return join(this.storageRoot, "control-plane", "review-verdicts", workspaceIdSchema.parse(workspaceId), `${reviewRequestIdSchema.parse(requestId)}.json`);
  }

  private async read(workspaceId: string, requestId: string): Promise<VerdictRecord | null> {
    let raw: string;
    try { raw = await readFile(this.file(workspaceId, requestId), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const record = recordSchema.parse(JSON.parse(raw));
    const selected = record.submissions.find((candidate) => candidate.correlation_key === record.evidence?.request_id);
    if (record.workspace_id !== workspaceId || record.review_request_id !== requestId
      || new Set(record.submissions.map((candidate) => candidate.correlation_key)).size !== record.submissions.length
      || (record.evidence !== undefined && (record.evidence.workspace_id !== workspaceId
        || record.evidence.review_request_id !== requestId || record.evidence.verdict.review_request_id !== requestId
        || record.evidence.conversation_id !== record.conversation_id
        || record.evidence.expected_user_message_id !== record.expected_user_message_id))
      || (record.confirmed_at !== undefined && (selected === undefined || record.evidence === undefined
        || record.confirmed_at < record.created_at
        || selected.verdict_sha256 !== verdictHash(record.evidence.verdict)))) this.fail("VERDICT_RECORD_INVALID");
    return record;
  }

  private async save(file: string, record: VerdictRecord) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await atomicWriteRecord(file, `${JSON.stringify(recordSchema.parse(record), null, 2)}\n`);
  }

  private wake(file: string) { for (const done of this.waiters.get(file) ?? []) done(); }
  private fail(code: string): never { throw new ReviewVerdictSubmissionError(code, code); }
}
