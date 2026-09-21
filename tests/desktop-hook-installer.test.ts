import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLrmHookCommand,
  installLrmSessionStartHook,
  isLrmHookEntry,
  isLrmHookHandler,
  LRM_HOOK_MATCHER,
  LRM_HOOK_STATUS_MESSAGE,
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

describe("Desktop Hook Installer", () => {
  it("builds a bounded command without auth token or pipe path", () => {
    const { command, timeout } = buildLrmHookCommand("C:\\repo", "C:\\repo\\config.production.json", "node");
    expect(command).toContain("desktop-session-start-handoff.mjs");
    expect(command).toContain("config.production.json");
    expect(command).not.toContain("token");
    expect(command).not.toContain("pipe");
    expect(timeout).toBe(10);
  });

  it("installs into empty or non-existent hooks.json", () => {
    const path = tempHooksPath();
    const res = installLrmSessionStartHook({ hooksFilePath: path });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("installed");

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
    expect(parsed.hooks.SessionStart[0].hooks[0].statusMessage).toBe(LRM_HOOK_STATUS_MESSAGE);
  });

  it("is idempotent when run twice", () => {
    const path = tempHooksPath();
    const res1 = installLrmSessionStartHook({ hooksFilePath: path });
    expect(res1.ok).toBe(true);
    expect(res1.action).toBe("installed");

    const res2 = installLrmSessionStartHook({ hooksFilePath: path });
    expect(res2.ok).toBe(true);
    expect(res2.action).toBe("already_installed");

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });

  it("preserves existing non-LRM hooks completely", () => {
    const path = tempHooksPath();
    const initial = {
      description: "Custom user hooks",
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "python probe.py", timeout: 10 }],
          },
        ],
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: "other-hook.sh", timeout: 5, statusMessage: "Other" }],
          },
        ],
      },
    };
    writeFileSync(path, JSON.stringify(initial, null, 2), "utf8");

    const res = installLrmSessionStartHook({ hooksFilePath: path });
    expect(res.ok).toBe(true);

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.description).toBe("Custom user hooks");
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe("python probe.py");
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.SessionStart[0].hooks[0].statusMessage).toBe("Other");
    expect(parsed.hooks.SessionStart[1].hooks[0].statusMessage).toBe(LRM_HOOK_STATUS_MESSAGE);
  });

  it("uninstalls only the LRM hook entry and preserves existing hooks", () => {
    const path = tempHooksPath();
    const initial = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "python probe.py" }] },
        ],
      },
    };
    writeFileSync(path, JSON.stringify(initial, null, 2), "utf8");

    installLrmSessionStartHook({ hooksFilePath: path });
    let parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.hooks.SessionStart).toHaveLength(1);

    const uninstRes = uninstallLrmSessionStartHook({ hooksFilePath: path });
    expect(uninstRes.ok).toBe(true);
    expect(uninstRes.action).toBe("uninstalled");

    parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.SessionStart).toBeUndefined();
  });

  it("fails closed without overwriting original file if hooks.json has malformed syntax", () => {
    const path = tempHooksPath();
    const badJson = '{\n  "hooks": { invalid json';
    writeFileSync(path, badJson, "utf8");

    const res = installLrmSessionStartHook({ hooksFilePath: path });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("malformed_hooks_json_syntax");
    expect(readFileSync(path, "utf8")).toBe(badJson);
  });

  it("fails closed if hooks.json root is not an object", () => {
    const path = tempHooksPath();
    writeFileSync(path, '["not", "an", "object"]', "utf8");

    const res = installLrmSessionStartHook({ hooksFilePath: path });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("malformed_hooks_json_root_not_object");
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

    expect(installLrmSessionStartHook({ hooksFilePath: path }).action).toBe("installed");
    let parsed = readJson(path);
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.SessionStart[0]).toEqual(userEntry);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("uninstalled");
    parsed = readJson(path);
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

    installLrmSessionStartHook({ hooksFilePath: path });
    expect(readJson(path).hooks.SessionStart).toHaveLength(2);
    expect(readJson(path).hooks.SessionStart[0]).toEqual(userEntry);

    uninstallLrmSessionStartHook({ hooksFilePath: path });
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

    expect(installLrmSessionStartHook({ hooksFilePath: path }).action).toBe("installed");
    let parsed = readJson(path);
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.SessionStart[0]).toEqual(mixedEntry);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("uninstalled");
    parsed = readJson(path);
    expect(parsed).toEqual(snapshot);
    expect(parsed.hooks.SessionStart[0].hooks).toHaveLength(2);
  });

  it("C2. does not claim a dedicated-shaped entry whose matcher differs", () => {
    const path = tempHooksPath();
    const otherMatcherEntry = { matcher: "startup", hooks: [lrmShapedHandler()] };
    const snapshot = { hooks: { SessionStart: [otherMatcherEntry] } };
    writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");

    expect(isLrmHookEntry(otherMatcherEntry)).toBe(false);
    installLrmSessionStartHook({ hooksFilePath: path });
    expect(readJson(path).hooks.SessionStart).toHaveLength(2);
    uninstallLrmSessionStartHook({ hooksFilePath: path });
    expect(readJson(path)).toEqual(snapshot);
  });

  it("D. recognizes, keeps idempotent, and removes only its own dedicated entry", () => {
    const path = tempHooksPath();
    expect(installLrmSessionStartHook({ hooksFilePath: path }).action).toBe("installed");

    const installed = readJson(path).hooks.SessionStart[0];
    expect(isLrmHookEntry(installed)).toBe(true);
    expect(isLrmHookHandler(installed.hooks[0])).toBe(true);

    expect(installLrmSessionStartHook({ hooksFilePath: path }).action).toBe("already_installed");
    expect(readJson(path).hooks.SessionStart).toHaveLength(1);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("uninstalled");
    expect(readJson(path).hooks.SessionStart).toBeUndefined();
  });

  it("E. restores the original hooks deeply after install then uninstall", () => {
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

    expect(installLrmSessionStartHook({ hooksFilePath: path }).action).toBe("installed");
    expect(readJson(path).hooks.SessionStart).toHaveLength(3);
    expect(readJson(path).hooks.UserPromptSubmit).toEqual(snapshot.hooks.UserPromptSubmit);
    expect(readJson(path).hooks.Stop).toEqual(snapshot.hooks.Stop);

    expect(uninstallLrmSessionStartHook({ hooksFilePath: path }).action).toBe("uninstalled");
    expect(readJson(path)).toEqual(snapshot);
  });
});
