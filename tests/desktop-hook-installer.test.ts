import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLrmHookCommand,
  defaultPluginHooksFilePath,
  installLrmSessionStartHook,
  isLrmHookEntry,
  isLrmHookHandler,
  LRM_HOOK_MATCHER,
  LRM_HOOK_STATUS_MESSAGE,
  migrateLrmSessionStartHookRegistration,
  uninstallLrmSessionStartHook,
} from "../src/desktop-codex/desktop-hook-installer.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempHooksPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lrm-hook-test-"));
  tempDirs.push(dir);
  return join(dir, "hooks.json");
}

const LRM_SHAPED_COMMAND = buildLrmHookCommand(
  "C:\\repo",
  "C:\\repo\\config.production.json",
  "node",
).command;

/** The handler shape the installer writes, so look-alike fixtures differ only where the test needs. */
function lrmShapedHandler(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "command",
    command: LRM_SHAPED_COMMAND,
    commandWindows: LRM_SHAPED_COMMAND,
    timeout: 10,
    statusMessage: LRM_HOOK_STATUS_MESSAGE,
    ...overrides,
  };
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The real plugin artifact this repository ships; the only production SessionStart entry. */
const SHIPPED_PLUGIN_HOOKS_PATH = defaultPluginHooksFilePath(process.cwd());

function lrmLegacyEntry(): Record<string, unknown> {
  return { matcher: LRM_HOOK_MATCHER, hooks: [lrmShapedHandler()] };
}

/** Writes the retired user-scope registration directly; no production code writes it any more. */
function writeLegacyUserEntry(path: string, extraHooks: Record<string, unknown[]> = {}): void {
  writeFileSync(
    path,
    JSON.stringify({ hooks: { ...extraHooks, SessionStart: [lrmLegacyEntry()] } }, null, 2) + "\n",
    "utf8",
  );
}

describe("Desktop Hook Installer", () => {
  it("builds a bounded command without auth token or pipe path", () => {
    const { command, timeout } = buildLrmHookCommand("C:\\repo", "C:\\repo\\config.production.json", "node");
    expect(command).toContain("desktop-session-start-handoff.mjs");
    expect(command).toContain("config.production.json");
    expect(command).not.toContain("token");
    expect(command).not.toContain("pipe");
    expect(timeout).toBe(10);
  });

  it("writes no user-scope entry and reports the shipped plugin hook (Case 2)", () => {
    const path = tempHooksPath();
    const res = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe("plugin_hook_present");
    expect(res.pluginHookPresent).toBe(true);
    expect(res.migrationRequired).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("reports a missing plugin hook instead of installing a fallback entry", () => {
    const path = tempHooksPath();
    const res = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: join(dirname(path), "absent-plugin-hooks.json"),
    });

    expect(res.ok).toBe(false);
    expect(res.action).toBe("plugin_hook_missing");
    expect(res.pluginHookPresent).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("is repeatable, flags the retired entry, and never rewrites hooks.json", () => {
    const path = tempHooksPath();
    writeLegacyUserEntry(path, {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: '"python" "probe.py"', timeout: 10 }] }],
    });
    const before = readFileSync(path, "utf8");

    const first = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    });
    const second = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    });

    expect(second).toEqual(first);
    expect(first.ok).toBe(false);
    expect(first.action).toBe("plugin_hook_present");
    expect(first.pluginHookPresent).toBe(true);
    expect(first.migrationRequired).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("leaves a user hooks.json without the retired entry untouched (Case 3)", () => {
    const path = tempHooksPath();
    const before = JSON.stringify({
      description: "Custom user hooks",
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "python probe.py", timeout: 10 }] },
        ],
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "other-hook.sh", timeout: 5, statusMessage: "Other" }] },
        ],
      },
    }, null, 2);
    writeFileSync(path, before, "utf8");

    const res = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    });

    expect(res.ok).toBe(true);
    expect(res.migrationRequired).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("uninstalls only the LRM hook entry and preserves existing hooks", () => {
    const path = tempHooksPath();
    writeLegacyUserEntry(path, {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "python probe.py" }] }],
    });

    const uninstRes = uninstallLrmSessionStartHook({ hooksFilePath: path });
    expect(uninstRes.ok).toBe(true);
    expect(uninstRes.action).toBe("uninstalled");

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.SessionStart).toBeUndefined();
  });

  it("fails closed without overwriting original file if hooks.json has malformed syntax", () => {
    const path = tempHooksPath();
    const badJson = '{\n  "hooks": { invalid json';
    writeFileSync(path, badJson, "utf8");

    const res = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("malformed_hooks_json_syntax");

    const uninstRes = uninstallLrmSessionStartHook({ hooksFilePath: path });
    expect(uninstRes.ok).toBe(false);
    expect(uninstRes.error).toContain("malformed_hooks_json_syntax");
    expect(readFileSync(path, "utf8")).toBe(badJson);
  });

  it("fails closed if hooks.json root is not an object", () => {
    const path = tempHooksPath();
    writeFileSync(path, '["not", "an", "object"]', "utf8");

    const res = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("malformed_hooks_json_root_not_object");

    const uninstRes = uninstallLrmSessionStartHook({ hooksFilePath: path });
    expect(uninstRes.ok).toBe(false);
    expect(uninstRes.error).toBe("malformed_hooks_json_root_not_object");
    expect(readFileSync(path, "utf8")).toBe('["not", "an", "object"]');
  });
});

