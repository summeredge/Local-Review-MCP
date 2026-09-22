// P5.7.0 diagnostic: read-only hooks/list census against a fresh app-server.
// It reports whether the LRM probe plugin's SessionStart hook is discovered and how Codex
// classifies its trust state. No hook is executed and no config is written.
import { spawn } from "node:child_process";

const codex = "C:\\Users\\shaoy\\AppData\\Local\\OpenAI\\Codex\\bin\\247581e40ee272fb\\codex.exe";
const child = spawn(codex, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buffer = "";
const responses = [];
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === "") continue;
    try { responses.push(JSON.parse(line)); } catch { responses.push({ unparsed: line.slice(0, 200) }); }
  }
});
child.stderr.on("data", () => {});

function send(message) { child.stdin.write(JSON.stringify(message) + "\n"); }

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "lrm-p570-probe", version: "0.1.0" } } });
await new Promise((r) => setTimeout(r, 1500));
send({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: {} });
await new Promise((r) => setTimeout(r, 3000));
child.kill();
process.stdout.write(JSON.stringify(responses, null, 2) + "\n");
