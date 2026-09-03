"""Minimal checks for asynchronous, read-only launcher status checks."""

from __future__ import annotations

import subprocess
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from PySide6.QtCore import QCoreApplication, QThreadPool
from status_checker import LauncherStatus, StatusChecker
from status_worker import StatusCheckScheduler, StatusCheckWorker


class StatusCheckSchedulerTests(unittest.TestCase):
    def test_rejects_a_second_check_until_the_first_finishes(self) -> None:
        scheduler = StatusCheckScheduler()

        self.assertTrue(scheduler.begin("normal"))
        self.assertFalse(scheduler.begin("startup"))
        self.assertEqual(scheduler.finish(), "normal")
        self.assertTrue(scheduler.begin("startup"))


class StatusCheckWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QCoreApplication.instance() or QCoreApplication([])

    def test_worker_returns_checker_status_without_lifecycle_calls(self) -> None:
        checker = SimpleNamespace(check=lambda: LauncherStatus(True, True, False))
        results: list[LauncherStatus] = []
        worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
        worker.signals.finished.connect(lambda _generation, status: results.append(status))

        worker.run()

        self.assertEqual(results, [LauncherStatus(True, True, False)])

    def test_worker_converts_checker_failure_to_offline(self) -> None:
        def check() -> LauncherStatus:
            raise TimeoutError("remote timeout")

        checker = SimpleNamespace(check=check)
        results: list[LauncherStatus] = []
        worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
        worker.signals.finished.connect(lambda _generation, status: results.append(status))

        worker.run()

        self.assertEqual(results, [LauncherStatus(False, False, False)])

    def test_worker_includes_cloudflared_version(self) -> None:
        checker = SimpleNamespace(
            check=lambda: LauncherStatus(True, True, False),
            cloudflared_version=lambda: "2026.8.2",
        )
        results: list[LauncherStatus] = []
        worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
        worker.signals.finished.connect(lambda _generation, status: results.append(status))

        worker.run()

        self.assertEqual(results, [LauncherStatus(True, True, False, "2026.8.2")])

    def test_worker_runs_outside_the_gui_thread(self) -> None:
        checker = SimpleNamespace(thread_id=None)

        def check() -> LauncherStatus:
            checker.thread_id = threading.get_ident()
            return LauncherStatus(False, False, False)

        checker.check = check
        pool = QThreadPool()
        pool.start(StatusCheckWorker(checker))  # type: ignore[arg-type]
        self.assertTrue(pool.waitForDone(2_000))
        self.assertNotEqual(checker.thread_id, threading.get_ident())


class StatusCheckerTests(unittest.TestCase):
    def test_remote_timeout_is_offline(self) -> None:
        with patch("status_checker.urlopen", side_effect=TimeoutError("remote timeout")):
            self.assertFalse(StatusChecker._reachable("https://example.invalid/health"))

    def test_tasklist_is_read_only_and_hidden(self) -> None:
        result = SimpleNamespace(returncode=0, stdout='"cloudflared.exe","1234"')
        with patch("status_checker.subprocess.run", return_value=result) as run:
            self.assertTrue(StatusChecker._cloudflared_running())

        self.assertEqual(run.call_args.args[0][0], "tasklist")
        self.assertEqual(run.call_args.kwargs["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def test_cloudflared_version_is_hidden_and_parsed(self) -> None:
        result = SimpleNamespace(
            returncode=0,
            stdout="cloudflared version 2026.8.2 (built 2026-08-01)",
            stderr="",
        )
        with patch("status_checker.subprocess.run", return_value=result) as run:
            self.assertEqual(StatusChecker.cloudflared_version(), "2026.8.2")

        self.assertEqual(run.call_args.args[0], ["cloudflared", "--version"])
        self.assertEqual(run.call_args.kwargs["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def test_missing_cloudflared_returns_unavailable(self) -> None:
        with patch("status_checker.subprocess.run", side_effect=FileNotFoundError):
            self.assertEqual(StatusChecker.cloudflared_version(), "unavailable")

    def test_check_reports_tunnel_only_when_mcp_is_healthy(self) -> None:
        with patch.object(StatusChecker, "_reachable", side_effect=[True, False]), patch.object(
            StatusChecker, "_cloudflared_running", return_value=True
        ) as cloudflared:
            self.assertEqual(StatusChecker().check(), LauncherStatus(True, True, False))
            cloudflared.assert_called_once_with()

        with patch.object(StatusChecker, "_reachable", side_effect=[False, False]), patch.object(
            StatusChecker, "_cloudflared_running"
        ) as cloudflared:
            self.assertEqual(StatusChecker().check(), LauncherStatus(False, False, False))
            cloudflared.assert_not_called()


if __name__ == "__main__":
    unittest.main()
