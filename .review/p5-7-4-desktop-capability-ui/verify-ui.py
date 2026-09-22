"""Renders the launcher Desktop block from the live runtime and from a blocked capability.

Read-only: it never posts a handoff. Both renders go through the real worker, the real status
checker and the real _render_status path, so the printed text is what the launcher shows.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "LocalReviewLauncher"))

from PySide6.QtWidgets import QApplication  # noqa: E402
from config_manager import ConfigManager, LauncherConfig  # noqa: E402
from gui import LauncherWindow  # noqa: E402
from status_checker import DesktopCapabilityStatus, LauncherStatus, StatusChecker  # noqa: E402
from status_worker import StatusCheckWorker  # noqa: E402

application = QApplication.instance() or QApplication([])
configuration = LauncherConfig(str(ROOT), "config.production.json", False)
launcher = ConfigManager(ROOT)
token = launcher.auth_token(configuration)
assert token, "the launcher auth token could not be read from the production config"

manager = Mock()
manager.load.return_value = LauncherConfig("", "config.production.json", False)
with patch("gui.ProductionProcessManager"), patch("gui.StatusChecker"), patch.object(
    LauncherWindow, "refresh_status"
), patch.object(LauncherWindow, "_render_runtime_info"):
    window = LauncherWindow(ROOT, manager)


def render(label: str, checker) -> None:
    results: list[LauncherStatus] = []
    worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
    worker.signals.finished.connect(lambda _generation, status: results.append(status))
    worker.run()
    status = results[-1]
    window._render_status(status)
    print(f"--- {label} ---")
    print(window.desktop_sync_status.text())
    print(f"desktop_capability={status.desktop_capability}")
    print()


live = StatusChecker(auth_token=token)
render("live runtime", live)

unreachable = StatusChecker(
    auth_token=token,
    desktop_capability_url="http://127.0.0.1:12099/launcher/desktop-interactive",
)
render("capability endpoint unreachable (fails closed)", unreachable)

restarted = SimpleNamespace(
    check=lambda: LauncherStatus(True, True, True),
    desktop_sync_status=live.desktop_sync_status,
    desktop_capability_status=lambda: DesktopCapabilityStatus(),
)
render("runtime restarted, no handoff accepted yet", restarted)

window.close()
