// P5.4.3.2 verification-only reader: reports the live Launcher desktop state for the acceptance
// lines of this experiment. Prints booleans and non-secret identity fields only; the pipe path and
// the auth token are never printed. Read-only unless --probe is passed.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const configPath = process.argv[2] ?? join(repoRoot, "config.production.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const base = `http://${config.host ?? "127.0.0.1"}:${config.port}`;
const headers = { authorization: `Bearer ${config.auth.token}` };

async function get(path) {
  const response = await fetch(base + path, { headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const report = { at: new Date().toISOString(), base };

const sync = await get("/launcher/desktop-sync");
report.desktop_sync = {
  status: sync.status,
  connected: sync.body?.connected ?? null,
  currentConversationId: sync.body?.currentConversationId ?? null,
  ownerClientId: sync.body?.ownerClientId ?? null,
  lastEventTime: sync.body?.lastEventTime ?? null,
  fallbackReason: sync.body?.fallbackReason ?? null,
};

const interactive = await get("/launcher/desktop-interactive");
report.desktop_interactive = {
  status: interactive.status,
  ready: interactive.body?.ready ?? null,
  reason: interactive.body?.reason ?? null,
  pipeSource: interactive.body?.pipeSource ?? null,
};

if (process.argv.includes("--probe")) {
  const response = await fetch(`${base}/launcher/desktop-tools-pipe/probe`, { method: "POST", headers });
  const body = await response.json().catch(() => null);
  report.probe = {
    status: response.status,
    connected: body?.connected ?? null,
    error: body?.error ?? null,
    mcpTransport: body?.mcpTransport ?? null,
    nativeDesktopTransport: body?.nativeDesktopTransport ?? null,
    codexAppToolsVersion: body?.codexAppToolsVersion ?? null,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : null,
  };
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
