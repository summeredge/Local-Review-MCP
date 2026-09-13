"""Minimal checks for launcher-only log actions."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLabel, QMessageBox, QPlainTextEdit

from gui import LauncherState, LauncherWindow
from status_checker import LauncherStatus, OAuthClientStatus, OAuthRegistryStatus


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

    def test_delete_oauth_client_deletes_selected_client_and_refreshes(self) -> None:
        status = OAuthRegistryStatus(
            "oauth/clients.json",
            True,
            2,
            (
                OAuthClientStatus("client-1", "ChatGPT", 123),
                OAuthClientStatus("client-2", "ChatGPT", 456),
            ),
        )
        delete = Mock(return_value=True)
        window = SimpleNamespace(
            _last_status=LauncherStatus(True, True, False, oauth_registry=status),
            state=LauncherState.RUNNING,
            status_checker=SimpleNamespace(delete_oauth_client=delete, reset_oauth_clients=Mock()),
            message_label=QLabel(),
            refresh_status=Mock(),
            _show_error=Mock(),
        )
        with patch("gui.QInputDialog.getItem", return_value=("ChatGPT (client-2)", True)) as get_item, patch(
            "gui.QMessageBox.question", return_value=QMessageBox.StandardButton.Yes
        ) as confirm:
            LauncherWindow.delete_oauth_client(window)  # type: ignore[arg-type]

        self.assertEqual(get_item.call_args.args[3], ["ChatGPT (client-1)", "ChatGPT (client-2)"])
        self.assertIn("只删除选中的 OAuth Client，不影响其他 Client", confirm.call_args.args[2])
        delete.assert_called_once_with("client-2")
        window.status_checker.reset_oauth_clients.assert_not_called()
        window.refresh_status.assert_called_once_with()

    def test_delete_oauth_client_cancel_does_not_delete(self) -> None:
        status = OAuthRegistryStatus(
            "oauth/clients.json",
            True,
            1,
            (OAuthClientStatus("client-1", "ChatGPT", 123),),
        )
        delete = Mock()
        window = SimpleNamespace(
            _last_status=LauncherStatus(True, True, False, oauth_registry=status),
            state=LauncherState.RUNNING,
            status_checker=SimpleNamespace(delete_oauth_client=delete),
            message_label=QLabel(),
            refresh_status=Mock(),
            _show_error=Mock(),
        )
        with patch("gui.QInputDialog.getItem", return_value=("", False)) as get_item, patch(
            "gui.QMessageBox.question"
        ) as question:
            LauncherWindow.delete_oauth_client(window)  # type: ignore[arg-type]

        get_item.assert_called_once()
        question.assert_not_called()
        delete.assert_not_called()
        window.refresh_status.assert_not_called()

    def test_delete_oauth_client_cancel_confirmation_does_not_delete(self) -> None:
        status = OAuthRegistryStatus(
            "oauth/clients.json",
            True,
            1,
            (OAuthClientStatus("client-1", "ChatGPT", 123),),
        )
        delete = Mock()
        window = SimpleNamespace(
            _last_status=LauncherStatus(True, True, False, oauth_registry=status),
            state=LauncherState.RUNNING,
            status_checker=SimpleNamespace(delete_oauth_client=delete),
            message_label=QLabel(),
            refresh_status=Mock(),
            _show_error=Mock(),
        )
        with patch("gui.QInputDialog.getItem", return_value=("ChatGPT (client-1)", True)), patch(
            "gui.QMessageBox.question", return_value=QMessageBox.StandardButton.No
        ):
            LauncherWindow.delete_oauth_client(window)  # type: ignore[arg-type]

        delete.assert_not_called()
        window.refresh_status.assert_not_called()

    def test_delete_oauth_client_with_no_clients_does_not_open_selection(self) -> None:
        status = OAuthRegistryStatus("oauth/clients.json", True, 0, ())
        window = SimpleNamespace(
            _last_status=LauncherStatus(True, True, False, oauth_registry=status),
            state=LauncherState.RUNNING,
        )
        with patch("gui.QInputDialog.getItem") as get_item:
            LauncherWindow.delete_oauth_client(window)  # type: ignore[arg-type]

        get_item.assert_not_called()


if __name__ == "__main__":
    unittest.main()
