// Local Review MCP Desktop SessionStart handoff hook.
//
// The only logic here is delegation to the existing LRM handoff runner:
//   runDesktopSessionStartHandoff() -> sendDesktopToolsPipeHandoff()
// No pipe validation, bearer request, handoff HTTP call, timeout, or Host capability logic is
// re-implemented. The repository root is passed by the hook command because the installed plugin
// lives in the Codex plugin cache and must not guess the repository location from its own path.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = process.argv[2];
if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
  process.stderr.write("lrm session-start handoff: repository root argument missing\n");
  process.exit(1);
}

const runnerPath = join(repoRoot, "dist", "src", "desktop-codex", "desktop-session-start-runner.js");
const configPath = join(repoRoot, "config.production.json");

try {
  const { runDesktopSessionStartHandoff } = await import(pathToFileURL(runnerPath).href);
  await runDesktopSessionStartHandoff(["--config", configPath]);
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH) {
    const worker = spawn(process.execPath, [
      join(repoRoot, "dist", "src", "desktop-codex", "desktop-session-start-maintainer.js"),
      "--config", configPath,
    ], { detached: true, windowsHide: true, stdio: "ignore", env: process.env });
    worker.on("error", () => process.stderr.write("lrm session-start maintenance: spawn_failed\n"));
    worker.unref();
  }
} catch (error) {
  process.stderr.write("lrm session-start handoff: runner_failed\n");
  process.exit(1);
}
