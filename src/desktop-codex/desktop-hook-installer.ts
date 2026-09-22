import { copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LRM_HOOK_STATUS_MESSAGE = "LRM Desktop session-start handoff";
export const LRM_HOOK_MATCHER = "startup|resume|clear|compact";
export const LRM_HOOK_TIMEOUT_SECONDS = 10;
const LRM_HOOK_SCRIPT_SUFFIX = "scripts/desktop-session-start-handoff.mjs";

export interface HookHandlerConfig {
  readonly type: "command";
  readonly command?: string;
  readonly commandWindows?: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
  readonly [key: string]: unknown;
}

export interface HookEntryConfig {
  readonly matcher?: string;
  readonly hooks: HookHandlerConfig[];
  readonly [key: string]: unknown;
}

export interface HooksFileConfig {
  readonly description?: string;
  readonly hooks?: Record<string, HookEntryConfig[]>;
  readonly [key: string]: unknown;
}

export interface HookInstallOptions {
  readonly hooksFilePath?: string;
  readonly repoRoot?: string;
  readonly pluginHooksFilePath?: string;
}

/** Whether the single production entry exists, and whether the retired user-scope entry is gone. */
export interface HookStatusResult {
  readonly ok: boolean;
  readonly action: "plugin_hook_present" | "plugin_hook_missing";
  readonly hooksFilePath: string;
  readonly pluginHooksFilePath: string;
  readonly pluginHookPresent: boolean;
  readonly migrationRequired: boolean;
  readonly error?: string;
}

export interface HookUninstallResult {
  readonly ok: boolean;
  readonly action: "uninstalled" | "not_installed";
  readonly hooksFilePath: string;
  readonly error?: string;
}

export function defaultHooksFilePath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

export function defaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

export const LRM_PLUGIN_HOOKS_FILE = "plugin/plugins/lrm-desktop-session-start/hooks/hooks.json";
const LRM_PLUGIN_SCRIPT_SUFFIX = "hooks/lrm-session-start-handoff.mjs";

export function defaultPluginHooksFilePath(repoRoot: string = process.cwd()): string {
  return resolve(repoRoot, LRM_PLUGIN_HOOKS_FILE);
}

/**
 * The retired user-scope command shape, kept as the single definition of what the ownership
 * predicate below still recognizes so the legacy entry can be migrated away safely.
 */
export function buildLrmHookCommand(
  repoRoot: string = process.cwd(),
  configPath: string = join(repoRoot, "config.production.json"),
  nodePath = "node",
): { readonly command: string; readonly timeout: number } {
  const scriptPath = resolve(join(repoRoot, "scripts", "desktop-session-start-handoff.mjs"));
  const resolvedConfig = resolve(configPath);
  const command = `"${nodePath}" "${scriptPath}" --config "${resolvedConfig}"`;
  return {
    command,
    timeout: LRM_HOOK_TIMEOUT_SECONDS,
  };
}

/**
 * True only for the exact retired user-scope command shape (see buildLrmHookCommand()):
 *   "<node>" "<repo>/scripts/desktop-session-start-handoff.mjs" --config "<config>"
 *
 * A substring mention of the runner name is not ownership evidence. A user command such as
 * "echo desktop-session-start-handoff" must never be claimed, replaced, or deleted, and neither
 * must a look-alike that only reuses the status message.
 *
 * ponytail: the pattern is deliberately anchored; a hand-edited LRM command stops being recognized
 * and install then appends its own entry instead of rewriting the edited one.
 */
function isLrmRunnerCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^"([^"]+)"\s+"([^"]+)"\s+--config\s+"([^"]+)"$/.exec(value.trim());
  if (match === null) return false;
  return match[2]!.replace(/\\/g, "/").toLowerCase().endsWith(`/${LRM_HOOK_SCRIPT_SUFFIX}`);
}

export function isLrmHookHandler(handler: unknown): boolean {
  if (typeof handler !== "object" || handler === null || Array.isArray(handler)) return false;
  const h = handler as Record<string, unknown>;
  return h.type === "command"
    && h.statusMessage === LRM_HOOK_STATUS_MESSAGE
    && h.timeout === LRM_HOOK_TIMEOUT_SECONDS
    && isLrmRunnerCommand(h.command)
    && isLrmRunnerCommand(h.commandWindows);
}

/**
 * Ownership requires the complete dedicated entry the retired user-scope installation created: the
 * LRM matcher, exactly one handler, and that handler carrying the full LRM handler shape. A mixed
 * entry whose single look-alike handler sits next to other handlers is never claimed as a whole.
 */
