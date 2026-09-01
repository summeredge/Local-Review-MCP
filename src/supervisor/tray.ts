import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultLogDirectory } from "./logger.js";
import type { Supervisor } from "./supervisor.js";
import type { SupervisorStatus } from "./types.js";
import { WindowsStartupManager } from "./startup.js";

export const TRAY_ACTIONS = [
  "start",
  "stop",
  "restart",
  "open-log-folder",
  "enable-startup",
  "disable-startup",
  "exit",
] as const;

export type TrayAction = typeof TRAY_ACTIONS[number];

export const TRAY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$statePath = [Environment]::GetEnvironmentVariable('LOCAL_REVIEW_MCP_TRAY_STATE')
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('Status: Stopped')
$workspaceItem = $menu.Items.Add('Workspace: unknown')
$remoteItem = $menu.Items.Add('Remote: Stopped')
[void]$menu.Items.Add('-')
$startItem = $menu.Items.Add('Start')
$stopItem = $menu.Items.Add('Stop')
$restartItem = $menu.Items.Add('Restart')
$openLogItem = $menu.Items.Add('Open Log Folder')
$enableStartupItem = $menu.Items.Add('Enable Startup')
$disableStartupItem = $menu.Items.Add('Disable Startup')
[void]$menu.Items.Add('-')
$exitItem = $menu.Items.Add('Exit')
$notifyIcon.ContextMenuStrip = $menu

function Send-Action([string]$action) {
  [Console]::Out.WriteLine($action)
  [Console]::Out.Flush()
}

function Read-State {
  if ($statePath -eq $null -or !(Test-Path -LiteralPath $statePath)) {
    return @{ state = 'STOPPED'; workspace = 'unknown'; remote = 'Stopped' }
  }
  try {
    return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  } catch {
    return @{ state = 'ERROR'; workspace = 'unknown'; remote = 'Error' }
  }
}

function Apply-State {
  $state = Read-State
  $statusItem.Text = 'Status: ' + [string]$state.state
  $workspaceItem.Text = 'Workspace: ' + [string]$state.workspace
  $remoteItem.Text = 'Remote: ' + [string]$state.remote
  $tooltip = 'Local Review MCP - ' + [string]$state.state
  if ($tooltip.Length -gt 63) { $tooltip = $tooltip.Substring(0, 63) }
  $notifyIcon.Text = $tooltip
}

