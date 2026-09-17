"""Runs launcher health checks outside the Qt GUI thread."""

from __future__ import annotations

from PySide6.QtCore import QObject, QRunnable, Signal

from status_checker import BrowserReadiness, LauncherStatus, StatusChecker


class StatusCheckScheduler:
    def __init__(self):
        self._source: str | None = None

    @property
    def in_progress(self) -> bool:
        return self._source is not None

    def begin(self, source: str) -> bool:
        if self.in_progress:
            return False
        self._source = source
        return True

    def finish(self) -> str | None:
        source = self._source
        self._source = None
        return source


class StatusCheckSignals(QObject):
    finished = Signal(int, object)


class StatusCheckWorker(QRunnable):
    def __init__(self, status_checker: StatusChecker, generation: int = 0):
        super().__init__()
        self.status_checker = status_checker
        self.generation = generation
        self.signals = StatusCheckSignals()

    def run(self) -> None:
        try:
            status = self.status_checker.check()
        except Exception:
            status = LauncherStatus(False, False, False)
        try:
            version = self.status_checker.cloudflared_version()
        except Exception:
            version = "unavailable"
        oauth_registry = None
        browser = BrowserReadiness()
        browser_readiness = getattr(self.status_checker, "browser_readiness", None)
        if status.mcp_running and callable(browser_readiness):
            try:
                browser = browser_readiness()
            except Exception:
                browser = BrowserReadiness()
        oauth_status = getattr(self.status_checker, "oauth_status", None)
        if status.mcp_running and callable(oauth_status):
            try:
                oauth_registry = oauth_status()
            except Exception:
                oauth_registry = None
        sessions = ()
        dashboard_sessions = getattr(self.status_checker, "dashboard_sessions", None)
        if status.mcp_running and callable(dashboard_sessions):
            try:
                sessions = dashboard_sessions()
            except Exception:
                sessions = ()
        status = LauncherStatus(
            status.mcp_running,
            status.tunnel_connected,
            status.remote_online,
            version if isinstance(version, str) else "unavailable",
            oauth_registry,
            sessions,
            browser,
        )
        self.signals.finished.emit(self.generation, status)
