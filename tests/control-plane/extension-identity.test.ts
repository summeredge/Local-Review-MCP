import { describe, expect, it } from "vitest";
import {
  extensionIdentityEvidenceSchema,
  parseExtensionIdentityEvidence,
} from "../../src/control-plane/extension-identity.js";

const validEvidence = {
  request_id: "32ca0d45-8b29-414a-bbe4-8e26c3aae911",
  conversation_id: "11111111-2222-3333-4444-555555555555",
  document_id: "chrome-document-id",
  navigation_epoch: 0,
};
const wfrEvidence = { ...validEvidence, request_id: "wfr_01a014bdd7cd7a15b6b533d3ce2b42f2" };

describe("ExtensionIdentityEvidence schema", () => {
  it("accepts the four required identity fields and rejects unknown fields", () => {
    expect(extensionIdentityEvidenceSchema.parse(validEvidence)).toEqual(validEvidence);
    expect(extensionIdentityEvidenceSchema.parse(wfrEvidence)).toEqual(wfrEvidence);
    expect(parseExtensionIdentityEvidence({ ...validEvidence, extra: true })).toBeNull();
  });

  it.each([
    { request_id: "", conversation_id: validEvidence.conversation_id, document_id: validEvidence.document_id, navigation_epoch: 0 },
    { request_id: "wfr.bad", conversation_id: validEvidence.conversation_id, document_id: validEvidence.document_id, navigation_epoch: 0 },
    { request_id: "x".repeat(101), conversation_id: validEvidence.conversation_id, document_id: validEvidence.document_id, navigation_epoch: 0 },
    { request_id: validEvidence.request_id, conversation_id: "a/b", document_id: validEvidence.document_id, navigation_epoch: 0 },
    { request_id: validEvidence.request_id, conversation_id: validEvidence.conversation_id, document_id: "", navigation_epoch: 0 },
    { request_id: validEvidence.request_id, conversation_id: validEvidence.conversation_id, document_id: validEvidence.document_id, navigation_epoch: -1 },
    { request_id: validEvidence.request_id, conversation_id: validEvidence.conversation_id, document_id: validEvidence.document_id, navigation_epoch: 1.5 },
  ])("rejects invalid evidence %#", (evidence) => {
    expect(extensionIdentityEvidenceSchema.safeParse(evidence).success).toBe(false);
  });
});
