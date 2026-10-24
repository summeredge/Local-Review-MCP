import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateDesktopToolsPipePath } from "./desktop-tools-pipe-handoff.js";
import { runDesktopSessionStartHandoff, type DesktopSessionStartHandoffStatus } from "./desktop-session-start-runner.js";

export interface DesktopHandoffMaintenanceDependencies {
  readonly checkPipe: () => Promise<void>;
  readonly handoff: () => Promise<DesktopSessionStartHandoffStatus>;
  readonly wait: () => Promise<void>;
}

/** The Desktop-owned capability outlives LRM, but never outlives the native tools transport. */
export async function maintainDesktopSessionStartHandoff(dependencies: DesktopHandoffMaintenanceDependencies): Promise<void> {
  for (;;) {
    await dependencies.checkPipe();
    const status = await dependencies.handoff();
    if (status === "handoff_rejected" || status === "pipe_env_unavailable") return;
    await dependencies.wait();
  }
}

function checkPipe(pipe: string): Promise<void> {
  return new Promise((accept, reject) => {
    const socket = createConnection({ path: pipe });
    socket.setTimeout(5000, () => socket.destroy(new Error("Desktop pipe timed out.")));
    socket.once("error", reject);
    socket.once("connect", () => { socket.destroy(); accept(); });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pipe = validateDesktopToolsPipePath(process.env.CODEX_APP_TOOLS_PIPE_PATH);
  // This is LRM's own ephemeral mutex, derived from received evidence; no Desktop pipe discovery.
  const key = createHash("sha256").update(pipe).update(JSON.stringify(args)).digest("hex");
  const mutex = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((accept, reject) => {
      mutex.once("error", reject);
      mutex.listen(`\\\\.\\pipe\\lrm-session-start-${key}`, accept);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return;
    throw error;
  }
  try {
    await maintainDesktopSessionStartHandoff({
      checkPipe: () => checkPipe(pipe),
      handoff: () => runDesktopSessionStartHandoff(args),
      wait: () => delay(10_000),
    });
  } finally {
    mutex.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No raw transport error may reach a durable log (it can contain a pipe path).
  void main().catch(() => { process.exitCode = 1; });
}
