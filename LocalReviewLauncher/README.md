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

`launcher.config.json` stores only the selected workspace, the existing
production config filename, and `autoStart`. Selecting a workspace never edits
`config.production.json`; when the selected workspace differs, the launcher
passes a temporary copy to the existing production startup script.

Run the launcher-only configuration check with:

```powershell
& "C:\Users\shaoy\Documents\PythonEnvs\local-review-launcher\Scripts\python.exe" .\LocalReviewLauncher\test_config_manager.py
```
