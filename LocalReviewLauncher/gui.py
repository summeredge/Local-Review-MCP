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

from PySide6.QtCore import QEvent, QThreadPool, QTimer, Qt, Slot
from PySide6.QtGui import QAction, QColor, QFont
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QFrame,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QInputDialog,
    QMenu,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QStyle,
    QSystemTrayIcon,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from config_manager import (
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
    ExecutionViewModel,
    LauncherStatus,
    OAuthRegistryStatus,
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
# The Execution Dashboard is one row per Execution; the Session columns are gone because a batch
# Execution has no Session and previously could not be shown at all.
EXECUTION_DASHBOARD_COLUMNS = (
    "名称",
    "模式",
    "后端",
    "状态",
    "Workspace",
    "开始时间",
    "结束时间",
)
CLEARED_TERMINAL_EXECUTION_STATUSES = frozenset({"passed", "failed"})
EXECUTION_STATUS_COLORS = {
    "running": "#946200",
    "passed": "#16803c",
    "failed": "#9b1c1c",
}
UNKNOWN_STATUS_COLOR = "#666666"
BATCH_EVENT_EMPTY_TEXT = "Batch Execution 无 Session 事件流"
NO_SESSION_TEXT = "\n".join(["Session：—", "Thread：—"])
BUTTON_WIDTH = 136
BUTTON_HEIGHT = 34
BUTTON_SPACING = 6
CONTENT_MARGIN = 16
CONTENT_SPACING = 10
ROW_LABEL_WIDTH = 132
IDLE_CAPABILITY_TEXT = "\n".join([
    "执行：—",
    "来源：—",
    "状态：当前空闲",
    "说明：当前没有活动的执行任务。",
])
STOPPED_CAPABILITY_TEXT = "\n".join([
    "执行：—",
    "来源：—",
    "状态：MCP 已停止",
    "说明：MCP 未运行，无法读取执行能力状态。",
])
# The Desktop primary path can fail while the standalone app-server backend is still able to start
# an execution, so that state is named as a degraded path rather than as a lost capability.
DESKTOP_DOWN_FALLBACK_CAPABILITY_TEXT = "Desktop 不可用，可回退 AppServer"
DEGRADED_CAPABILITY_COLOR = "#946200"
UNAVAILABLE_CAPABILITY_COLOR = "#9b1c1c"


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
        self._cleared_execution_ids: set[str] = set()
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
        self.browser_status = QLabel("不可用")
        self.browser_status.setWordWrap(True)
        self.browser_status.setTextFormat(Qt.TextFormat.PlainText)
        self.browser_diagnostic_status = QLabel("未运行")
        self.browser_diagnostic_status.setWordWrap(True)
        self.browser_diagnostic_status.setTextFormat(Qt.TextFormat.PlainText)
        self.desktop_status = QLabel("不可用")
        self.desktop_ipc_status = QLabel("不可用")
        self.desktop_identity_status = QLabel("不可用")
        self.tools_pipe_status = QLabel("不可用")
        self.pipe_source_status = QLabel("不可用")
        self.desktop_sync_status = QLabel("不可用")
        self.desktop_sync_status.setWordWrap(True)
        self.desktop_sync_status.setTextFormat(Qt.TextFormat.PlainText)
        self.execution_summary_status = QLabel("不可用")
        self.capability_status = QLabel(IDLE_CAPABILITY_TEXT)
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
        self.workspace_table = QTableWidget(0, 4)
        self.workspace_table.setHorizontalHeaderLabels(["默认", "工作区 ID", "名称", "路径"])
        self.workspace_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.workspace_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.workspace_table.horizontalHeader().setStretchLastSection(True)
        self.workspace_table.setMinimumHeight(120)
        self.execution_table = QTableWidget(0, len(EXECUTION_DASHBOARD_COLUMNS))
        self.execution_table.setHorizontalHeaderLabels(list(EXECUTION_DASHBOARD_COLUMNS))
        self.execution_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.execution_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.execution_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.execution_table.horizontalHeader().setStretchLastSection(True)
        self.execution_table.setMinimumHeight(160)
        self.execution_table.setMaximumHeight(
            self.execution_table.horizontalHeader().sizeHint().height()
            + self.execution_table.verticalHeader().defaultSectionSize() * MAX_DASHBOARD_ROWS
            + 2 * self.execution_table.frameWidth()
        )
        self.query_workspace_label = QLabel()
        self.query_workspace_label.setWordWrap(True)
        self.query_workspace_label.setTextFormat(Qt.TextFormat.PlainText)
        self.session_details_label = QLabel(NO_SESSION_TEXT)
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
        self.event_empty_label = QLabel(BATCH_EVENT_EMPTY_TEXT)
        self.event_empty_label.setWordWrap(True)
        self.event_empty_label.setVisible(False)
        self._execution_view_models: tuple[ExecutionViewModel, ...] = ()
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
        self.set_current_workspace_button = QPushButton("设为默认")
        self.open_config_button = QPushButton("打开配置文件")
        self.backup_config_button = QPushButton("备份配置")
        self.validate_config_button = QPushButton("校验配置")
        self.open_codex_task_button = QToolButton()
        self.open_codex_task_button.setText("线程信息")
        self.open_codex_task_button.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.open_codex_task_button.setCheckable(True)
        self.open_codex_task_button.setEnabled(False)
        self.session_viewer_toggle = self.open_codex_task_button
        self.session_viewer_toggle.toggled.connect(self._set_session_viewer_expanded)
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
        self.execution_table.itemSelectionChanged.connect(self._render_selected_execution)
        self.event_table.addAction(self._copy_event_stream_action())
        self.copy_log_button.clicked.connect(self.copy_log)
        self.clear_log_button.clicked.connect(self.clear_log)
        self.save_log_button.clicked.connect(self.save_log)

        startup_layout = QVBoxLayout()
        startup_layout.setContentsMargins(12, 12, 12, 12)
        startup_layout.setSpacing(CONTENT_SPACING)
        startup_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
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
        startup_layout.addWidget(top_actions, 0, Qt.AlignmentFlag.AlignLeft)
        status_cards = QGridLayout()
        status_cards.setContentsMargins(0, 0, 0, 0)
        status_cards.setHorizontalSpacing(8)
        status_cards.setVerticalSpacing(8)
        for column in range(3):
            status_cards.setColumnStretch(column, 1)
        for row in range(4):
            status_cards.setRowStretch(row, 1)
        for index, (title, value) in enumerate((
            ("启动器状态", self.launcher_state),
            ("MCP 运行时", self.mcp_status),
            ("Cloudflare 隧道", self.tunnel_status),
            ("远程端点", self.remote_status),
            ("浏览器", self.browser_status),
            ("Desktop", self.desktop_status),
            ("Desktop IPC", self.desktop_ipc_status),
            ("Desktop 身份", self.desktop_identity_status),
            ("Tools Pipe", self.tools_pipe_status),
            ("PipeSource", self.pipe_source_status),
            ("执行能力", self.execution_summary_status),
            ("OAuth", self.oauth_status_label),
        )):
            row, column = divmod(index, 3)
            status_cards.addWidget(self._status_card(title, value), row, column)
        startup_layout.addLayout(status_cards)
        startup_layout.addSpacing(6)
        startup_layout.addWidget(self._section_title("工作区注册表"))
        startup_layout.addWidget(self.workspace_table)
        startup_layout.addWidget(QLabel("默认工作区仅用于未指定 workspace_id 的调用，不限制其他工作区执行。"))
        workspace_buttons = QHBoxLayout()
        workspace_buttons.setSpacing(BUTTON_SPACING)
        workspace_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        workspace_buttons.addWidget(self.workspace_button)
        workspace_buttons.addWidget(self.delete_workspace_button)
        workspace_buttons.addWidget(self.rename_workspace_button)
        workspace_buttons.addWidget(self.set_current_workspace_button)
        startup_layout.addLayout(workspace_buttons)
        startup_layout.addSpacing(6)
        startup_layout.addWidget(self._section_title("配置"))
        config_buttons = QHBoxLayout()
        config_buttons.setSpacing(BUTTON_SPACING)
        config_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        config_buttons.addWidget(self.open_config_button)
        config_buttons.addWidget(self.backup_config_button)
        config_buttons.addWidget(self.validate_config_button)
        startup_layout.addLayout(config_buttons)
        oauth_buttons = QHBoxLayout()
        oauth_buttons.setSpacing(BUTTON_SPACING)
        oauth_buttons.setAlignment(Qt.AlignmentFlag.AlignLeft)
        oauth_buttons.addWidget(self.refresh_oauth_button)
        oauth_buttons.addWidget(self.reset_oauth_button)
        oauth_buttons.addWidget(self.delete_oauth_button)
        startup_layout.addWidget(self._section_title("OAuth 操作"))
        startup_layout.addLayout(oauth_buttons)
        startup_layout.addWidget(self.message_label)
        startup_layout.addWidget(self._section_title("运行日志"))
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
        capability_layout.addWidget(self._section_title("能力详细状态"))
        capability_layout.addWidget(self._row("诊断状态：", self.doctor_status))
        capability_layout.addWidget(self._row("浏览器详情：", self.browser_diagnostic_status))
        capability_layout.addWidget(self._row("Desktop 诊断：", self.desktop_sync_status))
        capability_layout.addWidget(self._row("执行能力诊断：", self.capability_status))
        capability_layout.addWidget(self.capability_timeline_content)

        task_layout = QVBoxLayout()
        task_layout.setContentsMargins(CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN, CONTENT_MARGIN)
        task_layout.setSpacing(CONTENT_SPACING)
        task_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        maintenance = QHBoxLayout()
        maintenance.setSpacing(BUTTON_SPACING)
        maintenance.setAlignment(Qt.AlignmentFlag.AlignLeft)
        maintenance.addWidget(self.clear_task_cache_button)
        maintenance.addWidget(self.clear_persisted_task_button)
        task_layout.addLayout(maintenance)
        task_layout.addWidget(self.execution_table)
        task_layout.addWidget(self._row("当前查询工作区：", self.query_workspace_label))
        task_layout.addWidget(self.open_codex_task_button)
        self.session_viewer_content = QWidget()
        session_viewer_layout = QVBoxLayout(self.session_viewer_content)
        session_viewer_layout.setContentsMargins(0, 0, 0, 0)
        session_viewer_layout.addWidget(self._section_title("Execution"))
        session_viewer_layout.addWidget(self.execution_details_label)
        session_viewer_layout.addWidget(self._section_title("Session"))
        session_viewer_layout.addWidget(self.session_details_label)
        task_layout.addWidget(self.session_viewer_content)
        task_layout.addWidget(self._section_title("Event Stream"))
        task_layout.addWidget(self.event_table)
        task_layout.addWidget(self.event_empty_label)
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
        self.tray_icon: QSystemTrayIcon | None = None
        self.tray_menu: QMenu | None = None
        self._setup_tray_icon()

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
        self._render_query_workspace()
        self._render_execution_dashboard(())
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
    def _status_card(title: str, value: QLabel) -> QFrame:
        card = QFrame()
        card.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        card.setFrameShape(QFrame.Shape.StyledPanel)
        card.setFrameShadow(QFrame.Shadow.Plain)
        layout = QVBoxLayout(card)
        layout.setContentsMargins(10, 8, 10, 8)
        layout.setSpacing(4)
        layout.addWidget(QLabel(title))
        value.setWordWrap(True)
        value.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(value)
        return card

    def _setup_tray_icon(self) -> None:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        self.tray_icon = QSystemTrayIcon(self)
        icon = self.windowIcon()
        if icon.isNull():
            icon = QApplication.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon)
        self.tray_icon.setIcon(icon)
        self.tray_menu = QMenu(self)
        show_action = QAction("显示 Launcher", self.tray_menu)
        quit_action = QAction("退出 Launcher", self.tray_menu)
        show_action.triggered.connect(self.show_and_activate)
        quit_action.triggered.connect(self.close)
        self.tray_menu.addAction(show_action)
        self.tray_menu.addAction(quit_action)
        self.tray_icon.setContextMenu(self.tray_menu)
        self.tray_icon.activated.connect(self._tray_icon_activated)
        self.tray_icon.show()

    def show_and_activate(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    @Slot(QSystemTrayIcon.ActivationReason)
    def _tray_icon_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self.show_and_activate()

    def changeEvent(self, event) -> None:  # type: ignore[override]
        super().changeEvent(event)
        if (
            event.type() == QEvent.Type.WindowStateChange
            and self.isMinimized()
            and self.tray_icon is not None
        ):
            self.hide()

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
            self._cleared_execution_ids.clear()
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
        executions = tuple(
            execution
            for execution in getattr(status, "executions", ())
            if (
                execution.execution_id not in self._cleared_execution_ids
                or execution.status not in CLEARED_TERMINAL_EXECUTION_STATUSES
            )
        )
        self._last_status = replace(status, executions=executions)
        self._set_status(self.mcp_status, "运行中" if status.mcp_running else "未运行", status.mcp_running)
        self._set_status(
            self.tunnel_status,
            "已连接" if status.tunnel_connected else "未连接",
            status.tunnel_connected,
            warning=status.mcp_running and not status.tunnel_connected,
        )
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
        browser_label = "已连接" if display_state == "READY" else (
            "未连接" if display_state == "DEGRADED" else {
                "extension_not_paired": "未配对",
                "extension_not_present": "未连接",
            }.get(browser.readiness_state, "不可用")
        )
        browser_color = "#16803c" if display_state == "READY" else (
            "#946200" if display_state == "DEGRADED" or browser.readiness_state in {
                "extension_not_paired", "extension_not_present",
            } else "#666666"
        )
        self._set_value(self.browser_status, browser_label, browser_color)
        browser_reason = self._localize_browser_text(browser.reason)
        browser_action = self._localize_browser_text(browser.action)
        browser_detail_label = {"READY": "已就绪", "DEGRADED": "降级", "NOT READY": "未就绪"}[display_state]
        browser_detail = browser_detail_label if display_state == "READY" else (
            f"{browser_detail_label}\n原因：{browser_reason}\n操作：{browser_action}"
        )
        self._set_value(self.browser_diagnostic_status, browser_detail, browser_color)
        self.browser_status.setToolTip("")
        desktop_sync = getattr(status, "desktop_sync", DesktopSyncStatus())
        desktop_capability = getattr(status, "desktop_capability", DesktopCapabilityStatus())
        capability = getattr(status, "capability", CapabilityStatus())
        self._render_capability_status(capability, status.mcp_running)
        self._set_value(self.execution_summary_status, *self._capability_summary(capability, status.mcp_running))
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
        pipe_source_ready = desktop_capability.ready and bool(desktop_capability.pipe_source)
        pipe_source_value = (
            desktop_capability.pipe_source
            if pipe_source_ready
            else "等待 Desktop 激活"
            if desktop_capability.pipe_state == "pending"
            else "不可用"
        )
        self._set_status(
            self.desktop_ipc_status,
            "已连接" if desktop_sync.connected else "已断开",
            desktop_sync.connected,
        )
        self._set_status(
            self.desktop_identity_status,
            identity_state,
            desktop_sync.connected and bool(desktop_sync.owner_client_id),
            warning=desktop_sync.connected and not desktop_sync.owner_client_id,
        )
        self._set_status(
            self.tools_pipe_status,
            pipe_state,
            desktop_capability.pipe_state == "active",
            warning=desktop_capability.pipe_state == "pending",
        )
        self._set_status(
            self.pipe_source_status,
            pipe_source_value,
            pipe_source_ready,
            warning=desktop_capability.pipe_state == "pending",
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
            self._set_value(self.desktop_status, "不可用（Tools Pipe 未连接）", "#666666")
        elif not desktop_sync.connected:
            self.desktop_sync_status.setText("\n".join(["不可用", *capability_lines]))
            self.desktop_sync_status.setStyleSheet("color: #666666")
            self._set_value(self.desktop_status, "不可用", "#666666")
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
            self._set_value(self.desktop_status, "已连接", "#16803c")
        self._render_oauth_status(status.oauth_registry)
        self._render_execution_dashboard(executions)

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
    def _capability_summary(capability: CapabilityStatus, mcp_running: bool) -> tuple[str, str]:
        """Name the execution capability without downgrading a usable fallback path to "unavailable".

        The fail-closed default, which no execution has established, is the only state without a
        backend behind it, so it is the only one reported as a lost capability. A failed Desktop
        primary path is degraded rather than lost, because the standalone app-server fallback can
        still start an execution. A fallback state that failed on the standalone side is the one
        case where no backend is left, so that is what is reported as a lost capability.
        """

        if capability == CapabilityStatus():
            return ("当前空闲" if mcp_running else "MCP 已停止", "#666666")
        if capability.state == "desktop_ready":
            return "Desktop 可用", "#16803c"
        if capability.state in {"fallback_ready", "fallback_running"}:
            if capability.reason == "standalone_execution_failed":
                return "不可用", UNAVAILABLE_CAPABILITY_COLOR
            return "Standalone", DEGRADED_CAPABILITY_COLOR
        if capability.state == "desktop_failed":
            return DESKTOP_DOWN_FALLBACK_CAPABILITY_TEXT, DEGRADED_CAPABILITY_COLOR
        if capability.state in {"initializing", "desktop_pending"}:
            return "正在建立执行能力", DEGRADED_CAPABILITY_COLOR
        return "不可用", UNAVAILABLE_CAPABILITY_COLOR

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
            "afk_fallback_timeout": "用户未操作，已自动切换 Standalone",
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

    def _render_capability_status(
        self,
        capability: CapabilityStatus,
        mcp_running: bool = True,
    ) -> None:
        # The fail-closed default is also what the status query returns when no execution is
        # active, so it is rendered as idle instead of a capability failure. A stopped runtime is
        # reported separately because it cannot be read at all.
        if capability == CapabilityStatus():
            self.capability_status.setText(IDLE_CAPABILITY_TEXT if mcp_running else STOPPED_CAPABILITY_TEXT)
            self.capability_status.setStyleSheet("color: #666666")
            return
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
            "fallback_ready": "Standalone 备用路径已选择"
            if capability.reason != "standalone_execution_failed"
            else "Standalone 备用路径不可用",
            "fallback_running": "Standalone 备用后端运行中",
        }.get(capability.state, capability.state or "未知")
        capability_hint = {
            "unavailable": "MCP 未报告可用的执行后端。",
            "initializing": "正在等待当前执行能力。",
            "desktop_pending": "正在等待 Desktop 接管。",
            "desktop_ready": "Desktop 能力已就绪。",
            "desktop_failed": "Desktop 连接失败，请选择继续等待或使用 Standalone。",
            "fallback_ready": "已选择 Standalone 备用路径。",
            "fallback_running": "Standalone 备用后端运行中。",
        }.get(capability.state, "执行能力状态未报告。")
        if capability.state == "fallback_ready" and capability.reason == "standalone_execution_failed":
            capability_hint = "Standalone 备用后端也不可用，当前没有可执行的执行路径。"
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
            capability_lines.append("Desktop：失败（Standalone 备用后端仍可执行）")
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
        # A failed Desktop path and a failed standalone path are told apart on purpose: the first
        # still has a backend to execute on, the second leaves nothing to start an execution with.
        no_usable_backend = (
            capability.reason == "standalone_execution_failed"
            or not capability.state.startswith(("initializing", "desktop_", "fallback_"))
        )
        self.capability_status.setStyleSheet(
            "color: #16803c" if capability.state in {"desktop_ready", "fallback_running"}
            and not no_usable_backend
            else UNAVAILABLE_CAPABILITY_COLOR if no_usable_backend
            else DEGRADED_CAPABILITY_COLOR
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
            LauncherWindow._set_value(self.oauth_status_label, "不可用", "#666666")
            return
        LauncherWindow._set_value(
            self.oauth_status_label,
            "正常" if status.loaded else "未配置",
            "#16803c" if status.loaded else "#666666",
        )

    def _render_workspace_registry(self) -> None:
        self.workspace_table.setRowCount(0)
        active_row = -1
        for row, record in enumerate(self.configuration.workspaces):
            self.workspace_table.insertRow(row)
            self.workspace_table.setItem(
                row, 0, QTableWidgetItem("✓" if record.id == self.configuration.active_workspace_id else "")
            )
            self.workspace_table.setItem(row, 1, QTableWidgetItem(record.id))
            self.workspace_table.setItem(row, 2, QTableWidgetItem(record.name))
            self.workspace_table.setItem(row, 3, QTableWidgetItem(record.path))
            if record.id == self.configuration.active_workspace_id:
                active_row = row
        self.workspace_table.resizeColumnsToContents()
        if active_row >= 0:
            self.workspace_table.selectRow(active_row)

    def _render_query_workspace(self) -> None:
        record = next(
            (
                record
                for record in self.configuration.workspaces
                if record.id == self.configuration.active_workspace_id
            ),
            None,
        )
        if record is None:
            self.query_workspace_label.setText("未配置")
            return
        self.query_workspace_label.setText(f"{record.name}（{record.id}）")

    def _selected_workspace_id(self) -> str | None:
        row = self.workspace_table.currentRow()
        item = self.workspace_table.item(row, 1) if row >= 0 else None
        return item.text() if item is not None else None

    def _selected_execution(self) -> ExecutionViewModel | None:
        row = self.execution_table.currentRow()
        return self._execution_view_models[row] if 0 <= row < len(self._execution_view_models) else None

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

    def _render_execution_dashboard(self, executions: tuple[ExecutionViewModel, ...]) -> None:
        selected = self._selected_execution()
        selected_id = selected.execution_id if selected is not None else None
        self._execution_view_models = tuple(executions)
        self.execution_table.blockSignals(True)
        try:
            self.execution_table.setRowCount(0)
            for row, execution in enumerate(self._execution_view_models):
                self.execution_table.insertRow(row)
                values = (
                    execution.name,
                    execution.display_mode,
                    execution.backend_label,
                    execution.status,
                    execution.workspace_id,
                    self._format_timestamp(execution.started_at),
                    self._format_timestamp(execution.finished_at),
                )
                for column, value in enumerate(values):
                    self.execution_table.setItem(row, column, QTableWidgetItem(value))
                status_item = self.execution_table.item(row, 3)
                if status_item is not None:
                    status_item.setForeground(QColor(
                        EXECUTION_STATUS_COLORS.get(execution.status, UNKNOWN_STATUS_COLOR)
                    ))
            self.execution_table.resizeColumnsToContents()
            self.execution_table.clearSelection()
            self.execution_table.setCurrentCell(-1, -1)
            if selected_id is not None:
                for row, execution in enumerate(self._execution_view_models):
                    if execution.execution_id == selected_id:
                        self.execution_table.selectRow(row)
                        break
        finally:
            self.execution_table.blockSignals(False)
        self._render_selected_execution()

    def _render_selected_execution(self) -> None:
        execution = self._selected_execution()
        if execution is None:
            self._clear_execution_view()
            return

        self.open_codex_task_button.setEnabled(True)
        self.execution_details_label.setText("\n".join([
            f"执行 ID：{execution.execution_id}",
            f"目标：{execution.goal_name or '—'}（{execution.goal_id or '—'}）",
            f"任务：{execution.task_name or '—'}（{execution.task_id}）",
            f"工作区：{execution.workspace_id}",
            f"模式：{execution.display_mode}",
            f"后端：{execution.backend_label}（{execution.backend or '—'}）",
            f"状态：{execution.status}",
            f"开始时间：{self._format_timestamp(execution.started_at)}",
            f"结束时间：{self._format_timestamp(execution.finished_at)}",
            f"摘要：{execution.summary or '—'}",
        ]))
        session = execution.session
        # A batch Execution has no Session and no event stream; both stay explicit instead of
        # being rendered as an empty Session.
        self.session_details_label.setText(NO_SESSION_TEXT if session is None else "\n".join([
            f"Session：{session.session_id}",
            f"Thread：{session.thread_id or '—'}",
            f"Model：{session.model or '—'}",
            f"Reasoning：{session.reasoning_effort or '—'}",
            f"更新时间：{self._format_timestamp(session.updated_at)}",
        ]))
        self.event_empty_label.setVisible(session is None)

        # Aggregate before limiting rows so a retained stream keeps all its text.
        rows = deque(maxlen=MAX_EVENT_STREAM_ROWS)
        # Session identity is already validated when building execution.events.
        for identity, group in groupby(execution.events, key=lambda event: (
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

    def _clear_execution_view(self) -> None:
        self.open_codex_task_button.setEnabled(False)
        self.session_details_label.setText("请选择执行查看详情。")
        self.execution_details_label.setText("执行：—")
        self.event_empty_label.setVisible(False)
        self.event_table.setRowCount(0)

    def clear_task_cache(self) -> None:
        self._cleared_execution_ids.update(
            execution.execution_id for execution in self._execution_view_models
        )
        self._status_check_generation += 1
        self._execution_view_models = ()
        self._last_status = replace(self._last_status, executions=())
        self.execution_table.setRowCount(0)
        self._clear_execution_view()
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
            "删除当前工作区中已结束的 Execution，以及关联且已结束的 Session 和 Event？\n"
            "没有其它需要保留的记录时会同时删除 Task。运行中的 Execution 和 Session 会保留。\n\n继续吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        result = self.status_checker.clear_persisted_task_records()
        if result is None:
            self._show_error("无法清理持久化任务记录。")
            return
        self.clear_task_cache()
        self.message_label.setText(
            f"已清理 Execution {result.deleted_executions} 条、Session {result.deleted_sessions} 条、"
            f"Event {result.deleted_events} 条、Task {result.deleted_tasks} 条。"
        )
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
        execution = self._selected_execution()
        if execution is None or not execution.can_open_codex_task:
            return
        QMessageBox.information(
            self,
            "线程信息",
            f"线程 ID：{execution.thread_id or '—'}\n"
            f"会话 ID：{execution.session_id or '—'}",
        )

    def _render_runtime_info(self) -> None:
        try:
            info = self.config_manager.runtime_info(self.configuration)
        except LauncherConfigError:
            self._set_value(self.remote_status, "未配置", "#666666")
            return
        endpoint = getattr(info, "remote_endpoint", "") or "未配置"
        self._set_value(self.remote_status, endpoint, "#333333")

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
        self._set_value(self.launcher_state, labels[state], colors[state])

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
    def _set_value(label: QLabel, text: str, color: str) -> None:
        label.setText(text)
        label.setStyleSheet(f"color: {color}")

    @staticmethod
    def _set_status(label: QLabel, text: str, healthy: bool, warning: bool = False) -> None:
        color = "#16803c" if healthy else "#946200" if warning else "#666666"
        LauncherWindow._set_value(label, text, color)

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
        missing = [
            record
            for record in self.configuration.workspaces
            if not Path(record.path).is_dir()
        ]
        if missing:
            self._show_error(
                "以下工作区目录不存在，MCP 无法启动：\n"
                + "\n".join(f"· {record.name}：{record.path}" for record in missing)
                + "\n\n请在工作区列表中删除这些记录后重试。"
            )
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
        self._render_query_workspace()
        self.message_label.setText("工作区已添加并设为默认工作区，将在下次启动 MCP 时生效。")
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
        self._render_query_workspace()
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
        self._render_query_workspace()
        self.message_label.setText("工作区名称已保存。")
        self.refresh_status()

    def set_current_workspace(self) -> None:
        workspace_id = self._selected_workspace_id()
        if workspace_id is None:
            self._show_error("请选择要设为默认工作区的项目。")
            return
        try:
            self.configuration = self.config_manager.set_active_workspace(self.configuration, workspace_id)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self.status_checker.workspace_id = self.configuration.active_workspace_id
        self._render_workspace_registry()
        self._render_query_workspace()
        self.message_label.setText("默认工作区已保存，将在下次启动 MCP 时生效。")
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
        try:
            self.process_manager.stop()
        except RuntimeError:
            pass
        if self.tray_icon is not None:
            self.tray_icon.hide()
            self.tray_icon.setContextMenu(None)
            self.tray_icon.deleteLater()
            self.tray_icon = None
        event.accept()
        QApplication.quit()

    def _show_error(self, message: str) -> None:
        self.message_label.setText(message)
        QMessageBox.critical(self, "Local Review MCP 启动器", message)
