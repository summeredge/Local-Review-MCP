"""PySide6 user interface for the Local Review MCP launcher."""

from __future__ import annotations

import os
from datetime import datetime
from enum import Enum
from pathlib import Path
from time import monotonic

from PySide6.QtCore import QThreadPool, QTimer, Slot
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
    QTableWidget,
    QTableWidgetItem,
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
from status_checker import LauncherStatus, StatusChecker
from status_worker import StatusCheckScheduler, StatusCheckWorker


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
        self._status_check_scheduler = StatusCheckScheduler()
        self._status_check_generation = 0
        self._status_thread_pool = QThreadPool(self)
        self._status_thread_pool.setMaxThreadCount(1)
        self._closing = False
        self._startup_started_at: float | None = None

        self.setWindowTitle("Local Review MCP Launcher")
        self.setMinimumWidth(460)
        self.launcher_state = QLabel()
        self.mcp_status = QLabel()
        self.tunnel_status = QLabel()
        self.remote_status = QLabel()
        self.workspace_label = QLabel()
        self.workspace_label.setWordWrap(True)
        self.runtime_workspace_label = QLabel()
        self.runtime_workspace_label.setWordWrap(True)
        self.production_config_label = QLabel()
        self.production_config_label.setWordWrap(True)
        self.tunnel_mode_label = QLabel()
        self.remote_endpoint_label = QLabel()
        self.remote_endpoint_label.setWordWrap(True)
        self.cloudflared_version_label = QLabel("unavailable")
        self.workspace_table = QTableWidget(0, 3)
        self.workspace_table.setHorizontalHeaderLabels(["Workspace ID", "名称", "路径"])
        self.workspace_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.workspace_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.workspace_table.horizontalHeader().setStretchLastSection(True)
        self.workspace_table.setMinimumHeight(120)
        self.message_label = QLabel()
        self.message_label.setWordWrap(True)
        self.log_output = QPlainTextEdit()
        self.log_output.setReadOnly(True)
        self.log_output.setMaximumHeight(220)

        self.start_button = QPushButton("启动 MCP")
        self.stop_button = QPushButton("停止 MCP")
        self.refresh_button = QPushButton("刷新状态")
        self.workspace_button = QPushButton("添加 Workspace")
        self.delete_workspace_button = QPushButton("删除 Workspace")
        self.rename_workspace_button = QPushButton("编辑名称")
        self.set_current_workspace_button = QPushButton("设为当前")
        self.open_config_button = QPushButton("打开配置文件")
        self.backup_config_button = QPushButton("备份配置")
        self.validate_config_button = QPushButton("校验配置")
        self.copy_log_button = QPushButton("复制日志")
        self.clear_log_button = QPushButton("清空显示")
        self.save_log_button = QPushButton("保存日志")
        self.start_button.clicked.connect(self.start_mcp)
        self.stop_button.clicked.connect(self.stop_mcp)
        self.refresh_button.clicked.connect(self.refresh_status)
        self.workspace_button.clicked.connect(self.choose_workspace)
        self.delete_workspace_button.clicked.connect(self.delete_workspace)
        self.rename_workspace_button.clicked.connect(self.rename_workspace)
        self.set_current_workspace_button.clicked.connect(self.set_current_workspace)
        self.open_config_button.clicked.connect(self.open_config)
        self.backup_config_button.clicked.connect(self.backup_config)
        self.validate_config_button.clicked.connect(self.validate_config)
        self.copy_log_button.clicked.connect(self.copy_log)
        self.clear_log_button.clicked.connect(self.clear_log)
        self.save_log_button.clicked.connect(self.save_log)

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
        layout.addWidget(QLabel("Workspace Registry"))
        layout.addWidget(self.workspace_table)
        workspace_buttons = QHBoxLayout()
        workspace_buttons.addWidget(self.workspace_button)
        workspace_buttons.addWidget(self.delete_workspace_button)
        workspace_buttons.addWidget(self.rename_workspace_button)
        workspace_buttons.addWidget(self.set_current_workspace_button)
        layout.addLayout(workspace_buttons)
        layout.addSpacing(8)
        layout.addWidget(QLabel("运行信息"))
        layout.addWidget(self._row("Workspace:", self.runtime_workspace_label))
        layout.addWidget(self._row("Production Config:", self.production_config_label))
        layout.addWidget(self._row("Tunnel Mode:", self.tunnel_mode_label))
        layout.addWidget(self._row("Remote Endpoint:", self.remote_endpoint_label))
        layout.addWidget(self._row("cloudflared Version:", self.cloudflared_version_label))
        layout.addSpacing(8)
        layout.addWidget(self.start_button)
        layout.addWidget(self.stop_button)
        layout.addWidget(self.refresh_button)
        layout.addSpacing(8)
        layout.addWidget(QLabel("配置"))
        config_buttons = QHBoxLayout()
        config_buttons.addWidget(self.open_config_button)
        config_buttons.addWidget(self.backup_config_button)
        config_buttons.addWidget(self.validate_config_button)
        layout.addLayout(config_buttons)
        layout.addWidget(self.message_label)
        layout.addWidget(QLabel("Startup log:"))
        layout.addWidget(self.log_output)
        log_buttons = QHBoxLayout()
        log_buttons.addWidget(self.copy_log_button)
        log_buttons.addWidget(self.clear_log_button)
        log_buttons.addWidget(self.save_log_button)
        layout.addLayout(log_buttons)
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
        self._render_workspace_registry()
        self._render_runtime_info()
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
        if self.state == LauncherState.STARTING:
            return
        self._render_runtime_info()
        self._request_status_check("normal")

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
        self._last_status = status
        self._set_status(self.mcp_status, "Running" if status.mcp_running else "Stopped", status.mcp_running)
        self._set_status(self.tunnel_status, "Connected" if status.tunnel_connected else "Offline", status.tunnel_connected)
        self._set_status(self.remote_status, "Online" if status.remote_online else "Offline", status.remote_online)
        self.workspace_label.setText(self._current_workspace_text())
        self.cloudflared_version_label.setText(getattr(status, "cloudflared_version", "unavailable"))

    def _current_workspace_text(self) -> str:
        if not self.configuration.workspace:
            return "Not configured"
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

    def _render_runtime_info(self) -> None:
        try:
            info = self.config_manager.runtime_info(self.configuration)
        except LauncherConfigError:
            self.runtime_workspace_label.setText(self.configuration.workspace or "Not configured")
            self.production_config_label.setText(str(self.config_manager.production_path(self.configuration.config_file)))
            self.tunnel_mode_label.setText("unavailable")
            self.remote_endpoint_label.setText(DEFAULT_REMOTE_ENDPOINT)
            return
        self.runtime_workspace_label.setText(info.workspace or "Not configured")
        self.production_config_label.setText(str(info.production_config))
        self.tunnel_mode_label.setText(info.tunnel_mode)
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
                "MCP startup timeout. Check logs.\n"
                "Startup timeout: local MCP or tunnel may still be running."
            )
        elif status.mcp_running and status.tunnel_connected and status.remote_online:
            self.startup_timer.stop()
            self.timer.start(5_000)
            self._startup_started_at = None
            self._set_state(LauncherState.RUNNING)
            self.message_label.setText("MCP started successfully.")

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
        self._status_check_generation += 1
        self.timer.stop()
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
        self._poll_startup()

    def stop_mcp(self) -> None:
        if self.state == LauncherState.STOPPING:
            return
        self.startup_timer.stop()
        self.timer.stop()
        self._status_check_generation += 1
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
            self.timer.start(5_000)

    def choose_workspace(self) -> None:
        initial = self.configuration.workspace if self.configuration.workspace and Path(self.configuration.workspace).is_dir() else ""
        selected = QFileDialog.getExistingDirectory(self, "选择 Workspace", initial)
        if not selected:
            return
        try:
            self.configuration = self.config_manager.add_workspace(self.configuration, Path(selected))
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self._render_workspace_registry()
        self.message_label.setText("Workspace added and set as current. It will be used on the next MCP start.")
        self.refresh_status()

    def delete_workspace(self) -> None:
        workspace_id = self._selected_workspace_id()
        if workspace_id is None:
            self._show_error("Select a Workspace to delete.")
            return
        record = next(
            (record for record in self.configuration.workspaces if record.id == workspace_id),
            None,
        )
        if record is None:
            self._show_error("The selected Workspace is no longer registered.")
            return
        answer = QMessageBox.question(
            self,
            "删除 Workspace",
            f"只删除 Registry 中的记录，不会删除磁盘目录：\n{record.name}\n{record.path}\n\n继续吗？",
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
        self._render_workspace_registry()
        self.message_label.setText("Workspace removed from the Registry. The directory was kept.")
        self.refresh_status()

    def rename_workspace(self) -> None:
        workspace_id = self._selected_workspace_id()
        if workspace_id is None:
            self._show_error("Select a Workspace to rename.")
            return
        record = next(
            (record for record in self.configuration.workspaces if record.id == workspace_id),
            None,
        )
        if record is None:
            self._show_error("The selected Workspace is no longer registered.")
            return
        name, accepted = QInputDialog.getText(self, "编辑 Workspace 名称", "名称：", text=record.name)
        if not accepted:
            return
        try:
            self.configuration = self.config_manager.rename_workspace(self.configuration, workspace_id, name)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self._render_workspace_registry()
        self.message_label.setText("Workspace name saved.")
        self.refresh_status()

    def set_current_workspace(self) -> None:
        workspace_id = self._selected_workspace_id()
        if workspace_id is None:
            self._show_error("Select a Workspace to make current.")
            return
        try:
            self.configuration = self.config_manager.set_active_workspace(self.configuration, workspace_id)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self._render_workspace_registry()
        self.message_label.setText("Current Workspace saved. It will be used on the next MCP start.")
        self.refresh_status()

    def open_config(self) -> None:
        path = self.config_manager.production_path(self.configuration.config_file)
        if not path.is_file():
            self._show_error(f"Production configuration was not found: {path}")
            return
        try:
            opener = getattr(os, "startfile")
            opener(str(path))
        except (AttributeError, OSError) as error:
            self._show_error(f"Could not open production configuration: {error}")

    def backup_config(self) -> None:
        try:
            path = self.config_manager.backup_production_config(self.configuration)
        except LauncherConfigError as error:
            self._show_error(str(error))
            return
        self.message_label.setText(f"Configuration backup created:\n{path}")

    def validate_config(self) -> None:
        errors = self.config_manager.validate_production_config(self.configuration)
        if errors:
            self.message_label.setText("Configuration validation failed:\n\n" + "\n".join(f"- {error}" for error in errors))
        else:
            self.message_label.setText("Configuration valid.")

    def copy_log(self) -> None:
        QApplication.clipboard().setText(self.log_output.toPlainText())
        self.message_label.setText("Log copied to clipboard.")

    def clear_log(self) -> None:
        self.log_output.clear()

    def save_log(self) -> None:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        default_name = f"local-review-mcp-launcher-{timestamp}.log"
        path, _ = QFileDialog.getSaveFileName(self, "保存日志", default_name, "Log files (*.log);;All files (*)")
        if not path:
            return
        try:
            with Path(path).open("w", encoding="utf-8", newline="\n") as stream:
                stream.write(self.log_output.toPlainText())
        except OSError as error:
            self._show_error(f"Could not save log: {error}")
            return
        self.message_label.setText(f"Log saved to:\n{path}")

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self._closing = True
        self._status_check_generation += 1
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
