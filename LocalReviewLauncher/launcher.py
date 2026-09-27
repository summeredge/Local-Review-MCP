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
TIMEOUT_MS = 500


def _write_message(socket, payload: bytes) -> bool:
    """Write a full message; False when any byte failed to leave the socket."""
    if socket.write(payload) != len(payload):
        return False
    if not socket.flush():
        return False
    # waitForBytesWritten() returns False when the buffer is already empty, so it
    # is only meaningful while bytes are still pending.
    if socket.bytesToWrite() and not socket.waitForBytesWritten(TIMEOUT_MS):
        return False
    return True


def _read_available(socket) -> bytes | None:
    """Consume buffered bytes, waiting for new ones only when nothing is buffered.

    Data can already sit in the socket buffer when this runs, and no fresh
    readyRead will ever fire for it, so buffered bytes must be drained first.
    Returns None on timeout.
    """
    if socket.bytesAvailable() <= 0 and not socket.waitForReadyRead(TIMEOUT_MS):
        return None
    return bytes(socket.readAll())


def _read_activation_ack(socket) -> bool:
    """True only when the exact ACTIVATION_ACK arrives before the timeout."""
    buffer = bytearray()
    while True:
        if buffer == ACTIVATION_ACK:
            return True
        # A longer or diverging payload can never become the exact ACK.
        if not ACTIVATION_ACK.startswith(buffer):
            return False
        chunk = _read_available(socket)
        if chunk is None:
            return False
        buffer += chunk


def _send_activation_request() -> bool:
    """Activate an existing instance; True only after a completed activate/ok handshake."""
    socket = QLocalSocket()
    socket.connectToServer(INSTANCE_NAME)
    if not socket.waitForConnected(TIMEOUT_MS):
        socket.abort()
        return False
    if not _write_message(socket, ACTIVATION_MESSAGE):
        socket.abort()
        return False
    if not _read_activation_ack(socket):
        socket.abort()
        return False
    socket.disconnectFromServer()
    return True


def _receive_activation_message(socket) -> bool:
    """Read exactly ACTIVATION_MESSAGE, tolerating fragmentation.

    Bounded by len(ACTIVATION_MESSAGE): never buffers more than the protocol
    needs, rejects as soon as the bytes diverge from the expected prefix, and
    gives up on the first timeout.
    """
    buffer = bytearray()
    while len(buffer) < len(ACTIVATION_MESSAGE):
        chunk = _read_available(socket)
        if chunk is None:
            return False
        buffer += chunk
        if not ACTIVATION_MESSAGE.startswith(bytes(buffer)):
            return False
    return True


def _read_activation_request(socket: QLocalSocket, activate) -> None:
    try:
        if not _receive_activation_message(socket):
            return
        activate()
        _write_message(socket, ACTIVATION_ACK)
    finally:
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
