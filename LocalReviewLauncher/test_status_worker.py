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
    BrowserReadiness,
    CapabilityStatus,
    DesktopCapabilityStatus,
    DesktopSyncStatus,
    StatusQueryError,
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
    def test_worker_includes_browser_readiness_and_fails_closed_on_probe_error(self) -> None:
        browser = BrowserReadiness(True, "ready", True, True, True, 123, "", "")
        probe = Mock(return_value=browser)
        checker = SimpleNamespace(check=lambda: LauncherStatus(True, True, True), browser_readiness=probe)
        results = []
        worker = StatusCheckWorker(checker)
        worker.signals.finished.connect(lambda _generation, status: results.append(status))
        worker.run()
        self.assertEqual(results[-1].browser, browser)
        probe.side_effect = TimeoutError()
        worker.run()
        self.assertEqual(results[-1].browser, BrowserReadiness())

    def test_worker_includes_desktop_sync_only_when_mcp_is_running(self) -> None:
        desktop = DesktopSyncStatus(
            connected=True,
            current_conversation_id="conversation-1",
            following=True,
            following_threads=("conversation-1",),
            owner_client_id="desktop-1",
            last_event_time="2026-09-19T01:09:59.933Z",
        )
        probe = Mock(return_value=desktop)
        checker = SimpleNamespace(
            check=lambda: LauncherStatus(True, True, True),
            desktop_sync_status=probe,
        )
        results: list[LauncherStatus] = []
        worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
        worker.signals.finished.connect(lambda _generation, status: results.append(status))

        worker.run()

        self.assertEqual(results[-1].desktop_sync, desktop)
        probe.side_effect = TimeoutError()
        worker.run()
        self.assertEqual(results[-1].desktop_sync, DesktopSyncStatus())

        offline_probe = Mock()
        offline_checker = SimpleNamespace(
            check=lambda: LauncherStatus(False, False, False),
            desktop_sync_status=offline_probe,
        )
        offline_results: list[LauncherStatus] = []
        offline_worker = StatusCheckWorker(offline_checker)  # type: ignore[arg-type]
        offline_worker.signals.finished.connect(lambda _generation, status: offline_results.append(status))
        offline_worker.run()
        offline_probe.assert_not_called()
        self.assertEqual(offline_results[-1].desktop_sync, DesktopSyncStatus())

    def test_worker_includes_desktop_capability_only_when_mcp_is_running(self) -> None:
        capability = DesktopCapabilityStatus(ready=True, pipe_source="handoff", pipe_state="active")
        probe = Mock(return_value=capability)
        checker = SimpleNamespace(
            check=lambda: LauncherStatus(True, True, True),
            desktop_capability_status=probe,
        )
        results: list[LauncherStatus] = []
        worker = StatusCheckWorker(checker)  # type: ignore[arg-type]
        worker.signals.finished.connect(lambda _generation, status: results.append(status))

        worker.run()
        self.assertEqual(results[-1].desktop_capability, capability)

        probe.side_effect = TimeoutError()
        worker.run()
        self.assertEqual(results[-1].desktop_capability, DesktopCapabilityStatus())

        offline_probe = Mock()
        offline_checker = SimpleNamespace(
            check=lambda: LauncherStatus(False, False, False),
            desktop_capability_status=offline_probe,
        )
        offline_results: list[LauncherStatus] = []
        offline_worker = StatusCheckWorker(offline_checker)  # type: ignore[arg-type]
        offline_worker.signals.finished.connect(lambda _generation, status: offline_results.append(status))
        offline_worker.run()
        offline_probe.assert_not_called()
        self.assertEqual(offline_results[-1].desktop_capability, DesktopCapabilityStatus())

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
    def test_browser_readiness_uses_authenticated_endpoint_for_all_states(self) -> None:
        for state, available, paired, present, reason, action in (
            ("bridge_unavailable", False, False, False, "Bridge is not ready.", "Start the runtime."),
            ("extension_not_paired", True, False, False, "Extension is not paired.", "Refresh ChatGPT 页面"),
            ("extension_not_present", True, True, False, "Extension is not connected.", "Refresh ChatGPT 页面"),
            ("ready", True, True, True, None, None),
        ):
            payload = dict(ready=state == "ready", readiness_state=state, bridge_available=available,
                           extension_paired=paired, extension_present=present, last_seen_at=123,
                           reason=reason, action=action)
            response = MagicMock()
            response.read.return_value = json.dumps(payload).encode()
            response.headers.get.return_value = "application/json"
            response.__enter__.return_value = response
            with self.subTest(state=state), patch("status_checker.urlopen", return_value=response) as open_url:
                browser = StatusChecker(auth_token="secret").browser_readiness()
                self.assertEqual(browser, BrowserReadiness(state == "ready", state, available, paired, present,
                                                           123, reason or "", action or ""))
                request = open_url.call_args.args[0]
                self.assertEqual(request.full_url, "http://127.0.0.1:12080/launcher/readiness")
                self.assertEqual(request.get_method(), "GET")
                self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_browser_readiness_fails_closed_on_missing_or_inconsistent_status(self) -> None:
        checker = StatusChecker()
        valid = dict(ready=True, readiness_state="ready", bridge_available=True, extension_paired=True,
                     extension_present=True, last_seen_at=123, reason=None, action=None)
        for payload in (None, {}, {**valid, "ready": "true"}, {**valid, "extension_present": False},
                        {**valid, "last_seen_at": True}, {**valid, "readiness_state": "unknown"}):
            with self.subTest(payload=payload), patch.object(checker, "_request_json", return_value=payload):
                self.assertEqual(checker.browser_readiness(), BrowserReadiness())
        with patch.object(checker, "_request_json", side_effect=StatusQueryError("unreachable")):
            self.assertEqual(checker.browser_readiness(), BrowserReadiness())

    def test_desktop_sync_status_parses_evidence_and_sends_bearer_auth(self) -> None:
        response = MagicMock()
        response.read.return_value = json.dumps({
            "connected": True,
            "currentConversationId": "conversation-1",
            "following": True,
            "followingThreads": ["conversation-1", "thread-2"],
            "ownerClientId": "desktop-1",
            "lastEventTime": "2026-09-19T01:09:59.933Z",
        }).encode()
        response.headers.get.return_value = "application/json"
        response.__enter__.return_value = response
        with patch("status_checker.urlopen", return_value=response) as open_url:
            status = StatusChecker(auth_token="secret").desktop_sync_status()

        self.assertEqual(status, DesktopSyncStatus(
            connected=True,
            current_conversation_id="conversation-1",
            following=True,
            following_threads=("conversation-1", "thread-2"),
            owner_client_id="desktop-1",
            last_event_time="2026-09-19T01:09:59.933Z",
            mode="auto",
            active_source="desktop_ipc",
            association_status="unavailable",
            fallback_reason=None,
        ))
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:12080/launcher/desktop-sync")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_desktop_sync_status_fails_closed_on_invalid_or_unreachable_response(self) -> None:
        valid = {
            "connected": True,
            "currentConversationId": "conversation-1",
            "following": True,
            "followingThreads": ["conversation-1"],
            "ownerClientId": "desktop-1",
            "lastEventTime": "2026-09-19T01:09:59.933Z",
        }
        invalid = [
            None,
            {**valid, "connected": "true"},
            {**valid, "currentConversationId": 1},
            {**valid, "following": "true"},
            {**valid, "followingThreads": [1]},
            {**valid, "ownerClientId": []},
            {**valid, "lastEventTime": "not-a-timestamp"},
            {**valid, "following": False},
            {**valid, "connected": False, "currentConversationId": None, "following": None,
             "followingThreads": ["thread-1"], "ownerClientId": None},
        ]
        checker = StatusChecker()
        for payload in invalid[:-1]:
            with self.subTest(payload=payload), patch.object(checker, "_request_json", return_value=payload):
                self.assertEqual(checker.desktop_sync_status(), DesktopSyncStatus())
        with patch.object(checker, "_request_json", side_effect=StatusQueryError("unreachable")):
            self.assertEqual(checker.desktop_sync_status(), DesktopSyncStatus())
        with patch.object(checker, "_request_json", return_value=invalid[-1]):
            self.assertEqual(checker.desktop_sync_status(), DesktopSyncStatus())

    def test_desktop_capability_status_reports_ready_source_with_bearer_auth(self) -> None:
        response = MagicMock()
        response.read.return_value = json.dumps({
            "ready": True,
            "reason": None,
            "pipeSource": "handoff",
        }).encode()
        response.headers.get.return_value = "application/json"
        response.__enter__.return_value = response
        with patch("status_checker.urlopen", return_value=response) as open_url:
            status = StatusChecker(auth_token="secret").desktop_capability_status()

        self.assertEqual(status, DesktopCapabilityStatus(ready=True, pipe_source="handoff", pipe_state="active"))
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:12080/launcher/desktop-interactive")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_desktop_capability_status_keeps_the_environment_source_distinct(self) -> None:
        checker = StatusChecker()
        with patch.object(checker, "_request_json", return_value={
            "ready": True,
            "reason": None,
            "pipeSource": "current_environment",
        }):
            self.assertEqual(
                checker.desktop_capability_status(),
                DesktopCapabilityStatus(ready=True, pipe_source="current_environment", pipe_state="active"),
            )

    def test_desktop_capability_status_reports_pending_without_a_source(self) -> None:
        checker = StatusChecker()
        with patch.object(checker, "_request_json", return_value={
            "ready": False,
            "reason": "executor_identity_unavailable",
            "pipeSource": None,
            "pipeState": "pending",
        }):
            self.assertEqual(
                checker.desktop_capability_status(),
                DesktopCapabilityStatus(pipe_state="pending"),
            )

    def test_desktop_capability_status_fails_closed_on_inconsistent_response(self) -> None:
        unavailable = {"ready": False, "reason": "desktop_tools_pipe_unavailable", "pipeSource": None}
        checker = StatusChecker()
        with patch.object(checker, "_request_json", return_value=unavailable):
            self.assertEqual(checker.desktop_capability_status(), DesktopCapabilityStatus())

        invalid = [
            None,
            {},
            {**unavailable, "ready": "true"},
            {**unavailable, "pipeSource": "handoff"},
            {"ready": True, "reason": None, "pipeSource": None},
            {"ready": True, "reason": None, "pipeSource": "guessed_pipe_name"},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), patch.object(checker, "_request_json", return_value=payload):
                self.assertEqual(checker.desktop_capability_status(), DesktopCapabilityStatus())
        with patch.object(checker, "_request_json", side_effect=StatusQueryError("unreachable")):
            self.assertEqual(checker.desktop_capability_status(), DesktopCapabilityStatus())

    def test_capability_status_parses_state_source_and_actions(self) -> None:
        checker = StatusChecker()
        with patch.object(checker, "_request_json", return_value={
            "state": "desktop_failed",
            "source": "desktop",
            "reason": "desktop_tools_pipe_unavailable",
            "actions": ["retry", "standalone"],
            "updatedAt": "2026-09-23T00:00:00.000Z",
        }):
            self.assertEqual(
                checker.capability_status(),
                CapabilityStatus(
                    state="desktop_failed",
                    source="desktop",
                    reason="desktop_tools_pipe_unavailable",
                    actions=("retry", "standalone"),
                ),
            )

    def test_capability_status_fails_closed_and_actions_use_the_authenticated_endpoint(self) -> None:
        checker = StatusChecker(auth_token="secret")
        with patch.object(checker, "_request_json", return_value={
            "state": "fallback_running",
            "source": "standalone",
            "reason": None,
            "actions": [],
        }):
            self.assertEqual(checker.capability_status(), CapabilityStatus(
                state="fallback_running", source="standalone", actions=(),
            ))
        with patch.object(checker, "_request_json", return_value={
            "state": "desktop_failed",
            "source": "standalone",
            "reason": None,
            "actions": [],
        }):
            self.assertEqual(checker.capability_status(), CapabilityStatus())
        with patch.object(checker, "_request_json", return_value={"state": "fallback_ready"}) as request:
            self.assertTrue(checker.capability_action("standalone"))
            request.assert_called_once_with(
                checker.capability_url,
                method="POST",
                body={"action": "standalone"},
            )
        self.assertFalse(checker.capability_action("unknown"))

    def test_legacy_p2_status_maps_to_a_consistent_fail_closed_source(self) -> None:
        disconnected = {
            "connected": False,
            "currentConversationId": None,
            "following": None,
            "followingThreads": [],
            "ownerClientId": None,
            "lastEventTime": None,
        }
        checker = StatusChecker()
        with patch.object(checker, "_request_json", return_value=disconnected):
            self.assertEqual(checker.desktop_sync_status(), DesktopSyncStatus())

        no_evidence = {**disconnected, "connected": True}
        with patch.object(checker, "_request_json", return_value=no_evidence):
            status = checker.desktop_sync_status()
            self.assertEqual(status.active_source, "legacy_app_server")
            self.assertEqual(status.association_status, "unavailable")
            self.assertEqual(status.fallback_reason, "desktop_evidence_unavailable")

    def test_desktop_sync_manager_status_keeps_source_and_association_distinct(self) -> None:
        common = {
            "mode": "auto",
            "connected": True,
            "currentConversationId": "thread-A",
            "following": True,
            "followingThreads": ["thread-A"],
            "ownerClientId": "desktop-1",
            "lastEventTime": "2026-09-19T01:09:59.933Z",
            "associationReason": None,
            "fallbackReason": None,
            "sessionId": "session-1",
            "goalId": "goal-1",
            "taskId": "task-1",
            "executionId": "execution-1",
            "threadId": "thread-A",
        }
        primary = {**common, "activeSource": "desktop_ipc", "associationStatus": "matched"}
        checker = StatusChecker()
        with patch.object(checker, "_request_json", return_value=primary):
            self.assertEqual(checker.desktop_sync_status().association_status, "matched")
            self.assertEqual(checker.desktop_sync_status().active_source, "desktop_ipc")

        unmatched = {
            **common,
            "activeSource": "desktop_ipc",
            "associationStatus": "unmatched",
            "associationReason": None,
            "sessionId": None,
            "goalId": None,
            "taskId": None,
            "executionId": None,
            "threadId": None,
        }
        with patch.object(checker, "_request_json", return_value=unmatched):
            status = checker.desktop_sync_status()
            self.assertEqual(status.active_source, "desktop_ipc")
            self.assertEqual(status.association_status, "unmatched")
            self.assertIsNone(status.fallback_reason)

        fallback = {
            "mode": "auto",
            "activeSource": "legacy_app_server",
            "connected": False,
            "currentConversationId": None,
            "following": None,
            "followingThreads": [],
            "ownerClientId": None,
            "lastEventTime": None,
            "associationStatus": "unavailable",
            "associationReason": None,
            "fallbackReason": "desktop_disconnected",
            "sessionId": None,
            "goalId": None,
            "taskId": None,
            "executionId": None,
            "threadId": None,
        }
        with patch.object(checker, "_request_json", return_value=fallback):
            status = checker.desktop_sync_status()
            self.assertEqual(status.active_source, "legacy_app_server")
            self.assertEqual(status.fallback_reason, "desktop_disconnected")

        conflict = {
            **common,
            "activeSource": "desktop_ipc",
            "associationStatus": "conflict",
            "associationReason": "ambiguous_thread_mapping",
            "sessionId": None,
            "goalId": None,
            "taskId": None,
            "executionId": None,
            "threadId": None,
        }
        with patch.object(checker, "_request_json", return_value=conflict):
            status = checker.desktop_sync_status()
            self.assertEqual(status.association_status, "conflict")
            self.assertEqual(status.association_reason, "ambiguous_thread_mapping")
            self.assertIsNone(status.fallback_reason)

        malformed = {**primary, "mode": "manual"}
        with patch.object(checker, "_request_json", return_value=malformed):
            self.assertEqual(checker.desktop_sync_status(), DesktopSyncStatus())

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