describe("LRM hook ownership safety (P5.4.3.1)", () => {
  it("A. never claims a user command that merely mentions the runner name", () => {
    const path = tempHooksPath();
    const userEntry = {
      matcher: LRM_HOOK_MATCHER,
      hooks: [
        {
          type: "command",
          command: "echo desktop-session-start-handoff",
          commandWindows: "echo desktop-session-start-handoff",
          timeout: 10,
        },
      ],
    };
    const snapshot = { hooks: { SessionStart: [userEntry] } };
    writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");

    // Ownership is a shape, not a substring: the mention alone is not evidence.
    expect(isLrmHookHandler(userEntry.hooks[0])).toBe(false);
    expect(isLrmHookEntry(userEntry)).toBe(false);

    const status = installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    });
    expect(status.migrationRequired).toBe(false);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("not_installed");
    const parsed = readJson(path);
    expect(parsed).toEqual(snapshot);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe("echo desktop-session-start-handoff");
  });

  it("B. never claims a look-alike that only reuses the status message", () => {
    const path = tempHooksPath();
    const userEntry = {
      matcher: LRM_HOOK_MATCHER,
      hooks: [
        {
          type: "command",
          command: "python probe.py",
          commandWindows: "python probe.py",
          timeout: 10,
          statusMessage: LRM_HOOK_STATUS_MESSAGE,
        },
      ],
    };
    const snapshot = { hooks: { SessionStart: [userEntry] } };
    writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");

    expect(isLrmHookHandler(userEntry.hooks[0])).toBe(false);
    expect(isLrmHookEntry(userEntry)).toBe(false);

    expect(installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    }).migrationRequired).toBe(false);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("not_installed");
    expect(readJson(path)).toEqual(snapshot);
  });

  it("C. never claims or deletes a mixed-handler entry as a whole", () => {
    const path = tempHooksPath();
    const mixedEntry = {
      matcher: LRM_HOOK_MATCHER,
      hooks: [
        lrmShapedHandler(),
        { type: "command", command: "echo unrelated", commandWindows: "echo unrelated", timeout: 5 },
      ],
    };
    const snapshot = { hooks: { SessionStart: [mixedEntry] } };
    writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");

    // The look-alike handler passes, but the entry is not a dedicated LRM entry.
    expect(isLrmHookHandler(mixedEntry.hooks[0])).toBe(true);
    expect(isLrmHookEntry(mixedEntry)).toBe(false);

    expect(installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    }).migrationRequired).toBe(false);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("not_installed");
    const parsed = readJson(path);
    expect(parsed).toEqual(snapshot);
    expect(parsed.hooks.SessionStart[0].hooks).toHaveLength(2);
  });

  it("C2. does not claim a dedicated-shaped entry whose matcher differs", () => {
    const path = tempHooksPath();
    const otherMatcherEntry = { matcher: "startup", hooks: [lrmShapedHandler()] };
    const snapshot = { hooks: { SessionStart: [otherMatcherEntry] } };
    writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");

    expect(isLrmHookEntry(otherMatcherEntry)).toBe(false);
    expect(installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    }).migrationRequired).toBe(false);
    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("not_installed");
    expect(readJson(path)).toEqual(snapshot);
  });

  it("D. recognizes the retired dedicated entry and removes exactly it", () => {
    const path = tempHooksPath();
    writeLegacyUserEntry(path);

    const installed = readJson(path).hooks.SessionStart[0];
    expect(isLrmHookEntry(installed)).toBe(true);
    expect(isLrmHookHandler(installed.hooks[0])).toBe(true);

    expect(installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    }).migrationRequired).toBe(true);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("uninstalled");
    expect(readJson(path).hooks.SessionStart).toBeUndefined();
  });

  it("E. leaves a hand-edited look-alike set deeply unchanged", () => {
    const path = tempHooksPath();
    const snapshot = {
      description: "Minimal local probe for UserPromptSubmit and Stop.",
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: '"python" "C:\\\\probe.py"',
                commandWindows: '"python" "C:\\\\probe.py"',
                timeout: 10,
              },
            ],
          },
        ],
        Stop: [
          { hooks: [{ type: "command", command: '"python" "C:\\\\probe.py"', timeout: 10 }] },
        ],
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "other-hook.sh", timeout: 5 }] },
          {
            matcher: LRM_HOOK_MATCHER,
            hooks: [
              lrmShapedHandler({ statusMessage: "Unrelated status" }),
              { type: "command", command: "echo keep me", commandWindows: "echo keep me", timeout: 3 },
            ],
          },
        ],
      },
    };
    const before = JSON.stringify(snapshot, null, 2);
    writeFileSync(path, before, "utf8");

    expect(installLrmSessionStartHook({
      hooksFilePath: path,
      pluginHooksFilePath: SHIPPED_PLUGIN_HOOKS_PATH,
    }).migrationRequired).toBe(false);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("not_installed");
    expect(readJson(path)).toEqual(snapshot);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

