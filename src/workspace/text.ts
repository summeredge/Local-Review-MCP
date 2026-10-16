import { open, type FileHandle } from "node:fs/promises";
import { WorkspacePathError } from "./path.js";

export const BINARY_CHECK_BYTES = 16 * 1024;

export async function readBoundedBytes(file: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

export async function containsNullByte(path: string, relativePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace file could not be read.", relativePath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
