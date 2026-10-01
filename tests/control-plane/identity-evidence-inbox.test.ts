import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityEvidenceInbox, IDENTITY_EVIDENCE_TTL_MS, MAX_IDENTITY_EVIDENCE } from "../../src/control-plane/identity-evidence-inbox.js";

const roots: string[] = [];
const evidence = { request_id: "request-a", conversation_id: "conversation-a", document_id: "document-a", navigation_epoch: 1 };
async function inbox(now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "lrm-evidence-inbox-"));
  roots.push(root);
  return new IdentityEvidenceInbox(root, now);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("durable identity evidence Inbox", () => {
  it("persists before returning, restores proof, and keeps duplicates idempotent without extending TTL", async () => {
    let now = Date.now();
    const store = await inbox(() => now);
    await store.put(evidence);
    const initial = await readFile(store.file, "utf8");
    now += 3000;
    await store.put({ ...evidence, document_id: "new-document", navigation_epoch: 2 });
    expect(await readFile(store.file, "utf8")).toBe(initial);
    const restored = new IdentityEvidenceInbox(join(store.file, "..", ".."), () => now);
    expect(await restored.get(evidence.request_id)).toEqual(evidence);
    await expect(restored.put({ ...evidence, conversation_id: "conversation-b" })).rejects.toThrow("different conversation");
    expect(await restored.get(evidence.request_id)).toEqual(evidence);
  });

  it("automatically removes evidence with no Pending when its TTL expires", async () => {
    const store = await inbox();
    const now = Date.now();
    await mkdir(join(store.file, ".."), { recursive: true });
    await writeFile(store.file, JSON.stringify({ schema_version: 1,
      entries: [{ ...evidence, received_at: now - IDENTITY_EVIDENCE_TTL_MS + 50, expires_at: now + 50 }] }));
    await store.restore();
    const deadline = Date.now() + 1000;
    while (JSON.parse(await readFile(store.file, "utf8")).entries.length > 0) {
      if (Date.now() > deadline) throw new Error("Inbox did not automatically expire");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await store.get(evidence.request_id)).toBeNull();
  });

  it("rejects a full Inbox without evicting accepted evidence", async () => {
    const now = Date.now();
    const store = await inbox(() => now);
    const entries = Array.from({ length: MAX_IDENTITY_EVIDENCE }, (_, i) => ({ ...evidence,
      request_id: `request-${i}`, received_at: now, expires_at: now + IDENTITY_EVIDENCE_TTL_MS }));
    await mkdir(join(store.file, ".."), { recursive: true });
    await writeFile(store.file, JSON.stringify({ schema_version: 1, entries }));
    await expect(store.put(evidence)).rejects.toThrow("inbox is full");
    expect(JSON.parse(await readFile(store.file, "utf8")).entries).toEqual(entries);
  });

  it("fails closed on corrupt persisted state", async () => {
    const store = await inbox();
    await mkdir(join(store.file, ".."), { recursive: true });
    await writeFile(store.file, "{broken");
    await expect(store.put(evidence)).rejects.toThrow();
    expect(await readFile(store.file, "utf8")).toBe("{broken");
  });

  it("does not publish in-memory evidence when the durable write fails", async () => {
    const store = await inbox();
    await store.restore();
    await mkdir(store.file, { recursive: true }); // The destination is a directory: atomic rename must fail.
    await expect(store.put(evidence)).rejects.toThrow();
    expect(await store.get(evidence.request_id)).toBeNull();
  });
});
