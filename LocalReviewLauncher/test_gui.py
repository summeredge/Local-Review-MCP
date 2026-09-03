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


if __name__ == "__main__":
    unittest.main()