export function isLrmHookEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return e.matcher === LRM_HOOK_MATCHER
    && Array.isArray(e.hooks)
    && e.hooks.length === 1
    && isLrmHookHandler(e.hooks[0]);
}

function hasSafeHookEntries(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const raw = entry as Record<string, unknown>;
    return raw.hooks === undefined || Array.isArray(raw.hooks);
  });
}

/**
 * Reports whether the Desktop SessionStart handoff has exactly one production entry.
 *
 * Nothing is written any more: the LRM plugin hook is the only supported entry point, so this
 * reports plugin hook presence and flags the retired user-scope entry while it is still installed
 * (retire it with migrateLrmSessionStartHookRegistration). `ok` means "single entry satisfied":
 * the plugin hook exists and no user-scope LRM entry remains.
 */
export function installLrmSessionStartHook(
  options: HookInstallOptions = {},
): HookStatusResult {
  const hooksFilePath = options.hooksFilePath ?? defaultHooksFilePath();
  const pluginHooksFilePath = options.pluginHooksFilePath
    ?? defaultPluginHooksFilePath(options.repoRoot);

  const plugin = inspectPluginHook(pluginHooksFilePath);
  const user = inspectLegacyUserEntry(hooksFilePath);
  const error = plugin.error ?? user.error;

  return {
    ok: error === undefined && plugin.present && !user.legacy,
    action: plugin.present ? "plugin_hook_present" : "plugin_hook_missing",
    hooksFilePath,
    pluginHooksFilePath,
    pluginHookPresent: plugin.present,
    migrationRequired: user.legacy,
    ...(error === undefined ? {} : { error }),
  };
}

interface PluginHookInspection {
  readonly present: boolean;
  readonly error?: string;
}

interface LegacyEntryInspection {
  readonly legacy: boolean;
  readonly error?: string;
}

/**
 * Ownership of the plugin entry: the LRM matcher plus at least one command handler running the
 * plugin's own handoff runner. The installed plugin lives in the Codex plugin cache, so the runner
 * is recognized by its path suffix, not by the repository root it happens to be invoked with.
 */
export function isPluginHookEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (e.matcher !== LRM_HOOK_MATCHER || !Array.isArray(e.hooks)) return false;
  return e.hooks.some((handler) => {
    if (typeof handler !== "object" || handler === null || Array.isArray(handler)) return false;
    const h = handler as Record<string, unknown>;
    return h.type === "command"
      && (isPluginRunnerCommand(h.command) || isPluginRunnerCommand(h.commandWindows));
  });
}

function isPluginRunnerCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^node\s+"([^"]+)"/u.exec(value.trim());
  if (match === null) return false;
  return match[1]!.replace(/\\/gu, "/").toLowerCase().endsWith(`/${LRM_PLUGIN_SCRIPT_SUFFIX}`);
}

function inspectPluginHook(pluginHooksFilePath: string): PluginHookInspection {
  let raw: string;
  try {
    raw = readFileSync(pluginHooksFilePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return { present: false, error: "failed_to_read_plugin_hooks_file" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: false, error: "malformed_plugin_hooks_json" };
  }

  const seen = sessionStartEntriesOf(parsed);
  if (seen.error !== undefined) return { present: false, error: seen.error };
  const entries = seen.entries ?? [];
  return { present: entries.some((entry) => isPluginHookEntry(entry)) };
}

function inspectLegacyUserEntry(hooksFilePath: string): LegacyEntryInspection {
  let raw: string;
  try {
    raw = readFileSync(hooksFilePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { legacy: false };
    return { legacy: false, error: "failed_to_read_hooks_file" };
  }
  if (raw.trim() === "") return { legacy: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { legacy: false, error: "malformed_hooks_json_syntax" };
  }

  const seen = sessionStartEntriesOf(parsed);
  if (seen.error !== undefined) return { legacy: false, error: seen.error };
  const entries = seen.entries ?? [];
  return { legacy: entries.some((entry) => isLrmHookEntry(entry)) };
}

/** Shared shape guard: a hooks document whose SessionStart entry list can be inspected safely. */
function sessionStartEntriesOf(
  parsed: unknown,
): { readonly entries?: readonly unknown[]; readonly error?: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "malformed_hooks_json_root_not_object" };
  }
  const hooks = (parsed as HooksFileConfig).hooks;
  if (hooks === undefined) return {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return { error: "unsafe_hooks_config_shape" };
  }
  const entries = (hooks as Record<string, unknown>).SessionStart;
  if (entries === undefined) return {};
  if (!Array.isArray(entries)) return { error: "unsafe_session_start_hook_shape" };
  return { entries };
}

