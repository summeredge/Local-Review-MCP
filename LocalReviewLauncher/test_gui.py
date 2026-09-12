"""Minimal checks for launcher-only log actions."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLabel, QPlainTextEdit

from gui import LauncherWindow
from status_checker import OAuthClientStatus, OAuthRegistryStatus


class LauncherLogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

    @staticmethod
    def _window() -> SimpleNamespace:
        return SimpleNamespace(log_output=QPlainTextEdit(), message_label=QLabel())

    def test_save_log_writes_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "launcher.log"
            window = self._window()
            window.log_output.setPlainText("启动完成 ✓")
            with patch("gui.QFileDialog.getSaveFileName", return_value=(str(target), "")):
                LauncherWindow.save_log(window)
            self.assertEqual(target.read_bytes(), "启动完成 ✓".encode("utf-8"))

    def test_clear_log_only_clears_display(self) -> None:
        window = self._window()
        process_log = Mock(return_value="actual process log")
        window.process_manager = SimpleNamespace(get_output=process_log)
        window.log_output.setPlainText("displayed log")

        LauncherWindow.clear_log(window)

        self.assertEqual(window.log_output.toPlainText(), "")
        process_log.assert_not_called()

    def test_render_oauth_status_shows_client_identity(self) -> None:
        window = SimpleNamespace(oauth_status_label=QLabel())
        status = OAuthRegistryStatus(
            "oauth/clients.json",
            True,
            1,
            (OAuthClientStatus("client-1", "ChatGPT", 123),),
        )

        LauncherWindow._render_oauth_status(window, status)  # type: ignore[arg-type]

        text = window.oauth_status_label.text()
        self.assertIn("OAuth Clients: 1", text)
        self.assertIn("ChatGPT", text)
        self.assertIn("client_id: client-1", text)
        self.assertIn("Created: 123", text)


if __name__ == "__main__":
    unittest.main()
