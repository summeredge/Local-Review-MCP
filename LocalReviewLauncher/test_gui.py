"""Minimal checks for launcher-only log actions."""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLabel, QMessageBox, QPlainTextEdit, QPushButton, QTableWidget

from config_manager import LauncherConfig
from gui import LauncherState, LauncherWindow
from status_checker import (
    LauncherStatus,
    OAuthClientStatus,
    OAuthRegistryStatus,
    SessionViewModel,
    build_session_view_model,
)


class LauncherLogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

    @staticmethod
    def _window() -> SimpleNamespace:
        return SimpleNamespace(log_output=QPlainTextEdit(), message_label=QLabel())

    def test_startup_actions_below_title_at_three_quarter_width(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)
            window.timer.stop()
            window.show()
            self.application.processEvents()
            title = next(label for label in window.findChildren(QLabel) if label.text() == "Local Review MCP")
            actions = window.start_button.parentWidget()
            overview = actions.parentWidget().layout().itemAt(0).layout()
            self.assertIs(overview.itemAt(0).widget(), title)
            self.assertIs(overview.itemAt(1).widget(), actions)
            self.assertEqual(actions.width(), 680 * 3 // 4)
            self.assertEqual(actions.x(), title.x())
            self.assertGreater(actions.y(), title.geometry().bottom())
            self.assertLess(actions.geometry().bottom(), window.launcher_state.parentWidget().y())
            first_row = (window.start_button, window.stop_button, window.refresh_button)
            second_row = (window.refresh_oauth_button, window.reset_oauth_button, window.delete_oauth_button)
            for column, (upper, lower) in enumerate(zip(first_row, second_row)):
                self.assertIs(actions.layout().itemAt(0).layout().itemAt(column).widget(), upper)
                self.assertIs(actions.layout().itemAt(1).layout().itemAt(column).widget(), lower)
                self.assertEqual(upper.x(), lower.x())
                self.assertEqual(upper.width(), lower.width())
                self.assertGreater(lower.y(), upper.geometry().bottom())

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


class LauncherDashboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

    @staticmethod
    def _window():
        window = LauncherWindow.__new__(LauncherWindow)
        window.session_table = QTableWidget(0, 8)
        window.session_empty_label = QLabel()
        window.session_details_label = QLabel()
        window.execution_details_label = QLabel()
        window.event_table = QTableWidget(0, 3)
        window.open_codex_task_button = QPushButton()
        window._session_view_models = ()
        return window

    @staticmethod
    def _payloads() -> tuple[dict, dict, dict, dict]:
        timestamp = "2026-09-15T12:34:56+08:00"
        session = {
            "session_id": "session-1",
            "goal_id": "goal-1",
            "task_id": "task-1",
            "backend_type": "codex_app_server",
            "status": "running_turn",
            "thread_id": "thread-1",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "max",
            "current_execution": {
                "execution_id": "execution-1",
                "status": "running",
                "turn_id": "turn-1",
            },
        }
        execution = {
            "execution_id": "execution-1",
            "workspace_id": "workspace-1",
            "task_id": "task-1",
            "status": "running",
            "started_at": timestamp,
            "session_id": "session-1",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
        }
        events = {
            "session_id": "session-1",
            "events": [
                {
                    "sequence": 1,
                    "session_id": "session-1",
                    "execution_id": "execution-1",
                    "thread_id": "thread-1",
                    "timestamp": timestamp,
                    "event_type": "session_started",
                    "payload": {},
                },
                {
                    "sequence": 2,
                    "session_id": "session-1",
                    "execution_id": "execution-1",
                    "thread_id": "thread-1",
                    "timestamp": timestamp,
                    "event_type": "turn_started",
                    "turn_id": "turn-1",
                    "payload": {},
                },
                {
                    "sequence": 3,
                    "session_id": "session-1",
                    "execution_id": "execution-1",
                    "thread_id": "thread-1",
                    "timestamp": timestamp,
                    "event_type": "agent_message_delta",
                    "turn_id": "turn-1",
                    "item_id": "item-1",
                    "payload": {"content": "Hello"},
                },
                {
                    "sequence": 4,
                    "session_id": "session-1",
                    "execution_id": "execution-1",
                    "thread_id": "thread-1",
                    "timestamp": timestamp,
                    "event_type": "turn_completed",
                    "turn_id": "turn-1",
                    "payload": {},
                },
            ],
        }
        summary = {
            "session_id": "session-1",
            "goal_name": "DataProject APC Analysis",
            "task_name": "Analyze APC",
            "updated_at": timestamp,
        }
        return session, execution, events, summary

    def test_status_maps_to_dashboard_view_model(self) -> None:
        session, execution, events, summary = self._payloads()

        view = build_session_view_model(session, execution, events, summary=summary)

        self.assertEqual(view, SessionViewModel(
            goal_name="DataProject APC Analysis",
            task_name="Analyze APC",
            status="running_turn",
            backend_type="codex_app_server",
            model="gpt-5.6-luna",
            reasoning_effort="max",
            session_id="session-1",
            thread_id="thread-1",
            updated_at="2026-09-15T12:34:56+08:00",
            goal_id="goal-1",
            task_id="task-1",
            execution=view.execution,
            events=view.events,
        ))
        self.assertEqual(view.execution_id, "execution-1")
        self.assertEqual(view.current_turn_id, "turn-1")
        self.assertEqual([event.event_type for event in view.events], [
            "session_started",
            "turn_started",
            "agent_message_delta",
            "turn_completed",
        ])
        self.assertEqual(view.events[2].content, "Hello")
        self.assertEqual(view.events[2].display_time,
                         datetime.fromisoformat(view.events[2].timestamp).astimezone().strftime("%H:%M:%S"))

    def test_dashboard_converts_utc_timestamps_to_local_time(self) -> None:
        session, execution, events, summary = self._payloads()
        for timestamp in ("2026-09-17T04:34:19Z", "2026-09-17T20:34:19+00:00",
                          "2026-09-17T12:34:19+08:00"):
            with self.subTest(timestamp=timestamp):
                expected = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone()
                full_time = expected.strftime("%Y-%m-%d %H:%M:%S")
                summary["updated_at"] = timestamp
                execution["started_at"] = execution["finished_at"] = timestamp
                for event in events["events"]:
                    event["timestamp"] = timestamp
                view = build_session_view_model(session, execution, events, summary=summary)
                window = self._window()
                LauncherWindow._render_session_dashboard(window, (view,))
                window.session_table.selectRow(0)
                LauncherWindow._render_selected_session(window)
                self.assertEqual(window.session_table.item(0, 7).text(), full_time)
                self.assertIn(f"updated_at: {full_time}", window.session_details_label.text())
                self.assertIn(f"started_at: {full_time}", window.execution_details_label.text())
                self.assertIn(f"finished_at: {full_time}", window.execution_details_label.text())
                self.assertEqual(window.event_table.item(0, 0).text(), expected.strftime("%H:%M:%S"))
                self.assertEqual(view.updated_at, timestamp)

    def test_empty_dashboard_shows_no_active_sessions(self) -> None:
        window = self._window()

        LauncherWindow._render_session_dashboard(window, ())  # type: ignore[arg-type]

        self.assertEqual(window.session_empty_label.text(), "No active sessions")
        self.assertTrue(window.session_empty_label.isVisible())
        self.assertEqual(window.session_table.rowCount(), 0)
        self.assertFalse(window.open_codex_task_button.isEnabled())

    def test_failed_session_is_visible_with_status_and_event_reason(self) -> None:
        session, execution, events, summary = self._payloads()
        session["status"] = "failed"
        session["current_execution"]["status"] = "failed"
        execution["status"] = "failed"
        execution["finished_at"] = "2026-09-15T12:35:00+08:00"
        events["events"][-1] = {
            **events["events"][-1],
            "event_type": "execution_failed",
            "payload": {"reason": "provider failed"},
        }
        view = build_session_view_model(session, execution, events, summary=summary)
        window = self._window()

        LauncherWindow._render_session_dashboard(window, (view,))  # type: ignore[arg-type]
        window.session_table.selectRow(0)
        LauncherWindow._render_selected_session(window)  # type: ignore[arg-type]

        self.assertEqual(window.session_table.item(0, 1).text(), "failed")
        self.assertEqual(window.event_table.item(3, 1).text(), "execution_failed")
        self.assertEqual(window.event_table.item(3, 2).text(), "provider failed")


if __name__ == "__main__":
    unittest.main()
