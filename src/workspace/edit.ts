import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readBoundedBytes } from "./text.js";
import { leaseEditDirectory } from "./edit-directory-lease.js";
import { serializeRecord } from "../context/record-store.js";
import { workspaceIdSchema, workspaceRelativePathSchema } from "../mcp/schema/common.js";
import { WorkspacePathError } from "./path.js";
import type { WorkspaceSelection } from "./registry.js";

export const MAX_EDIT_BYTES = 1024 * 1024;
const text = z.string().max(MAX_EDIT_BYTES).refine((value) =>
  !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value,
"Expected valid UTF-8 text without NUL");
export const editFileInputSchema = z.object({
  workspace_id: workspaceIdSchema,
  path: workspaceRelativePathSchema,
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  edits: z.array(z.object({ old_text: text.refine((value) => value.length > 0), new_text: text })).min(1).max(5),
});
export const editFileOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  path: workspaceRelativePathSchema,
  success: z.literal(true),
  edits_applied: z.number().int().min(1).max(5),
  before_sha256: z.string(),
  after_sha256: z.string(),
  metadata_note: z.string(),
});
export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function target(selection: WorkspaceSelection, path: string) {
  const resolved = selection.manager.resolveExisting(path);
  let current = selection.manager.root;
  for (const part of resolved.relativePath.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new WorkspacePathError("UNSAFE_EDIT_TARGET", "Links and Junctions cannot be edited.");
    }
  }
  const stats = await lstat(resolved.absolutePath);
  if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o200) === 0) {
    throw new WorkspacePathError("UNSAFE_EDIT_TARGET", "Expected a writable regular file without hard links.");
  }
  return { ...resolved, stats };
}

export async function editWorkspaceFile(selection: WorkspaceSelection, value: z.infer<typeof editFileInputSchema>) {
  const input = editFileInputSchema.parse(value);
  if (input.workspace_id !== selection.id) {
    throw new WorkspacePathError("EDIT_NOT_AUTHORIZED", "workspace_id must match the selected registered workspace.");
  }
  const initial = await target(selection, input.path);
  const key = process.platform === "win32" ? initial.absolutePath.toLowerCase() : initial.absolutePath;
  return serializeRecord(key, async () => {
    let lease: Awaited<ReturnType<typeof leaseEditDirectory>>;
    try { lease = await leaseEditDirectory(initial.absolutePath); }
    catch { throw new WorkspacePathError("EDIT_WRITE_FAILED", "Could not lease target directories; secure editing requires Windows PowerShell."); }
    try {
      const resolved = await target(selection, input.path);
      if (resolved.absolutePath !== initial.absolutePath) throw new WorkspacePathError("UNSAFE_EDIT_TARGET", "Target changed.");
      const file = await open(resolved.absolutePath, "r");
      let original: Buffer;
      try {
        const stats = await file.stat();
        if (stats.dev !== resolved.stats.dev || stats.ino !== resolved.stats.ino) throw new WorkspacePathError("UNSAFE_EDIT_TARGET", "Target changed.");
        if (stats.size > MAX_EDIT_BYTES) throw new WorkspacePathError("FILE_TOO_LARGE", "Editing is limited to 1 MiB.");
        original = await readBoundedBytes(file, MAX_EDIT_BYTES);
        if (original.length > MAX_EDIT_BYTES) throw new WorkspacePathError("FILE_TOO_LARGE", "Editing is limited to 1 MiB.");
      } finally { await file.close(); }
      if (original.includes(0)) throw new WorkspacePathError("BINARY_FILE", "Binary files cannot be edited.");
      try { new TextDecoder("utf-8", { fatal: true }).decode(original); }
      catch { throw new WorkspacePathError("INVALID_UTF8", "File must be valid UTF-8."); }
      const before = sha256(original);
      if (before !== input.expected_sha256) throw new WorkspacePathError("HASH_CONFLICT", "File hash changed; read again.");
      const bom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
      const ranges = input.edits.map(({ old_text, new_text }) => {
        const old = Buffer.from(old_text, "utf8");
        const start = original.indexOf(old, bom);
        if (start < 0) throw new WorkspacePathError("TEXT_NOT_FOUND", "old_text was not found.");
        if (original.indexOf(old, start + 1) >= 0) throw new WorkspacePathError("TEXT_NOT_UNIQUE", "old_text must match once.");
        return { start, end: start + old.length, replacement: Buffer.from(new_text, "utf8") };
      }).sort((a, b) => a.start - b.start);
      const chunks: Buffer[] = [];
      let end = 0;
      for (const range of ranges) {
        if (range.start < end) throw new WorkspacePathError("OVERLAPPING_EDITS", "Edits overlap in the original file.");
        chunks.push(original.subarray(end, range.start), range.replacement);
        end = range.end;
      }
      chunks.push(original.subarray(end));
      const updated = Buffer.concat(chunks);
      if (updated.length > MAX_EDIT_BYTES) throw new WorkspacePathError("FILE_TOO_LARGE", "Result exceeds 1 MiB.");
      const temporary = resolved.absolutePath + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        const checked = await target(selection, input.path);
        if (checked.absolutePath !== resolved.absolutePath || checked.stats.ino !== resolved.stats.ino
          || checked.stats.dev !== resolved.stats.dev) throw new WorkspacePathError("UNSAFE_EDIT_TARGET", "Target changed.");
        // External writers do not share this lock; this is not cross-process CAS.
        await lease.commit(temporary, updated);
      } catch (error) {
        if (error instanceof WorkspacePathError) throw error;
        throw new WorkspacePathError("EDIT_WRITE_FAILED", "Atomic file replacement failed.");
      }
      return {
        workspace_id: selection.id, path: resolved.relativePath, success: true as const,
        edits_applied: ranges.length, before_sha256: before, after_sha256: sha256(updated),
        metadata_note: "Mode bits preserved. New inode; timestamps, custom ACLs, xattrs and Windows alternate streams are not preserved; Windows directory ACL inheritance applies.",
      };
    } finally { await lease.release(); }
  });
}
