"""Windows login startup checks using an isolated current-user registry key."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import uuid
import winreg
from pathlib import Path
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

import gui
from config_manager import ConfigManager, LauncherConfig, LauncherConfigError
from gui import LauncherWindow


class LoginStartupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        self.registry_key = rf"Software\LocalReviewMCPLauncherTests-{uuid.uuid4()}"
        winreg.CreateKey(winreg.HKEY_CURRENT_USER, self.registry_key).Close()
        self.addCleanup(winreg.DeleteKey, winreg.HKEY_CURRENT_USER, self.registry_key)
        self._patch("gui.LOGIN_STARTUP_KEY", self.registry_key)
        temporary = tempfile.TemporaryDirectory(prefix="launcher startup ")
        self.addCleanup(temporary.cleanup)
        self.manager = ConfigManager(Path(temporary.name))
        process = self._patch("gui.ProductionProcessManager")
        process.return_value.has_started = False
        self._patch("gui.StatusChecker")
        self._patch("gui.QSystemTrayIcon.isSystemTrayAvailable", return_value=False)
        self._patch("gui.QTimer.singleShot")
        self._patch("gui.LauncherWindow.refresh_status")
        self._patch("gui.LauncherWindow._render_runtime_info")
        self.error = self._patch("gui.LauncherWindow._show_error")

    def _patch(self, *args, **kwargs):
        patcher = patch(*args, **kwargs)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    @staticmethod
    def _command(*, login_startup: bool = True) -> str:
        command = (f'"{Path(sys.executable).with_name("pythonw.exe")}" '
                   f'"{Path(gui.__file__).resolve().with_name("launcher.py")}"')
        return command + (" --login-startup" if login_startup else "")

    def _window(self, *, login_startup: bool = False) -> LauncherWindow:
        window = LauncherWindow(self.manager.project_root, self.manager, login_startup=login_startup)
        window.timer.stop()
        window.capability_countdown_timer.stop()
        self.addCleanup(window.close)
        return window

    def test_enable_disable_and_reopen_read_actual_registry_without_writing_config(self) -> None:
        window = self._window()
        self.assertFalse(window.auto_start_checkbox.isChecked())
        self.assertFalse(self.manager.path.exists())
        window.auto_start_checkbox.setChecked(True)
        expected = self._command()
        self.assertEqual(window._read_login_startup(), (expected, winreg.REG_SZ))
        self.assertTrue(self.manager.load().auto_start)
        original = self.manager.path.read_bytes()
        reopened = self._window()
        self.assertTrue(reopened.auto_start_checkbox.isChecked())
        self.assertEqual(self.manager.path.read_bytes(), original)
        reopened.auto_start_checkbox.setChecked(False)
        self.assertIsNone(window._read_login_startup())
        self.assertFalse(self.manager.load().auto_start)
        self.assertFalse(self._window().auto_start_checkbox.isChecked())
        self.error.assert_not_called()

    def test_initial_state_comes_from_registry_even_when_config_disagrees(self) -> None:
        self.manager.set_auto_start(LauncherConfig("", "config.production.json", False), True)
        original = self.manager.path.read_bytes()
        self.assertFalse(self._window().auto_start_checkbox.isChecked())
        self.assertEqual(self.manager.path.read_bytes(), original)
        LauncherWindow._write_login_startup((self._command(), winreg.REG_EXPAND_SZ))
        self.manager.set_auto_start(self.manager.load(), False)
        original = self.manager.path.read_bytes()
        with patch("gui.QTimer.singleShot") as single_shot:
            reopened = self._window()
        self.assertTrue(reopened.auto_start_checkbox.isChecked())
        self.assertIn("手动启动时不会自动启动 MCP", reopened.message_label.text())
        single_shot.assert_not_called()
        self.assertEqual(self.manager.path.read_bytes(), original)

    def test_legacy_command_requires_auto_start_and_can_be_repaired(self) -> None:
        LauncherWindow._write_login_startup((self._command(login_startup=False), winreg.REG_SZ))
        window = self._window()
        self.assertFalse(window.auto_start_checkbox.isChecked())
        self.assertIn("Windows 登录启动项无效", window.message_label.text())
        self.assertFalse(self.manager.path.exists())
        window.auto_start_checkbox.setChecked(True)
        self.assertEqual(window._read_login_startup(), (self._command(), winreg.REG_SZ))
        self.assertTrue(self.manager.load().auto_start)
        LauncherWindow._write_login_startup((self._command(login_startup=False), winreg.REG_SZ))
        self.assertTrue(self._window().auto_start_checkbox.isChecked())

    def test_invalid_paths_command_and_registry_types_are_not_shown_as_enabled(self) -> None:
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        launcher = Path(gui.__file__).resolve().with_name("launcher.py")
        other_launcher = self.manager.project_root / "other launcher.py"
        other_launcher.write_text("", encoding="utf-8")
        self.manager.set_auto_start(self.manager.load(), True)
        original = self.manager.path.read_bytes()
        for value in (
            (f'"{pythonw.with_name("missing-pythonw.exe")}" "{launcher}" --login-startup', winreg.REG_SZ),
            (f'"{pythonw}" "{launcher.with_name("missing-launcher.py")}" --login-startup', winreg.REG_SZ),
            (f'"{pythonw}" "{other_launcher}" --login-startup', winreg.REG_SZ),
            (f'"{sys.executable}" "{launcher}" --login-startup', winreg.REG_SZ),
            (self._command() + " --unknown", winreg.REG_SZ),
            ("invalid command", winreg.REG_SZ),
            (1, winreg.REG_DWORD),
        ):
            with self.subTest(value=value):
                LauncherWindow._write_login_startup(value)
                window = self._window()
                self.assertFalse(window.auto_start_checkbox.isChecked())
                self.assertIn("Windows 登录启动项无效", window.message_label.text())
                self.assertEqual(self.manager.path.read_bytes(), original)

    def test_deleted_python_or_launcher_is_not_shown_as_enabled(self) -> None:
        LauncherWindow._write_login_startup((self._command(), winreg.REG_SZ))
        for missing in (Path(sys.executable).with_name("pythonw.exe"),
                        Path(gui.__file__).resolve().with_name("launcher.py")):
            original_is_file = Path.is_file
            with self.subTest(missing=missing), patch(
                "gui.Path.is_file", lambda path: False if path == missing else original_is_file(path)
            ):
                self.assertFalse(self._window().auto_start_checkbox.isChecked())

    def test_expandable_paths_are_valid_for_current_application(self) -> None:
        with patch.dict(os.environ, LRM_TEST_PYTHON=str(Path(sys.executable).parent),
                        LRM_TEST_LAUNCHER=str(Path(gui.__file__).resolve().parent)):
            LauncherWindow._write_login_startup((
                '"%LRM_TEST_PYTHON%\\pythonw.exe" "%LRM_TEST_LAUNCHER%\\launcher.py" --login-startup',
                winreg.REG_EXPAND_SZ,
            ))
            self.assertTrue(self._window().auto_start_checkbox.isChecked())

    def test_enabled_config_schedules_existing_mcp_start(self) -> None:
        self.manager.set_auto_start(LauncherConfig("", "config.production.json", False), True)
        with patch("gui.QTimer.singleShot") as single_shot:
            window = self._window()
        single_shot.assert_called_once_with(0, window.start_mcp)

    def test_real_run_key_registration_and_removal(self) -> None:
        with patch("gui.LOGIN_STARTUP_KEY", r"Software\Microsoft\Windows\CurrentVersion\Run"), patch(
            "gui.LOGIN_STARTUP_NAME", f"LocalReviewMCPLauncherTest-{uuid.uuid4()}"
        ):
            try:
                window = self._window()
                window.auto_start_checkbox.setChecked(True)
                self.assertIsNotNone(window._read_login_startup())
                self.assertTrue(self._window().auto_start_checkbox.isChecked())
                window.auto_start_checkbox.setChecked(False)
                self.assertIsNone(window._read_login_startup())
            finally:
                LauncherWindow._write_login_startup(None)

    def test_config_failure_restores_exact_registry_value_and_config_bytes(self) -> None:
        for previous in (None, (self._command(), winreg.REG_EXPAND_SZ)):
            with self.subTest(previous=previous):
                LauncherWindow._write_login_startup(previous)
                self.manager.set_auto_start(LauncherConfig("", "config.production.json", False), bool(previous))
                original = self.manager.path.read_bytes()
                window = self._window()
                with patch("config_manager.os.replace", side_effect=PermissionError("config denied")):
                    window.auto_start_checkbox.setChecked(previous is None)
                self.assertEqual(window._read_login_startup(), previous)
                self.assertEqual(window.auto_start_checkbox.isChecked(), previous is not None)
                self.assertEqual(self.manager.path.read_bytes(), original)
                self.assertEqual(list(self.manager.launcher_directory.iterdir()), [self.manager.path])
                self.assertIn("config denied", self.error.call_args.args[0])

    def test_registry_failure_keeps_config_and_checkbox(self) -> None:
        window = self._window()
        with patch.object(LauncherWindow, "_write_login_startup", side_effect=PermissionError("registry denied")):
            window.auto_start_checkbox.setChecked(True)
        self.assertFalse(window.auto_start_checkbox.isChecked())
        self.assertFalse(self.manager.path.exists())
        self.assertIn("registry denied", self.error.call_args.args[0])

    def test_config_validation_failure_restores_registry(self) -> None:
        window = self._window()
        with patch.object(self.manager, "set_auto_start", side_effect=LauncherConfigError("invalid config")):
            window.auto_start_checkbox.setChecked(True)
        self.assertIsNone(window._read_login_startup())
        self.assertFalse(window.auto_start_checkbox.isChecked())
        self.assertFalse(self.manager.path.exists())
        self.assertIn("invalid config", self.error.call_args.args[0])

    def test_disable_registry_failure_keeps_enabled_state_and_config(self) -> None:
        window = self._window()
        window.auto_start_checkbox.setChecked(True)
        original = self.manager.path.read_bytes()
        with patch.object(LauncherWindow, "_write_login_startup", side_effect=PermissionError("registry denied")):
            window.auto_start_checkbox.setChecked(False)
        self.assertTrue(window.auto_start_checkbox.isChecked())
        self.assertEqual(window._read_login_startup(), (self._command(), winreg.REG_SZ))
        self.assertEqual(self.manager.path.read_bytes(), original)

    def test_read_failure_during_toggle_keeps_config_and_disables_unknown_state(self) -> None:
        window = self._window()
        with patch.object(LauncherWindow, "_read_login_startup", side_effect=PermissionError("read denied")):
            window.auto_start_checkbox.setChecked(True)
        self.assertFalse(window.auto_start_checkbox.isChecked())
        self.assertFalse(window.auto_start_checkbox.isEnabled())
        self.assertFalse(self.manager.path.exists())
        self.assertIn("无法确认 Windows 启动项状态", self.error.call_args.args[0])

    def test_rollback_failure_displays_actual_registry_state(self) -> None:
        window = self._window()
        write = LauncherWindow._write_login_startup
        def fail_rollback(value):
            if value is None:
                raise PermissionError("rollback denied")
            write(value)
        with patch.object(self.manager, "set_auto_start", side_effect=OSError("config denied")), patch.object(
            LauncherWindow, "_write_login_startup", side_effect=fail_rollback
        ):
            window.auto_start_checkbox.setChecked(True)
        self.assertTrue(window.auto_start_checkbox.isChecked())
        self.assertIsNotNone(window._read_login_startup())
        self.assertIn("恢复 Windows 启动项失败", self.error.call_args.args[0])

    def test_read_failure_disables_checkbox_without_config_write(self) -> None:
        with patch.object(LauncherWindow, "_read_login_startup", side_effect=PermissionError("read denied")):
            window = self._window()
        self.assertFalse(window.auto_start_checkbox.isEnabled())
        self.assertIn("读取开机自启状态失败", window.message_label.text())
        self.assertFalse(self.manager.path.exists())

    def test_command_quotes_paths_with_spaces_and_missing_pythonw_is_rejected(self) -> None:
        window = self._window()
        with patch("gui.sys.executable", r"C:\Python Envs\launcher\python.exe"), patch(
            "gui.__file__", r"C:\My Project\LocalReviewLauncher\gui.py"
        ), patch("gui.Path.is_file", return_value=True):
            window.auto_start_checkbox.setChecked(True)
        self.assertEqual(window._read_login_startup()[0],
                         '"C:\\Python Envs\\launcher\\pythonw.exe" '
                         '"C:\\My Project\\LocalReviewLauncher\\launcher.py" --login-startup')
        window.auto_start_checkbox.setChecked(False)
        with patch("gui.Path.is_file", return_value=False):
            window.auto_start_checkbox.setChecked(True)
        self.assertFalse(window.auto_start_checkbox.isChecked())
        self.assertFalse(self.manager.load().auto_start)

    def test_login_entry_runs_existing_mcp_start_when_config_is_false(self) -> None:
        import launcher

        self.manager.add_workspace(self.manager.load(), self.manager.project_root)
        LauncherWindow._write_login_startup((self._command(), winreg.REG_SZ))
        windows = []
        def create_window(project_root, manager, **kwargs):
            window = LauncherWindow(project_root, manager, **kwargs)
            self.addCleanup(window.close)
            windows.append(window)
            return window
        def run_event_loop():
            callback = single_shot.call_args.args[1]
            self.assertEqual(callback, windows[0].start_mcp)
            with patch.object(windows[0]._status_thread_pool, "start"), patch.object(windows[0], "_update_log"):
                callback()
                windows[0]._status_check_finished(0, gui.LauncherStatus(False, False, False))
            return 0
        application = Mock()
        application.exec.side_effect = run_event_loop
        with patch.object(launcher, "QApplication", return_value=application), patch.object(
            launcher, "_create_single_instance_server"
        ), patch.object(launcher, "ConfigManager", return_value=self.manager), patch.object(
            launcher, "LauncherWindow", side_effect=create_window
        ), patch.object(launcher.sys, "argv", ["launcher.py", "--login-startup"]), patch(
            "gui.QTimer.singleShot"
        ) as single_shot, patch.object(LauncherWindow, "_poll_startup"):
            self.assertEqual(launcher.main(), 0)
        self.assertFalse(windows[0].configuration.auto_start)
        windows[0].process_manager.start.assert_called_once_with(windows[0].configuration)
        self.error.assert_not_called()

    def test_login_entry_defers_to_existing_single_instance(self) -> None:
        import launcher

        with patch.object(launcher, "QApplication"), patch.object(
            launcher, "_create_single_instance_server", return_value=None
        ), patch.object(launcher, "LauncherWindow") as create_window, patch.object(
            launcher.sys, "argv", ["launcher.py", "--login-startup"]
        ):
            self.assertEqual(launcher.main(), 0)
        create_window.assert_not_called()

    def test_auto_start_config_preserves_other_fields(self) -> None:
        self.manager.set_auto_start(LauncherConfig("", "config.production.json", False), False)
        values = json.loads(self.manager.path.read_text(encoding="utf-8"))
        values["custom"] = "preserved"
        self.manager.path.write_text(json.dumps(values), encoding="utf-8")
        self.manager.set_auto_start(self.manager.load(), True)
        updated = json.loads(self.manager.path.read_text(encoding="utf-8"))
        self.assertEqual(updated, {**values, "autoStart": True})

    def test_checkbox_is_after_refresh_and_vertically_centered(self) -> None:
        window = self._window()
        window.show()
        self.application.processEvents()
        row = window.refresh_button.parentWidget().layout().itemAt(0).layout()
        self.assertIs(row.itemAt(3).widget(), window.auto_start_checkbox)
        self.assertEqual(row.spacing(), gui.BUTTON_SPACING)
        self.assertLessEqual(abs(window.auto_start_checkbox.geometry().center().y()
                                 - window.refresh_button.geometry().center().y()), 1)
        self.assertGreater(window.auto_start_checkbox.x(), window.refresh_button.geometry().right())
        self.assertLessEqual(window.auto_start_checkbox.geometry().right(), window.refresh_button.parentWidget().width())


if __name__ == "__main__":
    unittest.main()
