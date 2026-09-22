// P5.7.2 evidence: read-only hooks/list census against a fresh app-server.
// Reports which SessionStart registrations Codex still discovers and how it classifies their
// trust state. No hook is executed and no config is written.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const codex = process.argv[2];
const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
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

const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "lrm-p572-census", version: "0.1.0" } } });
await new Promise((r) => setTimeout(r, 1500));
send({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: {} });
await new Promise((r) => setTimeout(r, 4000));
child.kill();

writeFileSync(".review/p5-7-2-hook-consolidation/hooks-list-census.json", JSON.stringify(responses, null, 2) + "\n", "utf8");

const entries = responses.find((r) => r.id === 2)?.result?.data ?? [];
const allHooks = entries.flatMap((entry) => entry.hooks ?? []);
const sessionStart = allHooks.filter((h) => h.eventName === "sessionStart");
process.stdout.write(JSON.stringify({
  sessionStart: sessionStart.map((h) => ({
    source: h.sourcePath ?? h.source ?? null,
    key: h.key ?? null,
    trustStatus: h.trustStatus ?? h.trust ?? null,
    command: h.command ?? null,
    matcher: h.matcher ?? null,
    enabled: h.enabled ?? null,
  })),
}, null, 2) + "\n");
