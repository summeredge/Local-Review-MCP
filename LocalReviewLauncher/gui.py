"""PySide6 user interface for the Local Review MCP launcher."""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from time import monotonic

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from config_manager import ConfigManager, LauncherConfig, LauncherConfigError
from process_manager import ProductionProcessManager
from status_checker import LauncherStatus, StatusChecker


STARTUP_TIMEOUT_SECONDS = 60
STARTUP_POLL_INTERVAL_MS = 2_000


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
        self.status_checker = StatusChecker()
        self.state = LauncherState.STOPPED
        self._last_status = LauncherStatus(False, False, False)
        self._startup_started_at: float | None = None

        self.setWindowTitle("Local Review MCP Launcher")
        self.setMinimumWidth(460)
        self.launcher_state = QLabel()
        self.mcp_status = QLabel()
        self.tunnel_status = QLabel()
        self.remote_status = QLabel()
        self.workspace_label = QLabel()
        self.workspace_label.setWordWrap(True)
        self.message_label = QLabel()
        self.message_label.setWordWrap(True)
        self.log_output = QPlainTextEdit()
        self.log_output.setReadOnly(True)
        self.log_output.setMaximumHeight(220)

        self.start_button = QPushButton("启动 MCP")
        self.stop_button = QPushButton("停止 MCP")
        self.refresh_button = QPushButton("刷新状态")
        self.workspace_button = QPushButton("选择 Workspace")
        self.start_button.clicked.connect(self.start_mcp)
        self.stop_button.clicked.connect(self.stop_mcp)
        self.refresh_button.clicked.connect(self.refresh_status)
        self.workspace_button.clicked.connect(self.choose_workspace)

        layout = QVBoxLayout()
        title = QLabel("Local Review MCP")
        title.setStyleSheet("font-size: 18px; font-weight: 600;")
        layout.addWidget(title)
        layout.addWidget(self._row("Launcher State:", self.launcher_state))
        layout.addWidget(self._row("MCP Runtime:", self.mcp_status))
        layout.addWidget(self._row("Cloudflare Tunnel:", self.tunnel_status))
        layout.addWidget(self._row("Remote Endpoint:", self.remote_status))
        layout.addWidget(self._row("Workspace:", self.workspace_label))
        layout.addSpacing(8)
        layout.addWidget(self.start_button)
        layout.addWidget(self.stop_button)
        layout.addWidget(self.refresh_button)
        layout.addWidget(self.workspace_button)
        layout.addWidget(self.message_label)
        layout.addWidget(QLabel("Startup log:"))
        layout.addWidget(self.log_output)
        container = QWidget()
        container.setLayout(layout)
        self.setCentralWidget(container)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh_status)
        self.timer.start(5_000)
        self.startup_timer = QTimer(self)
        self.startup_timer.setInterval(STARTUP_POLL_INTERVAL_MS)
        self.startup_timer.timeout.connect(self._poll_startup)
        self._set_state(LauncherState.STOPPED)
        self.refresh_status()
        if self.configuration.auto_start:
            QTimer.singleShot(0, self.start_mcp)

    @staticmethod
    def _row(name: str, value: QLabel) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        label = QLabel(name)
        label.setMinimumWidth(140)
        layout.addWidget(label)
        layout.addWidget(value, 1)
        return row

    def refresh_status(self) -> None:
        status = self._read_status()
        self._render_status(status)
        self._update_log()
        self._apply_controls(status)

    def _read_status(self) -> LauncherStatus:
        try:
            return self.status_checker.check()
        except Exception as error:
            self.message_label.setText(f"Status check failed: {error}")
            return LauncherStatus(False, False, False)

    def _render_status(self, status: LauncherStatus) -> None:
        self._last_status = status
        self._set_status(self.mcp_status, "Running" if status.mcp_running else "Stopped", status.mcp_running)
        self._set_status(self.tunnel_status, "Connected" if status.tunnel_connected else "Offline", status.tunnel_connected)
        self._set_status(self.remote_status, "Online" if status.remote_online else "Offline", status.remote_online)
        self.workspace_label.setText(self.configuration.workspace or "Not configured")

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

    def _set_state(self, state: LauncherState) -> None:
        self.state = state
        colors = {
            LauncherState.STOPPED: "#666666",
            LauncherState.STARTING: "#9a6700",
            LauncherState.RUNNING: "#16803c",
            LauncherState.STOPPING: "#9a6700",
            LauncherState.FAILED: "#9b1c1c",
        }
        self.launcher_state.setText(f'<span style="color: {colors[state]}">●</span> {state.value}')

    def _poll_startup(self) -> None:
        if self.state != LauncherState.STARTING:
            self.startup_timer.stop()
            return

        status = self._read_status()
        self._render_status(status)
        self._update_log()
        failure_reason = self.process_manager.failure_reason
        timed_out = self._startup_started_at is not None and monotonic() - self._startup_started_at >= STARTUP_TIMEOUT_SECONDS
        if failure_reason and not status.mcp_running:
            self._fail_startup(failure_reason)
        elif timed_out:
            self._fail_startup("MCP startup timeout.\nCheck logs.")
        elif status.mcp_running and status.tunnel_connected and status.remote_online:
            self.startup_timer.stop()
            self._startup_started_at = None
            self._set_state(LauncherState.RUNNING)
            self.message_label.setText("MCP started successfully.")
        self._apply_controls(status)

    def _fail_startup(self, message: str) -> None:
        self.startup_timer.stop()
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
            self._show_error("Select an existing workspace before starting MCP.")
            return
        if not Path(self.configuration.workspace).is_dir():
            self._show_error(f"Workspace is not an existing directory: {self.configuration.workspace}")
            return
        if self._last_status.mcp_running:
            self._apply_controls(self._last_status)
            self.message_label.setText("MCP is already running.")
            return
        self._startup_started_at = monotonic()
        self._set_state(LauncherState.STARTING)
        self.message_label.setText("Starting the existing production startup flow...")
        self.start_button.setEnabled(False)
        self.stop_button.setEnabled(True)
        self.workspace_button.setEnabled(False)
        try:
            self.process_manager.start(self.configuration)
        except (LauncherConfigError, RuntimeError) as error:
            self._fail_startup(str(error))
            self._apply_controls(self._last_status)
            self._show_error(str(error))
            return
        self.startup_timer.start()
        self.refresh_status()

    def stop_mcp(self) -> None:
        if self.state == LauncherState.STOPPING:
            return
        self.startup_timer.stop()
        self._set_state(LauncherState.STOPPING)
        self.message_label.setText("Stopping MCP...")
        self.start_button.setEnabled(False)
        self.stop_button.setEnabled(False)
        self.workspace_button.setEnabled(False)
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

    def choose_workspace(self) -> None:
        initial = self.configuration.workspace if Path(self.configuration.workspace).is_dir() else ""
        selected = QFileDialog.getExistingDirectory(self, "选择 Workspace", initial)
        if not selected:
            return
        try:
            self.configuration = self.config_manager.save_workspace(self.configuration, Path(selected))
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self.message_label.setText("Workspace saved. It will be used on the next MCP start.")
        self.refresh_status()

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self.timer.stop()
        self.startup_timer.stop()
        if self.process_manager.has_started:
            try:
                self.process_manager.stop()
            except RuntimeError:
                pass
        event.accept()

    def _show_error(self, message: str) -> None:
        self.message_label.setText(message)
        QMessageBox.critical(self, "Local Review MCP Launcher", message)
