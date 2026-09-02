"""PySide6 user interface for the Local Review MCP launcher."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from config_manager import ConfigManager, LauncherConfig, LauncherConfigError
from process_manager import ProductionProcessManager
from status_checker import StatusChecker


class LauncherWindow(QMainWindow):
    def __init__(self, project_root: Path, config_manager: ConfigManager):
        super().__init__()
        self.config_manager = config_manager
        self.configuration: LauncherConfig = config_manager.load()
        self.process_manager = ProductionProcessManager(project_root, config_manager)
        self.status_checker = StatusChecker()

        self.setWindowTitle("Local Review MCP Launcher")
        self.setMinimumWidth(460)
        self.mcp_status = QLabel()
        self.tunnel_status = QLabel()
        self.remote_status = QLabel()
        self.workspace_label = QLabel()
        self.workspace_label.setWordWrap(True)
        self.message_label = QLabel()
        self.message_label.setWordWrap(True)

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
        container = QWidget()
        container.setLayout(layout)
        self.setCentralWidget(container)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh_status)
        self.timer.start(5_000)
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
        status = self.status_checker.check()
        self._set_status(self.mcp_status, "Running" if status.mcp_running else "Stopped", status.mcp_running)
        self._set_status(self.tunnel_status, "Connected" if status.tunnel_connected else "Offline", status.tunnel_connected)
        self._set_status(self.remote_status, "Online" if status.remote_online else "Offline", status.remote_online)
        self.workspace_label.setText(self.configuration.workspace or "Not configured")
        self.start_button.setEnabled(not status.mcp_running and not self.process_manager.is_running)
        self.stop_button.setEnabled(status.mcp_running or self.process_manager.is_running)
        self.workspace_button.setEnabled(not status.mcp_running and not self.process_manager.is_running)
        if self.process_manager.failure_reason:
            self.message_label.setText(self.process_manager.failure_reason)

    @staticmethod
    def _set_status(label: QLabel, text: str, healthy: bool) -> None:
        color = "#16803c" if healthy else "#9b1c1c"
        label.setText(f'<span style="color: {color}">●</span> {text}')

    def start_mcp(self) -> None:
        if not self.configuration.workspace:
            self._show_error("Select an existing workspace before starting MCP.")
            return
        if not Path(self.configuration.workspace).is_dir():
            self._show_error(f"Workspace is not an existing directory: {self.configuration.workspace}")
            return
        try:
            self.process_manager.start(self.configuration)
        except (LauncherConfigError, RuntimeError) as error:
            self._show_error(str(error))
            return
        self.message_label.setText("Starting the existing production startup flow...")
        self.refresh_status()

    def stop_mcp(self) -> None:
        try:
            self.message_label.setText(self.process_manager.stop())
        except RuntimeError as error:
            self._show_error(str(error))
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
        if self.process_manager.is_running:
            try:
                self.process_manager.stop()
            except RuntimeError:
                pass
        event.accept()

    def _show_error(self, message: str) -> None:
        self.message_label.setText(message)
        QMessageBox.critical(self, "Local Review MCP Launcher", message)