function tempCodexPaths(): { hooksFilePath: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "lrm-hook-migration-"));
  tempDirs.push(dir);
  return { hooksFilePath: join(dir, "hooks.json"), configPath: join(dir, "config.toml") };
}

/**
 * The real user file shape: an unrelated prompt/stop probe, one SessionStart hook of its own, and
 * the retired LRM entry the old installer appended after it.
 */
function writeLegacyUserHooks(hooksFilePath: string): Record<string, unknown> {
  const userSessionStart = {
    matcher: LRM_HOOK_MATCHER,
    hooks: [{ type: "command", command: '"python" "probe.py"', commandWindows: '"python" "probe.py"', timeout: 10 }],
  };
  writeFileSync(
    hooksFilePath,
    JSON.stringify(
      {
        description: "Minimal local probe for UserPromptSubmit and Stop.",
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: '"python" "probe.py"', timeout: 10 }] }],
          Stop: [{ hooks: [{ type: "command", command: '"python" "probe.py"', timeout: 10 }] }],
          SessionStart: [userSessionStart, lrmLegacyEntry()],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return userSessionStart;
}

function trustStateConfig(hooksFilePath: string, legacyTablePresent = true): string {
  const legacyTable = legacyTablePresent
    ? [
        "[hooks.state.'" + hooksFilePath + ":session_start:0:0']",
        'trusted_hash = "sha256:legacy"',
        "enabled = true",
        "",
      ]
    : [];
  return [
    'model = "deepseek/deepseek-flash"',
    "",
    "[hooks.state]",
    "",
    '[hooks.state."lrm-desktop-session-start@lrm-local:hooks/hooks.json:session_start:0:0"]',
    'trusted_hash = "sha256:plugin"',
    "",
    ...legacyTable,
    "[hooks.state.'" + hooksFilePath + ":user_prompt_submit:0:0']",
    'trusted_hash = "sha256:probe"',
    "enabled = true",
    "",
    "[hooks.state.'" + hooksFilePath + ":stop:0:0']",
    'trusted_hash = "sha256:stop"',
    "enabled = true",
    "",
    "[tui.model_availability_nux]",
    '"gpt-5.6-sol" = 3',
    "",
  ].join("\n");
}

function backupFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".lrm-backup"));
}

describe("Desktop SessionStart registration migration to the plugin (P5.7.2)", () => {
  it("retires only the legacy user-scope entry, keeping other hooks and trust state", () => {
    const { hooksFilePath, configPath } = tempCodexPaths();
    const userSessionStart = writeLegacyUserHooks(hooksFilePath);
    const before = trustStateConfig(hooksFilePath);
    writeFileSync(configPath, before, "utf8");

    const result = migrateLrmSessionStartHookRegistration({ hooksFilePath, configPath });

    expect(result.ok).toBe(true);
    expect(result.action).toBe("migrated");
    expect(result.removedHookEntries).toBe(1);
    expect(result.removedTrustStateKeys).toEqual([hooksFilePath + ":session_start:0:0"]);
    expect(result.configBackupPath).toBeDefined();
    expect(readFileSync(result.configBackupPath!, "utf8")).toBe(before);

    const hooks = readJson(hooksFilePath);
    expect(hooks.description).toBe("Minimal local probe for UserPromptSubmit and Stop.");
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.hooks.Stop).toHaveLength(1);
    expect(hooks.hooks.SessionStart).toEqual([userSessionStart]);

    // Byte-identical apart from the retired table.
    expect(readFileSync(configPath, "utf8")).toBe(trustStateConfig(hooksFilePath, false));
  });

  it("is idempotent and reports already_migrated without touching either file again", () => {
    const { hooksFilePath, configPath } = tempCodexPaths();
    writeLegacyUserHooks(hooksFilePath);
    writeFileSync(configPath, trustStateConfig(hooksFilePath), "utf8");

    expect(migrateLrmSessionStartHookRegistration({ hooksFilePath, configPath }).action).toBe("migrated");
    const hooksAfterFirst = readFileSync(hooksFilePath, "utf8");
    const configAfterFirst = readFileSync(configPath, "utf8");

    const second = migrateLrmSessionStartHookRegistration({ hooksFilePath, configPath });
    expect(second.ok).toBe(true);
    expect(second.action).toBe("already_migrated");
    expect(second.removedHookEntries).toBe(0);
    expect(second.removedTrustStateKeys).toEqual([]);
    expect(second.configBackupPath).toBeUndefined();
    expect(readFileSync(hooksFilePath, "utf8")).toBe(hooksAfterFirst);
    expect(readFileSync(configPath, "utf8")).toBe(configAfterFirst);
    expect(backupFiles(dirname(configPath))).toHaveLength(1);
  });

  it("fails closed on a malformed hooks.json and leaves config.toml untouched", () => {
    const { hooksFilePath, configPath } = tempCodexPaths();
    writeFileSync(hooksFilePath, '{ "hooks": { invalid json', "utf8");
    const before = trustStateConfig(hooksFilePath);
    writeFileSync(configPath, before, "utf8");

    const result = migrateLrmSessionStartHookRegistration({ hooksFilePath, configPath });

    expect(result.ok).toBe(false);
    expect(result.action).toBe("failed");
    expect(result.error).toContain("hooks_file_not_migrated");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(backupFiles(dirname(configPath))).toHaveLength(0);
  });

  it("fails closed when the legacy key survives in an unsupported shape", () => {
    const { hooksFilePath, configPath } = tempCodexPaths();
    writeLegacyUserHooks(hooksFilePath);
    const before = [
      "[hooks.state]",
      "'" + hooksFilePath + ":session_start:0:0' = { trusted_hash = \"sha256:legacy\" }",
      "",
    ].join("\n");
    writeFileSync(configPath, before, "utf8");

    const result = migrateLrmSessionStartHookRegistration({ hooksFilePath, configPath });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("trust_state_not_migrated");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    // The hooks.json half is reported as applied rather than silently rolled back.
    expect(result.removedHookEntries).toBe(1);
    const remaining = readJson(hooksFilePath).hooks.SessionStart;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].hooks[0].command).toBe('"python" "probe.py"');
  });
});
