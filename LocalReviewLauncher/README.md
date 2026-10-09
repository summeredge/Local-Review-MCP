# Local Review MCP Launcher

This launcher is independent of the MCP runtime. It starts the existing
`scripts/start-production.ps1` entry point and uses only local process and HTTP
checks for its status display.

Create its dedicated environment with a non-Codex Python installation, then
double-click `start-launcher.cmd`:

```powershell
& "C:\path\to\python.exe" -m venv "C:\Users\shaoy\Documents\PythonEnvs\local-review-launcher"
& "C:\Users\shaoy\Documents\PythonEnvs\local-review-launcher\Scripts\python.exe" -m pip install -r .\LocalReviewLauncher\requirements.txt
```

`launcher.config.json` stores the selected workspace together with the local
Workspace Registry, the existing production config filename, and `autoStart`.
Old configurations containing only `workspace` are migrated on first load. A
registry ID is generated once and then retained across name changes and
restarts. Selecting or removing a registry entry never edits or deletes the
workspace directory or `config.production.json`; the launcher passes a
temporary effective config to the existing production startup script when
needed. That config carries the active registry entry as `workspace.id`,
`workspace.name`, and `workspace.path`, alongside the compatible `workspaces`
array.

## 开机自启

在“启动信息”页勾选“开机自启”即可启用，取消勾选即可关闭。启动项写入
`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` 的
`LocalReviewMCPLauncher` 值，无需管理员权限，仅在当前 Windows 用户登录时执行。
命令使用当前环境的 `pythonw.exe` 和本项目的 `launcher.py --login-startup`，
两个路径均加双引号；登录入口会自动启动 MCP，重复启动仍复用已有单实例。
启用和关闭时同时保存 `autoStart=true/false`；手动启动继续遵循 `autoStart`。

GUI 初始化只读取启动项，不自动改写配置。复选框仅勾选命令、当前环境及
Launcher 路径有效且能自动启动 MCP 的启动项。带 `--login-startup` 的启动项
即使配置被改为 `autoStart=false`，登录时仍会自动启动 MCP；界面会提示此差异。
旧版无参数启动项需要 `autoStart=true`，否则显示无效，可重新勾选修复。
移动项目或删除 Python 环境后，失效启动项也会显示未勾选并提示修复。

实际 Windows 登录需人工验收：

1. 勾选后确认上述 Run 值存在，命令包含有效的两个绝对路径和 `--login-startup`。
2. 退出 Launcher，注销并重新登录当前 Windows 用户，确认 Launcher 出现、MCP
   状态变为运行中；如 Windows 任务管理器禁用了该启动项，先将其启用。
3. 再运行 `start-launcher.cmd`，确认只激活已有窗口，没有第二个 GUI。
4. 取消勾选，确认 Run 值删除、重开 GUI 后未勾选；再次注销登录，确认不再自动启动。

Run the launcher-only configuration check with:

```powershell
& "C:\Users\shaoy\Documents\PythonEnvs\local-review-launcher\Scripts\python.exe" .\LocalReviewLauncher\test_config_manager.py
```

The read-only Execution Dashboard, Execution details, Event Stream, and Codex
Task locator are documented in
[`docs/launcher-dashboard.md`](../docs/launcher-dashboard.md).

The startup overview includes a read-only Desktop Sync Status supplied by the
local runtime's `DesktopSyncManager` through the authenticated loopback
`/launcher/desktop-sync` endpoint. `mode` is currently `auto`: valid Desktop
IPC conversation evidence is the Primary observation/association source;
when Desktop is disconnected or has not established evidence, the status uses
the existing app-server `Session.thread_id` as the Legacy fallback source.
The endpoint does not guess a current Session when no unambiguous context is
available.
The launcher does not read the named pipe or control Desktop. Codex execution
negotiates the Desktop capability first and uses the existing standalone
app-server provider after a recheck/standalone choice or bounded fallback timeout.
Unmatched or
conflicting Desktop identities remain visible as Desktop IPC association
states and are not disguised as fallback.

The overview also reads `/launcher/capability?execution_id=current` and exposes
the current execution, source, state, and the recheck/standalone actions. These actions select the execution
provider; they do not acquire a pipe or change the Desktop protocols.

The capability panel also provides **Run Doctor**. It reads the authenticated
`/launcher/doctor` observation report and displays the latest total status,
timestamp, each check, and any failure reason. Doctor does not submit a Goal,
create an Execution or Codex Thread, send a message, change the capability
snapshot, or select a fallback provider.
