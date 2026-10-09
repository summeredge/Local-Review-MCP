import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

/** Save the exact legacy bytes before the store publishes its atomic replacement. */
export async function backupLegacyState(file: string, raw: string): Promise<void> {
  await writeFile(`${file}.v1-${randomUUID()}.bak`, raw, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
}

export function stateRestoreDiagnostic(file: string, error: unknown): string {
  const reason = error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join(".") || "state"}: ${issue.message}`).join("; ")
    : error instanceof SyntaxError ? "invalid JSON"
    : error instanceof Error ? error.message : String(error);
  return `${file}: ${reason}`.slice(0, 3_500);
}
