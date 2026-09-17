"""Minimal checks for asynchronous launcher status checks and task maintenance."""

from __future__ import annotations

import json
import subprocess
import threading
import unittest
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from unittest.mock import MagicMock, Mock, patch

from PySide6.QtCore import QCoreApplication, QThreadPool
from status_checker import (
    OAuthClientStatus,
    OAuthRegistryStatus,
    LauncherStatus,
    SessionViewModel,
    StatusChecker,
)
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

    def test_worker_includes_oauth_registry_status(self) -> None:
        oauth = OAuthRegistryStatus(
            "oauth/clients.json",
            True,
            1,
            (OAuthClientStatus("client-1", "ChatGPT", 123),),
        )
        checker = SimpleNamespace(
            check=lambda: LauncherStatus(True, True, False),
            cloudflared_version=lambda: "unavailable",
            oauth_status=lambda: oauth,
        )
        results: list[LauncherStatus] = []
        worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
        worker.signals.finished.connect(lambda _generation, status: results.append(status))

        worker.run()

        self.assertEqual(results, [LauncherStatus(True, True, False, "unavailable", oauth)])

    def test_worker_includes_dashboard_sessions(self) -> None:
        session = SessionViewModel(
            "Goal",
            "Task",
            "running_turn",
            "codex_app_server",
            "gpt-5.6-luna",
            "max",
            "session-1",
            "thread-1",
            "2026-09-15T12:34:56+08:00",
            "goal-1",
            "task-1",
            None,
            (),
        )
        checker = SimpleNamespace(
            check=lambda: LauncherStatus(True, True, False),
            cloudflared_version=lambda: "unavailable",
            dashboard_sessions=lambda: (session,),
        )
        results: list[LauncherStatus] = []
        worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
        worker.signals.finished.connect(lambda _generation, status: results.append(status))

        worker.run()

        self.assertEqual(results[0].sessions, (session,))

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
    def test_mcp_sse_tool_response_is_decoded(self) -> None:
        response = MagicMock()
        response.read.return_value = (
            b'event: message\n'
            b'data: {"jsonrpc":"2.0","id":"1","result":{"structuredContent":{"session_id":"session-1"}}}\n\n'
        )
        response.headers.get.return_value = "text/event-stream"
        response.__enter__.return_value = response
        response.__exit__.return_value = None

        with patch("status_checker.urlopen", return_value=response) as open_url:
            result = StatusChecker(auth_token="secret")._call_tool(
                "get_session_status", {"session_id": "session-1"}
            )

        self.assertEqual(result, {"session_id": "session-1"})
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:12080/mcp")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_dashboard_uses_status_query_tools_for_each_session(self) -> None:
        timestamp = "2026-09-15T12:34:56+08:00"
        summary = {
            "session_id": "session-1",
            "goal_name": "Goal",
            "task_name": "Task",
            "updated_at": timestamp,
        }
        session = {
            "session_id": "session-1",
            "goal_id": "goal-1",
            "task_id": "task-1",
            "backend_type": "codex_app_server",
            "status": "running_turn",
            "thread_id": "thread-1",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "max",
            "current_execution": {"execution_id": "execution-1", "status": "running", "turn_id": "turn-1"},
        }
        execution = {
            "execution_id": "execution-1",
            "workspace_id": "workspace-1",
            "task_id": "task-1",
            "status": "running",
            "started_at": timestamp,
            "session_id": "session-1",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
        }
        events = {"session_id": "session-1", "events": []}
        checker = StatusChecker(auth_token="secret", workspace_id="workspace-1")
        calls: list[tuple[str, dict[str, object]]] = []

        def call_tool(name: str, arguments: dict[str, object]) -> dict[str, object]:
            calls.append((name, arguments))
            return {"get_session_status": session, "get_execution_status": execution, "list_session_events": events}[name]

        with patch.object(checker, "_session_catalog", return_value=(summary,)), patch.object(
            checker, "_call_tool", side_effect=call_tool
        ):
            result = checker.dashboard_sessions()

        self.assertEqual([name for name, _arguments in calls], [
            "get_session_status",
            "get_execution_status",
            "list_session_events",
        ])
        self.assertTrue(all(arguments["workspace_id"] == "workspace-1" for _name, arguments in calls))
        self.assertEqual(result[0].session_id, "session-1")
        self.assertEqual(result[0].execution.started_at, timestamp)

    def test_oauth_status_reads_registry_metadata(self) -> None:
        payload = {
            "storage_path": "oauth/clients.json",
            "loaded": True,
            "client_count": 1,
            "clients": [{"client_id": "client-1", "client_name": "ChatGPT", "created_at": 123}],
        }
        response = MagicMock()
        response.read.return_value = json.dumps(payload).encode("utf-8")
        response.__enter__.return_value = response
        response.__exit__.return_value = None
        with patch("status_checker.urlopen", return_value=response) as open_url:
            status = StatusChecker(auth_token="secret").oauth_status()

        self.assertEqual(status, OAuthRegistryStatus(
            "oauth/clients.json",
            True,
            1,
            (OAuthClientStatus("client-1", "ChatGPT", 123),),
        ))
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_reset_oauth_clients_uses_delete(self) -> None:
        response = MagicMock(status=204)
        response.__enter__.return_value = response
        response.__exit__.return_value = None
        with patch("status_checker.urlopen", return_value=response) as open_url:
            self.assertTrue(StatusChecker(auth_token="secret").reset_oauth_clients())

        request = open_url.call_args.args[0]
        self.assertEqual(request.get_method(), "DELETE")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_clear_persisted_task_records_uses_authenticated_delete(self) -> None:
        response = MagicMock()
        response.read.return_value = json.dumps({
            "deleted": True,
            "deleted_sessions": 2,
            "deleted_events": 2,
            "deleted_tasks": 1,
        }).encode("utf-8")
        response.headers.get.return_value = "application/json"
        response.__enter__.return_value = response
        response.__exit__.return_value = None
        with patch("status_checker.urlopen", return_value=response) as open_url:
            self.assertEqual(StatusChecker(auth_token="secret").clear_persisted_task_records(), 2)

        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:12080/launcher/sessions")
        self.assertEqual(request.get_method(), "DELETE")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_delete_oauth_client_uses_encoded_url_and_auth(self) -> None:
        response = MagicMock(status=204)
        response.__enter__.return_value = response
        response.__exit__.return_value = None
        with patch("status_checker.urlopen", return_value=response) as open_url:
            self.assertTrue(StatusChecker(auth_token="secret").delete_oauth_client("client/id name"))

        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:12080/oauth/clients/client%2Fid%20name")
        self.assertEqual(request.get_method(), "DELETE")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_delete_oauth_client_failures_return_false(self) -> None:
        failures = (
            HTTPError("http://example.invalid", 404, "not found", {}, None),
            URLError("network failure"),
            TimeoutError("timed out"),
        )
        for failure in failures:
            with self.subTest(type=type(failure).__name__), patch("status_checker.urlopen", side_effect=failure):
                self.assertFalse(StatusChecker().delete_oauth_client("client-1"))

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
