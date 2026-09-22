// P5.6.0 read-only evidence scan: capability inventory of the installed codex_app MCP server.
// Prints counts and short code contexts only; any literal named-pipe path is redacted.
import { readFileSync } from "node:fs";

const SERVER = process.argv[2];
if (!SERVER) {
  console.error("usage: node scan-codex-app-mcp-capability.mjs <server.mjs>");
  process.exit(64);
}

const PIPE_PREFIX = "\\\\.\\pipe\\";

function redact(text) {
  return text
    .split(PIPE_PREFIX)
    .map((part, index) => (index === 0 ? part : part.replace(/^[^\s"'<>]*/, "[REDACTED_PIPE]")))
    .join("");
}

const MARKERS = [
  "setRequestHandler",
  "setNotificationHandler",
  "oninitialized",
  "new Server(",
  "StdioServerTransport",
  "server.connect",
  "net.createConnection",
  "process.env",
  "process.argv",
  "node:net",
  "node:http",
  "node:https",
  "node:child_process",
  "child_process",
  "spawn(",
  "execFile(",
  "execSync(",
  "fetch(",
  "XMLHttpRequest",
  "createServer",
  ".listen(",
  "import(",
  "require(",
  "setInterval",
  "setTimeout",
  "process.on(",
  "process.once(",
  "capabilities:",
  "sampling",
  "elicitation",
  "roots",
  "CODEX_APP_TOOLS_PIPE_PATH",
];

const buffer = readFileSync(SERVER);
const report = { server: "server.mjs", bytes: buffer.length, markers: {}, codeImports: [] };

for (const marker of MARKERS) {
  const target = Buffer.from(marker, "utf8");
  let index = buffer.indexOf(target);
  let count = 0;
  const contexts = [];
  while (index !== -1) {
    count += 1;
    if (contexts.length < 3) {
      contexts.push(
        redact(
          buffer
            .slice(Math.max(0, index - 160), Math.min(buffer.length, index + 160))
            .toString("utf8"),
        ),
      );
    }
    index = buffer.indexOf(target, index + 1);
  }
  report.markers[marker] = { count, contexts };
}

// Only real ESM import specifiers, so bundled CJS shims do not pollute the inventory.
const text = buffer.toString("utf8");
const importPattern = /^import[^;]*?from\s*"([^"]+)";/gm;
let match = importPattern.exec(text);
while (match !== null) {
  report.codeImports.push(match[1]);
  match = importPattern.exec(text);
}

console.log(JSON.stringify(report, null, 2));
