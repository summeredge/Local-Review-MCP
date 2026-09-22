// P5.7.3 evidence: read-only check of the user hook file, the trust state, and the plugin hook.
// It imports the production ownership predicates from the built runtime, so "no LRM user entry"
// and "plugin hook present" are decided by the same code the migration and the status command use.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultPluginHooksFilePath,
  isLrmHookEntry,
  isPluginHookEntry,
} from "../../dist/src/desktop-codex/desktop-hook-installer.js";

const hooksPath = join(homedir(), ".codex", "hooks.json");
const configPath = join(homedir(), ".codex", "config.toml");

const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
const sessionStart = Array.isArray(hooks.hooks?.SessionStart) ? hooks.hooks.SessionStart : [];
const probeCommands = ["UserPromptSubmit", "Stop"].flatMap((event) =>
  (hooks.hooks?.[event] ?? []).map((entry) => ({ event, command: entry.hooks?.[0]?.command ?? null })));

const configText = readFileSync(configPath, "utf8");
const stateHeaders = configText
  .split("\n")
  .filter((line) => line.trim().startsWith("[hooks.state."));

const plugin = JSON.parse(readFileSync(defaultPluginHooksFilePath(process.cwd()), "utf8"));
const pluginEntries = plugin.hooks?.SessionStart ?? [];

process.stdout.write(JSON.stringify({
  at: new Date().toISOString(),
  userHooksFile: {
    path: hooksPath,
    events: Object.keys(hooks.hooks ?? {}),
    sessionStartEntries: sessionStart.length,
    lrmOwnedSessionStartEntries: sessionStart.filter((entry) => isLrmHookEntry(entry)).length,
    otherHooksPreserved: probeCommands,
  },
  trustState: {
    path: configPath,
    lines: configText.split("\n").length,
    userSessionStartKeys: stateHeaders.filter((line) => line.includes(hooksPath + ":session_start")),
    userOtherKeys: stateHeaders.filter((line) => line.includes(hooksPath + ":") && !line.includes(":session_start")),
    pluginKeys: stateHeaders.filter((line) => line.includes("lrm-desktop-session-start@lrm-local")),
  },
  pluginHook: {
    path: defaultPluginHooksFilePath(process.cwd()),
    sessionStartEntries: pluginEntries.length,
    handoffEntries: pluginEntries.filter((entry) => isPluginHookEntry(entry)).length,
    matcher: pluginEntries[0]?.matcher ?? null,
    command: pluginEntries[0]?.hooks?.[0]?.command ?? null,
  },
}, null, 2) + "\n");
