"""Minimal checks for launcher-only log actions."""

from __future__ import annotations

import os
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication,
    QLabel,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
)

from config_manager import LauncherConfig
from gui import BUTTON_HEIGHT, BUTTON_WIDTH, LauncherState, LauncherWindow
from status_checker import (
    BrowserReadiness,
    CapabilityStatus,
    CapabilityTimelineEvent,
    DesktopCapabilityStatus,
    DoctorCheckStatus,
    DoctorStatus,
    DesktopSyncStatus,
    LauncherStatus,
    OAuthClientStatus,
    OAuthRegistryStatus,
    SessionViewModel,
    StatusChecker,
    StatusQueryError,
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
            self.assertEqual(window.timer.interval(), 5_000)
            window.timer.stop()
            window.show()
            self.application.processEvents()
            actions = window.start_button.parentWidget()
            overview = actions.parentWidget().layout().itemAt(0).layout()
            self.assertIs(overview.itemAt(0).widget(), actions)
            self.assertEqual(actions.width(), 680 * 3 // 4)
            self.assertEqual(actions.x(), window.launcher_state.parentWidget().x())
            self.assertLess(actions.geometry().bottom(), window.launcher_state.parentWidget().y())
            self.assertTrue(any(label.text() == "浏览器：" for label in window.findChildren(QLabel)))
            self.assertFalse(any(label.text() == "Local Review MCP" for label in window.findChildren(QLabel)))
            for button in window.findChildren(QPushButton) + [window.capability_timeline_toggle, window.session_viewer_toggle]:
                self.assertEqual((button.width(), button.height()), (BUTTON_WIDTH, BUTTON_HEIGHT))
                self.assertEqual(button.font().family(), window.font().family())
                self.assertEqual(button.font().pointSize(), window.font().pointSize())
            connected_desktop = DesktopSyncStatus(
                connected=True,
                current_conversation_id="conversation-1",
                following=True,
                following_threads=("conversation-1",),
                owner_client_id="desktop-1",
                active_source="desktop_ipc",
                association_status="unavailable",
                fallback_reason=None,
            )
            state_before = window.state
            window._render_status(LauncherStatus(
                True, True, True,
                desktop_sync=connected_desktop,
                desktop_capability=DesktopCapabilityStatus(ready=True, pipe_source="handoff", pipe_state="active"),
                capability=CapabilityStatus(
                    state="desktop_failed",
                    source="desktop",
                    reason="desktop_tools_pipe_unavailable",
                    actions=("recheck", "standalone"),
                    execution_id="execution-1",
                    task_id="task-1",
                    actuation_id="actuation-1",
                    error_code="owner_binding_timeout",
                    fallback_deadline_at="2999-09-24T01:00:00.000Z",
                ),
            ))
            window._render_doctor(DoctorStatus(
                "DEGRADED",
                "2026-09-24T01:00:00.000Z",
                (DoctorCheckStatus("Desktop Handoff", "WARN", "desktop_tools_pipe_unavailable", "2026-09-24T01:00:00.000Z"),),
            ))
            self.assertIn("状态：降级（DEGRADED）", window.doctor_status.text())
            self.assertIn("[警告] Desktop Handoff", window.doctor_status.text())
            self.assertIn("desktop_tools_pipe_unavailable", window.doctor_status.text())
            self.assertIn('style="color: #946200">[警告] Desktop Handoff', window.doctor_status.text())
            window._render_doctor(DoctorStatus(
                "READY",
                "2026-09-24T01:00:00.000Z",
                (DoctorCheckStatus("MCP Runtime", "PASS"),),
            ))
            self.assertIn('style="color: #16803c">状态：已就绪（READY）', window.doctor_status.text())
            self.assertIn('style="color: #16803c">[通过] MCP Runtime', window.doctor_status.text())
            window._render_doctor(DoctorStatus())
            self.assertIn("[失败] 诊断 — doctor_unavailable", window.doctor_status.text())
            window._apply_controls(window._last_status)
            self.assertIn("已连接", window.desktop_sync_status.text())
            self.assertIn("模式：自动", window.desktop_sync_status.text())
            self.assertIn("来源：Desktop IPC", window.desktop_sync_status.text())
            self.assertIn("会话：conversation-1", window.desktop_sync_status.text())
            self.assertIn("跟随：是", window.desktop_sync_status.text())
            self.assertIn("Desktop IPC：已连接", window.desktop_sync_status.text())
            self.assertIn("Desktop 身份：已就绪", window.desktop_sync_status.text())
            self.assertIn("Tools Pipe：活动", window.desktop_sync_status.text())
            self.assertIn("能力：pipeSource=handoff", window.desktop_sync_status.text())
            self.assertIn("执行：execution-1", window.capability_status.text())
            self.assertIn("来源：Desktop", window.capability_status.text())
            self.assertIn("状态：Desktop 失败（desktop_failed）", window.capability_status.text())
            self.assertIn("Desktop：失败", window.capability_status.text())
            self.assertIn("错误代码：owner_binding_timeout", window.capability_status.text())
            self.assertIn("等待用户选择", window.capability_status.text())
            self.assertIn("自动备用路径倒计时：", window.capability_status.text())
            self.assertTrue(window.recheck_desktop_button.isEnabled())
            self.assertTrue(window.standalone_button.isEnabled())

            window._render_status(LauncherStatus(
                True,
                True,
                True,
                desktop_sync=connected_desktop,
                capability=CapabilityStatus(state="desktop_pending", source="desktop"),
            ))
            self.assertIn("Desktop：等待中", window.capability_status.text())
            self.assertIn("等待 Desktop 接管", window.capability_status.text())

            window._render_status(LauncherStatus(
                True,
                True,
                True,
                desktop_sync=connected_desktop,
                capability=CapabilityStatus(
                    state="fallback_running",
                    source="standalone",
                    reason="desktop_handoff_timeout",
                    error_code="desktop_handoff_timeout",
                ),
            ))
            self.assertIn("已启用备用路径", window.capability_status.text())
            self.assertIn("提供方：Standalone", window.capability_status.text())
            self.assertIn("Desktop 交接超时", window.capability_status.text())

            window._render_status(LauncherStatus(
                True,
                True,
                True,
                desktop_sync=connected_desktop,
                capability=CapabilityStatus(
                    state="desktop_ready",
                    source="desktop",
                    reason="desktop_binding_recovered",
                    execution_id="execution-1",
                ),
            ))
            self.assertIn("Desktop：已就绪", window.capability_status.text())
            self.assertIn("来源：Desktop", window.capability_status.text())
            self.assertIn("Desktop 绑定已恢复", window.capability_status.text())

            offline_status = LauncherStatus(False, False, False)
            window._render_status(offline_status)
            window._apply_controls(offline_status)
            self.assertIn("状态：不可用（unavailable）", window.capability_status.text())
            self.assertIn("MCP 能力不可用", window.capability_status.text())
            self.assertFalse(window.recheck_desktop_button.isEnabled())
            self.assertFalse(window.standalone_button.isEnabled())

            window._render_status(LauncherStatus(
                True,
                True,
                True,
                desktop_sync=replace(connected_desktop, owner_client_id=None),
                desktop_capability=DesktopCapabilityStatus(pipe_state="pending"),
            ))
            self.assertIn("Desktop 身份：等待激活", window.desktop_sync_status.text())
            self.assertIn("Tools Pipe：等待中", window.desktop_sync_status.text())
            self.assertIn("能力：等待 Desktop 激活", window.desktop_sync_status.text())

            unmatched = replace(connected_desktop, association_status="unmatched")
            window._render_status(LauncherStatus(True, True, True, desktop_sync=unmatched))
            self.assertIn("来源：Desktop IPC", window.desktop_sync_status.text())
            self.assertIn("关联：未匹配", window.desktop_sync_status.text())
            self.assertNotIn("Legacy app-server", window.desktop_sync_status.text())

            conflict = replace(connected_desktop, association_status="conflict")
            window._render_status(LauncherStatus(True, True, True, desktop_sync=conflict))
            self.assertIn("关联：冲突", window.desktop_sync_status.text())

            fallback = DesktopSyncStatus(
                active_source="legacy_app_server",
                association_status="unavailable",
                fallback_reason="desktop_disconnected",
            )
            window._render_status(LauncherStatus(True, True, True, desktop_sync=fallback))
            self.assertEqual(window.desktop_sync_status.text(),
                             "不可用\n模式：自动\n来源：Legacy app-server\n"
                             "原因：Desktop 不可用\n\n"
                             "Desktop IPC：已断开\n"
                             "Desktop 身份：不可用\n"
                             "Tools Pipe：不可用\n"
                             "能力：不可用")

            evidence_unavailable = replace(
                fallback,
                connected=True,
                fallback_reason="desktop_evidence_unavailable",
            )
            window._render_status(LauncherStatus(True, True, True, desktop_sync=evidence_unavailable))
            self.assertIn("来源：Legacy app-server", window.desktop_sync_status.text())
            self.assertIn("原因：Desktop 证据不可用", window.desktop_sync_status.text())

            self.assertEqual(window.state, state_before)
            self.assertTrue(window._last_status.mcp_running)
            window._render_status(LauncherStatus(True, True, True, desktop_sync=DesktopSyncStatus()))
            self.assertEqual(window.desktop_sync_status.text(),
                             "不可用\n模式：自动\n来源：Legacy app-server\n"
                             "原因：Desktop 不可用\n\n"
                             "Desktop IPC：已断开\n"
                             "Desktop 身份：不可用\n"
                             "Tools Pipe：不可用\n"
                             "能力：不可用")
            for state, reason in (("extension_not_paired", "Extension is not paired."),
                                  ("extension_not_present", "Extension is not connected.")):
                browser = BrowserReadiness(False, state, True, state == "extension_not_present", False,
                                           123, reason, "Refresh ChatGPT page / 刷新 ChatGPT 页面")
                window._render_status(LauncherStatus(True, True, True, browser=browser))
                expected_reason = "扩展未配对。" if state == "extension_not_paired" else "扩展未连接。"
                self.assertEqual(window.browser_status.text(), f"未就绪\n原因：{expected_reason}\n操作：刷新 ChatGPT 页面")
            bilingual_action = (
                "Refresh the ChatGPT page and wait for the extension to reconnect. "
                "Reload/更新扩展后，请刷新 ChatGPT 页面并等待扩展重新连接。"
            )
            window._render_status(LauncherStatus(
                True, True, True,
                browser=BrowserReadiness(False, "extension_not_paired", True, False, False, 123,
                                         "Extension is not paired.", bilingual_action),
            ))
            self.assertEqual(
                window.browser_status.text(),
                "未就绪\n原因：扩展未配对。\n操作：请刷新 ChatGPT 页面并等待扩展重新连接。",
            )
            ready = BrowserReadiness(True, "ready", True, True, True, 123, "", "")
            window._render_status(LauncherStatus(True, True, True, browser=ready))
            self.assertEqual(window.browser_status.text(), "已就绪")
            missing = BrowserReadiness(False, "extension_not_present", True, True, False,
                                       123, "Extension is not connected.", "Refresh ChatGPT page")
            with patch("gui.monotonic", return_value=100) as clock:
                window._render_status(LauncherStatus(True, True, True, browser=missing))
                self.assertEqual(window.browser_status.text(), "已就绪")
                self.assertFalse(window._last_status.browser.ready)  # Raw readiness stays authoritative.
                clock.return_value = 114.9
                window._render_status(LauncherStatus(True, True, True, browser=missing))
                self.assertEqual(window.browser_status.text(), "已就绪")
                clock.return_value = 115
                window._render_status(LauncherStatus(True, True, True, browser=missing))
                self.assertTrue(window.browser_status.text().startswith("降级\n原因："))
                self.assertIn("刷新 ChatGPT 页面", window.browser_status.text())
                window._render_status(LauncherStatus(True, True, True, browser=ready))
                self.assertEqual(window.browser_status.text(), "已就绪")
                clock.return_value = 200
                window._render_status(LauncherStatus(True, True, True, browser=missing))
                self.assertEqual(window.browser_status.text(), "已就绪")
                for hard_failure in (BrowserReadiness(), BrowserReadiness(
                    False, "extension_not_paired", True, False, False, None, "Not paired", "Refresh ChatGPT page"
                )):
                    window._render_status(LauncherStatus(True, True, True, browser=ready))
                    window._render_status(LauncherStatus(True, True, True, browser=hard_failure))
                    self.assertTrue(window.browser_status.text().startswith("未就绪"))
                    window._render_status(LauncherStatus(True, True, True, browser=missing))
                    self.assertTrue(window.browser_status.text().startswith("未就绪"))
            first_row = (window.start_button, window.stop_button, window.refresh_button)
            second_row = (window.refresh_oauth_button, window.reset_oauth_button, window.delete_oauth_button)
            for column, (upper, lower) in enumerate(zip(first_row, second_row)):
                self.assertIs(actions.layout().itemAt(0).layout().itemAt(column).widget(), upper)
                self.assertIs(actions.layout().itemAt(1).layout().itemAt(column).widget(), lower)
                self.assertEqual(upper.x(), lower.x())
                self.assertEqual(upper.width(), lower.width())
                self.assertGreater(lower.y(), upper.geometry().bottom())
            initial_x = {button: button.mapTo(window, button.rect().topLeft()).x()
                         for button in window.findChildren(QPushButton) + [window.capability_timeline_toggle, window.session_viewer_toggle]}
            window.resize(window.width() + 400, window.height())
            self.application.processEvents()
            for button, x in initial_x.items():
                self.assertEqual(button.mapTo(window, button.rect().topLeft()).x(), x)

    def test_capability_timeline_renders_state_and_failure_fields(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        self.assertFalse(window.capability_timeline_toggle.isChecked())
        self.assertTrue(window.capability_timeline_content.isHidden())
        window._render_capability_timeline((CapabilityTimelineEvent(
            "2026-09-24T01:00:00.000Z",
            "desktop_pending",
            "desktop_failed",
            "desktop",
            "desktop_handoff_failed",
            "handoff_failed",
            "fallback_waiting",
        ),))

        self.assertEqual(window.capability_timeline_table.rowCount(), 1)
        expected_time = datetime.fromisoformat("2026-09-24T01:00:00.000Z".replace("Z", "+00:00")) \
            .astimezone().strftime("%Y-%m-%d %H:%M:%S")
        self.assertEqual(
            [window.capability_timeline_table.item(0, column).text() for column in range(7)],
            [expected_time, "desktop_pending", "desktop_failed", "desktop",
             "desktop_handoff_failed", "handoff_failed", "fallback_waiting"],
        )
        window._render_capability_timeline(())
        self.assertEqual(window.capability_timeline_table.rowCount(), 0)
        self.assertEqual(window.capability_timeline_empty_label.text(), "暂无最近的能力时间线事件。")

    def test_capability_doctor_has_own_tab_between_startup_and_tasks(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        tabs = window.findChild(QTabWidget)
        self.assertIsNotNone(tabs)
        assert tabs is not None
        self.assertEqual([tabs.tabText(index) for index in range(tabs.count())], [
            "启动信息", "能力诊断", "任务信息",
        ])
        startup = tabs.widget(0)
        capability = tabs.widget(1)
        self.assertIsInstance(capability, QScrollArea)
        self.assertIs(window.capability_scroll_area, capability)
        self.assertTrue(capability.widget().layout().alignment() & Qt.AlignmentFlag.AlignTop)
        self.assertIs(
            capability.widget().layout().itemAt(0).layout().itemAt(0).widget(),
            window.run_doctor_button,
        )
        self.assertNotIn(window.doctor_status, startup.findChildren(QLabel))
        self.assertIn(window.doctor_status, capability.findChildren(QLabel))
        for widget in (
            window.run_doctor_button,
            window.capability_timeline_toggle,
            window.recheck_desktop_button,
            window.standalone_button,
            window.capability_timeline_content,
        ):
            self.assertIn(widget, capability.findChildren(type(widget)))

    def test_save_log_writes_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "launcher.log"
            window = self._window()
            window.log_output.setPlainText("启动完成 ✓")
            with patch("gui.QFileDialog.getSaveFileName", return_value=(str(target), "")):
                LauncherWindow.save_log(window)
            self.assertEqual(target.read_bytes(), "启动完成 ✓".encode("utf-8"))

    def test_task_dashboard_layout_and_event_copy(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        self.assertFalse(window.session_viewer_toggle.isChecked())
        self.assertTrue(window.session_viewer_content.isHidden())
        window.session_viewer_toggle.click()
        self.assertTrue(window.session_viewer_toggle.isChecked())
        self.assertFalse(window.session_viewer_content.isHidden())
        window.session_viewer_toggle.click()
        self.assertTrue(window.session_viewer_content.isHidden())
        self.assertEqual(window.event_table.minimumHeight(), 270)
        self.assertLessEqual(
            window.session_table.maximumHeight(),
            window.session_table.horizontalHeader().sizeHint().height()
            + window.session_table.verticalHeader().defaultSectionSize() * 5
            + 2 * window.session_table.frameWidth(),
        )

        window.event_table.setRowCount(1)
        window.event_table.setItem(0, 2, QTableWidgetItem("完整消息\n第二行"))
        window.event_table.selectRow(0)
        LauncherWindow.copy_event_stream(window)
        self.assertEqual(QApplication.clipboard().text(), "完整消息\n第二行")

    def test_clear_task_cache_hides_terminal_records_but_keeps_active_tasks_visible(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        session = SessionViewModel(
            "Goal", "Task", "completed", "codex_app_server", "model", "max",
            "session-1", "thread-1", "2026-09-18T12:00:00+08:00", "goal-1", "task-1", None, (),
        )
        status = LauncherStatus(True, True, True, sessions=(session,))
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "_request_status_check"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        window._render_status(status)
        self.assertEqual(window.session_table.rowCount(), 1)
        window.clear_task_cache()
        window._render_status(status)
        self.assertEqual(window.session_table.rowCount(), 0)
        self.assertEqual(window._cleared_session_keys, {("session-1", None)})

        active_session = replace(session, status="running_turn")
        new_session = replace(active_session, session_id="session-2", task_id="task-2")
        status_with_active_sessions = LauncherStatus(True, True, True, sessions=(active_session, new_session))

        with patch.object(window, "_request_status_check"), patch.object(window, "_render_runtime_info"):
            window._refresh_status_automatically()
        window._render_status(status_with_active_sessions)
        self.assertEqual(window.session_table.rowCount(), 2)
        self.assertEqual(
            [window.session_table.item(row, 5).text() for row in range(2)],
            ["session-1", "session-2"],
        )

        with patch.object(window, "_request_status_check"), patch.object(window, "_render_runtime_info"):
            window.refresh_button.click()
        window._render_status(status)
        self.assertEqual(window.session_table.rowCount(), 1)

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
        self.assertIn("OAuth 客户端数：1", text)
        self.assertIn("ChatGPT", text)
        self.assertIn("客户端 ID：client-1", text)
        self.assertIn("创建时间：123", text)

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
        self.assertIn("只删除选中的 OAuth 客户端，不影响其他客户端", confirm.call_args.args[2])
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
        self.assertEqual((view.events[2].execution_id, view.events[2].turn_id, view.events[2].item_id),
                         ("execution-1", "turn-1", "item-1"))
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
                self.assertIn(f"更新时间：{full_time}", window.session_details_label.text())
                self.assertIn(f"开始时间：{full_time}", window.execution_details_label.text())
                self.assertIn(f"结束时间：{full_time}", window.execution_details_label.text())
                self.assertEqual(window.event_table.item(0, 0).text(), expected.strftime("%H:%M:%S"))
                self.assertEqual(view.updated_at, timestamp)

    def test_execution_summary_matches_status_schema_and_survives_turn_fallback(self) -> None:
        session, execution, events, summary = self._payloads()
        execution.pop("turn_id")
        for text in ("", "  diagnostic\n", "x" * 4000, "😀" * 2000):
            with self.subTest(text_length=len(text)):
                view = build_session_view_model(session, {**execution, "summary": text}, events)
                self.assertEqual(view.execution.summary, text)
                self.assertEqual(view.execution.turn_id, "turn-1")
        for invalid in (None, 42, False, [], {}, "x" * 4001, "😀" * 2001):
            with self.subTest(invalid_type=type(invalid)), self.assertRaises(StatusQueryError):
                build_session_view_model(session, {**execution, "summary": invalid}, events)
        for payload in (execution, None):
            view = build_session_view_model(session, payload, events)
            self.assertIsNone(view.execution.summary)
            window = self._window()
            window._render_session_dashboard((view,))
            window.session_table.selectRow(0)
            window._render_selected_session()
            self.assertIn("摘要：—", window.execution_details_label.text())

    def test_empty_dashboard_shows_no_active_sessions(self) -> None:
        window = self._window()

        LauncherWindow._render_session_dashboard(window, ())  # type: ignore[arg-type]

        self.assertEqual(window.session_empty_label.text(), "暂无活动会话")
        self.assertTrue(window.session_empty_label.isVisible())
        self.assertEqual(window.session_table.rowCount(), 0)
        self.assertFalse(window.open_codex_task_button.isEnabled())

    def test_failed_session_is_visible_with_status_and_event_reason(self) -> None:
        session, execution, events, summary = self._payloads()
        session["status"] = "failed"
        session["current_execution"]["status"] = "failed"
        execution["status"] = "failed"
        execution["summary"] = "Events could not be saved. [code=EPERM syscall=rename errno=-4048]"
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
        self.assertEqual(view.execution.summary, execution["summary"])
        self.assertIn("摘要：" + execution["summary"], window.execution_details_label.text())
        self.assertEqual(window.event_table.item(3, 1).text(), "execution_failed")
        self.assertEqual(window.event_table.item(3, 2).text(), "provider failed")

    def test_event_stream_identity_completion_boundaries_and_latest_500(self) -> None:
        session, execution, events, summary = self._payloads()
        view = build_session_view_model(session, execution, events, summary=summary)
        window = self._window()
        raw = tuple(replace(view.events[2], sequence=i + 1, event_type=kind, content=content)
                    for i, (kind, content) in enumerate([
                        ("session_started", ""), ("turn_started", ""),
                        *[("agent_message_delta", text) for text in ("L", "RM_", "ID", "ENTITY_PASS")],
                        ("agent_message_completed", " complete"),
                        ("agent_message_delta", "next\nmessage"),
                        ("turn_completed", ""),
                        ("execution_failed", "reason"),
                    ]))
        delta = view.events[2]
        completed = replace(delta, event_type="agent_message_completed", content="EVENT_PASS")
        cases = [
            ("completion closes message", raw, [("session_started", "—"), ("turn_started", "—"),
                   ("agent_message_stream", "LRM_IDENTITY_PASS complete"),
                   ("agent_message_stream", "next\nmessage"),
                   ("turn_completed", "—"),
                   ("execution_failed", "reason")]),
            ("10000 deltas", tuple(replace(delta, sequence=i + 1, content="x") for i in range(10_000)),
             [("agent_message_stream", "x" * 10_000)]),
            ("500 lifecycle rows", tuple(replace(raw[-1], sequence=i + 1, content=str(i)) for i in range(600)),
             [("execution_failed", str(i)) for i in range(100, 600)]),
            ("500 text rows", tuple(replace(delta, sequence=i + 1, item_id=f"item-{i}", content=str(i))
                                    for i in range(600)),
             [("agent_message_stream", str(i)) for i in range(100, 600)]),
            ("same identity", tuple(replace(delta, content=text) for text in ("我", "会", "先")),
             [("agent_message_stream", "我会先")]),
            ("delta plus completed suffix", (delta, completed), [("agent_message_stream", delta.content + "EVENT_PASS")]),
            ("completed alone", (replace(completed, content="完整消息"),), [("agent_message_stream", "完整消息")]),
            ("full deltas plus empty completion", (delta, replace(completed, content="")),
             [("agent_message_stream", delta.content)]),
            ("whitespace", tuple(replace(delta, content=text) for text in ("", " ", "\n", "x", " ")),
             [("agent_message_stream", " \nx ")]),
            ("empty delta", (replace(delta, content=""),), [("agent_message_stream", "")]),
            ("empty events", (), []),
        ]
        for field in ("execution_id", "turn_id", "item_id"):
            for event in (delta, completed):
                cases.append((f"{field} {event.event_type}", (delta, replace(event, **{field: "other"})),
                              [("agent_message_stream", delta.content), ("agent_message_stream", event.content)]))
        for lifecycle in (view.events[0], view.events[1], view.events[-1], raw[-1]):
            for event in (delta, completed):
                cases.append((f"{lifecycle.event_type} {event.event_type}", (delta, lifecycle, event),
                              [("agent_message_stream", delta.content),
                               (lifecycle.event_type, lifecycle.content or "—"),
                               ("agent_message_stream", event.content)]))
        for name, source, expected in cases:
            with self.subTest(case=name):
                source = tuple(replace(event, sequence=i + 1) for i, event in enumerate(source))
                snapshot = tuple(replace(event) for event in source)
                current = replace(view, events=source)
                window._render_session_dashboard((current,))
                window.session_table.selectRow(0)
                window._render_selected_session()
                self.assertEqual(window.event_table.rowCount(), len(expected))
                self.assertEqual([(window.event_table.item(i, 1).text(),
                                   window.event_table.item(i, 2).text())
                                  for i in range(len(expected))], expected)
                window._render_session_dashboard((current,))
                self.assertEqual(window.event_table.rowCount(), len(expected))
                self.assertIs(current.events, source)
                self.assertEqual(current.events, snapshot)
                self.assertEqual(current.execution, view.execution)

    def test_event_identity_is_required_and_foreign_or_unknown_events_are_rejected(self) -> None:
        session, execution, payload, summary = self._payloads()
        delta = payload["events"][2]
        invalid = [{**delta, "event_type": kind} for kind in ("execution_completed", "agent_message_stream", "unknown")]
        invalid.append({**delta, "session_id": "other-session"})
        for kind in ("agent_message_delta", "agent_message_completed"):
            for field in ("execution_id", "turn_id", "item_id"):
                invalid.append({key: value for key, value in {**delta, "event_type": kind}.items() if key != field})
        for event in invalid:
            with self.subTest(event=event), self.assertRaises(StatusQueryError):
                build_session_view_model(session, execution, {**payload, "events": [event]}, summary=summary)

    def test_paginated_text_preserves_whitespace_and_rejects_stalled_or_foreign_pages(self) -> None:
        session, execution, payload, summary = self._payloads()
        delta = payload["events"][2]
        pages = [
            {"session_id": "session-1", "has_more": True, "events": [
                {**delta, "sequence": 1, "payload": {"content": "Hello"}},
                {**delta, "sequence": 2, "payload": {"content": " "}},
            ]},
            {"session_id": "session-1", "has_more": False, "events": [
                {**delta, "sequence": 3, "payload": {"content": "world\n"}},
                {**payload["events"][-1], "sequence": 4},
            ]},
        ]
        checker = StatusChecker(workspace_id="workspace-1")
        with patch.object(checker, "_call_tool", side_effect=pages) as query:
            events = checker._session_events(session)
        self.assertEqual([call.args[1]["after_sequence"] for call in query.call_args_list], [0, 2])
        self.assertTrue(all(call.args[1]["workspace_id"] == "workspace-1" for call in query.call_args_list))
        view = build_session_view_model(session, execution, events, summary=summary)
        window = self._window()
        window._render_session_dashboard((view,))
        window.session_table.selectRow(0)
        window._render_selected_session()
        self.assertEqual(window.event_table.item(0, 2).text(), "Hello world\n")
        self.assertEqual(window.event_table.item(1, 1).text(), "turn_completed")
        self.assertEqual(len(view.events), 4)
        for invalid in (pages[0], {**pages[1], "session_id": "other-session"},
                        {**pages[0], "events": []}):
            with self.subTest(page=invalid), patch.object(checker, "_call_tool", side_effect=[pages[0], invalid]):
                with self.assertRaises(StatusQueryError):
                    checker._session_events(session)


if __name__ == "__main__":
    unittest.main()
