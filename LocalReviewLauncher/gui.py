"""PySide6 user interface for the Local Review MCP launcher."""

from __future__ import annotations

import os
from collections import deque
from dataclasses import replace
from datetime import datetime
from enum import Enum
from html import escape
from itertools import groupby
from math import ceil
from pathlib import Path
from time import monotonic

from PySide6.QtCore import QThreadPool, QTimer, Qt, Slot
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QInputDialog,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from config_manager import (
    DEFAULT_REMOTE_ENDPOINT,
    ConfigManager,
    LauncherConfig,
    LauncherConfigError,
)
from process_manager import ProductionProcessManager
from status_checker import (
    CapabilityStatus,
    CapabilityTimelineEvent,
    DoctorStatus,
    DesktopCapabilityStatus,
    DesktopSyncStatus,
    LauncherStatus,
    OAuthRegistryStatus,
    SessionViewModel,
    StatusChecker,
)
from status_worker import (
    CapabilityTimelineCheckWorker,
    DoctorCheckWorker,
    StatusCheckScheduler,
    StatusCheckWorker,
)


STARTUP_TIMEOUT_SECONDS = 60
STARTUP_POLL_INTERVAL_MS = 2_000
BROWSER_PRESENCE_GRACE_SECONDS = 15
MAX_EVENT_STREAM_ROWS = 500
MAX_DASHBOARD_ROWS = 5
CAPABILITY_TIMELINE_LIMIT = 100
EVENT_STREAM_MIN_HEIGHT = 270
CLEARED_TERMINAL_SESSION_STATUSES = frozenset({"completed", "failed", "terminated"})
BUTTON_WIDTH = 136
BUTTON_HEIGHT = 34
BUTTON_SPACING = 6
CONTENT_MARGIN = 16
CONTENT_SPACING = 10
ROW_LABEL_WIDTH = 132


class LauncherState(str, Enum):
    STOPPED = "Stopped"
    STARTING = "Starting"
    RUNNING = "Running"
    STOPPING = "Stopping"
    FAILED = "Failed"


