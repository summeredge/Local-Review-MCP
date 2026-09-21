// P5.4.2 temporary SessionStart hook probe.
// Records environment *presence only* (never the pipe path value) and the result of the existing
// handoff CLI, so the PoC proves the supported trigger can reach the LRM loopback endpoint.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
const OUT_PATH = join(HERE, "session-start-hook.json");
const TRACKED_KEYS = [
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_MCP_NODE_PATH",
  "CODEX_BROWSER_USE_NODE_PATH",
  "CODEX_ELECTRON_RESOURCES_PATH",
  "CODEX_CLI_PATH",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
];

function presence(env) {
  const out = {};
  for (const key of TRACKED_KEYS) {
    out[key] = typeof env[key] === "string" && env[key].length > 0;
  }
  return out;
}

function runHandoffCli() {
  const cli = join(REPO, "dist", "src", "cli.js");
  const configPath = join(REPO, "config.production.json");
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, "handoff-desktop-tools-pipe", "--config", configPath], {
      cwd: REPO,
      timeout: 20000,
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      let parsed = null;
      try { parsed = JSON.parse(String(stdout)); } catch { parsed = null; }
      resolve({
        exit_code: error && typeof error.code === "number" ? error.code : 0,
        stdout_json: parsed,
        stderr_present: typeof stderr === "string" && stderr.trim().length > 0,
      });
    });
  });
}

async function main(rawInput) {
  let hook = {};
  try { hook = JSON.parse(rawInput); } catch { hook = {}; }
  const record = {
    probe: "p5-4-2-session-start-hook",
    hook_event_name: typeof hook.hook_event_name === "string" ? hook.hook_event_name : null,
    hook_source: typeof hook.source === "string" ? hook.source : null,
    session_id: typeof hook.session_id === "string" ? hook.session_id : null,
    hook_cwd: typeof hook.cwd === "string" ? hook.cwd : null,
    hook_process_id: process.pid,
    hook_process_ppid: process.ppid,
    hook_process_cwd: process.cwd(),
    hook_process_env_presence: presence(process.env),
    started_at: new Date().toISOString(),
  };
  record.handoff_cli = await runHandoffCli();
  record.finished_at = new Date().toISOString();
  writeFileSync(OUT_PATH, JSON.stringify(record, null, 2), "utf8");
  return record;
}

let input = "";
let done = false;
function finish() {
  if (done) return;
  done = true;
  main(input).then(() => process.exit(0), () => process.exit(0));
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", finish);
process.stdin.on("error", finish);
setTimeout(finish, 3000).unref();
