import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  readonly configPath?: string;
  readonly nodePath?: string;
}

export interface HookInstallResult {
  readonly ok: boolean;
  readonly action: "installed" | "already_installed" | "uninstalled" | "not_installed";
  readonly hooksFilePath: string;
  readonly error?: string;
}

export function defaultHooksFilePath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

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
 * True only for the exact command shape buildLrmHookCommand() writes:
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
 * Ownership requires the complete dedicated entry this installer creates: the LRM matcher, exactly
 * one handler, and that handler carrying the full LRM handler shape. A mixed entry whose single
 * look-alike handler sits next to other handlers is never claimed as a whole.
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

export function installLrmSessionStartHook(
  options: HookInstallOptions = {},
): HookInstallResult {
  const targetPath = options.hooksFilePath ?? defaultHooksFilePath();
  let existingRaw = "";
  let existingConfig: HooksFileConfig = { hooks: {} };

  try {
    existingRaw = readFileSync(targetPath, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        ok: false,
        action: "installed",
        hooksFilePath: targetPath,
        error: `failed_to_read_hooks_file: ${code}`,
      };
    }
  }

  if (existingRaw.trim() !== "") {
    try {
      const parsed = JSON.parse(existingRaw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          ok: false,
          action: "installed",
          hooksFilePath: targetPath,
          error: "malformed_hooks_json_root_not_object",
        };
      }
      existingConfig = parsed as HooksFileConfig;
    } catch (parseError: unknown) {
      return {
        ok: false,
        action: "installed",
        hooksFilePath: targetPath,
        error: `malformed_hooks_json_syntax: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }
  }

  if (existingConfig.hooks !== undefined
    && (typeof existingConfig.hooks !== "object" || existingConfig.hooks === null || Array.isArray(existingConfig.hooks))) {
    return {
      ok: false,
      action: "installed",
      hooksFilePath: targetPath,
      error: "unsafe_hooks_config_shape",
    };
  }
  const hooksMap = existingConfig.hooks === undefined ? {} : { ...existingConfig.hooks };

  if (hooksMap.SessionStart !== undefined && !hasSafeHookEntries(hooksMap.SessionStart)) {
    return {
      ok: false,
      action: "installed",
      hooksFilePath: targetPath,
      error: "unsafe_session_start_hook_shape",
    };
  }
  const sessionStartEntries: HookEntryConfig[] = Array.isArray(hooksMap.SessionStart)
    ? [...hooksMap.SessionStart] as HookEntryConfig[]
    : [];

  const existingLrmIndex = sessionStartEntries.findIndex((e) => isLrmHookEntry(e));
  const { command, timeout } = buildLrmHookCommand(
    options.repoRoot,
    options.configPath,
    options.nodePath,
  );

  const lrmEntry: HookEntryConfig = {
    matcher: LRM_HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command,
        commandWindows: command,
        timeout,
        statusMessage: LRM_HOOK_STATUS_MESSAGE,
      },
    ],
  };

  if (existingLrmIndex >= 0) {
    const existingEntry = sessionStartEntries[existingLrmIndex]!;
    const existingHandler = existingEntry.hooks?.[0];
    if (
      existingEntry.matcher === lrmEntry.matcher
      && existingHandler?.command === command
      && existingHandler?.commandWindows === command
      && existingHandler?.timeout === timeout
      && existingHandler?.statusMessage === LRM_HOOK_STATUS_MESSAGE
    ) {
      return {
        ok: true,
        action: "already_installed",
        hooksFilePath: targetPath,
      };
    }
    sessionStartEntries[existingLrmIndex] = lrmEntry;
  } else {
    sessionStartEntries.push(lrmEntry);
  }

  hooksMap.SessionStart = sessionStartEntries;
  const nextConfig: HooksFileConfig = {
    ...existingConfig,
    hooks: hooksMap,
  };

  try {
    atomicWriteJson(targetPath, nextConfig);
    return {
      ok: true,
      action: existingLrmIndex >= 0 ? "already_installed" : "installed",
      hooksFilePath: targetPath,
    };
  } catch (writeErr: unknown) {
    return {
      ok: false,
      action: "installed",
      hooksFilePath: targetPath,
      error: `failed_to_write_hooks_file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
    };
  }
}

export function uninstallLrmSessionStartHook(
  options: HookInstallOptions = {},
): HookInstallResult {
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

function atomicWriteJson(targetPath: string, data: unknown): void {
  const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const serialized = JSON.stringify(data, null, 2) + "\n";
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