export function uninstallLrmSessionStartHook(
  options: HookInstallOptions = {},
): HookUninstallResult {
  const targetPath = options.hooksFilePath ?? defaultHooksFilePath();
  let existingRaw = "";
  let existingConfig: HooksFileConfig = { hooks: {} };

  try {
    existingRaw = readFileSync(targetPath, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: true,
        action: "not_installed",
        hooksFilePath: targetPath,
      };
    }
    return {
      ok: false,
      action: "uninstalled",
      hooksFilePath: targetPath,
      error: `failed_to_read_hooks_file: ${code}`,
    };
  }

  if (existingRaw.trim() === "") {
    return {
      ok: true,
      action: "not_installed",
      hooksFilePath: targetPath,
    };
  }

  try {
    const parsed = JSON.parse(existingRaw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        action: "uninstalled",
        hooksFilePath: targetPath,
        error: "malformed_hooks_json_root_not_object",
      };
    }
    existingConfig = parsed as HooksFileConfig;
  } catch (parseError: unknown) {
    return {
      ok: false,
      action: "uninstalled",
      hooksFilePath: targetPath,
      error: `malformed_hooks_json_syntax: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    };
  }

  if (!existingConfig.hooks || typeof existingConfig.hooks !== "object" || Array.isArray(existingConfig.hooks)) {
    return {
      ok: true,
      action: "not_installed",
      hooksFilePath: targetPath,
    };
  }

  const hooksMap = { ...existingConfig.hooks };
  if (hooksMap.SessionStart !== undefined && !hasSafeHookEntries(hooksMap.SessionStart)) {
    return {
      ok: false,
      action: "uninstalled",
      hooksFilePath: targetPath,
      error: "unsafe_session_start_hook_shape",
    };
  }
  const sessionStartEntries = Array.isArray(hooksMap.SessionStart)
    ? [...hooksMap.SessionStart] as HookEntryConfig[]
    : [];
  const remaining = sessionStartEntries.filter((e) => !isLrmHookEntry(e));

  if (remaining.length === sessionStartEntries.length) {
    return {
      ok: true,
      action: "not_installed",
      hooksFilePath: targetPath,
    };
  }

  if (remaining.length > 0) {
    hooksMap.SessionStart = remaining;
  } else {
    delete hooksMap.SessionStart;
  }

  const nextConfig: HooksFileConfig = {
    ...existingConfig,
    hooks: hooksMap,
  };

  try {
    atomicWriteJson(targetPath, nextConfig);
    return {
      ok: true,
      action: "uninstalled",
      hooksFilePath: targetPath,
    };
  } catch (writeErr: unknown) {
    return {
      ok: false,
      action: "uninstalled",
      hooksFilePath: targetPath,
      error: `failed_to_write_hooks_file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
    };
  }
}

export interface HookMigrationOptions {
  readonly hooksFilePath?: string;
  readonly configPath?: string;
}

export interface HookMigrationResult {
  readonly ok: boolean;
  readonly action: "migrated" | "already_migrated" | "failed";
  readonly hooksFilePath: string;
  readonly configPath: string;
  readonly removedHookEntries: number;
  readonly removedTrustStateKeys: readonly string[];
  readonly configBackupPath?: string;
  readonly error?: string;
}

interface TrustStatePruneResult {
  readonly ok: boolean;
  readonly removedKeys: readonly string[];
  readonly backupPath?: string;
  readonly error?: string;
}

/** `[hooks.state.'C:\...\hooks.json:session_start:0:0']` — literal (') or basic (") quoted key. */
const HOOK_STATE_TABLE_HEADER =
  /^\[\s*hooks\.state\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*\]$/u;
const QUOTED_STRING = /'([^']*)'|"((?:[^"\\]|\\.)*)"/gu;
const TABLE_HEADER = /^\[[^\[\]]+\]$/u;
const SESSION_START_STATE_MARKER = ":session_start:";

