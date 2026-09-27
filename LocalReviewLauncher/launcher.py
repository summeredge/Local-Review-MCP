"""Local Review MCP Windows Launcher entry point."""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import QApplication, QMessageBox

from config_manager import ConfigManager, LauncherConfigError
from gui import LauncherWindow


INSTANCE_NAME = "LocalReviewMCPLauncher"
ACTIVATION_MESSAGE = b"activate"
ACTIVATION_ACK = b"ok"


def _send_activation_request() -> bool:
    socket = QLocalSocket()
    socket.connectToServer(INSTANCE_NAME)
    if not socket.waitForConnected(500):
        socket.abort()
        return False
    socket.write(ACTIVATION_MESSAGE)
    socket.flush()
    socket.waitForBytesWritten(500)
    socket.waitForReadyRead(500)
    socket.disconnectFromServer()
    return True


def _read_activation_request(socket: QLocalSocket, activate) -> None:
    if not socket.bytesAvailable() and not socket.waitForReadyRead(500):
        return
    if bytes(socket.readAll()).strip() == ACTIVATION_MESSAGE:
        activate()
        socket.write(ACTIVATION_ACK)
        socket.flush()
        socket.waitForBytesWritten(500)
    socket.disconnectFromServer()
    socket.deleteLater()


def _accept_connections(server: QLocalServer, activate) -> None:
    while server.hasPendingConnections():
        socket = server.nextPendingConnection()
        QTimer.singleShot(0, lambda socket=socket: _read_activation_request(socket, activate))


def _create_single_instance_server(activate) -> QLocalServer | None:
    server = QLocalServer()
    server.newConnection.connect(
        lambda: QTimer.singleShot(0, lambda: _accept_connections(server, activate))
    )
    if _send_activation_request():
        return None

    QLocalServer.removeServer(INSTANCE_NAME)
    if server.listen(INSTANCE_NAME):
        return server

    server.close()
    if _send_activation_request():
        return None
    QLocalServer.removeServer(INSTANCE_NAME)
    if server.listen(INSTANCE_NAME):
        return server
    raise RuntimeError(f"无法创建单实例服务：{server.errorString()}")


def main() -> int:
    project_root = Path(__file__).resolve().parent.parent
    application = QApplication(sys.argv)
    try:
        instance_server = _create_single_instance_server(
            lambda: window.show_and_activate()
        )
    except RuntimeError as error:
        QMessageBox.critical(None, "Local Review MCP Launcher", str(error))
        return 1
    if instance_server is None:
        return 0
    try:
        try:
            window = LauncherWindow(project_root, ConfigManager(project_root))
        except LauncherConfigError as error:
            QMessageBox.critical(None, "Local Review MCP Launcher", str(error))
            return 1
        window.show()
        return application.exec()
    finally:
        instance_server.close()
        QLocalServer.removeServer(INSTANCE_NAME)


if __name__ == "__main__":
    raise SystemExit(main())
