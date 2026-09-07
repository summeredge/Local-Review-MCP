import { z } from "zod";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ROUTE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export const extensionIdentityEvidenceSchema = z.object({
  request_id: z.string().min(1).max(100).regex(REQUEST_ID_PATTERN),
  conversation_id: z.string().min(1).max(256).regex(ROUTE_SEGMENT_PATTERN),
  document_id: z.string().min(1).max(256).regex(DOCUMENT_ID_PATTERN),
  navigation_epoch: z.number().int().nonnegative().refine(Number.isSafeInteger),
}).strict();

export type ExtensionIdentityEvidence = z.infer<typeof extensionIdentityEvidenceSchema>;

export function parseExtensionIdentityEvidence(value: unknown): ExtensionIdentityEvidence | null {
  const parsed = extensionIdentityEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
