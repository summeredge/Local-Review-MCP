"""Runs launcher health checks outside the Qt GUI thread."""

from __future__ import annotations

from PySide6.QtCore import QObject, QRunnable, Signal

from status_checker import (
    BrowserReadiness,
    CapabilityStatus,
    DoctorStatus,
    DesktopCapabilityStatus,
    DesktopSyncStatus,
    LauncherStatus,
    StatusChecker,
)


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


class DoctorCheckSignals(QObject):
    finished = Signal(int, object)


class DoctorCheckWorker(QRunnable):
    def __init__(self, status_checker: StatusChecker, generation: int = 0):
        super().__init__()
        self.status_checker = status_checker
        self.generation = generation
        self.signals = DoctorCheckSignals()

    def run(self) -> None:
        try:
            report = self.status_checker.doctor_report()
        except Exception:
            report = DoctorStatus()
        self.signals.finished.emit(self.generation, report if isinstance(report, DoctorStatus) else DoctorStatus())


class CapabilityTimelineCheckSignals(QObject):
    finished = Signal(int, object)


class CapabilityTimelineCheckWorker(QRunnable):
    def __init__(
        self,
        status_checker: StatusChecker,
        execution_id: str | None = None,
        limit: int = 100,
        generation: int = 0,
    ):
        super().__init__()
        self.status_checker = status_checker
        self.execution_id = execution_id
        self.limit = limit
        self.generation = generation
        self.signals = CapabilityTimelineCheckSignals()

    def run(self) -> None:
        try:
            events = self.status_checker.capability_timeline(self.execution_id, self.limit)
        except Exception:
            events = ()
        self.signals.finished.emit(self.generation, events if isinstance(events, tuple) else ())


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
        desktop_sync = DesktopSyncStatus()
        desktop_sync_status = getattr(self.status_checker, "desktop_sync_status", None)
        if status.mcp_running and callable(desktop_sync_status):
            try:
                candidate = desktop_sync_status()
                desktop_sync = candidate if isinstance(candidate, DesktopSyncStatus) else DesktopSyncStatus()
            except Exception:
                desktop_sync = DesktopSyncStatus()
        desktop_capability = DesktopCapabilityStatus()
        capability_status = getattr(self.status_checker, "desktop_capability_status", None)
        if status.mcp_running and callable(capability_status):
            try:
                candidate = capability_status()
                desktop_capability = (
                    candidate if isinstance(candidate, DesktopCapabilityStatus) else DesktopCapabilityStatus()
                )
            except Exception:
                desktop_capability = DesktopCapabilityStatus()
        capability = CapabilityStatus()
        capability_status = getattr(self.status_checker, "capability_status", None)
        if status.mcp_running and callable(capability_status):
            try:
                candidate = capability_status("current")
                capability = candidate if isinstance(candidate, CapabilityStatus) else CapabilityStatus()
            except Exception:
                capability = CapabilityStatus()
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
            mcp_running=status.mcp_running,
            tunnel_connected=status.tunnel_connected,
            remote_online=status.remote_online,
            cloudflared_version=version if isinstance(version, str) else "unavailable",
            oauth_registry=oauth_registry,
            sessions=sessions,
            browser=browser,
            desktop_sync=desktop_sync,
            desktop_capability=desktop_capability,
            capability=capability,
        )
        self.signals.finished.emit(self.generation, status)
