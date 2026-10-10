import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";

// Shared across service instances: serialize the whole read-modify-publish operation.
const writes = new Map<string, Promise<void>>();
export function serializeRecord<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(file) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  writes.set(file, settled);
  void settled.finally(() => { if (writes.get(file) === settled) writes.delete(file); });
  return result;
}

export async function atomicWriteRecord(file: string, contents: string): Promise<void> {
  const temporary = file + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