class LauncherWindow(QMainWindow):
    def __init__(self, project_root: Path, config_manager: ConfigManager):
        super().__init__()
        self.config_manager = config_manager
        self.configuration: LauncherConfig = config_manager.load()
        self.process_manager = ProductionProcessManager(project_root, config_manager)
        self.status_checker = StatusChecker(
            auth_token=config_manager.auth_token(self.configuration),
            workspace_id=self.configuration.active_workspace_id,
        )
        self.state = LauncherState.STOPPED
        self._last_status = LauncherStatus(False, False, False)
        self._browser_was_ready = False
        self._browser_missing_since: float | None = None
        self._status_check_scheduler = StatusCheckScheduler()
        self._status_check_generation = 0
        self._cleared_session_keys: set[tuple[str, str | None]] = set()
        self._status_thread_pool = QThreadPool(self)
        self._status_thread_pool.setMaxThreadCount(1)
        self._closing = False
        self._startup_started_at: float | None = None

        self.setWindowTitle("Local Review MCP 启动器")
        self.setMinimumSize(740, 520)
        launcher_font = QFont("Microsoft YaHei UI", 9)
        launcher_font.setStyleHint(QFont.StyleHint.SansSerif)
        self.setFont(launcher_font)
        self.launcher_state = QLabel()
        self.mcp_status = QLabel()
        self.tunnel_status = QLabel()
        self.remote_status = QLabel()
        self.browser_status = QLabel("未就绪")
        self.browser_status.setWordWrap(True)
        self.browser_status.setTextFormat(Qt.TextFormat.PlainText)
        self.desktop_sync_status = QLabel("不可用")
        self.desktop_sync_status.setWordWrap(True)
        self.desktop_sync_status.setTextFormat(Qt.TextFormat.PlainText)
        self.capability_status = QLabel("不可用")
        self.capability_status.setWordWrap(True)
        self.capability_status.setTextFormat(Qt.TextFormat.PlainText)
        self.doctor_status = QLabel("未运行")
        self.doctor_status.setWordWrap(True)
        self.doctor_status.setTextFormat(Qt.TextFormat.RichText)
        self.capability_timeline_toggle = QToolButton()
        self.capability_timeline_toggle.setText("能力时间线")
        self.capability_timeline_toggle.setCheckable(True)
        self.capability_timeline_refresh_button = QPushButton("刷新时间线")
        self.capability_timeline_table = QTableWidget(0, 7)
        self.capability_timeline_table.setHorizontalHeaderLabels([
            "时间",
            "之前状态",
            "当前状态",
            "来源",
            "原因",
            "错误代码",
            "事件",
        ])
        self.capability_timeline_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.capability_timeline_table.horizontalHeader().setStretchLastSection(True)
        self.capability_timeline_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.capability_timeline_table.setMinimumHeight(160)
        self.capability_timeline_table.setMaximumHeight(280)
        self.capability_timeline_empty_label = QLabel("暂无最近的能力时间线事件。")
        self.capability_timeline_empty_label.setWordWrap(True)
        self.capability_timeline_content = QWidget()
        timeline_layout = QVBoxLayout(self.capability_timeline_content)
        timeline_layout.setContentsMargins(0, 0, 0, 0)
        timeline_toolbar = QHBoxLayout()
        timeline_toolbar.setSpacing(BUTTON_SPACING)
        timeline_toolbar.setAlignment(Qt.AlignmentFlag.AlignLeft)
        timeline_toolbar.addWidget(self.capability_timeline_refresh_button)
        timeline_layout.addLayout(timeline_toolbar)
        timeline_layout.addWidget(self.capability_timeline_table)
        timeline_layout.addWidget(self.capability_timeline_empty_label)
        self._capability_timeline_loading = False
        self.oauth_status_label = QLabel("不可用")
        self.oauth_status_label.setWordWrap(True)
        self.workspace_label = QLabel()
        self.workspace_label.setWordWrap(True)
        self.runtime_workspace_label = QLabel()
        self.runtime_workspace_label.setWordWrap(True)
        self.production_config_label = QLabel()
        self.production_config_label.setWordWrap(True)
        self.tunnel_mode_label = QLabel()
        self.remote_endpoint_label = QLabel()
        self.remote_endpoint_label.setWordWrap(True)
        self.cloudflared_version_label = QLabel("不可用")
        self.workspace_table = QTableWidget(0, 3)
        self.workspace_table.setHorizontalHeaderLabels(["工作区 ID", "名称", "路径"])
        self.workspace_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.workspace_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.workspace_table.horizontalHeader().setStretchLastSection(True)
        self.workspace_table.setMinimumHeight(120)
        self.session_table = QTableWidget(0, 8)
        self.session_table.setHorizontalHeaderLabels([
            "目标 / 任务",
            "状态",
            "后端",
            "模型",
            "推理",
            "会话 ID",
            "线程 ID",
            "更新时间",
        ])
        self.session_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.session_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.session_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.session_table.horizontalHeader().setStretchLastSection(True)
        self.session_table.setMinimumHeight(160)
        self.session_table.setMaximumHeight(
            self.session_table.horizontalHeader().sizeHint().height()
            + self.session_table.verticalHeader().defaultSectionSize() * MAX_DASHBOARD_ROWS
            + 2 * self.session_table.frameWidth()
        )
        self.session_empty_label = QLabel("暂无活动会话")
        self.session_details_label = QLabel("请选择会话查看详情。")
        self.session_details_label.setWordWrap(True)
        self.execution_details_label = QLabel("执行：—")
        self.execution_details_label.setWordWrap(True)
        self.event_table = QTableWidget(0, 3)
        self.event_table.setHorizontalHeaderLabels(["时间", "事件类型", "内容"])
        self.event_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.event_table.horizontalHeader().setStretchLastSection(True)
        self.event_table.setMinimumHeight(EVENT_STREAM_MIN_HEIGHT)
        self.event_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectItems)
        self.event_table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.event_table.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self._session_view_models: tuple[SessionViewModel, ...] = ()
        self.message_label = QLabel()
        self.message_label.setWordWrap(True)
        self.log_output = QPlainTextEdit()
        self.log_output.setReadOnly(True)
        self.log_output.setMinimumHeight(240)
        self.log_output.setMaximumHeight(300)

        self.start_button = QPushButton("启动 MCP")
        self.stop_button = QPushButton("停止 MCP")
        self.refresh_button = QPushButton("刷新状态")
        self.recheck_desktop_button = QPushButton("重试 Desktop")
        self.standalone_button = QPushButton("使用 Standalone")
        self.run_doctor_button = QPushButton("运行诊断")
        self.capability_timeline_toggle.setEnabled(False)
        self.capability_timeline_refresh_button.setEnabled(False)
        self.recheck_desktop_button.setEnabled(False)
        self.standalone_button.setEnabled(False)
        self.run_doctor_button.setEnabled(False)
        self.refresh_oauth_button = QPushButton("刷新 OAuth 状态")
        self.reset_oauth_button = QPushButton("重置 OAuth 客户端")
        self.delete_oauth_button = QPushButton("删除 OAuth 客户端")
        self.delete_oauth_button.setEnabled(False)
        self.clear_task_cache_button = QPushButton("清理界面缓存")
        self.clear_persisted_task_button = QPushButton("清理持久化任务记录")
        self.clear_persisted_task_button.setEnabled(False)
        self.workspace_button = QPushButton("添加工作区")
        self.delete_workspace_button = QPushButton("删除工作区")
        self.rename_workspace_button = QPushButton("编辑名称")
        self.set_current_workspace_button = QPushButton("设为当前")
        self.open_config_button = QPushButton("打开配置文件")
        self.backup_config_button = QPushButton("备份配置")
        self.validate_config_button = QPushButton("校验配置")
        self.open_codex_task_button = QPushButton("打开 Codex 任务")
        self.open_codex_task_button.setEnabled(False)
        self.copy_log_button = QPushButton("复制日志")
        self.clear_log_button = QPushButton("清空显示")
        self.save_log_button = QPushButton("保存日志")
        self.start_button.clicked.connect(self.start_mcp)
        self.stop_button.clicked.connect(self.stop_mcp)
        self.refresh_button.clicked.connect(self.refresh_status)
        self.recheck_desktop_button.clicked.connect(self.recheck_desktop_capability)
        self.standalone_button.clicked.connect(self.select_standalone_capability)
        self.run_doctor_button.clicked.connect(self.run_doctor)
        self.capability_timeline_toggle.toggled.connect(self._set_capability_timeline_expanded)
        self.capability_timeline_refresh_button.clicked.connect(self.refresh_capability_timeline)
        self.refresh_oauth_button.clicked.connect(self.refresh_oauth_status)
        self.reset_oauth_button.clicked.connect(self.reset_oauth_clients)
        self.delete_oauth_button.clicked.connect(self.delete_oauth_client)
        self.clear_task_cache_button.clicked.connect(self.clear_task_cache)
        self.clear_persisted_task_button.clicked.connect(self.clear_persisted_task_records)
        self.workspace_button.clicked.connect(self.choose_workspace)
        self.delete_workspace_button.clicked.connect(self.delete_workspace)
        self.rename_workspace_button.clicked.connect(self.rename_workspace)
        self.set_current_workspace_button.clicked.connect(self.set_current_workspace)
        self.open_config_button.clicked.connect(self.open_config)
        self.backup_config_button.clicked.connect(self.backup_config)
        self.validate_config_button.clicked.connect(self.validate_config)
        self.open_codex_task_button.clicked.connect(self.open_codex_task)
        self.session_table.itemSelectionChanged.connect(self._render_selected_session)
        self.event_table.addAction(self._copy_event_stream_action())
        self.copy_log_button.clicked.connect(self.copy_log)
        self.clear_log_button.clicked.connect(self.clear_log)
        self.save_log_button.clicked.connect(self.save_log)

        startup_layout = QVBoxLayout()
        startup_layout.setContentsMargins(CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN)
        startup_layout.setSpacing(CONTENT_SPACING)
        startup_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        overview_layout = QVBoxLayout()
        overview_layout.setContentsMargins(0, 0, 0, 0)
        overview_layout.setSpacing(8)
        overview_layout.addWidget(self._row("启动器状态：", self.launcher_state))
        overview_layout.addWidget(self._row("MCP 运行时：", self.mcp_status))
        overview_layout.addWidget(self._row("Cloudflare 隧道：", self.tunnel_status))
        overview_layout.addWidget(self._row("远程端点：", self.remote_status))
        overview_layout.addWidget(self._row("浏览器：", self.browser_status))
        overview_layout.addWidget(self._row("Desktop 同步：", self.desktop_sync_status))
        overview_layout.addWidget(self._row("执行能力：", self.capability_status))
        overview_layout.addWidget(self._row("OAuth 状态：", self.oauth_status_label))
        overview_layout.addWidget(self._row("工作区：", self.workspace_label))
        top_actions = QWidget()
        top_actions.setFixedWidth(510)
        top_actions_layout = QVBoxLayout(top_actions)
        top_actions_layout.setContentsMargins(0, 0, 0, 0)
        top_actions_layout.setSpacing(BUTTON_SPACING)
        control_buttons = QHBoxLayout()
        control_buttons.setSpacing(BUTTON_SPACING)
        control_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        control_buttons.addWidget(self.start_button)
        control_buttons.addWidget(self.stop_button)
        control_buttons.addWidget(self.refresh_button)
        top_actions_layout.addLayout(control_buttons)
        oauth_buttons = QHBoxLayout()
        oauth_buttons.setSpacing(BUTTON_SPACING)
        oauth_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        oauth_buttons.addWidget(self.refresh_oauth_button)
        oauth_buttons.addWidget(self.reset_oauth_button)
        oauth_buttons.addWidget(self.delete_oauth_button)
        top_actions_layout.addLayout(oauth_buttons)
        overview_layout.insertWidget(0, top_actions, 0, Qt.AlignmentFlag.AlignLeft)
        startup_layout.addLayout(overview_layout)
        startup_layout.addSpacing(6)
        startup_layout.addWidget(self._section_title("工作区注册表"))
        startup_layout.addWidget(self.workspace_table)
        workspace_buttons = QHBoxLayout()
        workspace_buttons.setSpacing(BUTTON_SPACING)
        workspace_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        workspace_buttons.addWidget(self.workspace_button)
        workspace_buttons.addWidget(self.delete_workspace_button)
        workspace_buttons.addWidget(self.rename_workspace_button)
        workspace_buttons.addWidget(self.set_current_workspace_button)
        startup_layout.addLayout(workspace_buttons)
        startup_layout.addSpacing(6)
        startup_layout.addWidget(self._section_title("运行信息"))
        startup_layout.addWidget(self._row("工作区：", self.runtime_workspace_label))
        startup_layout.addWidget(self._row("生产配置：", self.production_config_label))
        startup_layout.addWidget(self._row("隧道模式：", self.tunnel_mode_label))
        startup_layout.addWidget(self._row("远程端点：", self.remote_endpoint_label))
        startup_layout.addWidget(self._row("cloudflared 版本：", self.cloudflared_version_label))
        startup_layout.addSpacing(6)
        startup_layout.addWidget(self._section_title("配置"))
        config_buttons = QHBoxLayout()
        config_buttons.setSpacing(BUTTON_SPACING)
        config_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        config_buttons.addWidget(self.open_config_button)
        config_buttons.addWidget(self.backup_config_button)
        config_buttons.addWidget(self.validate_config_button)
        startup_layout.addLayout(config_buttons)
        startup_layout.addWidget(self.message_label)
        startup_layout.addWidget(QLabel("启动日志："))
        startup_layout.addWidget(self.log_output)
        log_buttons = QHBoxLayout()
        log_buttons.setSpacing(BUTTON_SPACING)
        log_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        log_buttons.addWidget(self.copy_log_button)
        log_buttons.addWidget(self.clear_log_button)
        log_buttons.addWidget(self.save_log_button)
        startup_layout.addLayout(log_buttons)

        capability_layout = QVBoxLayout()
        capability_layout.setContentsMargins(CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN)
        capability_layout.setSpacing(CONTENT_SPACING)
        capability_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        capability_buttons = QHBoxLayout()
        capability_buttons.setSpacing(BUTTON_SPACING)
        capability_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        capability_buttons.addWidget(self.run_doctor_button)
        capability_buttons.addWidget(self.capability_timeline_toggle)
        capability_buttons.addWidget(self.recheck_desktop_button)
        capability_buttons.addWidget(self.standalone_button)
        capability_layout.addLayout(capability_buttons)
        capability_layout.addWidget(self._section_title("当前诊断状态"))
        capability_layout.addWidget(self._row("诊断状态：", self.doctor_status))
        capability_layout.addWidget(self.capability_timeline_content)

        task_layout = QVBoxLayout()
        task_layout.setContentsMargins(CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN)
        task_layout.setSpacing(CONTENT_SPACING)
        task_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        task_layout.addWidget(self._section_title("任务面板"))
        task_toolbar = QHBoxLayout()
        task_toolbar.setSpacing(BUTTON_SPACING)
        task_toolbar.setAlignment(Qt.AlignmentFlag.AlignLeft)
        task_toolbar.addWidget(self.clear_task_cache_button)
        task_toolbar.addWidget(self.clear_persisted_task_button)
        task_layout.addLayout(task_toolbar)
        task_layout.addWidget(self.session_table)
        task_layout.addWidget(self.session_empty_label)
        task_layout.addWidget(self.open_codex_task_button)
        self.session_viewer_toggle = QToolButton()
        self.session_viewer_toggle.setText("会话查看器")
        self.session_viewer_toggle.setCheckable(True)
        self.session_viewer_toggle.toggled.connect(self._set_session_viewer_expanded)
        self.session_viewer_content = QWidget()
        session_viewer_layout = QVBoxLayout(self.session_viewer_content)
        session_viewer_layout.setContentsMargins(0, 0, 0, 0)
        session_viewer_layout.addWidget(self.session_details_label)
        session_viewer_layout.addWidget(self.execution_details_label)
        task_layout.addWidget(self.session_viewer_toggle)
        task_layout.addWidget(self.session_viewer_content)
        task_layout.addWidget(self._section_title("事件流"))
        task_layout.addWidget(self.event_table)
        self._set_session_viewer_expanded(False)
        self._set_capability_timeline_expanded(False)

        for button in (
            self.start_button,
            self.stop_button,
            self.refresh_button,
            self.recheck_desktop_button,
            self.standalone_button,
            self.run_doctor_button,
            self.capability_timeline_toggle,
            self.capability_timeline_refresh_button,
            self.refresh_oauth_button,
            self.reset_oauth_button,
            self.delete_oauth_button,
            self.clear_task_cache_button,
            self.clear_persisted_task_button,
            self.workspace_button,
            self.delete_workspace_button,
            self.rename_workspace_button,
            self.set_current_workspace_button,
            self.open_config_button,
            self.backup_config_button,
            self.validate_config_button,
            self.open_codex_task_button,
            self.copy_log_button,
            self.clear_log_button,
            self.save_log_button,
            self.session_viewer_toggle,
        ):
            button.setFixedSize(BUTTON_WIDTH, BUTTON_HEIGHT)

        startup_container = QWidget()
        startup_container.setLayout(startup_layout)
        startup_scroll_area = QScrollArea()
        startup_scroll_area.setWidgetResizable(True)
        startup_scroll_area.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        startup_scroll_area.setWidget(startup_container)

        capability_container = QWidget()
        capability_container.setLayout(capability_layout)
        capability_scroll_area = QScrollArea()
        capability_scroll_area.setWidgetResizable(True)
        capability_scroll_area.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        capability_scroll_area.setWidget(capability_container)
        self.capability_scroll_area = capability_scroll_area

        task_container = QWidget()
        task_container.setLayout(task_layout)
        task_scroll_area = QScrollArea()
        task_scroll_area.setWidgetResizable(True)
        task_scroll_area.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        task_scroll_area.setWidget(task_container)

        tabs = QTabWidget()
        tabs.addTab(startup_scroll_area, "启动信息")
        tabs.addTab(capability_scroll_area, "能力诊断")
        tabs.addTab(task_scroll_area, "任务信息")
        self.setCentralWidget(tabs)
        self.resize(820, 680)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._refresh_status_automatically)
        self.timer.start(5_000)
        self.capability_countdown_timer = QTimer(self)
        self.capability_countdown_timer.setInterval(1_000)
        self.capability_countdown_timer.timeout.connect(self._refresh_capability_countdown)
        self.capability_countdown_timer.start()
        self.startup_timer = QTimer(self)
        self.startup_timer.setInterval(STARTUP_POLL_INTERVAL_MS)
        self.startup_timer.timeout.connect(self._poll_startup)
        self._set_state(LauncherState.STOPPED)
        self._render_workspace_registry()
        self._render_session_dashboard(())
        self._render_runtime_info()
        self.refresh_status()
        if self.configuration.auto_start:
            QTimer.singleShot(0, self.start_mcp)

    @staticmethod
    def _section_title(text: str) -> QLabel:
        label = QLabel(text)
        label.setStyleSheet("font-weight: 600;")
        return label

    @staticmethod
    def _row(name: str, value: QLabel) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setAlignment(Qt.AlignmentFlag.AlignTop)
        label = QLabel(name)
        label.setFixedWidth(ROW_LABEL_WIDTH)
        layout.addWidget(label, 0, Qt.AlignmentFlag.AlignTop)
        layout.addWidget(value, 1, Qt.AlignmentFlag.AlignTop)
        return row

    def refresh_status(self) -> None:
        self._refresh_status(restore_task_cache=True)

    def _refresh_status(self, restore_task_cache: bool) -> None:
        if self.state == LauncherState.STARTING:
            return
        if restore_task_cache:
            self._cleared_session_keys.clear()
        self._render_runtime_info()
        self._request_status_check("normal")

    def _refresh_status_automatically(self) -> None:
        self._refresh_status(restore_task_cache=False)

    def refresh_oauth_status(self) -> None:
        self.refresh_status()

    def _request_status_check(self, source: str) -> None:
        if self._closing or not self._status_check_scheduler.begin(source):
            return
        generation = self._status_check_generation
        worker = StatusCheckWorker(self.status_checker, generation)
        worker.signals.finished.connect(self._status_check_finished)
        self._status_thread_pool.start(worker)

    @Slot(int, object)
    def _status_check_finished(self, generation: int, status: LauncherStatus) -> None:
        source = self._status_check_scheduler.finish()
        if self._closing or source is None or generation != self._status_check_generation:
            return
        self._render_status(status)
        self._update_log()
        if source == "startup":
            self._handle_startup_status(status)
        self._apply_controls(status)

    def _render_status(self, status: LauncherStatus) -> None:
        sessions = tuple(
            session
            for session in getattr(status, "sessions", ())
            if (
                (session.session_id, session.execution_id) not in self._cleared_session_keys
                or session.status not in CLEARED_TERMINAL_SESSION_STATUSES
            )
        )
        self._last_status = replace(status, sessions=sessions)
        self._set_status(self.mcp_status, "运行中" if status.mcp_running else "已停止", status.mcp_running)
        self._set_status(self.tunnel_status, "已连接" if status.tunnel_connected else "离线", status.tunnel_connected)
        self._set_status(self.remote_status, "在线" if status.remote_online else "离线", status.remote_online)
        browser = status.browser
        display_state = "READY" if browser.ready else "NOT READY"
        if browser.ready:
            self._browser_was_ready = True
            self._browser_missing_since = None
        elif (status.mcp_running and browser.bridge_available and browser.extension_paired
              and browser.readiness_state == "extension_not_present" and self._browser_was_ready):
            now = monotonic()
            if self._browser_missing_since is None:
                self._browser_missing_since = now
            display_state = ("READY" if now - self._browser_missing_since < BROWSER_PRESENCE_GRACE_SECONDS
                             else "DEGRADED")
        else:
            self._browser_was_ready = False
            self._browser_missing_since = None
        browser_reason = self._localize_browser_text(browser.reason)
        browser_action = self._localize_browser_text(browser.action)
        browser_label = {"READY": "已就绪", "DEGRADED": "降级", "NOT READY": "未就绪"}[display_state]
        browser_text = browser_label if display_state == "READY" else (
            f"{browser_label}\n原因：{browser_reason}\n操作：{browser_action}"
        )
        self.browser_status.setText(browser_text)
        self.browser_status.setStyleSheet("color: " + {
            "READY": "#16803c", "DEGRADED": "#946200", "NOT READY": "#9b1c1c",
        }[display_state])
        self.browser_status.setToolTip(
            "显示宽限期：最近未检测到浏览器，但 submit_goal 仍会检查实时就绪状态。"
            if display_state == "READY" and not browser.ready else ""
        )
        desktop_sync = getattr(status, "desktop_sync", DesktopSyncStatus())
        desktop_capability = getattr(status, "desktop_capability", DesktopCapabilityStatus())
        capability = getattr(status, "capability", CapabilityStatus())
        self._render_capability_status(capability)
        # A connected Desktop IPC observer says nothing about the Desktop codex_app capability, so
        # the handoff state is always rendered separately instead of being read as the same thing.
        identity_state = (
            "不可用" if not desktop_sync.connected
            else "已就绪" if desktop_sync.owner_client_id
            else "等待激活"
        )
        pipe_state = {
            "active": "活动",
            "pending": "等待中",
            "unavailable": "不可用",
        }.get(desktop_capability.pipe_state, "不可用")
        capability_state = (
            f"pipeSource={desktop_capability.pipe_source}"
            if desktop_capability.ready and desktop_capability.pipe_source
            else "等待 Desktop 激活"
            if desktop_capability.pipe_state == "pending"
            else "不可用"
        )
        capability_lines = [
            "",
            f"Desktop IPC：{'已连接' if desktop_sync.connected else '已断开'}",
            f"Desktop 身份：{identity_state}",
            f"Tools Pipe：{pipe_state}",
            f"能力：{capability_state}",
        ]
        if desktop_sync.active_source == "legacy_app_server":
            reason = {
                "desktop_disconnected": "Desktop 不可用",
                "desktop_evidence_unavailable": "Desktop 证据不可用",
            }.get(desktop_sync.fallback_reason, "Desktop 同步不可用")
            self.desktop_sync_status.setText("\n".join([
                "不可用",
                "模式：自动",
                "来源：Legacy app-server",
                f"原因：{reason}",
                *capability_lines,
            ]))
            self.desktop_sync_status.setStyleSheet("color: #666666")
        elif not desktop_sync.connected:
            self.desktop_sync_status.setText("\n".join(["不可用", *capability_lines]))
            self.desktop_sync_status.setStyleSheet("color: #666666")
        else:
            lines = [
                "已连接",
                "模式：自动",
                "来源：Desktop IPC",
                f"会话：{desktop_sync.current_conversation_id or '—'}",
                f"跟随：{'是' if desktop_sync.following is True else '否' if desktop_sync.following is False else '—'}",
                f"所有者：{desktop_sync.owner_client_id or '—'}",
                f"最近事件：{desktop_sync.last_event_display}",
            ]
            if desktop_sync.association_status != "matched":
                association = {
                    "conflict": "冲突",
                    "unavailable": "不可用",
                    "unmatched": "未匹配",
                }.get(desktop_sync.association_status, desktop_sync.association_status)
                lines.append(f"关联：{association}")
            lines.extend(capability_lines)
            self.desktop_sync_status.setText("\n".join(lines))
            self.desktop_sync_status.setStyleSheet(
                "color: #946200" if desktop_sync.association_status in {"conflict", "unavailable"}
                else "color: #16803c"
            )
        self._render_oauth_status(status.oauth_registry)
        self._render_session_dashboard(sessions)
        self.workspace_label.setText(self._current_workspace_text())
        cloudflared_version = getattr(status, "cloudflared_version", None)
        self.cloudflared_version_label.setText(
            "不可用" if not cloudflared_version or cloudflared_version == "unavailable" else cloudflared_version
        )

    @staticmethod
    def _localize_browser_text(text: str) -> str:
        return {
            "Browser readiness could not be read.": "无法读取浏览器就绪状态。",
            "Start or restart the local MCP runtime and refresh status.": "请启动或重启本地 MCP 运行时，然后刷新状态。",
            "Extension is not paired.": "扩展未配对。",
            "Extension is not connected.": "扩展未连接。",
            "Not paired": "未配对",
            "Refresh ChatGPT page": "刷新 ChatGPT 页面",
            "Refresh ChatGPT page / 刷新 ChatGPT 页面": "刷新 ChatGPT 页面",
            "Refresh the ChatGPT page and wait for the extension to reconnect. Reload/更新扩展后，请刷新 ChatGPT 页面并等待扩展重新连接。": "请刷新 ChatGPT 页面并等待扩展重新连接。",
        }.get(text, text)

    @staticmethod
    def _capability_reason_text(reason: str | None) -> str:
        labels = {
            "desktop_disconnected": "Desktop 已断开",
            "executor_identity_unavailable": "Desktop 所有者身份不可用",
            "desktop_tools_pipe_unavailable": "Desktop Tools Pipe 不可用",
            "desktop_handoff_failed": "Desktop 交接失败",
            "desktop_handoff_timeout": "Desktop 交接超时",
            "desktop_binding_recovered": "Desktop 绑定已恢复",
            "desktop_execution_failed": "Desktop 执行失败",
            "standalone_execution_failed": "Standalone 执行失败",
            "user_selected_standalone": "用户选择了 Standalone",
        }
        return labels.get(reason or "", reason or "—")

    @staticmethod
    def _capability_reason_line(reason: str | None) -> str:
        if reason is None:
            return "原因：—"
        label = LauncherWindow._capability_reason_text(reason)
        return f"原因：{label}（{reason}）" if label != reason else f"原因：{label}"

    @staticmethod
    def _seconds_until(timestamp: str | None) -> int | None:
        if timestamp is None:
            return None
        try:
            deadline = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if deadline.tzinfo is None:
                return None
            return max(0, int(ceil((deadline - datetime.now(deadline.tzinfo)).total_seconds())))
        except ValueError:
            return None

    def _render_capability_status(self, capability: CapabilityStatus) -> None:
        capability_source = {
            "desktop": "Desktop",
            "standalone": "Standalone",
        }.get(capability.source or "", "—")
        capability_state = {
            "unavailable": "不可用",
            "initializing": "初始化中",
            "desktop_pending": "等待 Desktop 接管",
            "desktop_ready": "Desktop 已就绪",
            "desktop_failed": "Desktop 失败",
            "fallback_ready": "Standalone 备用路径已选择",
            "fallback_running": "Standalone 备用后端运行中",
        }.get(capability.state, capability.state or "未知")
        capability_hint = {
            "unavailable": "MCP 能力不可用。",
            "initializing": "正在等待当前执行能力。",
            "desktop_pending": "正在等待 Desktop 接管。",
            "desktop_ready": "Desktop 能力已就绪。",
            "desktop_failed": "Desktop 交接失败；请重试 Desktop 或使用 Standalone。",
            "fallback_ready": "已选择 Standalone 备用路径。",
            "fallback_running": "Standalone 备用后端运行中。",
        }.get(capability.state, "能力状态不可用。")
        capability_lines = [
            f"执行：{capability.execution_id or '—'}",
            f"来源：{capability_source}",
            f"状态：{capability_state}（{capability.state}）",
            f"说明：{capability_hint}",
        ]
        if capability.state == "desktop_pending":
            capability_lines.extend(["Desktop：等待中", "等待 Desktop 接管"])
        elif capability.state == "desktop_ready":
            capability_lines.append("Desktop：已就绪")
            if capability.reason:
                capability_lines.append(self._capability_reason_line(capability.reason))
        elif capability.state == "desktop_failed":
            capability_lines.append("Desktop：失败")
            capability_lines.append(self._capability_reason_line(capability.reason))
            if capability.error_code:
                capability_lines.append(f"错误代码：{capability.error_code}")
            remaining = self._seconds_until(capability.fallback_deadline_at)
            if remaining is not None:
                capability_lines.extend([
                    "",
                    "等待用户选择",
                    f"自动备用路径倒计时：{remaining} 秒",
                ])
        elif capability.state == "fallback_running":
            capability_lines.extend([
                "",
                "已启用备用路径",
                "提供方：Standalone",
                self._capability_reason_line(capability.reason if capability.reason else "user_selected_standalone"),
            ])
            if capability.error_code:
                capability_lines.append(f"错误代码：{capability.error_code}")
        elif capability.reason:
            capability_lines.append(self._capability_reason_line(capability.reason))
            if capability.error_code:
                capability_lines.append(f"错误代码：{capability.error_code}")
        self.capability_status.setText("\n".join(capability_lines))
        self.capability_status.setStyleSheet(
            "color: #16803c" if capability.state in {"desktop_ready", "fallback_running"}
            else "color: #946200" if capability.state in {"initializing", "desktop_pending", "fallback_ready"}
            else "color: #9b1c1c"
        )

    def _refresh_capability_countdown(self) -> None:
        if self._closing:
            return
        capability = getattr(self._last_status, "capability", CapabilityStatus())
        if capability.state == "desktop_failed" and capability.fallback_deadline_at:
            self._render_capability_status(capability)

    def _render_doctor(self, report: DoctorStatus) -> None:
        status_label = {
            "READY": "已就绪",
            "DEGRADED": "降级",
            "FAILED": "失败",
        }.get(report.status, report.status or "未知")
        check_labels = {
            "PASS": "通过",
            "READY": "通过",
            "WARN": "警告",
            "FAIL": "失败",
        }
        status_colors = {
            "READY": "#16803c",
            "DEGRADED": "#946200",
            "FAILED": "#9b1c1c",
        }
        check_colors = {
            "PASS": "#16803c",
            "READY": "#16803c",
            "WARN": "#946200",
            "FAIL": "#9b1c1c",
        }

        def colored(text: str, color: str | None) -> str:
            text = escape(text)
            return f'<span style="color: {color}">{text}</span>' if color else text

        lines = [
            colored(f"状态：{status_label}（{report.status}）", status_colors.get(report.status)),
            colored(f"最近运行：{self._format_timestamp(report.generated_at)}", None),
        ]
        if report.checks:
            for check in report.checks:
                line = f"[{check_labels.get(check.status, check.status)}] {check.component}"
                if check.reason:
                    line += f" — {check.reason}"
                lines.append(colored(line, check_colors.get(check.status)))
        else:
            lines.append(colored("[失败] 诊断 — doctor_unavailable", "#9b1c1c"))
        self.doctor_status.setText("<br>".join(lines))
        self.doctor_status.setStyleSheet({
            "READY": "color: #16803c",
            "DEGRADED": "color: #946200",
            "FAILED": "color: #9b1c1c",
        }.get(report.status, "color: #666666"))

    def _render_capability_timeline(self, events: tuple[CapabilityTimelineEvent, ...]) -> None:
        self.capability_timeline_table.setRowCount(0)
        for event in events:
            row = self.capability_timeline_table.rowCount()
            self.capability_timeline_table.insertRow(row)
            values = (
                self._format_timestamp(event.timestamp),
                event.previous_state or "—",
                event.current_state,
                event.source or "—",
                event.reason or "—",
                event.error_code or "—",
                event.event or event.current_state,
            )
            for column, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setToolTip(value)
                self.capability_timeline_table.setItem(row, column, item)
        self.capability_timeline_table.resizeColumnsToContents()
        self.capability_timeline_empty_label.setText(
            "暂无最近的能力时间线事件。" if not events else ""
        )
        self.capability_timeline_empty_label.setVisible(not events)

    def _render_oauth_status(self, status: OAuthRegistryStatus | None) -> None:
        if status is None:
            self.oauth_status_label.setText("不可用")
            return
        lines = [
            f"OAuth 客户端数：{status.client_count}",
            f"注册表：{status.storage_path}",
            f"已加载：{'是' if status.loaded else '否'}",
        ]
        for client in status.clients:
            lines.extend([
                "",
                client.client_name,
                f"客户端 ID：{client.client_id}",
                f"创建时间：{client.created_at}",
            ])
            if client.last_used is not None:
                lines.append(f"最近使用：{client.last_used}")
        self.oauth_status_label.setText("\n".join(lines))

    def _current_workspace_text(self) -> str:
        if not self.configuration.workspace:
            return "未配置"
        current = next(
            (
                record
                for record in self.configuration.workspaces
                if record.id == self.configuration.active_workspace_id
            ),
            None,
        )
        return f"{current.name} ({current.path})" if current else self.configuration.workspace

    def _render_workspace_registry(self) -> None:
        self.workspace_table.setRowCount(0)
        active_row = -1
        for row, record in enumerate(self.configuration.workspaces):
            self.workspace_table.insertRow(row)
            self.workspace_table.setItem(row, 0, QTableWidgetItem(record.id))
            self.workspace_table.setItem(row, 1, QTableWidgetItem(record.name))
            self.workspace_table.setItem(row, 2, QTableWidgetItem(record.path))
            if record.id == self.configuration.active_workspace_id:
                active_row = row
        self.workspace_table.resizeColumnsToContents()
        if active_row >= 0:
            self.workspace_table.selectRow(active_row)

    def _selected_workspace_id(self) -> str | None:
        row = self.workspace_table.currentRow()
        item = self.workspace_table.item(row, 0) if row >= 0 else None
        return item.text() if item is not None else None

    def _selected_session_id(self) -> str | None:
        row = self.session_table.currentRow()
        item = self.session_table.item(row, 5) if row >= 0 else None
        return item.text() if item is not None else None

    def _selected_session(self) -> SessionViewModel | None:
        session_id = self._selected_session_id()
        return next(
            (session for session in self._session_view_models if session.session_id == session_id),
            None,
        )

    def _set_session_viewer_expanded(self, expanded: bool) -> None:
        self.session_viewer_toggle.setArrowType(
            Qt.ArrowType.DownArrow if expanded else Qt.ArrowType.RightArrow
        )
        self.session_viewer_content.setVisible(expanded)

    def _copy_event_stream_action(self):
        from PySide6.QtGui import QAction, QKeySequence

        action = QAction("复制事件内容", self.event_table)
        action.setShortcut(QKeySequence.StandardKey.Copy)
        action.setShortcutContext(Qt.ShortcutContext.WidgetShortcut)
        action.triggered.connect(self.copy_event_stream)
        return action

    def copy_event_stream(self) -> None:
        rows = dict.fromkeys(item.row() for item in self.event_table.selectedItems())
        if not rows and self.event_table.currentItem() is not None:
            rows[self.event_table.currentItem().row()] = None
        contents = [
            item.text()
            for row in rows
            if (item := self.event_table.item(row, 2)) is not None
        ]
        if contents:
            QApplication.clipboard().setText("\n".join(contents))

    def _render_session_dashboard(self, sessions: tuple[SessionViewModel, ...]) -> None:
        selected_id = self._selected_session_id()
        self._session_view_models = tuple(sessions)
        self.session_table.blockSignals(True)
        try:
            self.session_table.setRowCount(0)
            for row, session in enumerate(self._session_view_models):
                self.session_table.insertRow(row)
                values = (
                    f"{session.goal_name} / {session.task_name}",
                    session.status,
                    session.backend_type,
                    session.model or "—",
                    session.reasoning_effort or "—",
                    session.session_id,
                    session.thread_id or "—",
                    self._format_timestamp(session.updated_at),
                )
                for column, value in enumerate(values):
                    self.session_table.setItem(row, column, QTableWidgetItem(value))
            self.session_table.resizeColumnsToContents()
            self.session_table.clearSelection()
            self.session_table.setCurrentCell(-1, -1)
            if selected_id is not None:
                for row, session in enumerate(self._session_view_models):
                    if session.session_id == selected_id:
                        self.session_table.selectRow(row)
                        break
        finally:
            self.session_table.blockSignals(False)
        self.session_empty_label.setText("暂无活动会话")
        self.session_empty_label.setVisible(not self._session_view_models)
        self._render_selected_session()

    def _render_selected_session(self) -> None:
        session = self._selected_session()
        if session is None:
            self._clear_session_view()
            return

        self.open_codex_task_button.setEnabled(True)
        self.session_details_label.setText("\n".join([
            f"会话 ID：{session.session_id}",
            f"目标 ID：{session.goal_id}",
            f"任务 ID：{session.task_id}",
            f"后端类型：{session.backend_type}",
            f"线程 ID：{session.thread_id or '—'}",
            f"模型：{session.model or '—'}",
            f"推理：{session.reasoning_effort or '—'}",
            f"状态：{session.status}",
            f"更新时间：{self._format_timestamp(session.updated_at)}",
        ]))
        execution = session.execution
        if execution is None:
            self.execution_details_label.setText("执行：—")
        else:
            self.execution_details_label.setText("\n".join([
                f"执行 ID：{execution.execution_id}",
                f"状态：{execution.status}",
                f"摘要：{execution.summary or '—'}",
                f"当前轮次：{execution.turn_id or '—'}",
                f"开始时间：{self._format_timestamp(execution.started_at)}",
                f"结束时间：{self._format_timestamp(execution.finished_at)}",
            ]))

        # Aggregate before limiting rows so a retained stream keeps all its text.
        rows = deque(maxlen=MAX_EVENT_STREAM_ROWS)
        # Session identity is already validated when building session.events.
        for identity, group in groupby(session.events, key=lambda event: (
            (event.execution_id, event.turn_id, event.item_id)
            if event.event_type in {"agent_message_delta", "agent_message_completed"} else None
        )):
            if identity is None:
                rows.extend((event.display_time, event.event_type, event.content or "—") for event in group)
                continue
            first = None
            chunks = []
            for event in group:
                if first is None:
                    first = event
                if event.event_type == "agent_message_completed":
                    # Core emits completed.content as the suffix not yet sent by deltas.
                    rows.append((first.display_time, "agent_message_stream", "".join(chunks) + event.content))
                    first = None
                    chunks.clear()
                else:
                    chunks.append(event.content)
            if first is not None:
                rows.append((first.display_time, "agent_message_stream", "".join(chunks)))
        scroll_position = self.event_table.verticalScrollBar().value()
        self.event_table.setRowCount(len(rows))
        for row, values in enumerate(rows):
            for column, value in enumerate(values):
                self.event_table.setItem(row, column, QTableWidgetItem(value))
        self.event_table.resizeColumnToContents(0)
        self.event_table.resizeColumnToContents(1)
        self.event_table.resizeRowsToContents()
        self.event_table.verticalScrollBar().setValue(scroll_position)

    def _clear_session_view(self) -> None:
        self.open_codex_task_button.setEnabled(False)
        self.session_details_label.setText("请选择会话查看详情。")
        self.execution_details_label.setText("执行：—")
        self.event_table.setRowCount(0)

    def clear_task_cache(self) -> None:
        self._cleared_session_keys.update(
            (session.session_id, session.execution_id)
            for session in self._session_view_models
        )
        self._status_check_generation += 1
        self._session_view_models = ()
        self._last_status = replace(self._last_status, sessions=())
        self.session_table.setRowCount(0)
        self.session_empty_label.setText("暂无活动会话")
        self.session_empty_label.setVisible(True)
        self._clear_session_view()
        self.message_label.setText("任务面板界面缓存已清理；活动任务和新任务仍会显示，请点击“刷新状态”重新加载全部内容。")

    def clear_persisted_task_records(self) -> None:
        if (
            not self._last_status.mcp_running
            or self.state in (LauncherState.STARTING, LauncherState.STOPPING)
        ):
            return
        answer = QMessageBox.question(
            self,
            "清理持久化任务记录",
            "删除当前 Workspace 中已结束的 Session、Event、Execution 和 Task 记录？\n"
            "运行中的任务不会删除。\n\n继续吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        deleted = self.status_checker.clear_persisted_task_records()
        if deleted is None:
            self._show_error("无法清理持久化任务记录。")
            return
        self.clear_task_cache()
        self.message_label.setText(f"已清理 {deleted} 条持久化任务记录。")
        self.refresh_status()

    @staticmethod
    def _format_timestamp(timestamp: str | None) -> str:
        if timestamp is None:
            return "—"
        try:
            return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            return timestamp

    def open_codex_task(self) -> None:
        session = self._selected_session()
        if session is None:
            return
        QMessageBox.information(
            self,
            "打开 Codex 任务",
            "当前启动器无法直接打开 Codex Desktop。\n\n"
            f"线程 ID：{session.thread_id or '—'}\n"
            f"会话 ID：{session.session_id}",
        )

    def _render_runtime_info(self) -> None:
        try:
            info = self.config_manager.runtime_info(self.configuration)
        except LauncherConfigError:
            self.runtime_workspace_label.setText(self.configuration.workspace or "未配置")
            self.production_config_label.setText(str(self.config_manager.production_path(self.configuration.config_file)))
            self.tunnel_mode_label.setText("不可用")
            self.remote_endpoint_label.setText(DEFAULT_REMOTE_ENDPOINT)
            return
        self.runtime_workspace_label.setText(info.workspace or "未配置")
        self.production_config_label.setText(str(info.production_config))
        self.tunnel_mode_label.setText({"auto": "自动"}.get(info.tunnel_mode, info.tunnel_mode))
        self.remote_endpoint_label.setText(info.remote_endpoint)

    def _update_log(self) -> None:
        self.log_output.setPlainText(self.process_manager.get_output())

    def _apply_controls(self, status: LauncherStatus) -> None:
        launcher_running = self.process_manager.launcher_is_running
        has_started = self.process_manager.has_started
        can_start = self.state in (LauncherState.STOPPED, LauncherState.FAILED)
        self.start_button.setEnabled(can_start and not status.mcp_running and not launcher_running and not has_started)
        self.stop_button.setEnabled(
            self.state != LauncherState.STOPPING
            and (
                self.state in (LauncherState.STARTING, LauncherState.RUNNING)
                or (self.state == LauncherState.FAILED and has_started)
                or status.mcp_running
                or launcher_running
            )
        )
        self.workspace_button.setEnabled(
            self.state in (LauncherState.STOPPED, LauncherState.FAILED)
            and not status.mcp_running
            and not launcher_running
            and not has_started
        )
        for button in (
            self.delete_workspace_button,
            self.rename_workspace_button,
            self.set_current_workspace_button,
        ):
            button.setEnabled(self.workspace_button.isEnabled())
        oauth_available = status.mcp_running and self.state not in (
            LauncherState.STARTING,
            LauncherState.STOPPING,
        )
        self.refresh_oauth_button.setEnabled(oauth_available)
        self.reset_oauth_button.setEnabled(oauth_available)
        self.clear_persisted_task_button.setEnabled(
            status.mcp_running
            and self.state not in (LauncherState.STARTING, LauncherState.STOPPING)
        )
        self.delete_oauth_button.setEnabled(
            oauth_available
            and status.oauth_registry is not None
            and status.oauth_registry.client_count > 0
            and bool(status.oauth_registry.clients)
        )
        capability = getattr(status, "capability", CapabilityStatus())
        capability_actions = set(capability.actions)
        capability_available = status.mcp_running and self.state not in (
            LauncherState.STARTING,
            LauncherState.STOPPING,
        )
        self.run_doctor_button.setEnabled(capability_available)
        self.capability_timeline_toggle.setEnabled(capability_available)
        self.capability_timeline_refresh_button.setEnabled(
            capability_available and not self._capability_timeline_loading
        )
        self.recheck_desktop_button.setEnabled(capability_available and "recheck" in capability_actions)
        self.standalone_button.setEnabled(capability_available and "standalone" in capability_actions)

    def recheck_desktop_capability(self) -> None:
        execution_id = getattr(self._last_status.capability, "execution_id", None)
        if self.status_checker.capability_action("recheck", execution_id):
            self.message_label.setText("已请求重新检查 Desktop 能力。")
            self.refresh_status()
        else:
            self._show_error("无法请求重新检查 Desktop 能力。")

    def select_standalone_capability(self) -> None:
        execution_id = getattr(self._last_status.capability, "execution_id", None)
        if self.status_checker.capability_action("standalone", execution_id):
            self.message_label.setText("已选择 Standalone 备用路径。")
            self.refresh_status()
        else:
            self._show_error("无法选择 Standalone fallback。")

    def run_doctor(self) -> None:
        if not self._last_status.mcp_running or self._closing:
            return
        self.run_doctor_button.setEnabled(False)
        self.message_label.setText("正在运行只读能力诊断……")
        generation = self._status_check_generation
        worker = DoctorCheckWorker(self.status_checker, generation)
        worker.signals.finished.connect(self._doctor_check_finished)
        self._status_thread_pool.start(worker)

    @Slot(int, object)
    def _doctor_check_finished(self, generation: int, report: DoctorStatus) -> None:
        if self._closing or generation != self._status_check_generation:
            return
        self._render_doctor(report)
        report_label = {"READY": "已就绪", "DEGRADED": "降级", "FAILED": "失败"}.get(
            report.status, report.status or "未知"
        )
        self.message_label.setText(f"能力诊断已完成：{report_label}。")
        self._apply_controls(self._last_status)

    def _set_capability_timeline_expanded(self, expanded: bool) -> None:
        self.capability_timeline_content.setVisible(expanded)
        if expanded and self._last_status.mcp_running and not self._capability_timeline_loading:
            self.refresh_capability_timeline()

    def refresh_capability_timeline(self) -> None:
        if self._closing or not self._last_status.mcp_running or self._capability_timeline_loading:
            return
        self._capability_timeline_loading = True
        self.capability_timeline_refresh_button.setEnabled(False)
        self.capability_timeline_empty_label.setText("正在加载能力时间线……")
        self.capability_timeline_empty_label.setVisible(True)
        execution_id = getattr(self._last_status.capability, "execution_id", None)
        worker = CapabilityTimelineCheckWorker(
            self.status_checker,
            execution_id,
            CAPABILITY_TIMELINE_LIMIT,
            self._status_check_generation,
        )
        worker.signals.finished.connect(self._capability_timeline_check_finished)
        self._status_thread_pool.start(worker)

    @Slot(int, object)
    def _capability_timeline_check_finished(
        self,
        generation: int,
        events: tuple[CapabilityTimelineEvent, ...],
    ) -> None:
        self._capability_timeline_loading = False
        if self._closing:
            return
        if generation != self._status_check_generation:
            self._apply_controls(self._last_status)
            return
        self._render_capability_timeline(events)
        self.message_label.setText(f"能力时间线已加载：{len(events)} 条事件。")
        self._apply_controls(self._last_status)

    def _set_state(self, state: LauncherState) -> None:
        self.state = state
        colors = {
            LauncherState.STOPPED: "#666666",
            LauncherState.STARTING: "#9a6700",
            LauncherState.RUNNING: "#16803c",
            LauncherState.STOPPING: "#9a6700",
            LauncherState.FAILED: "#9b1c1c",
        }
        labels = {
            LauncherState.STOPPED: "已停止",
            LauncherState.STARTING: "启动中",
            LauncherState.RUNNING: "运行中",
            LauncherState.STOPPING: "停止中",
            LauncherState.FAILED: "失败",
        }
        self.launcher_state.setText(f'<span style="color: {colors[state]}">●</span> {labels[state]}')

    def _poll_startup(self) -> None:
        if self.state != LauncherState.STARTING:
            self.startup_timer.stop()
            return

        self._request_status_check("startup")

    def _handle_startup_status(self, status: LauncherStatus) -> None:
        if self.state != LauncherState.STARTING:
            return
        failure_reason = self.process_manager.failure_reason
        timed_out = self._startup_started_at is not None and monotonic() - self._startup_started_at >= STARTUP_TIMEOUT_SECONDS
        if failure_reason and not status.mcp_running:
            self._fail_startup(failure_reason)
        elif timed_out:
            self._fail_startup(
                "MCP 启动超时，请检查日志。\n"
                "启动超时：本地 MCP 或隧道可能仍在运行。"
            )
        elif status.mcp_running and status.tunnel_connected and status.remote_online:
            self.startup_timer.stop()
            self.timer.start(5_000)
            self._startup_started_at = None
            self._set_state(LauncherState.RUNNING)
            self.message_label.setText("MCP 启动成功。")

    def _fail_startup(self, message: str) -> None:
        self.startup_timer.stop()
        self.timer.start(5_000)
        self._set_state(LauncherState.FAILED)
        self.message_label.setText(message)
        self._update_log()

    @staticmethod
    def _set_status(label: QLabel, text: str, healthy: bool) -> None:
        color = "#16803c" if healthy else "#9b1c1c"
        label.setText(f'<span style="color: {color}">●</span> {text}')

    def start_mcp(self) -> None:
        if self.state in (LauncherState.STARTING, LauncherState.RUNNING, LauncherState.STOPPING):
            return
        if self.process_manager.has_started:
            return
        if not self.configuration.workspace:
            self._show_error("启动 MCP 前请先选择一个已存在的工作区。")
            return
        if not Path(self.configuration.workspace).is_dir():
            self._show_error(f"工作区不是已存在的目录：{self.configuration.workspace}")
            return
        if self._last_status.mcp_running:
            self._apply_controls(self._last_status)
            self.message_label.setText("MCP 已在运行。")
            return
        self._startup_started_at = monotonic()
        self._set_state(LauncherState.STARTING)
        self.message_label.setText("正在启动现有生产启动流程……")
        self._status_check_generation += 1
        self.timer.stop()
        self.start_button.setEnabled(False)
        self.stop_button.setEnabled(True)
        self.workspace_button.setEnabled(False)
        self.clear_persisted_task_button.setEnabled(False)
        self.delete_oauth_button.setEnabled(False)
        try:
            self.process_manager.start(self.configuration)
        except (LauncherConfigError, RuntimeError) as error:
            self._fail_startup(str(error))
            self._apply_controls(self._last_status)
            self._show_error(str(error))
            return
        self.startup_timer.start()
        self._poll_startup()

    def stop_mcp(self) -> None:
        if self.state == LauncherState.STOPPING:
            return
        self.startup_timer.stop()
        self.timer.stop()
        self._status_check_generation += 1
        self._set_state(LauncherState.STOPPING)
        self.message_label.setText("正在停止 MCP……")
        self.start_button.setEnabled(False)
        self.stop_button.setEnabled(False)
        self.workspace_button.setEnabled(False)
        self.clear_persisted_task_button.setEnabled(False)
        self.delete_oauth_button.setEnabled(False)
        try:
            message = self.process_manager.stop()
        except RuntimeError as error:
            self._set_state(LauncherState.FAILED)
            self._show_error(str(error))
        else:
            self._startup_started_at = None
            self._set_state(LauncherState.STOPPED)
            self.message_label.setText(message)
        finally:
            self.refresh_status()
            self.timer.start(5_000)

    def reset_oauth_clients(self) -> None:
        if not self._last_status.mcp_running:
            return
        answer = QMessageBox.question(
            self,
            "重置 OAuth 客户端",
            "要从 MCP 注册表中删除所有已注册的 OAuth 客户端吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        if not self.status_checker.reset_oauth_clients():
            self._show_error("无法重置 OAuth 客户端。")
            return
        self.message_label.setText("OAuth 客户端已重置。")
        self.refresh_status()

    def delete_oauth_client(self) -> None:
        status = self._last_status.oauth_registry
        if (
            not self._last_status.mcp_running
            or self.state in (LauncherState.STARTING, LauncherState.STOPPING)
            or status is None
            or status.client_count == 0
            or not status.clients
        ):
            return
        options = [f"{client.client_name} ({client.client_id})" for client in status.clients]
        selected, accepted = QInputDialog.getItem(
            self,
            "删除 OAuth 客户端",
            "选择要删除的 OAuth 客户端：",
            options,
            0,
            False,
        )
        if not accepted:
            return
        client = next((client for option, client in zip(options, status.clients) if option == selected), None)
        if client is None:
            return
        answer = QMessageBox.question(
            self,
            "删除 OAuth 客户端",
            f"只删除选中的 OAuth 客户端，不影响其他客户端：\n"
            f"{client.client_name}\n客户端 ID：{client.client_id}\n\n继续吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        if not self.status_checker.delete_oauth_client(client.client_id):
            self._show_error("无法删除 OAuth 客户端。")
            return
        self.message_label.setText(f"OAuth 客户端已删除：{client.client_id}")
        self.refresh_status()

    def choose_workspace(self) -> None:
        initial = self.configuration.workspace if self.configuration.workspace and Path(self.configuration.workspace).is_dir() else ""
        selected = QFileDialog.getExistingDirectory(self, "选择工作区", initial)
        if not selected:
            return
        try:
            self.configuration = self.config_manager.add_workspace(self.configuration, Path(selected))
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self.status_checker.workspace_id = self.configuration.active_workspace_id
        self._render_workspace_registry()
        self.message_label.setText("工作区已添加并设为当前工作区，将在下次启动 MCP 时使用。")
        self.refresh_status()

    def delete_workspace(self) -> None:
        workspace_id = self._selected_workspace_id()
        if workspace_id is None:
            self._show_error("请选择要删除的工作区。")
            return
        record = next(
            (record for record in self.configuration.workspaces if record.id == workspace_id),
            None,
        )
        if record is None:
            self._show_error("选中的工作区已不在注册表中。")
            return
        answer = QMessageBox.question(
            self,
            "删除工作区",
            f"只删除注册表中的记录，不会删除磁盘目录：\n{record.name}\n{record.path}\n\n继续吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        try:
            self.configuration = self.config_manager.remove_workspace(self.configuration, workspace_id)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self.status_checker.workspace_id = self.configuration.active_workspace_id
        self._render_workspace_registry()
        self.message_label.setText("工作区已从注册表移除，磁盘目录未删除。")
        self.refresh_status()

    def rename_workspace(self) -> None:
        workspace_id = self._selected_workspace_id()
        if workspace_id is None:
            self._show_error("请选择要重命名的工作区。")
            return
        record = next(
            (record for record in self.configuration.workspaces if record.id == workspace_id),
            None,
        )
        if record is None:
            self._show_error("选中的工作区已不在注册表中。")
            return
        name, accepted = QInputDialog.getText(self, "编辑工作区名称", "名称：", text=record.name)
        if not accepted:
            return
        try:
            self.configuration = self.config_manager.rename_workspace(self.configuration, workspace_id, name)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self._render_workspace_registry()
        self.message_label.setText("工作区名称已保存。")
        self.refresh_status()

    def set_current_workspace(self) -> None:
        workspace_id = self._selected_workspace_id()
        if workspace_id is None:
            self._show_error("请选择要设为当前工作区的项目。")
            return
        try:
            self.configuration = self.config_manager.set_active_workspace(self.configuration, workspace_id)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self.status_checker.workspace_id = self.configuration.active_workspace_id
        self._render_workspace_registry()
        self.message_label.setText("当前工作区已保存，将在下次启动 MCP 时使用。")
        self.refresh_status()

    def open_config(self) -> None:
        path = self.config_manager.production_path(self.configuration.config_file)
        if not path.is_file():
            self._show_error(f"未找到生产配置文件：{path}")
            return
        try:
            opener = getattr(os, "startfile")
            opener(str(path))
        except (AttributeError, OSError) as error:
            self._show_error(f"无法打开生产配置文件：{error}")

    def backup_config(self) -> None:
        try:
            path = self.config_manager.backup_production_config(self.configuration)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self.message_label.setText(f"配置备份已创建：\n{path}")

    def validate_config(self) -> None:
        errors = self.config_manager.validate_production_config(self.configuration)
        if errors:
            self.message_label.setText("配置校验失败：\n\n" + "\n".join(f"- {error}" for error in errors))
        else:
            self.message_label.setText("配置有效。")

    def copy_log(self) -> None:
        QApplication.clipboard().setText(self.log_output.toPlainText())
        self.message_label.setText("日志已复制到剪贴板。")

    def clear_log(self) -> None:
        self.log_output.clear()

    def save_log(self) -> None:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        default_name = f"local-review-mcp-launcher-{timestamp}.log"
        path, _ = QFileDialog.getSaveFileName(self, "保存日志", default_name, "日志文件 (*.log);;所有文件 (*)")
        if not path:
            return
        try:
            with Path(path).open("w", encoding="utf-8", newline="\n") as stream:
                stream.write(self.log_output.toPlainText())
        except OSError as error:
            self._show_error(f"无法保存日志：{error}")
            return
        self.message_label.setText(f"日志已保存到：\n{path}")

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self._closing = True
        self._status_check_generation += 1
        self.timer.stop()
        self.capability_countdown_timer.stop()
        self.startup_timer.stop()
        if self.process_manager.has_started:
            try:
                self.process_manager.stop()
            except RuntimeError:
                pass
        event.accept()

    def _show_error(self, message: str) -> None:
        self.message_label.setText(message)
        QMessageBox.critical(self, "Local Review MCP 启动器", message)
