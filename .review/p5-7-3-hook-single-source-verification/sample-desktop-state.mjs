// P5.7.3 evidence: read-only sampler for the LRM launcher Desktop capability endpoints.
//
// GET only. It never posts a handoff, never runs the pipe probe, and never enumerates pipes, so
// running it can never create the capability whose source it reports.
import { readFileSync } from "node:fs";

const configPath = process.argv[2];
const config = JSON.parse(readFileSync(configPath, "utf8"));
const base = `http://127.0.0.1:${config.port}`;
const headers = { authorization: `Bearer ${config.auth.token}` };

async function read(path) {
  try {
    const response = await fetch(`${base}${path}`, { method: "GET", headers });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, error: String(error).slice(0, 120) };
  }
}

const [interactive, sync] = await Promise.all([
  read("/launcher/desktop-interactive"),
  read("/launcher/desktop-sync"),
]);

process.stdout.write(JSON.stringify({
  at: new Date().toISOString(),
  desktopInteractiveStatus: interactive.status,
  ready: interactive.body?.ready ?? null,
  reason: interactive.body?.reason ?? null,
  pipeSource: interactive.body?.pipeSource ?? null,
  desktopConnected: sync.body?.connected ?? null,
  desktopOwnerClientId: sync.body?.ownerClientId ?? null,
  currentConversationId: sync.body?.currentConversationId ?? null,
}, null, 2) + "\n");
