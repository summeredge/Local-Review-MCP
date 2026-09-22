// P5.7.0 LRM Desktop integration probe: plugin-bundled SessionStart wrapper.
//
// This file is the ONLY new logic in this probe. It records a minimal marker before any business
// logic, then delegates to the existing LRM handoff runner:
//   runDesktopSessionStartHandoff() -> sendDesktopToolsPipeHandoff()
// Nothing about pipe validation, bearer auth, the handoff HTTP request, the timeout, or the Host
// capability is re-implemented here.
//
// The LRM repository root is passed by the hook command because the installed plugin lives in the
// Codex plugin cache and must not guess the repository location from its own path.
//
// Marker policy: timestamp / phase / pid / ppid / pipe-env boolean / handoff status / exit status.
// Never recorded: the pipe path value, any token, the config contents, other env vars, prompts.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.argv[2];
const PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH";

const reviewDir = repoRoot === undefined ? undefined : join(repoRoot, ".review", "p5-7-0-plugin-sessionstart");
const markerPath = reviewDir === undefined ? undefined : join(reviewDir, "live-marker.jsonl");
const configPath = repoRoot === undefined ? undefined : join(repoRoot, "config.production.json");
const runnerPath = repoRoot === undefined
  ? undefined
  : join(repoRoot, "dist", "src", "desktop-codex", "desktop-session-start-runner.js");

const pipeEnvPresent = typeof process.env[PIPE_ENV] === "string" && process.env[PIPE_ENV].trim() !== "";

function marker(record) {
  if (markerPath === undefined) return;
  try {
    mkdirSync(reviewDir, { recursive: true });
    appendFileSync(markerPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // The marker must never change the hook's behaviour.
  }
}

marker({
  timestamp: new Date().toISOString(),
  phase: "hook_started",
  pid: process.pid,
  ppid: process.ppid,
  pipe_env_present: pipeEnvPresent,
});

let handoffStatus = "not_attempted";
let exitStatus = 0;
if (repoRoot === undefined) {
  handoffStatus = "repo_root_argument_missing";
  exitStatus = 1;
  process.stderr.write("repo root argument missing\n");
} else {
  try {
    const { runDesktopSessionStartHandoff } = await import(pathToFileURL(runnerPath).href);
    handoffStatus = await runDesktopSessionStartHandoff(["--config", configPath], {
      logStatus: (status) => {
        process.stderr.write(String(status) + "\n");
      },
    });
  } catch (error) {
    handoffStatus = "runner_import_or_call_failed";
    exitStatus = 1;
    process.stderr.write(String(error) + "\n");
  }
}

marker({
  timestamp: new Date().toISOString(),
  phase: "hook_finished",
  pid: process.pid,
  ppid: process.ppid,
  pipe_env_present: pipeEnvPresent,
  handoff_status: handoffStatus,
  exit_status: exitStatus,
});

process.exit(exitStatus);
