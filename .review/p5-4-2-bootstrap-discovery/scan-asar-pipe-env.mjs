// P5.4.2 read-only evidence scan: locate the Desktop (app.asar) side of CODEX_APP_TOOLS_PIPE_PATH.
// Prints code context only; any literal named-pipe path is redacted.
import { readFileSync } from "node:fs";

const ASAR = process.argv[2];
const NEEDLES = process.argv.slice(3);
const PIPE_PREFIX = "\\\\.\\pipe\\";

function redact(text) {
  return text.split(PIPE_PREFIX).map((part, index) => index === 0
    ? part
    : part.replace(/^[^\s"'<>]*/, "[REDACTED_PIPE]")).join("");
}

const buffer = readFileSync(ASAR);
const report = {};
for (const needle of NEEDLES) {
  const target = Buffer.from(needle, "utf8");
  let index = buffer.indexOf(target);
  let count = 0;
  const contexts = [];
  while (index !== -1) {
    count += 1;
    if (contexts.length < 8) {
      contexts.push(redact(buffer.slice(Math.max(0, index - 340), Math.min(buffer.length, index + 260)).toString("utf8")));
    }
    index = buffer.indexOf(target, index + 1);
  }
  report[needle] = { count, contexts };
}
console.log(JSON.stringify(report, null, 2));
