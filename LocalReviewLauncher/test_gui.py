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
    QGridLayout,
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
from gui import (
    BATCH_EVENT_EMPTY_TEXT,
    BUTTON_HEIGHT,
    BUTTON_WIDTH,
    DESKTOP_DOWN_FALLBACK_CAPABILITY_TEXT,
    EXECUTION_DASHBOARD_COLUMNS,
    LauncherState,
    LauncherWindow,
)
from status_checker import (
    BrowserReadiness,
    CapabilityStatus,
    CapabilityTimelineEvent,
    DesktopCapabilityStatus,
    DoctorCheckStatus,
    DoctorStatus,
    DesktopSyncStatus,
    ExecutionViewModel,
    LauncherStatus,
    OAuthClientStatus,
    OAuthRegistryStatus,
    PersistedCleanupResult,
    SessionEventViewModel,
    SessionViewModel,
    StatusChecker,
    StatusQueryError,
    build_execution_view_model,
)


class FakeLocalServer:
    """Injected in place of QLocalServer so C++ class state is never patched."""

    listen = Mock(return_value=True)
    removed: list[str] = []

    def __init__(self) -> None:
        self.newConnection = Mock()

    @staticmethod
    def removeServer(name: str) -> None:
        FakeLocalServer.removed.append(name)

    def close(self) -> None:
        pass

    @classmethod
    def reset(cls) -> None:
        cls.listen = Mock(return_value=True)
        cls.removed = []


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
            self.assertIs(actions.layout().itemAt(0).layout().itemAt(0).widget(), window.start_button)
            self.assertEqual(actions.width(), 680 * 3 // 4)
            self.assertEqual(actions.x(), window.launcher_state.parentWidget().x())
            self.assertLess(actions.geometry().bottom(), window.launcher_state.parentWidget().y())
            startup = window.findChild(QTabWidget).widget(0)
            cards = startup.widget().layout().itemAt(1).layout()
            self.assertIsInstance(cards, QGridLayout)
            self.assertEqual((cards.rowCount(), cards.columnCount()), (4, 3))
            self.assertEqual(cards.count(), 12)
            self.assertEqual(cards.itemAtPosition(1, 1).widget().findChildren(QLabel)[0].text(), "浏览器")
            self.assertEqual(cards.itemAtPosition(1, 2).widget().findChildren(QLabel)[0].text(), "Desktop")
            self.assertEqual(cards.itemAtPosition(2, 0).widget().findChildren(QLabel)[0].text(), "Desktop IPC")
            self.assertEqual(cards.itemAtPosition(3, 0).widget().findChildren(QLabel)[0].text(), "PipeSource")
            self.assertFalse(any(label.text() == "浏览器：" for label in window.findChildren(QLabel)))
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
            for label, text in (
                (window.desktop_ipc_status, "已连接"),
                (window.desktop_identity_status, "已就绪"),
                (window.tools_pipe_status, "活动"),
                (window.pipe_source_status, "handoff"),
            ):
                self.assertEqual(label.text(), text)
                self.assertEqual(label.styleSheet(), "color: #16803c")
            self.assertIn("执行：execution-1", window.capability_status.text())
            self.assertIn("来源：Desktop", window.capability_status.text())
            self.assertIn("状态：Desktop 失败（desktop_failed）", window.capability_status.text())
            self.assertIn("Desktop：失败", window.capability_status.text())
            self.assertIn("错误代码：owner_binding_timeout", window.capability_status.text())
            self.assertIn("Desktop 连接失败，请选择继续等待或使用 Standalone", window.capability_status.text())
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

            # An AFK fallback is reported as the clock having decided it, not as the user, so the
            # two fallback sources stay distinguishable in the launcher.
            window._render_status(LauncherStatus(
                True,
                True,
                True,
                desktop_sync=connected_desktop,
                capability=CapabilityStatus(
                    state="fallback_running",
                    source="standalone",
                    reason="afk_fallback_timeout",
                    error_code="afk_fallback_timeout",
                    execution_id="execution-1",
                ),
            ))
            self.assertIn("用户未操作，已自动切换 Standalone", window.capability_status.text())

            window._render_status(LauncherStatus(
                True,
                True,
                True,
                desktop_sync=connected_desktop,
                capability=CapabilityStatus(
                    state="fallback_running",
                    source="standalone",
                    reason="user_selected_standalone",
                    execution_id="execution-1",
                ),
            ))
            self.assertIn("用户选择了 Standalone", window.capability_status.text())

            offline_status = LauncherStatus(False, False, False)
            window._render_status(offline_status)
            window._apply_controls(offline_status)
            self.assertEqual(window.capability_status.text(), "\n".join([
                "执行：—",
                "来源：—",
                "状态：MCP 已停止",
                "说明：MCP 未运行，无法读取执行能力状态。",
            ]))
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
                self.assertEqual(window.browser_status.text(), "未配对" if state == "extension_not_paired" else "未连接")
            bilingual_action = (
                "Refresh the ChatGPT page and wait for the extension to reconnect. "
                "Reload/更新扩展后，请刷新 ChatGPT 页面并等待扩展重新连接。"
            )
            window._render_status(LauncherStatus(
                True, True, True,
                browser=BrowserReadiness(False, "extension_not_paired", True, False, False, 123,
                                         "Extension is not paired.", bilingual_action),
            ))
            self.assertEqual(window.browser_status.text(), "未配对")
            ready = BrowserReadiness(True, "ready", True, True, True, 123, "", "")
            window._render_status(LauncherStatus(True, True, True, browser=ready))
            self.assertEqual(window.browser_status.text(), "已连接")
            self.assertEqual(window.browser_status.styleSheet(), "color: #16803c")
            # Raw readiness is authoritative: the very refresh that reports a lost extension must
            # drop the green 已连接, with no GUI-side grace keeping the old state visible.
            for degraded, label, color in (
                (BrowserReadiness(False, "extension_not_present", True, True, False, 123,
                                  "Extension is not connected.", "Refresh ChatGPT page"),
                 "未连接", "color: #946200"),
                (BrowserReadiness(False, "extension_not_paired", True, False, False, 123,
                                  "Extension is not paired.", "Refresh ChatGPT page"),
                 "未配对", "color: #946200"),
                (BrowserReadiness(), "不可用", "color: #666666"),
            ):
                window._render_status(LauncherStatus(True, True, True, browser=degraded))
                self.assertEqual(window.browser_status.text(), label)
                self.assertEqual(window.browser_status.styleSheet(), color)
                self.assertFalse(window._last_status.browser.ready)
                window._render_status(LauncherStatus(True, True, True, browser=ready))
                self.assertEqual(window.browser_status.text(), "已连接")
                self.assertEqual(window.browser_status.styleSheet(), "color: #16803c")
            initial_x = {button: button.mapTo(window, button.rect().topLeft()).x()
                         for button in window.findChildren(QPushButton) + [window.capability_timeline_toggle, window.session_viewer_toggle]}
            window.resize(window.width() + 400, window.height())
            self.application.processEvents()
            for button, x in initial_x.items():
                self.assertEqual(button.mapTo(window, button.rect().topLeft()).x(), x)

    def test_capability_status_distinguishes_idle_from_a_stopped_runtime(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        window._render_status(LauncherStatus(True, True, True))
        idle = window.capability_status.text()
        self.assertEqual(idle, "\n".join([
            "执行：—",
            "来源：—",
            "状态：当前空闲",
            "说明：当前没有活动的执行任务。",
        ]))
        self.assertNotIn("unavailable", idle)

        window._render_status(LauncherStatus(False, False, False))
        stopped = window.capability_status.text()
        self.assertNotEqual(stopped, idle)
        self.assertIn("状态：MCP 已停止", stopped)
        self.assertNotIn("当前空闲", stopped)

        window._render_status(LauncherStatus(
            True,
            True,
            True,
            capability=CapabilityStatus(state="initializing"),
        ))
        self.assertIn("状态：初始化中（initializing）", window.capability_status.text())
        window._render_status(LauncherStatus(
            True,
            True,
            True,
            capability=CapabilityStatus(
                state="desktop_ready", source="desktop", execution_id="execution-1",
            ),
        ))
        self.assertIn("执行：execution-1", window.capability_status.text())
        self.assertIn("状态：Desktop 已就绪（desktop_ready）", window.capability_status.text())

    def test_live_desktop_summary_is_independent_of_execution_negotiation(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        for state, reason in (
            ("fallback_running", "afk_fallback_timeout"),
            ("fallback_ready", "standalone_execution_failed"),
            ("desktop_failed", "desktop_execution_failed"),
        ):
            with self.subTest(state=state):
                window._render_status(LauncherStatus(
                    True, True, True,
                    desktop_capability=DesktopCapabilityStatus(True, "handoff", "active"),
                    capability=CapabilityStatus(
                        state=state, source="desktop" if state == "desktop_failed" else "standalone",
                        reason=reason, execution_id="old-execution",
                    ),
                ))
                self.assertEqual(window.execution_summary_status.text(), "Desktop 前置能力就绪，可优先尝试")
                self.assertIn("#16803c", window.execution_summary_status.styleSheet())
                self.assertIn("Execution capability negotiation", window.capability_status.text())
                self.assertIn("执行：old-execution", window.capability_status.text())
                self.assertIn(state, window.capability_status.text())
                self.assertEqual(window.tools_pipe_status.text(), "活动")
                self.assertEqual(window.pipe_source_status.text(), "handoff")
                if reason == "desktop_execution_failed":
                    self.assertIn("本次 Execution 已失败", window.capability_status.text())
                    self.assertIn("请人工处理", window.capability_status.text())
                    self.assertNotIn("请选择继续等待", window.capability_status.text())
                    self.assertNotIn("备用后端仍可执行", window.capability_status.text())
                    self.assertFalse(window.recheck_desktop_button.isEnabled())
                    self.assertFalse(window.standalone_button.isEnabled())

        for capability, text in (
            (DesktopCapabilityStatus(), "Desktop 前置能力未就绪"),
            (DesktopCapabilityStatus(pipe_state="pending"), "Desktop 前置能力建立中"),
        ):
            window._render_status(LauncherStatus(
                True, True, True, desktop_capability=capability,
                capability=CapabilityStatus(state="desktop_ready", source="desktop", execution_id="old-execution"),
            ))
            self.assertEqual(window.execution_summary_status.text(), text)
        window._render_status(LauncherStatus(False, False, False))
        self.assertEqual(window.execution_summary_status.text(), "MCP 已停止")

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
            window.execution_table.maximumHeight(),
            window.execution_table.horizontalHeader().sizeHint().height()
            + window.execution_table.verticalHeader().defaultSectionSize() * 5
            + 2 * window.execution_table.frameWidth(),
        )

        window.event_table.setRowCount(1)
        window.event_table.setItem(0, 2, QTableWidgetItem("完整消息\n第二行"))
        window.event_table.selectRow(0)
        LauncherWindow.copy_event_stream(window)
        self.assertEqual(QApplication.clipboard().text(), "完整消息\n第二行")

    def test_clear_task_cache_hides_terminal_records_but_keeps_active_tasks_visible(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        execution = ExecutionViewModel(
            execution_id="execution-1",
            name="Goal",
            mode="batch",
            backend="cli",
            status="passed",
            workspace_id="workspace-1",
            task_id="task-1",
        )
        status = LauncherStatus(True, True, True, executions=(execution,))
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "_request_status_check"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        window._render_status(status)
        self.assertEqual(window.execution_table.rowCount(), 1)
        window.clear_task_cache()
        window._render_status(status)
        self.assertEqual(window.execution_table.rowCount(), 0)
        self.assertEqual(window._cleared_execution_ids, {"execution-1"})

        active_execution = replace(execution, status="running")
        new_execution = replace(active_execution, execution_id="execution-2", task_id="task-2")
        status_with_active = LauncherStatus(
            True, True, True, executions=(active_execution, new_execution)
        )

        with patch.object(window, "_request_status_check"), patch.object(window, "_render_runtime_info"):
            window._refresh_status_automatically()
        window._render_status(status_with_active)
        self.assertEqual(window.execution_table.rowCount(), 2)

        with patch.object(window, "_request_status_check"), patch.object(window, "_render_runtime_info"):
            window.refresh_button.click()
        window._render_status(status)
        self.assertEqual(window.execution_table.rowCount(), 1)

    def test_persisted_cleanup_reports_actual_record_counts(self) -> None:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        checker = Mock()
        checker.clear_persisted_task_records.return_value = PersistedCleanupResult(2, 1, 3, 1)
        with patch("gui.ProductionProcessManager") as process, patch(
            "gui.StatusChecker", return_value=checker
        ), patch.object(LauncherWindow, "_request_status_check"), patch.object(
            LauncherWindow, "_render_runtime_info"
        ):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
            self.addCleanup(window.close)

        window._last_status = LauncherStatus(True, True, True)
        with patch(
            "gui.QMessageBox.question",
            return_value=QMessageBox.StandardButton.Yes,
        ), patch.object(window, "refresh_status"):
            window.clear_persisted_task_records()

        checker.clear_persisted_task_records.assert_called_once_with()
        self.assertEqual(
            window.message_label.text(),
            "已清理 Execution 2 条、Session 1 条、Event 3 条、Task 1 条。",
        )

    def test_clear_log_only_clears_display(self) -> None:
        window = self._window()
        process_log = Mock(return_value="actual process log")
        window.process_manager = SimpleNamespace(get_output=process_log)
        window.log_output.setPlainText("displayed log")

        LauncherWindow.clear_log(window)

        self.assertEqual(window.log_output.toPlainText(), "")
        process_log.assert_not_called()

    def test_render_oauth_status_shows_summary_only(self) -> None:
        window = SimpleNamespace(oauth_status_label=QLabel())
        status = OAuthRegistryStatus(
            "oauth/clients.json",
            True,
            1,
            (OAuthClientStatus("client-1", "ChatGPT", 123),),
        )

        LauncherWindow._render_oauth_status(window, status)  # type: ignore[arg-type]

        text = window.oauth_status_label.text()
        self.assertEqual(text, "正常")
        self.assertNotIn("client-1", text)

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


class LauncherLayoutAcceptanceTests(unittest.TestCase):
    """Locks the information-architecture contract of the three tabs."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

    def _window(self, config: LauncherConfig | None = None) -> LauncherWindow:
        manager = Mock()
        manager.load.return_value = config or LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
        window.timer.stop()
        self.addCleanup(window.close)
        return window

    @staticmethod
    def _label_texts(window: LauncherWindow) -> list[str]:
        return [label.text() for label in window.findChildren(QLabel)]

    @staticmethod
    def _button_texts(window: LauncherWindow) -> list[str]:
        return [button.text() for button in window.findChildren(QPushButton)]

    def test_status_cards_pin_twelve_positions_in_four_by_three_grid(self) -> None:
        window = self._window()
        startup = window.findChild(QTabWidget).widget(0)
        cards = startup.widget().layout().itemAt(1).layout()
        self.assertIsInstance(cards, QGridLayout)
        self.assertEqual((cards.rowCount(), cards.columnCount()), (4, 3))
        self.assertEqual(cards.count(), 12)
        expected = (
            (0, 0, "启动器状态"),
            (0, 1, "MCP 运行时"),
            (0, 2, "Cloudflare 隧道"),
            (1, 0, "远程端点"),
            (1, 1, "浏览器"),
            (1, 2, "Desktop"),
            (2, 0, "Desktop IPC"),
            (2, 1, "Desktop 身份"),
            (2, 2, "Tools Pipe"),
            (3, 0, "PipeSource"),
            (3, 1, "当前 Desktop 能力"),
            (3, 2, "OAuth"),
        )
        for row, column, title in expected:
            card = cards.itemAtPosition(row, column).widget()
            labels = card.findChildren(QLabel)
            self.assertEqual(labels[0].text(), title, f"card {row},{column}")
            self.assertEqual(len(labels), 2, f"card {row},{column} must show title + value only")
            self.assertFalse(card.findChildren(QPushButton), f"card {row},{column} must hold no button")
        self.assertEqual(cards.itemAtPosition(0, 0).widget(), cards.itemAtPosition(0, 0).widget())
        self.assertEqual(cards.columnStretch(0), cards.columnStretch(1))
        self.assertEqual(cards.columnStretch(1), cards.columnStretch(2))

    def test_workspace_registry_columns_and_default_marker(self) -> None:
        config = LauncherConfig("", "config.production.json", False)
        config = replace(
            config,
            active_workspace_id="ws-default",
            workspaces=(
                SimpleNamespace(id="ws-default", name="主仓库", path="C:/repo"),
                SimpleNamespace(id="ws-other", name="副仓库", path="C:/other"),
            ),
        )
        window = self._window(config)
        table = window.workspace_table
        self.assertEqual(table.columnCount(), 4)
        self.assertEqual(
            [table.horizontalHeaderItem(c).text() for c in range(4)],
            ["默认", "工作区 ID", "名称", "路径"],
        )
        window._render_workspace_registry()
        self.assertEqual(table.item(0, 0).text(), "✓")
        self.assertEqual(table.item(1, 0).text(), "")
        self.assertIn("设为默认", self._button_texts(window))
        self.assertNotIn("设为当前", self._button_texts(window))
        self.assertIn(
            "默认工作区仅用于未指定 workspace_id 的调用，不限制其他工作区执行。",
            self._label_texts(window),
        )

    def test_start_blocks_when_registered_workspace_directory_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as existing:
            config = replace(
                LauncherConfig(existing, "config.production.json", False),
                active_workspace_id="ws-live",
                workspaces=(
                    SimpleNamespace(id="ws-live", name="在用仓库", path=existing),
                    SimpleNamespace(id="ws-gone", name="Jev", path=str(Path(existing) / "Jev")),
                ),
            )
            window = self._window(config)
            with patch.object(LauncherWindow, "_show_error") as show_error, patch.object(
                window.process_manager, "start"
            ) as start:
                window.start_mcp()
            start.assert_not_called()
            show_error.assert_called_once()
            message = show_error.call_args.args[0]
            self.assertIn("Jev", message)
            self.assertIn(str(Path(existing) / "Jev"), message)

    def test_removed_runtime_information_is_absent(self) -> None:
        window = self._window()
        labels = self._label_texts(window)
        for removed in ("运行信息", "工作区：", "生产配置：", "隧道模式：", "cloudflared 版本："):
            self.assertNotIn(removed, labels)

    def test_task_tab_uses_thread_info_and_query_workspace(self) -> None:
        window = self._window()
        texts = self._label_texts(window)
        self.assertIn("任务列表范围：", texts)
        self.assertIn("所有已注册工作区", texts)
        self.assertIn("默认工作区：", texts)
        self.assertIn("线程信息", texts)
        self.assertIn("Execution Dashboard", texts)
        self.assertIn("维护", texts)
        self.assertNotIn("会话所属工作区：", texts)
        self.assertNotIn("打开 Codex 任务", self._button_texts(window))
        self.assertIn("线程信息", self._button_texts(window))

    def test_thread_info_dialog_shows_ids_only(self) -> None:
        window = self._window()
        execution = ExecutionViewModel(
            execution_id="execution-1",
            name="Goal",
            mode="interactive",
            backend="desktop_codex_app",
            status="running",
            workspace_id="workspace-1",
            task_id="task-1",
            session=SessionViewModel(
                session_id="session-1",
                thread_id="thread-1",
                backend_type="desktop_codex_app",
            ),
        )
        with patch("gui.QMessageBox.information") as information:
            window._selected_execution = Mock(return_value=execution)  # type: ignore[method-assign]
            window.open_codex_task()
        title, message = information.call_args.args[1], information.call_args.args[2]
        self.assertEqual(title, "线程信息")
        self.assertIn("线程 ID：thread-1", message)
        self.assertIn("会话 ID：session-1", message)
        self.assertNotIn("Codex Desktop", message)

    def test_thread_info_dialog_stays_closed_without_a_desktop_thread(self) -> None:
        window = self._window()
        app_server = ExecutionViewModel(
            execution_id="execution-2",
            name="Goal",
            mode="interactive",
            backend="codex_app_server",
            status="running",
            workspace_id="workspace-1",
            task_id="task-2",
            session=SessionViewModel(
                session_id="session-2",
                thread_id="thread-2",
                backend_type="codex_app_server",
            ),
        )
        for execution in (None, app_server, replace(app_server, session=None)):
            with self.subTest(execution=execution), patch(
                "gui.QMessageBox.information"
            ) as information:
                window._selected_execution = Mock(return_value=execution)  # type: ignore[method-assign]
                window.open_codex_task()
                information.assert_not_called()

    def test_runtime_log_section_renamed(self) -> None:
        window = self._window()
        self.assertIn("运行日志", self._label_texts(window))
        self.assertNotIn("启动日志", self._label_texts(window))
        for action in ("复制日志", "清空显示", "保存日志"):
            self.assertIn(action, self._button_texts(window))

    def test_user_visible_workspace_wording_stays_unambiguous(self) -> None:
        window = self._window()
        for ambiguous in ("当前工作区", "当前 Workspace", "设为当前"):
            for text in self._label_texts(window) + self._button_texts(window):
                self.assertNotIn(ambiguous, text)


class LauncherDashboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

    @staticmethod
    def _window():
        window = LauncherWindow.__new__(LauncherWindow)
        window.execution_table = QTableWidget(0, len(EXECUTION_DASHBOARD_COLUMNS))
        window.execution_empty_label = QLabel("暂无执行记录")
        window.session_details_label = QLabel()
        window.execution_details_label = QLabel()
        window.event_table = QTableWidget(0, 3)
        window.event_empty_label = QLabel(BATCH_EVENT_EMPTY_TEXT)
        window.open_codex_task_button = QPushButton()
        window._execution_view_models = ()
        return window

    @staticmethod
    def _batch_summary() -> dict:
        timestamp = "2026-09-15T12:34:56+08:00"
        return {
            "execution_id": "execution-batch",
            "workspace_id": "workspace-1",
            "task_id": "task-batch",
            "goal_id": "goal-batch",
            "name": "PCA WebUI",
            "goal_name": "PCA WebUI",
            "task_name": "Add the chart",
            "execution_mode": "batch",
            "backend": "cli",
            "status": "passed",
            "started_at": timestamp,
            "finished_at": timestamp,
            "summary": "Batch finished",
        }

    @staticmethod
    def _interactive_summary() -> dict:
        timestamp = "2026-09-15T12:34:56+08:00"
        return {
            "execution_id": "execution-1",
            "workspace_id": "workspace-1",
            "task_id": "task-1",
            "goal_id": "goal-1",
            "name": "DataProject APC Analysis",
            "goal_name": "DataProject APC Analysis",
            "task_name": "Analyze APC",
            "execution_mode": "interactive",
            "backend": "desktop_codex_app",
            "backend_type": "desktop_codex_app",
            "status": "running",
            "started_at": timestamp,
            "session_id": "session-1",
            "thread_id": "thread-1",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "max",
            "updated_at": timestamp,
        }

    @staticmethod
    def _events() -> dict:
        timestamp = "2026-09-15T12:34:56+08:00"
        return {
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

    def test_execution_summary_maps_to_the_execution_view_model(self) -> None:
        view = build_execution_view_model(self._interactive_summary(), self._events())

        self.assertEqual(view, ExecutionViewModel(
            execution_id="execution-1",
            name="DataProject APC Analysis",
            mode="interactive",
            backend="desktop_codex_app",
            status="running",
            workspace_id="workspace-1",
            task_id="task-1",
            goal_id="goal-1",
            goal_name="DataProject APC Analysis",
            task_name="Analyze APC",
            started_at="2026-09-15T12:34:56+08:00",
            session=view.session,
            events=view.events,
        ))
        self.assertEqual(view.session, SessionViewModel(
            session_id="session-1",
            thread_id="thread-1",
            backend_type="desktop_codex_app",
            model="gpt-5.6-luna",
            reasoning_effort="max",
            updated_at="2026-09-15T12:34:56+08:00",
        ))
        self.assertEqual(view.session_id, "session-1")
        self.assertEqual(view.thread_id, "thread-1")
        self.assertEqual(view.backend_label, "Desktop")
        self.assertTrue(view.can_open_codex_task)
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
        for timestamp in ("2026-09-17T04:34:19Z", "2026-09-17T20:34:19+00:00",
                          "2026-09-17T12:34:19+08:00"):
            with self.subTest(timestamp=timestamp):
                expected = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone()
                full_time = expected.strftime("%Y-%m-%d %H:%M:%S")
                summary = {
                    **self._interactive_summary(),
                    "started_at": timestamp,
                    "finished_at": timestamp,
                    "updated_at": timestamp,
                }
                payload = {
                    "session_id": "session-1",
                    "events": [
                        {**event, "timestamp": timestamp} for event in self._events()["events"]
                    ],
                }
                view = build_execution_view_model(summary, payload)
                window = self._window()
                LauncherWindow._render_execution_dashboard(window, (view,))
                window.execution_table.selectRow(0)
                LauncherWindow._render_selected_execution(window)
                self.assertEqual(window.execution_table.item(0, 5).text(), full_time)
                self.assertEqual(window.execution_table.item(0, 6).text(), full_time)
                self.assertIn(f"开始时间：{full_time}", window.execution_details_label.text())
                self.assertIn(f"结束时间：{full_time}", window.execution_details_label.text())
                self.assertIn(f"更新时间：{full_time}", window.session_details_label.text())
                self.assertEqual(window.event_table.item(0, 0).text(), expected.strftime("%H:%M:%S"))
                self.assertEqual(view.session.updated_at, timestamp)

    def test_failed_execution_detail_preserves_provider_summary(self) -> None:
        summary = "create_thread failed: Project unavailable"
        view = build_execution_view_model({
            **self._interactive_summary(), "status": "failed", "summary": summary,
        })
        window = self._window()
        window._render_execution_dashboard((view,))
        window.execution_table.selectRow(0)
        window._render_selected_execution()
        self.assertIn(f"摘要：{summary}", window.execution_details_label.text())

    def test_execution_summary_contract_keeps_the_dash_placeholder(self) -> None:
        summary = self._interactive_summary()
        for text in ("", "  diagnostic\n", "x" * 4000, "😀" * 2000):
            with self.subTest(text_length=len(text)):
                self.assertEqual(
                    build_execution_view_model({**summary, "summary": text}).summary, text
                )
        for invalid in (None, 42, False, [], {}, "x" * 4001, "😀" * 2001):
            with self.subTest(invalid_type=type(invalid)), self.assertRaises(StatusQueryError):
                build_execution_view_model({**summary, "summary": invalid})
        view = build_execution_view_model(summary)
        self.assertIsNone(view.summary)
        window = self._window()
        window._render_execution_dashboard((view,))
        window.execution_table.selectRow(0)
        window._render_selected_execution()
        self.assertIn("摘要：—", window.execution_details_label.text())

    def test_unknown_mode_and_backend_keep_the_dash_placeholder(self) -> None:
        view = build_execution_view_model({
            "execution_id": "execution-orphan",
            "workspace_id": "workspace-1",
            "task_id": "task-orphan",
            "name": "task-orphan",
            "task_name": "task-orphan",
            "status": "running",
            "started_at": "2026-09-15T12:34:56+08:00",
        })

        self.assertEqual((view.mode, view.display_mode), (None, "—"))
        self.assertEqual((view.backend, view.backend_label), (None, "—"))
        self.assertEqual((view.goal_id, view.session), (None, None))
        self.assertFalse(view.can_open_codex_task)

    def test_thread_locator_requires_a_desktop_interactive_execution(self) -> None:
        batch_with_session = build_execution_view_model({
            **self._interactive_summary(),
            "execution_mode": "batch",
        })

        self.assertEqual(batch_with_session.backend, "desktop_codex_app")
        self.assertFalse(batch_with_session.can_open_codex_task)

    def test_empty_dashboard_shows_no_executions(self) -> None:
        window = self._window()

        LauncherWindow._render_execution_dashboard(window, ())  # type: ignore[arg-type]

        self.assertEqual(window.execution_empty_label.text(), "暂无执行记录")
        self.assertTrue(window.execution_empty_label.isVisible())
        self.assertEqual(window.execution_table.rowCount(), 0)
        self.assertFalse(window.open_codex_task_button.isEnabled())
        self.assertFalse(window.event_empty_label.isVisible())

    def test_failed_execution_is_visible_with_status_and_event_reason(self) -> None:
        failure = "Events could not be saved. [code=EPERM syscall=rename errno=-4048]"
        summary = {
            **self._interactive_summary(),
            "status": "failed",
            "finished_at": "2026-09-15T12:35:00+08:00",
            "summary": failure,
        }
        payload = self._events()
        payload["events"][-1] = {
            **payload["events"][-1],
            "event_type": "execution_failed",
            "payload": {"reason": "provider failed"},
        }
        view = build_execution_view_model(summary, payload)
        window = self._window()

        LauncherWindow._render_execution_dashboard(window, (view,))  # type: ignore[arg-type]
        window.execution_table.selectRow(0)
        LauncherWindow._render_selected_execution(window)  # type: ignore[arg-type]

        self.assertEqual(window.execution_table.item(0, 3).text(), "failed")
        self.assertEqual(view.summary, failure)
        self.assertIn("摘要：" + failure, window.execution_details_label.text())
        self.assertEqual(window.event_table.item(3, 1).text(), "execution_failed")
        self.assertEqual(window.event_table.item(3, 2).text(), "provider failed")

    def test_batch_row_keeps_open_codex_task_disabled_and_shows_the_empty_event_state(self) -> None:
        view = build_execution_view_model(self._batch_summary())
        window = self._window()

        window._render_execution_dashboard((view,))
        window.execution_table.selectRow(0)
        window._render_selected_execution()

        self.assertEqual(window.execution_table.item(0, 1).text(), "batch")
        self.assertEqual(window.execution_table.item(0, 2).text(), "CLI Batch")
        self.assertEqual(window.execution_table.item(0, 3).text(), "passed")
        self.assertEqual(window.execution_table.item(0, 4).text(), "workspace-1")
        self.assertIn("模式：batch", window.execution_details_label.text())
        self.assertIn("后端：CLI Batch（cli）", window.execution_details_label.text())
        self.assertIn("摘要：Batch finished", window.execution_details_label.text())
        self.assertEqual(window.session_details_label.text(), "Session：—\nThread：—")
        self.assertFalse(window.open_codex_task_button.isEnabled())
        self.assertEqual(window.event_table.rowCount(), 0)
        self.assertEqual(window.event_empty_label.text(), "暂无执行事件")
        self.assertTrue(window.event_empty_label.isVisible())

    def test_batch_without_readable_events_shows_the_temporary_empty_state(self) -> None:
        view = build_execution_view_model(self._batch_summary())
        window = self._window()

        window._render_execution_dashboard((view,))
        window.execution_table.selectRow(0)
        window._render_selected_execution()

        self.assertEqual(window.session_details_label.text(), "Session：—\nThread：—")
        self.assertEqual(window.event_table.rowCount(), 0)
        self.assertEqual(window.event_empty_label.text(), "暂无执行事件")
        self.assertTrue(window.event_empty_label.isVisible())

    def test_batch_execution_events_use_the_shared_stream_table_without_a_session(self) -> None:
        timestamp = "2026-09-15T12:34:56+08:00"
        events = (
            SessionEventViewModel(1, timestamp, "execution_started", "", "execution-batch"),
            SessionEventViewModel(2, timestamp, "agent_message", "partial response", "execution-batch"),
            SessionEventViewModel(3, timestamp, "command_started", "Command started.", "execution-batch"),
        )
        view = build_execution_view_model(self._batch_summary(), execution_events=events)
        window = self._window()

        window._render_execution_dashboard((view,))
        window.execution_table.selectRow(0)
        window._render_selected_execution()

        self.assertEqual(window.session_details_label.text(), "Session：—\nThread：—")
        self.assertEqual(window.event_table.rowCount(), 3)
        self.assertEqual(window.event_table.item(1, 1).text(), "agent_message")
        self.assertEqual(window.event_table.item(1, 2).text(), "partial response")
        self.assertFalse(window.event_empty_label.isVisible())

    def test_dashboard_keeps_batch_and_interactive_rows_selectable_in_one_table(self) -> None:
        batch = build_execution_view_model(self._batch_summary())
        interactive = build_execution_view_model(self._interactive_summary(), self._events())
        window = self._window()

        window._render_execution_dashboard((batch, interactive))

        self.assertEqual(window.execution_table.rowCount(), 2)
        self.assertEqual(
            [(window.execution_table.item(row, 1).text(),
              window.execution_table.item(row, 2).text()) for row in range(2)],
            [("batch", "CLI Batch"), ("interactive", "Desktop")],
        )
        self.assertFalse(window.execution_empty_label.isVisible())
        self.assertFalse(window.open_codex_task_button.isEnabled())
        self.assertEqual(window.event_table.rowCount(), 0)

        # The interactive row keeps the Session details, the Codex Task locator, and its stream.
        window.execution_table.selectRow(1)
        window._render_selected_execution()
        self.assertEqual(window._selected_execution().execution_id, "execution-1")
        self.assertEqual(window.session_details_label.text().splitlines(), [
            "Session：session-1",
            "Thread：thread-1",
            "Model：gpt-5.6-luna",
            "Reasoning：max",
            "更新时间：" + LauncherWindow._format_timestamp("2026-09-15T12:34:56+08:00"),
        ])
        self.assertTrue(window.open_codex_task_button.isEnabled())
        self.assertFalse(window.event_empty_label.isVisible())
        self.assertEqual(window.event_table.rowCount(), 4)
        self.assertIn("模式：interactive", window.execution_details_label.text())
        self.assertIn("后端：Desktop（desktop_codex_app）", window.execution_details_label.text())

        window.execution_table.selectRow(0)
        window._render_selected_execution()
        self.assertEqual(window._selected_execution().execution_id, "execution-batch")
        self.assertFalse(window.open_codex_task_button.isEnabled())
        self.assertEqual(window.event_table.rowCount(), 0)
        self.assertTrue(window.event_empty_label.isVisible())

    def test_event_stream_identity_completion_boundaries_and_latest_500(self) -> None:
        view = build_execution_view_model(self._interactive_summary(), self._events())
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
                window._render_execution_dashboard((current,))
                window.execution_table.selectRow(0)
                window._render_selected_execution()
                self.assertEqual(window.event_table.rowCount(), len(expected))
                self.assertEqual([(window.event_table.item(i, 1).text(),
                                   window.event_table.item(i, 2).text())
                                  for i in range(len(expected))], expected)
                window._render_execution_dashboard((current,))
                self.assertEqual(window.event_table.rowCount(), len(expected))
                self.assertIs(current.events, source)
                self.assertEqual(current.events, snapshot)
                self.assertEqual(current.session, view.session)

    def test_event_identity_is_required_and_foreign_or_unknown_events_are_rejected(self) -> None:
        summary = self._interactive_summary()
        payload = self._events()
        delta = payload["events"][2]
        invalid = [{**delta, "event_type": kind} for kind in ("execution_completed", "agent_message_stream", "unknown")]
        invalid.append({**delta, "session_id": "other-session"})
        for kind in ("agent_message_delta", "agent_message_completed"):
            for field in ("execution_id", "turn_id", "item_id"):
                invalid.append({key: value for key, value in {**delta, "event_type": kind}.items() if key != field})
        for event in invalid:
            with self.subTest(event=event), self.assertRaises(StatusQueryError):
                build_execution_view_model(summary, {**payload, "events": [event]})

    def test_paginated_text_preserves_whitespace_and_rejects_stalled_or_foreign_pages(self) -> None:
        summary = self._interactive_summary()
        payload = self._events()
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
            events = checker._session_events("session-1", "thread-1")
        self.assertEqual([call.args[1]["after_sequence"] for call in query.call_args_list], [0, 2])
        self.assertTrue(all(call.args[1]["workspace_id"] == "workspace-1" for call in query.call_args_list))
        view = build_execution_view_model(summary, events)
        window = self._window()
        window._render_execution_dashboard((view,))
        window.execution_table.selectRow(0)
        window._render_selected_execution()
        self.assertEqual(window.event_table.item(0, 2).text(), "Hello world\n")
        self.assertEqual(window.event_table.item(1, 1).text(), "turn_completed")
        self.assertEqual(len(view.events), 4)
        for invalid in (pages[0], {**pages[1], "session_id": "other-session"},
                        {**pages[0], "events": []}):
            with self.subTest(page=invalid), patch.object(checker, "_call_tool", side_effect=[pages[0], invalid]):
                with self.assertRaises(StatusQueryError):
                    checker._session_events("session-1", "thread-1")


class SingleInstanceAndTrayTests(unittest.TestCase):
    """Locks the single-instance handshake and the minimize-to-tray contract."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

    def _window(self) -> LauncherWindow:
        manager = Mock()
        manager.load.return_value = LauncherConfig("", "config.production.json", False)
        with patch("gui.ProductionProcessManager") as process, patch("gui.StatusChecker"), patch.object(
            LauncherWindow, "refresh_status"
        ), patch.object(LauncherWindow, "_render_runtime_info"):
            process.return_value.has_started = False
            window = LauncherWindow(Path.cwd(), manager)
        window.timer.stop()
        self.addCleanup(window.close)
        return window

    def test_change_event_hides_window_when_minimized_and_tray_present(self) -> None:
        window = self._window()
        window.tray_icon = Mock()
        window.show()
        self.application.processEvents()
        window.setWindowState(window.windowState() | Qt.WindowState.WindowMinimized)
        self.application.processEvents()
        self.assertFalse(window.isVisible())

    def test_change_event_keeps_window_visible_without_tray(self) -> None:
        window = self._window()
        window.tray_icon = None
        window.show()
        self.application.processEvents()
        window.setWindowState(window.windowState() | Qt.WindowState.WindowMinimized)
        self.application.processEvents()
        self.assertTrue(window.isVisible())
        self.assertTrue(window.isMinimized())

    def test_show_and_activate_restores_normal_state(self) -> None:
        window = self._window()
        window.show()
        self.application.processEvents()
        window.setWindowState(window.windowState() | Qt.WindowState.WindowMinimized)
        self.application.processEvents()
        window.tray_icon = None
        window.show_and_activate()
        self.application.processEvents()
        self.assertTrue(window.isVisible())
        self.assertFalse(window.isMinimized())

    def test_tray_menu_only_offers_show_and_quit(self) -> None:
        window = self._window()
        with patch("gui.QSystemTrayIcon.isSystemTrayAvailable", return_value=True):
            window._setup_tray_icon()
        self.addCleanup(self._destroy_tray, window)
        self.assertEqual([action.text() for action in window.tray_menu.actions()], ["显示 Launcher", "退出 Launcher"])

    @staticmethod
    def _destroy_tray(window: LauncherWindow) -> None:
        if window.tray_icon is not None:
            window.tray_icon.hide()
            window.tray_icon = None

    def test_close_destroys_tray_icon(self) -> None:
        window = self._window()
        window.tray_icon = Mock()
        window.close()
        self.assertIsNone(window.tray_icon)


class SingleInstanceServerTests(unittest.TestCase):
    """Locks the launcher.py handshake: first instance listens, second instance defers."""

    def test_second_instance_sends_activation_and_defers_window_creation(self) -> None:
        import launcher

        # A live peer is served by a stub socket here on purpose: the requester
        # blocks on waitForReadyRead(), so driving a real responder from the same
        # thread would deadlock. ActivationHandshakeTests covers both protocol
        # sides, and the real-socket path is exercised by the launcher itself.
        FakeLocalServer.reset()
        socket = _StubSocket(writes=8, acks=[b"ok"])
        with patch.object(launcher, "QLocalSocket", return_value=socket):
            with patch.object(launcher, "QLocalServer", FakeLocalServer):
                self.assertIsNone(launcher._create_single_instance_server(lambda: None))
        self.assertEqual(bytes(socket.written), b"activate")
        self.assertEqual(FakeLocalServer.removed, [])
        FakeLocalServer.listen.assert_not_called()
        FakeLocalServer.reset()

    def test_stale_endpoint_is_reclaimed_after_failed_connect(self) -> None:
        import launcher

        QApplication.instance() or QApplication([])
        fake = FakeLocalServer
        with patch.object(launcher, "_send_activation_request", return_value=False) as send:
            with patch.object(launcher, "QLocalServer", fake):
                self.assertIsNotNone(launcher._create_single_instance_server(lambda: None))
        self.assertEqual(fake.listen.call_count, 1)
        self.assertEqual(fake.removed, [launcher.INSTANCE_NAME])
        self.assertEqual(send.call_count, 1)
        fake.reset()


class _StubSocket:
    """Minimal QLocalSocket stand-in so each handshake branch is deterministic."""

    def __init__(
        self,
        *,
        connects=True,
        writes=0,
        acks=(),
        flush_ok=True,
        bytes_written=True,
        pending_after_write=0,
        prebuffered=False,
    ) -> None:
        self._connects = connects
        self._write_result = writes
        self._acks = [bytes(ack) for ack in acks]
        self._flush_ok = flush_ok
        self._bytes_written = bytes_written
        self._pending_after_write = pending_after_write
        # prebuffered: bytes are already in the buffer and no new readyRead
        # will ever fire, so waitForReadyRead() must not be relied upon.
        self._prebuffered = prebuffered
        self.ready_read_calls = 0
        self.written = bytearray()
        self.connected_to: str | None = None
        self.aborted = False
        self.disconnected = False
        self._pending = 0
        self.delete_later = False

    def connectToServer(self, name: str) -> None:
        self.connected_to = name

    def waitForConnected(self, _timeout: int) -> bool:
        return self._connects

    def write(self, payload: bytes) -> int:
        self.written += payload
        return self._write_result

    def flush(self) -> bool:
        return self._flush_ok

    def bytesToWrite(self) -> int:
        return self._pending_after_write

    def waitForBytesWritten(self, _timeout: int) -> bool:
        self._pending = 0
        return self._bytes_written

    def bytesAvailable(self) -> int:
        return sum(len(ack) for ack in self._acks)

    def waitForReadyRead(self, _timeout: int) -> bool:
        self.ready_read_calls += 1
        if self._prebuffered:
            return False
        return bool(self._acks)

    def readAll(self) -> bytearray:
        return bytearray(self._acks.pop(0))

    def abort(self) -> None:
        self.aborted = True

    def disconnectFromServer(self) -> None:
        self.disconnected = True

    def deleteLater(self) -> None:
        self.delete_later = True


class ActivationHandshakeTests(unittest.TestCase):
    """Locks the requester/server sides of the activate/ok protocol."""

    def setUp(self) -> None:
        import launcher

        self.launcher = launcher
        QApplication.instance() or QApplication([])

    def _request(self, **stub_kwargs) -> tuple[bool, _StubSocket]:
        socket = _StubSocket(**stub_kwargs)
        with patch.object(self.launcher, "QLocalSocket", return_value=socket):
            return self.launcher._send_activation_request(), socket

    def test_activate_then_ok_returns_true(self) -> None:
        result, socket = self._request(writes=8, acks=[b"ok"])
        self.assertTrue(result)
        self.assertEqual(bytes(socket.written), b"activate")
        self.assertFalse(socket.aborted)
        self.assertTrue(socket.disconnected)

    def test_connect_failure_returns_false(self) -> None:
        result, socket = self._request(connects=False, writes=8, acks=[b"ok"])
        self.assertFalse(result)
        self.assertTrue(socket.aborted)
        self.assertEqual(bytes(socket.written), b"")

    def test_missing_ack_times_out_to_false(self) -> None:
        result, socket = self._request(writes=8, acks=[])
        self.assertFalse(result)
        self.assertTrue(socket.aborted)

    def test_wrong_ack_returns_false(self) -> None:
        for wrong in (b"", b"no", b"okay", b"nope"):
            with self.subTest(ack=wrong):
                result, _ = self._request(writes=8, acks=[wrong])
                self.assertFalse(result)

    def test_partial_ack_then_timeout_returns_false(self) -> None:
        result, _ = self._request(writes=8, acks=[b"o"])
        self.assertFalse(result)

    def test_partial_ack_then_completion_returns_true(self) -> None:
        result, _ = self._request(writes=8, acks=[b"o", b"k"])
        self.assertTrue(result)

    def test_write_failure_returns_false(self) -> None:
        result, _ = self._request(writes=3, acks=[b"ok"])
        self.assertFalse(result)

    def test_flush_failure_returns_false(self) -> None:
        result, _ = self._request(writes=8, flush_ok=False, acks=[b"ok"])
        self.assertFalse(result)

    def test_pending_bytes_that_never_flush_return_false(self) -> None:
        socket = _StubSocket(writes=8, acks=[b"ok"], bytes_written=False, pending_after_write=8)
        with patch.object(self.launcher, "QLocalSocket", return_value=socket):
            self.assertFalse(self.launcher._send_activation_request())

    def test_server_activates_once_and_answers_ok(self) -> None:
        socket = _StubSocket(writes=2, acks=[b"activate"])
        calls: list[str] = []
        self.launcher._read_activation_request(socket, lambda: calls.append("activate"))
        self.assertEqual(calls, ["activate"])
        self.assertEqual(bytes(socket.written), b"ok")
        self.assertTrue(socket.disconnected)
        self.assertTrue(socket.delete_later)

    def test_server_accepts_fragmented_activation(self) -> None:
        for fragments in ([b"acti", b"vate"], [b"a", b"c", b"t", b"i", b"v", b"a", b"t", b"e"]):
            with self.subTest(fragments=fragments):
                socket = _StubSocket(writes=2, acks=fragments)
                calls: list[str] = []
                self.launcher._read_activation_request(socket, lambda: calls.append("activate"))
                self.assertEqual(calls, ["activate"])
                self.assertEqual(bytes(socket.written), b"ok")
                self.assertTrue(socket.disconnected)
                self.assertTrue(socket.delete_later)

    def test_server_ignores_non_activation_messages(self) -> None:
        for message in (b"", b"nope", b"activate activate", b"deactivate", b" activate ", b"\nactivate\n", b"activate "):
            with self.subTest(message=message):
                socket = _StubSocket(writes=2, acks=[message])
                calls: list[str] = []
                self.launcher._read_activation_request(socket, lambda: calls.append("activate"))
                self.assertEqual(calls, [])
                self.assertEqual(bytes(socket.written), b"")
                self.assertTrue(socket.disconnected)
                self.assertTrue(socket.delete_later)

    def test_server_rejects_incomplete_or_silent_message(self) -> None:
        for fragments in ([], [b"acti"], [b"a"]):
            with self.subTest(fragments=fragments):
                socket = _StubSocket(writes=2, acks=fragments)
                calls: list[str] = []
                self.launcher._read_activation_request(socket, lambda: calls.append("activate"))
                self.assertEqual(calls, [])
                self.assertEqual(bytes(socket.written), b"")
                self.assertTrue(socket.disconnected)
                self.assertTrue(socket.delete_later)

    def test_server_cleans_up_when_ack_write_fails(self) -> None:
        socket = _StubSocket(writes=0, acks=[b"activate"])
        calls: list[str] = []
        self.launcher._read_activation_request(socket, lambda: calls.append("activate"))
        self.assertEqual(calls, ["activate"])
        self.assertTrue(socket.disconnected)
        self.assertTrue(socket.delete_later)

    def test_ack_already_buffered_needs_no_new_ready_read(self) -> None:
        socket = _StubSocket(writes=8, acks=[b"ok"], prebuffered=True)
        self.assertEqual(socket.bytesAvailable(), 2)
        with patch.object(self.launcher, "QLocalSocket", return_value=socket):
            self.assertTrue(self.launcher._send_activation_request())
        self.assertEqual(socket.ready_read_calls, 0)

    def test_activation_already_buffered_needs_no_new_ready_read(self) -> None:
        socket = _StubSocket(writes=2, acks=[b"activate"], prebuffered=True)
        self.assertEqual(socket.bytesAvailable(), 8)
        calls: list[str] = []
        self.launcher._read_activation_request(socket, lambda: calls.append("activate"))
        self.assertEqual(calls, ["activate"])
        self.assertEqual(bytes(socket.written), b"ok")
        self.assertEqual(socket.ready_read_calls, 0)
        self.assertTrue(socket.disconnected)
        self.assertTrue(socket.delete_later)

    def test_buffered_prefix_then_fragmented_completion(self) -> None:
        socket = _StubSocket(writes=2, acks=[b"acti", b"vate"])
        calls: list[str] = []
        self.launcher._read_activation_request(socket, lambda: calls.append("activate"))
        self.assertEqual(calls, ["activate"])
        self.assertEqual(bytes(socket.written), b"ok")
        self.assertTrue(socket.disconnected)
        self.assertTrue(socket.delete_later)

    def test_successful_handshake_never_removes_live_server(self) -> None:
        FakeLocalServer.reset()
        with patch.object(self.launcher, "_send_activation_request", return_value=True):
            with patch.object(self.launcher, "QLocalServer", FakeLocalServer):
                self.assertIsNone(self.launcher._create_single_instance_server(lambda: None))
        self.assertEqual(FakeLocalServer.removed, [])
        FakeLocalServer.listen.assert_not_called()
        FakeLocalServer.reset()


if __name__ == "__main__":
    unittest.main()
