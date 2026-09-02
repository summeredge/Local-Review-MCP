"""Starts the existing production PowerShell entry point and stops its process tree."""

from __future__ import annotations

import json
import subprocess
import threading
from pathlib import Path
from typing import Any

from config_manager import ConfigManager, LauncherConfig


class ProductionProcessManager:
    def __init__(self, project_root: Path, config_manager: ConfigManager):
        self.project_root = project_root
        self.config_manager = config_manager
        self._process: subprocess.Popen[str] | None = None
        self._temporary_config: Path | None = None
        self._output = ""
        self._failure_reason = ""
        self._stopping = False
        self._lock = threading.Lock()

    def start(self, configuration: LauncherConfig) -> None:
        if self.is_running:
            return
        config_path, temporary_config = self.config_manager.runtime_config(configuration)
        script = self.project_root / "scripts" / "start-production.ps1"
        if not script.is_file():
            if temporary_config is not None:
                temporary_config.unlink(missing_ok=True)
            raise RuntimeError(f"Production startup script was not found: {script}")

        command = [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-Config",
            str(config_path),
        ]
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        try:
            self._process = subprocess.Popen(
                command,
                cwd=self.project_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creation_flags,
            )
        except OSError as error:
            if temporary_config is not None:
                temporary_config.unlink(missing_ok=True)
            raise RuntimeError(f"Could not start the production script: {error}") from error

        self._temporary_config = temporary_config
        self._failure_reason = ""
        with self._lock:
            self._output = ""
        threading.Thread(target=self._capture_output, args=(self._process,), daemon=True).start()

    @property
    def is_running(self) -> bool:
        self._record_exit()
        return self._process is not None and self._process.poll() is None

    @property
    def failure_reason(self) -> str:
        self._record_exit()
        return self._failure_reason

    def stop(self, port: int = 12080) -> str:
        self._stopping = True
        targets: set[int] = set()
        if self._process is not None and self._process.poll() is None:
            targets.add(self._process.pid)
        else:
            for listener_pid in self._listener_pids(port):
                supervisor_pid = self._local_review_supervisor_pid(listener_pid)
                if supervisor_pid is not None:
                    targets.add(supervisor_pid)

        errors: list[str] = []
        for pid in targets:
            result = subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
            )
            if result.returncode != 0:
                errors.append((result.stderr or result.stdout).strip() or f"taskkill failed for PID {pid}")

        if self._process is not None:
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                errors.append("Production process did not stop within five seconds")
        self._process = None
        self._cleanup_temporary_config()
        self._stopping = False
        if errors:
            raise RuntimeError("\n".join(errors))
        return "MCP stopped." if targets else "No Local Review MCP process was found."

    def _capture_output(self, process: subprocess.Popen[str]) -> None:
        if process.stdout is None:
            return
        for line in process.stdout:
            with self._lock:
                self._output = (self._output + line)[-64_000:]

    def _record_exit(self) -> None:
        if self._process is None:
            return
        exit_code = self._process.poll()
        if exit_code is None:
            return
        if not self._stopping and exit_code != 0:
            with self._lock:
                detail = self._output[-4_000:].strip()
            self._failure_reason = f"Production startup exited with code {exit_code}." + (f"\n{detail}" if detail else "")
        self._process = None
        self._cleanup_temporary_config()

    def _cleanup_temporary_config(self) -> None:
        if self._temporary_config is not None:
            self._temporary_config.unlink(missing_ok=True)
            self._temporary_config = None

    @staticmethod
    def _listener_pids(port: int) -> set[int]:
        try:
            result = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            return set()
        pids: set[int] = set()
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 5 or parts[-2].upper() != "LISTENING":
                continue
            if parts[1].rsplit(":", 1)[-1] != str(port):
                continue
            try:
                pids.add(int(parts[-1]))
            except ValueError:
                continue
        return pids

    def _local_review_supervisor_pid(self, listener_pid: int) -> int | None:
        current_pid = listener_pid
        candidate: int | None = None
        for _ in range(12):
            process = self._process_details(current_pid)
            if process is None:
                break
            command_line = str(process.get("CommandLine") or "").replace("/", "\\").casefold()
            if "dist\\src\\cli.js" in command_line:
                candidate = current_pid
            parent_pid = process.get("ParentProcessId")
            if not isinstance(parent_pid, int) or parent_pid <= 0 or parent_pid == current_pid:
                break
            current_pid = parent_pid
        return candidate

    @staticmethod
    def _process_details(pid: int) -> dict[str, Any] | None:
        command = (
            "$process = Get-CimInstance Win32_Process -Filter 'ProcessId = "
            f"{pid}' -ErrorAction SilentlyContinue; "
            "if ($null -ne $process) { "
            "[pscustomobject]@{ProcessId=[int]$process.ProcessId; "
            "ParentProcessId=[int]$process.ParentProcessId; CommandLine=$process.CommandLine} "
            "| ConvertTo-Json -Compress }"
        )
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
            )
            if result.returncode != 0 or not result.stdout.strip():
                return None
            data = json.loads(result.stdout)
            return data if isinstance(data, dict) else None
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return None
