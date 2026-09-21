import { loadSettings } from "../config/settings.js";
import { CODEX_APP_TOOLS_PIPE_ENV } from "./codex-app-runtime.js";
import {
  DesktopToolsPipeHandoffError,
  sendDesktopToolsPipeHandoff,
} from "./desktop-tools-pipe-handoff.js";

export type DesktopSessionStartHandoffStatus =
  | "handoff_accepted"
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

export async function runDesktopSessionStartHandoff(
  args: readonly string[] = [],
  dependencies: DesktopSessionStartRunnerDependencies = {},
): Promise<DesktopSessionStartHandoffStatus> {
  const env = dependencies.environment ?? process.env;
  const pipe = env[CODEX_APP_TOOLS_PIPE_ENV];
  // Diagnostics go to stderr so the hook's stdout stays free of non-JSON output for Codex.
  const log = dependencies.logStatus ?? ((status: DesktopSessionStartHandoffStatus) => {
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
    await sendDesktopToolsPipeHandoff(settings, {
      environment: env,
      fetch: boundedFetch,
    });
    clearTimeout(timer);
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
        log("pipe_env_unavailable");
        return "pipe_env_unavailable";
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
