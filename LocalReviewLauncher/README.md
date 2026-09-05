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

Run the launcher-only configuration check with:

```powershell
& "C:\Users\shaoy\Documents\PythonEnvs\local-review-launcher\Scripts\python.exe" .\LocalReviewLauncher\test_config_manager.py
```
