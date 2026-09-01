import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import type { ResolvedSettings } from "../config/settings.js";

export const STARTUP_REGISTRY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const STARTUP_VALUE_NAME = "LocalReviewMCP";

export interface StartupManagerOptions {
  readonly commandLine?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly regCommand?: string;
  readonly spawn?: typeof defaultSpawn;
  readonly platform?: NodeJS.Platform;
}

function quoteWindowsArg(value: string): string {
  if (/^[^\s"]+$/u.test(value)) return value;
  let quoted = "";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `"${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function buildStartupCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteWindowsArg).join(" ");
}

function runRegistryCommand(
  command: string,
  args: readonly string[],
  spawnProcess: typeof defaultSpawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    const finish = (code: number | null, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(cause === undefined
        ? new Error("Windows startup registry operation failed")
        : new Error("Windows startup registry operation failed", { cause }));
    };
    try {
      const options: SpawnOptions = {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      };
      child = spawnProcess(command, args, options);
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
      child.once("exit", (code) => finish(code));
    } catch (error: unknown) {
      reject(new Error("Windows startup registry operation failed", { cause: error }));
    }
  });
}

export class WindowsStartupManager {
  private readonly commandLine: string;
  private readonly regCommand: string;
  private readonly spawnProcess: typeof defaultSpawn;
  private readonly platform: NodeJS.Platform;

  public constructor(options: StartupManagerOptions = {}) {
    const executable = options.executable ?? process.execPath;
    this.commandLine = options.commandLine
      ?? buildStartupCommand(
        executable,
        options.args ?? (process.argv[1] === undefined ? [] : [process.argv[1]]),
      );
    this.regCommand = options.regCommand ?? "reg.exe";
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.platform = options.platform ?? process.platform;
  }

  public async enable(): Promise<void> {
    this.assertWindows();
    await runRegistryCommand(this.regCommand, [
      "ADD",
      STARTUP_REGISTRY_KEY,
      "/V",
      STARTUP_VALUE_NAME,
      "/T",
      "REG_SZ",
      "/D",
      this.commandLine,
      "/F",
    ], this.spawnProcess);
  }

  public async disable(): Promise<void> {
    this.assertWindows();
    await runRegistryCommand(this.regCommand, [
      "DELETE",
      STARTUP_REGISTRY_KEY,
      "/V",
      STARTUP_VALUE_NAME,
      "/F",
    ], this.spawnProcess);
  }

  public async isEnabled(): Promise<boolean> {
    this.assertWindows();
    try {
      await runRegistryCommand(this.regCommand, [
        "QUERY",
        STARTUP_REGISTRY_KEY,
        "/V",
        STARTUP_VALUE_NAME,
      ], this.spawnProcess);
      return true;
    } catch {
      return false;
    }
  }

  public enableStartup(): Promise<void> {
    return this.enable();
  }

  public disableStartup(): Promise<void> {
    return this.disable();
  }

  private assertWindows(): void {
    if (this.platform !== "win32") {
      throw new Error("Windows startup is only available on Windows");
    }
  }
}

export interface CreateStartupManagerOptions {
  readonly configPath?: string;
  readonly runtimeScript?: string;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof defaultSpawn;
  readonly regCommand?: string;
}

export function createStartupManager(
  settings: ResolvedSettings,
  options: CreateStartupManagerOptions = {},
): WindowsStartupManager {
  const runtimeScript = options.runtimeScript ?? process.argv[1] ?? "local-review-mcp";
  const args = options.configPath === undefined
    ? [runtimeScript, "--port", String(settings.port), "--workspace", resolve(settings.workspace)]
    : [runtimeScript, "--config", resolve(options.configPath)];
  return new WindowsStartupManager({
    executable: process.execPath,
    args,
    platform: options.platform,
    spawn: options.spawn,
    regCommand: options.regCommand,
  });
}