$startItem.Add_Click({ Send-Action 'start' })
$stopItem.Add_Click({ Send-Action 'stop' })
$restartItem.Add_Click({ Send-Action 'restart' })
$openLogItem.Add_Click({ Send-Action 'open-log-folder' })
$enableStartupItem.Add_Click({ Send-Action 'enable-startup' })
$disableStartupItem.Add_Click({ Send-Action 'disable-startup' })
$exitItem.Add_Click({ Send-Action 'exit'; $notifyIcon.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ Apply-State })
$timer.Start()
Apply-State
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$notifyIcon.Visible = $false
$notifyIcon.Dispose()
`;

export interface TrayApplicationOptions {
  readonly platform?: NodeJS.Platform;
  readonly powershellCommand?: string;
  readonly openFolderCommand?: string;
  readonly logDirectory?: string;
  readonly statePath?: string;
  readonly spawn?: typeof defaultSpawn;
  readonly startupManager?: WindowsStartupManager;
  readonly onExit?: () => void | Promise<void>;
}

function remoteLabel(state: string): string {
  if (state === "REMOTE_READY") return "Ready";
  if (state === "REMOTE_STARTING") return "Starting";
  if (state === "REMOTE_ERROR") return "Error";
  return "Stopped";
}

function stateLabel(state: SupervisorStatus["state"]): string {
  if (state === "RUNNING") return "Running";
  if (state === "STARTING") return "Starting";
  if (state === "STOPPING") return "Stopping";
  if (state === "DEGRADED") return "Degraded";
  if (state === "ERROR") return "Error";
  return "Stopped";
}

export class WindowsTrayApp {
  private readonly platform: NodeJS.Platform;
  private readonly powershellCommand: string;
  private readonly openFolderCommand: string;
  private readonly spawnProcess: typeof defaultSpawn;
  private readonly logDirectoryValue: string;
  private readonly statePathValue: string;
  private readonly startupManager: WindowsStartupManager | undefined;
  private readonly onExit: (() => void | Promise<void>) | undefined;
  private child: ChildProcess | undefined;
  private removeStateListener: (() => void) | undefined;
  private output = "";
  private refreshQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly supervisor: Supervisor,
    options: TrayApplicationOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.powershellCommand = options.powershellCommand ?? "powershell.exe";
    this.openFolderCommand = options.openFolderCommand ?? "explorer.exe";
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.logDirectoryValue = options.logDirectory
      ?? supervisor.logDirectory
      ?? defaultLogDirectory();
    this.statePathValue = options.statePath ?? join(this.logDirectoryValue, "tray-state.json");
    this.startupManager = options.startupManager;
    this.onExit = options.onExit;
    this.removeStateListener = supervisor.onStateChange(() => { void this.refresh(); });
  }

  public get logDirectory(): string {
    return this.logDirectoryValue;
  }

  public get statePath(): string {
    return this.statePathValue;
  }

  public async start(): Promise<void> {
    await this.refresh();
    if (this.platform !== "win32" || this.child !== undefined) return;

    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.powershellCommand, [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        TRAY_SCRIPT,
      ], {
        env: this.trayEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      } satisfies SpawnOptions);
    } catch (error: unknown) {
      throw new Error("Windows tray failed to start", { cause: error });
    }
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.readActions(chunk));
    child.once("close", () => {
      if (this.child === child) this.child = undefined;
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.removeListener("error", onError);
        resolve();
      };
      const onError = (error: unknown): void => {
        child.removeListener("spawn", onSpawn);
        if (this.child === child) this.child = undefined;
        reject(new Error("Windows tray failed to start", { cause: error }));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  public async stop(): Promise<void> {
    this.removeStateListener?.();
    this.removeStateListener = undefined;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && !child.killed) child.kill();
  }

  public async refresh(): Promise<void> {
    const update = this.refreshQueue.then(async () => {
      await this.writeState(await this.supervisor.status());
    });
    this.refreshQueue = update.catch(() => undefined);
    await update;
  }

  public async openLogFolder(): Promise<void> {
    if (this.platform !== "win32") return;
    try {
      this.spawnProcess(this.openFolderCommand, [this.logDirectoryValue], {
        shell: false,
        windowsHide: false,
        stdio: "ignore",
      });
    } catch {
      // The tray action is best effort and must not affect the supervisor.
    }
  }

  public async enableStartup(): Promise<void> {
    await this.startupManager?.enableStartup();
  }

  public async disableStartup(): Promise<void> {
    await this.startupManager?.disableStartup();
  }

  public dispose(): void {
    this.removeStateListener?.();
    this.removeStateListener = undefined;
  }

  private trayEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    delete environment.LOCAL_REVIEW_MCP_TOKEN;
    delete environment.CLOUDFLARE_TUNNEL_TOKEN;
    environment.LOCAL_REVIEW_MCP_TRAY_STATE = this.statePathValue;
    return environment;
  }

  private readActions(chunk: string): void {
    this.output += chunk;
    const lines = this.output.split(/\r?\n/u);
    this.output = lines.pop() ?? "";
    for (const line of lines) {
      if ((TRAY_ACTIONS as readonly string[]).includes(line)) void this.handleAction(line as TrayAction);
    }
  }

  private async handleAction(action: TrayAction): Promise<void> {
    try {
      if (action === "start") await this.supervisor.start();
      else if (action === "stop") await this.supervisor.stop();
      else if (action === "restart") await this.supervisor.restart();
      else if (action === "open-log-folder") await this.openLogFolder();
      else if (action === "enable-startup") await this.enableStartup();
      else if (action === "disable-startup") await this.disableStartup();
      else {
        await this.supervisor.stop().catch(() => undefined);
        await this.onExit?.();
      }
    } catch (error: unknown) {
      console.warn(`Windows supervisor action failed (${action}); MCP runtime continues`);
      if (error instanceof Error) {
        console.warn(error.message);
        if (error.stack !== undefined) console.warn(error.stack);
      } else {
        console.warn(String(error));
      }
    }
    await this.refresh();
  }

  private async writeState(status: SupervisorStatus): Promise<void> {
    const state = {
      state: stateLabel(status.state),
      workspace: status.workspace,
      remote: remoteLabel(status.tunnel.state),
    };
    try {
      await mkdir(dirname(this.statePathValue), { recursive: true });
      await writeFile(this.statePathValue, JSON.stringify(state), "utf8");
    } catch {
      // A missing tray state file only disables live UI details.
    }
  }
}

export { WindowsTrayApp as TrayApplication };