function normalizeForCompare(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

/** Ownership: the key names this exact hooks.json and a SessionStart entry/handler index. */
function isOwnedSessionStartStateKey(key: string, hooksFilePath: string): boolean {
  const markerIndex = key.lastIndexOf(SESSION_START_STATE_MARKER);
  if (markerIndex < 0) return false;
  const indices = key.slice(markerIndex + SESSION_START_STATE_MARKER.length);
  if (!/^\d+:\d+$/u.test(indices)) return false;
  return normalizeForCompare(key.slice(0, markerIndex)) === normalizeForCompare(hooksFilePath);
}

function unescapeBasicString(value: string): string {
  return value.replace(/\\("|\\)/gu, "$1");
}

function hookStateTableKey(line: string): string | undefined {
  const match = HOOK_STATE_TABLE_HEADER.exec(line.trim());
  if (match === null) return undefined;
  return match[1] ?? unescapeBasicString(match[2]!);
}

function quotedStrings(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(QUOTED_STRING)) {
    found.push(match[1] ?? unescapeBasicString(match[2]!));
  }
  return found;
}

/**
 * Removes exactly the `[hooks.state.<key>]` tables Codex recorded for the retired user-scope
 * hooks.json SessionStart registration. The file is edited line by line, so unrelated sections,
 * comments, and formatting survive untouched; a legacy key appearing in any other shape fails
 * closed rather than leaving a stale trust entry behind unnoticed.
 *
 * ponytail: only the two table shapes Codex writes are understood. A hand-written root-level
 * `hooks.state = {...}` inline table fails closed instead of being rewritten.
 */
function pruneSessionStartTrustState(
  configPath: string,
  hooksFilePath: string,
): TrustStatePruneResult {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, removedKeys: [] };
    return { ok: false, removedKeys: [], error: "failed_to_read_config_file" };
  }

  const lineSeparator = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(lineSeparator);

  for (const line of lines) {
    if (hookStateTableKey(line) !== undefined) continue;
    if (quotedStrings(line).some((key) => isOwnedSessionStartStateKey(key, hooksFilePath))) {
      return { ok: false, removedKeys: [], error: "unsupported_hooks_state_shape" };
    }
  }

  const removedKeys: string[] = [];
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const key = hookStateTableKey(line);
    if (key !== undefined) {
      skipping = isOwnedSessionStartStateKey(key, hooksFilePath);
      if (skipping) removedKeys.push(key);
    } else if (TABLE_HEADER.test(line.trim())) {
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }

  if (removedKeys.length === 0) return { ok: true, removedKeys: [] };

  const backupPath = `${configPath}.${Date.now()}.lrm-backup`;
  try {
    copyFileSync(configPath, backupPath);
    atomicWriteText(configPath, kept.join(lineSeparator));
  } catch {
    return { ok: false, removedKeys: [], error: "failed_to_write_config_file" };
  }
  return { ok: true, removedKeys, backupPath };
}

/**
 * Retires the legacy user-scope registration of the Desktop SessionStart handoff so the LRM plugin
 * (plugin/plugins/lrm-desktop-session-start) stays the only production entry and one SessionStart
 * produces one handoff request.
 *
 * hooks.json is cleaned by the installer's own ownership predicate; the trust-state tables Codex
 * recorded for that file are pruned from config.toml. Other user hooks and other trust state are
 * preserved, and both halves are idempotent. A half that cannot be applied safely returns
 * `failed` with the applied parts reported, never a silent partial migration.
 */
export function migrateLrmSessionStartHookRegistration(
  options: HookMigrationOptions = {},
): HookMigrationResult {
  const hooksFilePath = options.hooksFilePath ?? defaultHooksFilePath();
  const configPath = options.configPath ?? defaultCodexConfigPath();

  const uninstalled = uninstallLrmSessionStartHook({ hooksFilePath });
  if (!uninstalled.ok) {
    return {
      ok: false,
      action: "failed",
      hooksFilePath,
      configPath,
      removedHookEntries: 0,
      removedTrustStateKeys: [],
      error: `hooks_file_not_migrated: ${uninstalled.error ?? "unknown"}`,
    };
  }
  const removedHookEntries = uninstalled.action === "uninstalled" ? 1 : 0;

  const pruned = pruneSessionStartTrustState(configPath, hooksFilePath);
  if (!pruned.ok) {
    return {
      ok: false,
      action: "failed",
      hooksFilePath,
      configPath,
      removedHookEntries,
      removedTrustStateKeys: [],
      error: `trust_state_not_migrated: ${pruned.error ?? "unknown"}`,
    };
  }

  const changed = removedHookEntries > 0 || pruned.removedKeys.length > 0;
  return {
    ok: true,
    action: changed ? "migrated" : "already_migrated",
    hooksFilePath,
    configPath,
    removedHookEntries,
    removedTrustStateKeys: pruned.removedKeys,
    ...(pruned.backupPath === undefined ? {} : { configBackupPath: pruned.backupPath }),
  };
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  atomicWriteText(targetPath, JSON.stringify(data, null, 2) + "\n");
}

function atomicWriteText(targetPath: string, serialized: string): void {
  const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(tempPath, serialized, "utf8");
  try {
    renameSync(tempPath, targetPath);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore temp cleanup error
    }
  }
}
