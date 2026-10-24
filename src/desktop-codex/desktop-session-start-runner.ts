import { loadSettings } from "../config/settings.js";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CODEX_APP_TOOLS_PIPE_ENV } from "./codex-app-runtime.js";
import {
  DesktopToolsPipeHandoffError,
  sendDesktopToolsPipeHandoff,
} from "./desktop-tools-pipe-handoff.js";

export type DesktopSessionStartHandoffStatus =
  | "handoff_accepted"
  | "handoff_pending"
  | "pipe_env_unavailable"
  | "host_unavailable"
  | "handoff_rejected"
  | "timeout";

export interface DesktopSessionStartRunnerDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly logStatus?: (status: DesktopSessionStartHandoffStatus) => void;
}

const DEFAULT_HANDOFF_TIMEOUT_MS = 5000;

/** Only status evidence is durable; capability values and credentials stay in memory. */
export function recordDesktopSessionStartStatus(args: readonly string[], status: DesktopSessionStartHandoffStatus): void {
  const configIndex = args.indexOf("--config");
  const root = configIndex >= 0 && args[configIndex + 1] !== undefined
    ? dirname(resolve(args[configIndex + 1]!)) : process.cwd();
  const path = join(root, ".lrm", "desktop-session-start-status.json");
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ status, timestamp: new Date().toISOString(), pid: process.pid }));
    renameSync(temporary, path);
  } catch {
    // Diagnostic I/O must never prevent native Desktop startup or capability handoff.
  }
}

export async function runDesktopSessionStartHandoff(
  args: readonly string[] = [],
  dependencies: DesktopSessionStartRunnerDependencies = {},
): Promise<DesktopSessionStartHandoffStatus> {
  const env = dependencies.environment ?? process.env;
  const pipe = env[CODEX_APP_TOOLS_PIPE_ENV];
  // Diagnostics go to stderr so the hook's stdout stays free of non-JSON output for Codex.
  const log = dependencies.logStatus ?? ((status: DesktopSessionStartHandoffStatus) => {
    recordDesktopSessionStartStatus(args, status);
    process.stderr.write(`${status}\n`);
  });

  if (typeof pipe !== "string" || pipe.trim() === "") {
    log("pipe_env_unavailable");
    return "pipe_env_unavailable";
  }

  let settings;
  try {
    settings = await loadSettings(args);
  } catch {
    log("host_unavailable");
    return "host_unavailable";
  }

  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const baseFetch = dependencies.fetch ?? globalThis.fetch;
  const boundedFetch: typeof globalThis.fetch = async (input, init) => {
    return baseFetch(input, {
      ...init,
      signal: controller.signal,
    });
  };

  try {
    const handoff = await sendDesktopToolsPipeHandoff(settings, {
      environment: env,
      fetch: boundedFetch,
    });
    clearTimeout(timer);
    if (handoff.accepted === false) {
      log("handoff_pending");
      return "handoff_pending";
    }
    log("handoff_accepted");
    return "handoff_accepted";
  } catch (error: unknown) {
    clearTimeout(timer);
    if (timedOut) {
      log("timeout");
      return "timeout";
    }
    if (error instanceof DesktopToolsPipeHandoffError) {
      if (error.code === "desktop_tools_pipe_unavailable") {
        // The local environment was checked above; HTTP 409 means IPC is not ready yet.
        log("host_unavailable");
        return "host_unavailable";
      }
      if (error.code === "desktop_tools_pipe_request_failed") {
        log("host_unavailable");
        return "host_unavailable";
      }
      log("handoff_rejected");
      return "handoff_rejected";
    }
    log("host_unavailable");
    return "host_unavailable";
  }
}
