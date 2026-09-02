"""Local Review MCP Windows Launcher entry point."""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication, QMessageBox

from config_manager import ConfigManager, LauncherConfigError
from gui import LauncherWindow


def main() -> int:
    project_root = Path(__file__).resolve().parent.parent
    application = QApplication(sys.argv)
    try:
        window = LauncherWindow(project_root, ConfigManager(project_root))
    except LauncherConfigError as error:
        QMessageBox.critical(None, "Local Review MCP Launcher", str(error))
        return 1
    window.show()
    return application.exec()


if __name__ == "__main__":
    raise SystemExit(main())
