"""Regression checks for the production Launcher process lifecycle."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from config_manager import ConfigManager, LauncherConfig
from process_manager import ProductionProcessManager


class ProductionProcessManagerTests(unittest.TestCase):
    def _project(self, root: Path) -> tuple[Path, ConfigManager, LauncherConfig, Path]:
        project_root = root / "Test User" / "Local Review MCP"
        (project_root / "scripts").mkdir(parents=True)
        (project_root / "scripts" / "start-production.ps1").touch()
        workspace = project_root / "workspace"
        workspace.mkdir()
        config_path = project_root / "config.production.json"
        config_path.write_text(json.dumps({"workspace": str(workspace)}), encoding="utf-8")
        config_manager = ConfigManager(project_root)
        return project_root, config_manager, config_manager.load(), config_path.resolve()

    def test_start_passes_spaced_config_path_as_one_powershell_argument(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, config_manager, configuration, config_path = self._project(Path(temporary))
            process = MagicMock(pid=1234, stdout=None)
            process.poll.return_value = None
            manager = ProductionProcessManager(root, config_manager)

            with patch("process_manager.subprocess.Popen", return_value=process) as popen:
                manager.start(configuration)

            command = popen.call_args.args[0]
            self.assertEqual(command, [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(root / "scripts" / "start-production.ps1"),
                "-Config",
                str(config_path),
            ])
            self.assertIn("Test User\\Local Review MCP", command[-1])

    def test_restart_waits_for_old_launcher_process_to_exit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, config_manager, configuration, _ = self._project(Path(temporary))
            events: list[str] = []
            old_process = MagicMock(pid=1234, stdout=None)
            old_process.poll.return_value = None

            def wait_for_old_process(*, timeout: int) -> None:
                events.append("old process exited")
                old_process.poll.return_value = 0

            old_process.wait.side_effect = wait_for_old_process
            new_process = MagicMock(pid=5678, stdout=None)
            new_process.poll.return_value = None

            def launch(*args: object, **kwargs: object) -> MagicMock:
                if not events:
                    events.append("first start")
                    return old_process
                self.assertIn("old process exited", events)
                events.append("second start")
                return new_process

            manager = ProductionProcessManager(root, config_manager)
            with patch("process_manager.subprocess.Popen", side_effect=launch), patch(
                "process_manager.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "SUCCESS", ""),
            ):
                manager.start(configuration)
                manager.stop()
                manager.start(configuration)

            self.assertEqual(events, ["first start", "old process exited", "second start"])

    def test_stop_timeout_keeps_old_process_tracked_and_blocks_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, config_manager, configuration, _ = self._project(Path(temporary))
            process = MagicMock(pid=1234, stdout=None)
            process.poll.return_value = None
            process.wait.side_effect = subprocess.TimeoutExpired("powershell.exe", 5)
            manager = ProductionProcessManager(root, config_manager)

            with patch("process_manager.subprocess.Popen", return_value=process) as popen, patch(
                "process_manager.subprocess.run",
                return_value=subprocess.CompletedProcess([], 1, "", "still running"),
            ):
                manager.start(configuration)
                with self.assertRaisesRegex(RuntimeError, "did not stop"):
                    manager.stop()
                manager.start(configuration)

            self.assertIs(manager._launcher_process, process)
            popen.assert_called_once()


if __name__ == "__main__":
    unittest.main()
