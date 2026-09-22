"""Launcher health checks and task dashboard maintenance."""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


LOCAL_HEALTH_URL = "http://127.0.0.1:12080/health"
LOCAL_OAUTH_CLIENTS_URL = "http://127.0.0.1:12080/oauth/clients"
LOCAL_MCP_URL = "http://127.0.0.1:12080/mcp"
LOCAL_SESSION_CATALOG_URL = "http://127.0.0.1:12080/launcher/sessions"
LOCAL_BROWSER_READINESS_URL = "http://127.0.0.1:12080/launcher/readiness"
LOCAL_DESKTOP_SYNC_URL = "http://127.0.0.1:12080/launcher/desktop-sync"
LOCAL_DESKTOP_INTERACTIVE_URL = "http://127.0.0.1:12080/launcher/desktop-interactive"
REMOTE_STATUS_URL = "https://review.syqiu.kdns.fr/.well-known/oauth-protected-resource"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MAX_STATUS_RESPONSE_BYTES = 2 * 1024 * 1024
SESSION_STATUSES = frozenset({
    "created",
    "starting",
    "active",
    "running_turn",
    "waiting_input",
    "completed",
    "failed",
    "terminated",
})
EXECUTION_STATUSES = frozenset({"running", "passed", "failed"})
EVENT_TYPES = frozenset({
    "session_started",
    "turn_started",
    "agent_message_delta",
    "agent_message_completed",
    "turn_completed",
    "execution_failed",
})
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class StatusQueryError(RuntimeError):
    """The local Status Query API returned an unusable result."""


def _display_event_time(timestamp: str) -> str:
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
    except ValueError:
        return "--:--:--"


@dataclass(frozen=True)
class SessionEventViewModel:
    sequence: int
    timestamp: str
    event_type: str
    content: str
    execution_id: str
    turn_id: str | None = None
    item_id: str | None = None

    @property
    def display_time(self) -> str:
        return _display_event_time(self.timestamp)


@dataclass(frozen=True)
class ExecutionViewModel:
    execution_id: str
    status: str
    started_at: str | None = None
    finished_at: str | None = None
    turn_id: str | None = None
    summary: str | None = None


@dataclass(frozen=True)
class SessionViewModel:
    goal_name: str
    task_name: str
    status: str
    backend_type: str
    model: str | None
    reasoning_effort: str | None
    session_id: str
    thread_id: str | None
    updated_at: str | None
    goal_id: str
    task_id: str
    execution: ExecutionViewModel | None
    events: tuple[SessionEventViewModel, ...]

    @property
    def execution_id(self) -> str | None:
        return self.execution.execution_id if self.execution is not None else None

    @property
    def current_turn_id(self) -> str | None:
        return self.execution.turn_id if self.execution is not None else None


@dataclass(frozen=True)
class OAuthClientStatus:
    client_id: str
    client_name: str
    created_at: int
    last_used: str | int | float | None = None


@dataclass(frozen=True)
class OAuthRegistryStatus:
    storage_path: str
    loaded: bool
    client_count: int
    clients: tuple[OAuthClientStatus, ...] = ()


@dataclass(frozen=True)
class BrowserReadiness:
    ready: bool = False
    readiness_state: str = "bridge_unavailable"
    bridge_available: bool = False
    extension_paired: bool = False
    extension_present: bool = False
    last_seen_at: int | None = None
    reason: str = "Browser readiness could not be read."
    action: str = "Start or restart the local MCP runtime and refresh status."


@dataclass(frozen=True)
class DesktopSyncStatus:
    connected: bool = False
    current_conversation_id: str | None = None
    following: bool | None = None
    following_threads: tuple[str, ...] = ()
    owner_client_id: str | None = None
    last_event_time: str | None = None
    # Fail-closed defaults describe an unavailable Desktop source, not a matched P2 thread.
    mode: str = "auto"
    active_source: str = "legacy_app_server"
    association_status: str = "unavailable"
    association_reason: str | None = None
    fallback_reason: str | None = "desktop_disconnected"
    session_id: str | None = None
    goal_id: str | None = None
    task_id: str | None = None
    execution_id: str | None = None
    thread_id: str | None = None

    @property
    def last_event_display(self) -> str:
        return "—" if self.last_event_time is None else _display_event_time(self.last_event_time)


@dataclass(frozen=True)
class DesktopCapabilityStatus:
    """Read-only Desktop codex_app capability, read from /launcher/desktop-interactive.

    This is not the Desktop IPC connection: an observer can be connected while no tools pipe has
    ever been handed to the runtime, and only a ready capability can execute desktop_codex_app.
    Fail-closed defaults describe a capability that was not established.
    """

    ready: bool = False
    pipe_source: str | None = None


@dataclass(frozen=True)
class LauncherStatus:
    mcp_running: bool
    tunnel_connected: bool
    remote_online: bool
    cloudflared_version: str = "unavailable"
    oauth_registry: OAuthRegistryStatus | None = None
    sessions: tuple[SessionViewModel, ...] = ()
    browser: BrowserReadiness = BrowserReadiness()
    desktop_sync: DesktopSyncStatus = DesktopSyncStatus()
    desktop_capability: DesktopCapabilityStatus = DesktopCapabilityStatus()


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise StatusQueryError(f"{label} must be an object")
    return dict(value)


def _text(value: object, label: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise StatusQueryError(f"{label} must be a non-empty string")
    return value


def _identifier(value: object, label: str) -> str:
    text = _text(value, label, 128)
    if not IDENTIFIER_PATTERN.fullmatch(text):
        raise StatusQueryError(f"{label} has an invalid identity")
    return text


def _optional_text(value: object, label: str, maximum: int = 256) -> str | None:
    if value is None:
        return None
    return _text(value, label, maximum)


def _timestamp(value: object, label: str) -> str:
    text = _text(value, label, 64)
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise StatusQueryError(f"{label} must be an RFC3339 timestamp") from error
    return text


def _rfc3339_timestamp(value: object, label: str) -> str:
    text = _timestamp(value, label)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise StatusQueryError(f"{label} must be an RFC3339 timestamp") from error
    if "T" not in text or parsed.tzinfo is None:
        raise StatusQueryError(f"{label} must be an RFC3339 timestamp")
    return text


def _status(value: object, label: str, allowed: frozenset[str]) -> str:
    text = _text(value, label, 64)
    if text not in allowed:
        raise StatusQueryError(f"{label} is not recognized")
    return text


def _parse_session_status(payload: object) -> dict[str, object]:
    document = _object(payload, "Session status")
    current_value = document.get("current_execution")
    current: dict[str, object] | None = None
    if current_value is not None:
        current_document = _object(current_value, "current_execution")
        current = {
            "execution_id": _identifier(current_document.get("execution_id"), "current_execution.execution_id"),
            "status": _status(current_document.get("status"), "current_execution.status", EXECUTION_STATUSES),
            "turn_id": _optional_text(current_document.get("turn_id"), "current_execution.turn_id"),
        }
    return {
        "session_id": _identifier(document.get("session_id"), "session_id"),
        "goal_id": _identifier(document.get("goal_id"), "goal_id"),
        "task_id": _identifier(document.get("task_id"), "task_id"),
        "backend_type": _status(document.get("backend_type"), "backend_type", frozenset({"cli", "codex_app_server"})),
        "status": _status(document.get("status"), "status", SESSION_STATUSES),
        "thread_id": _optional_text(document.get("thread_id"), "thread_id"),
        "model": _optional_text(document.get("model"), "model"),
        "reasoning_effort": _optional_text(document.get("reasoning_effort"), "reasoning_effort", 64),
        "current_execution": current,
    }


def _parse_execution_status(
    payload: object,
    session: Mapping[str, object],
) -> ExecutionViewModel:
    document = _object(payload, "Execution status")
    execution_id = _identifier(document.get("execution_id"), "execution_id")
    expected_execution_id = session.get("current_execution_id")
    if expected_execution_id is not None and execution_id != expected_execution_id:
        raise StatusQueryError("Execution does not match the Session")
    if _identifier(document.get("task_id"), "task_id") != session["task_id"]:
        raise StatusQueryError("Execution task does not match the Session")
    session_id = document.get("session_id")
    if session_id is not None and _identifier(session_id, "session_id") != session["session_id"]:
        raise StatusQueryError("Execution Session does not match")
    thread_id = _optional_text(document.get("thread_id"), "thread_id")
    if thread_id is not None and session.get("thread_id") is not None and thread_id != session["thread_id"]:
        raise StatusQueryError("Execution Thread does not match the Session")
    summary = document.get("summary")
    if "summary" in document and (
        not isinstance(summary, str)
        or len(summary.encode("utf-16-le", errors="surrogatepass")) // 2 > 4_000
    ):
        raise StatusQueryError("summary must be a string of at most 4000 UTF-16 code units")
    return ExecutionViewModel(
        execution_id=execution_id,
        status=_status(document.get("status"), "status", EXECUTION_STATUSES),
        started_at=_timestamp(document.get("started_at"), "started_at"),
        finished_at=None if document.get("finished_at") is None else _timestamp(document.get("finished_at"), "finished_at"),
        turn_id=_optional_text(document.get("turn_id"), "turn_id"),
        summary=summary,
    )


def _parse_events(payload: object, session: Mapping[str, object]) -> tuple[SessionEventViewModel, ...]:
    document = _object(payload, "Session events")
    if _identifier(document.get("session_id"), "session_id") != session["session_id"]:
        raise StatusQueryError("Events do not match the Session")
    events_value = document.get("events")
    if not isinstance(events_value, list):
        raise StatusQueryError("events must be an array")
    events: list[SessionEventViewModel] = []
    for value in events_value:
        event = _object(value, "event")
        sequence = event.get("sequence")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
            raise StatusQueryError("event.sequence must be a positive integer")
        if _identifier(event.get("session_id"), "event.session_id") != session["session_id"]:
            raise StatusQueryError("event Session does not match")
        event_thread_id = _text(event.get("thread_id"), "event.thread_id")
        if session.get("thread_id") is not None and event_thread_id != session["thread_id"]:
            raise StatusQueryError("event Thread does not match the Session")
        execution_id = _identifier(event.get("execution_id"), "event.execution_id")
        event_type = _text(event.get("event_type"), "event.event_type", 64)
        if event_type not in EVENT_TYPES:
            raise StatusQueryError("event.event_type is not recognized")
        turn_id = None if event_type == "session_started" else _text(event.get("turn_id"), "event.turn_id")
        item_id = None
        event_payload = _object(event.get("payload"), "event.payload")
        content = ""
        if event_type in {"agent_message_delta", "agent_message_completed"}:
            item_id = _text(event.get("item_id"), "event.item_id")
            content = event_payload.get("content", "")
            if not isinstance(content, str) or len(content) > 4_000:
                raise StatusQueryError("event.payload.content must be a string of at most 4000 characters")
        elif event_type == "execution_failed":
            reason = event_payload.get("reason")
            content = "" if reason is None else _text(reason, "event.payload.reason", 4_000)
        events.append(SessionEventViewModel(
            sequence=sequence,
            timestamp=_timestamp(event.get("timestamp"), "event.timestamp"),
            event_type=event_type,
            content=content,
            execution_id=execution_id,
            turn_id=turn_id,
            item_id=item_id,
        ))
    return tuple(sorted(events, key=lambda event: event.sequence))


def build_session_view_model(
    session_status: object,
    execution_status: object | None = None,
    session_events: object | None = None,
    *,
    summary: Mapping[str, object] | None = None,
) -> SessionViewModel:
    session = _parse_session_status(session_status)
    current = session["current_execution"]
    current_execution_id = current["execution_id"] if isinstance(current, dict) else None
    session_for_execution = {
        **session,
        "current_execution_id": current_execution_id,
    }
    execution: ExecutionViewModel | None = None
    if execution_status is not None:
        execution = _parse_execution_status(execution_status, session_for_execution)
        if execution.turn_id is None and isinstance(current, dict):
            execution = ExecutionViewModel(
                execution_id=execution.execution_id,
                status=execution.status,
                started_at=execution.started_at,
                finished_at=execution.finished_at,
                turn_id=current["turn_id"],
                summary=execution.summary,
            )
    elif isinstance(current, dict):
        execution = ExecutionViewModel(
            execution_id=current["execution_id"],
            status=current["status"],
            turn_id=current["turn_id"],
        )
    events = () if session_events is None else _parse_events(session_events, session_for_execution)
    summary_document = {} if summary is None else _object(summary, "Session summary")
    summary_session_id = summary_document.get("session_id")
    if summary_session_id is not None and _identifier(summary_session_id, "summary.session_id") != session["session_id"]:
        raise StatusQueryError("Session summary does not match the Session")
    goal_name = _optional_text(summary_document.get("goal_name"), "summary.goal_name", 256) or session["goal_id"]
    task_name = _optional_text(summary_document.get("task_name"), "summary.task_name", 256) or session["task_id"]
    updated_at = None
    if summary_document.get("updated_at") is not None:
        updated_at = _timestamp(summary_document.get("updated_at"), "summary.updated_at")
    elif events:
        updated_at = events[-1].timestamp
    return SessionViewModel(
        goal_name=goal_name,
        task_name=task_name,
        status=session["status"],
        backend_type=session["backend_type"],
        model=session["model"],
        reasoning_effort=session["reasoning_effort"],
        session_id=session["session_id"],
        thread_id=session["thread_id"],
        updated_at=updated_at,
        goal_id=session["goal_id"],
        task_id=session["task_id"],
        execution=execution,
        events=events,
    )


def _decode_json_response(raw: bytes, content_type: str | None) -> object:
    text = raw.decode("utf-8")
    if content_type is not None and "text/event-stream" in content_type.casefold():
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data:
                return json.loads(data)
        raise StatusQueryError("MCP response contained no event data")
    return json.loads(text)


class StatusChecker:
    def __init__(
        self,
        auth_token: str | None = None,
        oauth_clients_url: str = LOCAL_OAUTH_CLIENTS_URL,
        mcp_url: str = LOCAL_MCP_URL,
        session_catalog_url: str = LOCAL_SESSION_CATALOG_URL,
        workspace_id: str | None = None,
        browser_readiness_url: str = LOCAL_BROWSER_READINESS_URL,
        desktop_sync_url: str = LOCAL_DESKTOP_SYNC_URL,
        desktop_capability_url: str = LOCAL_DESKTOP_INTERACTIVE_URL,
    ) -> None:
        self.auth_token = auth_token
        self.oauth_clients_url = oauth_clients_url
        self.mcp_url = mcp_url
        self.session_catalog_url = session_catalog_url
        self.workspace_id = workspace_id
        self.browser_readiness_url = browser_readiness_url
        self.desktop_sync_url = desktop_sync_url
        self.desktop_capability_url = desktop_capability_url

    def browser_readiness(self) -> BrowserReadiness:
        try:
            document = _object(self._request_json(self.browser_readiness_url), "Browser readiness")
            state = _status(document.get("readiness_state"), "readiness_state", frozenset({
                "bridge_unavailable", "extension_not_paired", "extension_not_present", "ready",
            }))
            flags = [document.get(key) for key in (
                "ready", "bridge_available", "extension_paired", "extension_present",
            )]
            if not all(isinstance(flag, bool) for flag in flags):
                raise StatusQueryError("Browser readiness flags must be booleans")
            ready, available, paired, present = flags
            expected_state = (
                "bridge_unavailable" if not available else "extension_not_paired" if not paired
                else "extension_not_present" if not present else "ready"
            )
            if state != expected_state or ready != (state == "ready"):
                raise StatusQueryError("Browser readiness is inconsistent")
            seen = document.get("last_seen_at")
            if seen is not None and (type(seen) is not int or seen < 0):
                raise StatusQueryError("last_seen_at must be a non-negative timestamp")
            reason = _optional_text(document.get("reason"), "reason", 4000) or ""
            action = _optional_text(document.get("action"), "action", 4000) or ""
            if not ready and (not reason or not action):
                raise StatusQueryError("NOT READY must include a reason and action")
            return BrowserReadiness(ready, state, available, paired, present, seen, reason, action)
        except StatusQueryError:
            return BrowserReadiness()

    def desktop_sync_status(self) -> DesktopSyncStatus:
        try:
            document = _object(self._request_json(self.desktop_sync_url), "Desktop Sync")
            required = {
                "connected", "currentConversationId", "following", "followingThreads",
                "ownerClientId", "lastEventTime",
            }
            if not required.issubset(document):
                raise StatusQueryError("Desktop Sync fields are incomplete")
            connected = document["connected"]
            if type(connected) is not bool:
                raise StatusQueryError("connected must be a boolean")
            current = document["currentConversationId"]
            current_id = None if current is None else _identifier(current, "currentConversationId")
            following_value = document["following"]
            if following_value is not None and type(following_value) is not bool:
                raise StatusQueryError("following must be a boolean or null")
            thread_values = document["followingThreads"]
            if not isinstance(thread_values, list):
                raise StatusQueryError("followingThreads must be an array")
            following_threads = tuple(
                _text(value, "followingThreads[]", 128) for value in thread_values
            )
            owner = document["ownerClientId"]
            owner_id = None if owner is None else _identifier(owner, "ownerClientId")
            last_event = document["lastEventTime"]
            last_event_time = None if last_event is None else _rfc3339_timestamp(last_event, "lastEventTime")
            if current_id is None and following_value is not None:
                raise StatusQueryError("following requires a current conversation")
            if current_id is not None and following_value != (current_id in following_threads):
                raise StatusQueryError("following does not match the current conversation")
            if not connected and (current_id is not None or following_value is not None
                                  or following_threads or owner_id is not None):
                raise StatusQueryError("Disconnected Desktop Sync state contains evidence")

            manager_fields = {
                "mode", "activeSource", "associationStatus", "associationReason", "fallbackReason",
                "sessionId", "goalId", "taskId", "executionId", "threadId",
            }
            present_manager_fields = manager_fields.intersection(document)
            if not present_manager_fields:
                has_evidence = connected and current_id is not None
                return DesktopSyncStatus(
                    connected=connected,
                    current_conversation_id=current_id if has_evidence else None,
                    following=following_value if has_evidence else None,
                    following_threads=following_threads if has_evidence else (),
                    owner_client_id=owner_id if has_evidence else None,
                    last_event_time=last_event_time,
                    mode="auto",
                    active_source="desktop_ipc" if has_evidence else "legacy_app_server",
                    association_status="unavailable",
                    fallback_reason=(
                        None
                        if has_evidence
                        else "desktop_evidence_unavailable" if connected else "desktop_disconnected"
                    ),
                )
            if present_manager_fields != manager_fields:
                raise StatusQueryError("Desktop Sync Manager fields are incomplete")

            mode = _status(document["mode"], "mode", frozenset({"auto"}))
            active_source = _status(
                document["activeSource"], "activeSource", frozenset({"desktop_ipc", "legacy_app_server"})
            )
            association_status = _status(
                document["associationStatus"],
                "associationStatus",
                frozenset({"matched", "unmatched", "unavailable", "conflict"}),
            )
            association_reason_value = document["associationReason"]
            association_reason = None if association_reason_value is None else _status(
                association_reason_value,
                "associationReason",
                frozenset({"ambiguous_thread_mapping", "session_lookup_unavailable"}),
            )
            fallback_reason_value = document["fallbackReason"]
            fallback_reason = None if fallback_reason_value is None else _status(
                fallback_reason_value,
                "fallbackReason",
                frozenset({"desktop_disconnected", "desktop_evidence_unavailable"}),
            )
            identifiers = {
                key: None if document[key] is None else _identifier(document[key], key)
                for key in ("sessionId", "goalId", "taskId", "executionId", "threadId")
            }
            if active_source == "desktop_ipc":
                if not connected or current_id is None or following_value is None or fallback_reason is not None:
                    raise StatusQueryError("Desktop IPC source is inconsistent")
                if association_status == "matched":
                    if (
                        association_reason is not None
                        or identifiers["sessionId"] is None
                        or identifiers["goalId"] is None
                        or identifiers["taskId"] is None
                        or identifiers["threadId"] != current_id
                    ):
                        raise StatusQueryError("Matched Desktop association is incomplete")
                elif any(value is not None for value in identifiers.values()):
                    raise StatusQueryError("Unmatched Desktop association contains identity")
                if association_status == "conflict" and association_reason != "ambiguous_thread_mapping":
                    raise StatusQueryError("Conflict Desktop association lacks its reason")
                if association_status == "unavailable" and association_reason != "session_lookup_unavailable":
                    raise StatusQueryError("Unavailable Desktop association lacks its reason")
                if association_status == "unmatched" and association_reason is not None:
                    raise StatusQueryError("Unmatched Desktop association has a reason")
            else:
                if (
                    current_id is not None
                    or following_value is not None
                    or following_threads
                    or owner_id is not None
                    or association_status != "unavailable"
                    or association_reason is not None
                    or any(value is not None for value in identifiers.values())
                    or fallback_reason is None
                ):
                    raise StatusQueryError("Legacy Desktop Sync state contains Desktop evidence")
            return DesktopSyncStatus(
                connected=connected,
                current_conversation_id=current_id,
                following=following_value,
                following_threads=following_threads,
                owner_client_id=owner_id,
                last_event_time=last_event_time,
                mode=mode,
                active_source=active_source,
                association_status=association_status,
                association_reason=association_reason,
                fallback_reason=fallback_reason,
                session_id=identifiers["sessionId"],
                goal_id=identifiers["goalId"],
                task_id=identifiers["taskId"],
                execution_id=identifiers["executionId"],
                thread_id=identifiers["threadId"],
            )
        except StatusQueryError:
            return DesktopSyncStatus()

    def desktop_capability_status(self) -> DesktopCapabilityStatus:
        """The capability only reports what the preflight reports; it never acquires one."""

        try:
            document = _object(self._request_json(self.desktop_capability_url), "Desktop capability")
            if not {"ready", "pipeSource"}.issubset(document):
                raise StatusQueryError("Desktop capability fields are incomplete")
            ready = document["ready"]
            if type(ready) is not bool:
                raise StatusQueryError("ready must be a boolean")
            source_value = document["pipeSource"]
            if not ready:
                if source_value is not None:
                    raise StatusQueryError("Unavailable Desktop capability has a pipe source")
                return DesktopCapabilityStatus()
            return DesktopCapabilityStatus(
                ready=True,
                pipe_source=_status(
                    source_value,
                    "pipeSource",
                    frozenset({"handoff", "current_environment"}),
                ),
            )
        except StatusQueryError:
            return DesktopCapabilityStatus()

    def check(self) -> LauncherStatus:
        mcp_running = self._reachable(LOCAL_HEALTH_URL)
        return LauncherStatus(
            mcp_running=mcp_running,
            tunnel_connected=mcp_running and self._cloudflared_running(),
            remote_online=self._reachable(REMOTE_STATUS_URL),
        )

    def oauth_status(self) -> OAuthRegistryStatus | None:
        try:
            with urlopen(Request(
                self.oauth_clients_url,
                method="GET",
                headers=self._auth_headers(),
            ), timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, OSError, TimeoutError, ValueError):
            return None
        return self._parse_oauth_status(payload)

    def reset_oauth_clients(self) -> bool:
        try:
            with urlopen(Request(
                self.oauth_clients_url,
                method="DELETE",
                headers=self._auth_headers(),
            ), timeout=3) as response:
                return 200 <= response.status < 300
        except (HTTPError, URLError, OSError, TimeoutError):
            return False

    def delete_oauth_client(self, client_id: str) -> bool:
        if not isinstance(client_id, str) or not client_id:
            return False
        try:
            with urlopen(Request(
                f"{self.oauth_clients_url.rstrip('/')}/{quote(client_id, safe='')}",
                method="DELETE",
                headers=self._auth_headers(),
            ), timeout=3) as response:
                return 200 <= response.status < 300
        except (HTTPError, URLError, OSError, TimeoutError):
            return False

    def clear_persisted_task_records(self) -> int | None:
        try:
            payload = self._request_json(self.session_catalog_url, method="DELETE")
        except StatusQueryError:
            return None
        if not isinstance(payload, dict):
            return None
        deleted = payload.get("deleted_sessions")
        return deleted if isinstance(deleted, int) and not isinstance(deleted, bool) and deleted >= 0 else None

    def dashboard_sessions(self) -> tuple[SessionViewModel, ...]:
        catalog = self._session_catalog()
        sessions: list[SessionViewModel] = []
        for summary in catalog:
            try:
                session_status = self._call_tool("get_session_status", {
                    "session_id": summary["session_id"],
                    **({"workspace_id": self.workspace_id} if self.workspace_id else {}),
                })
            except StatusQueryError:
                continue
            if session_status.get("backend_type") != "codex_app_server":
                continue

            current = session_status.get("current_execution")
            execution_status = None
            if isinstance(current, dict) and isinstance(current.get("execution_id"), str):
                try:
                    execution_status = self._call_tool("get_execution_status", {
                        "execution_id": current["execution_id"],
                        "session_id": summary["session_id"],
                        **({"workspace_id": self.workspace_id} if self.workspace_id else {}),
                    })
                except StatusQueryError:
                    execution_status = None

            try:
                session_events = self._session_events(session_status)
            except StatusQueryError:
                session_events = None

            try:
                sessions.append(build_session_view_model(
                    session_status,
                    execution_status,
                    session_events,
                    summary=summary,
                ))
            except StatusQueryError:
                continue
        return tuple(sessions)

    def _session_events(self, session: Mapping[str, object]) -> dict[str, object]:
        events: list[object] = []
        after_sequence = 0
        while True:
            page = self._call_tool("list_session_events", {
                "session_id": session["session_id"],
                "after_sequence": after_sequence,
                **({"workspace_id": self.workspace_id} if self.workspace_id else {}),
            })
            parsed = _parse_events(page, session)
            if any(event.sequence <= after_sequence for event in parsed):
                raise StatusQueryError("Event pagination did not advance")
            events.extend(page["events"])
            has_more = page.get("has_more", False)
            if not isinstance(has_more, bool):
                raise StatusQueryError("has_more must be a boolean")
            if not has_more:
                return {"session_id": session["session_id"], "events": events}
            if not parsed:
                raise StatusQueryError("Event pagination returned an empty continuation")
            after_sequence = parsed[-1].sequence

    def _session_catalog(self) -> tuple[dict[str, object], ...]:
        payload = self._request_json(self.session_catalog_url)
        document = _object(payload, "Session catalog")
        values = document.get("sessions")
        if not isinstance(values, list):
            raise StatusQueryError("Session catalog sessions must be an array")
        summaries: list[dict[str, object]] = []
        for value in values:
            summary = _object(value, "Session catalog entry")
            summaries.append({
                "session_id": _identifier(summary.get("session_id"), "session_id"),
                "goal_name": _text(summary.get("goal_name"), "goal_name"),
                "task_name": _text(summary.get("task_name"), "task_name"),
                "updated_at": _timestamp(summary.get("updated_at"), "updated_at"),
            })
        return tuple(summaries)

    def _call_tool(self, name: str, arguments: Mapping[str, object]) -> dict[str, object]:
        payload = self._request_json(self.mcp_url, method="POST", body={
            "jsonrpc": "2.0",
            "id": str(uuid4()),
            "method": "tools/call",
            "params": {"name": name, "arguments": dict(arguments)},
        }, mcp=True)
        document = _object(payload, "MCP response")
        if document.get("error") is not None:
            raise StatusQueryError(f"MCP tool {name} failed")
        result = _object(document.get("result"), "MCP result")
        if result.get("isError") is True:
            raise StatusQueryError(f"MCP tool {name} failed")
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            return structured
        content = result.get("content")
        if isinstance(content, list) and content and isinstance(content[0], dict):
            text = content[0].get("text")
            if isinstance(text, str):
                try:
                    return _object(json.loads(text), f"MCP tool {name} output")
                except json.JSONDecodeError as error:
                    raise StatusQueryError(f"MCP tool {name} output is not JSON") from error
        raise StatusQueryError(f"MCP tool {name} returned no structured output")

    def _request_json(
        self,
        url: str,
        *,
        method: str = "GET",
        body: Mapping[str, object] | None = None,
        mcp: bool = False,
    ) -> object:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = self._auth_headers()
        if mcp:
            headers.update({
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            })
        request = Request(url, data=data, method=method, headers=headers)
        try:
            with urlopen(request, timeout=3) as response:
                raw = response.read(MAX_STATUS_RESPONSE_BYTES + 1)
                if len(raw) > MAX_STATUS_RESPONSE_BYTES:
                    raise StatusQueryError("Status Query response is too large")
                content_type = response.headers.get("content-type", "")
                return _decode_json_response(raw, content_type)
        except StatusQueryError:
            raise
        except (HTTPError, URLError, OSError, TimeoutError, UnicodeDecodeError, ValueError) as error:
            raise StatusQueryError("Status Query request failed") from error

    def _auth_headers(self) -> dict[str, str]:
        return {} if self.auth_token is None else {"Authorization": f"Bearer {self.auth_token}"}

    @staticmethod
    def _parse_oauth_status(payload: object) -> OAuthRegistryStatus | None:
        if not isinstance(payload, dict):
            return None
        storage_path = payload.get("storage_path")
        loaded = payload.get("loaded")
        client_count = payload.get("client_count")
        clients_value = payload.get("clients")
        if (
            not isinstance(storage_path, str)
            or not isinstance(loaded, bool)
            or not isinstance(client_count, int)
            or isinstance(client_count, bool)
            or client_count < 0
            or not isinstance(clients_value, list)
        ):
            return None

        clients: list[OAuthClientStatus] = []
        for value in clients_value:
            if not isinstance(value, dict):
                return None
            client_id = value.get("client_id")
            client_name = value.get("client_name")
            created_at = value.get("created_at")
            last_used = value.get("last_used")
            if (
                not isinstance(client_id, str)
                or not client_id
                or not isinstance(client_name, str)
                or not client_name
                or not isinstance(created_at, int)
                or isinstance(created_at, bool)
                or (
                    last_used is not None
                    and not isinstance(last_used, (str, int, float))
                )
            ):
                return None
            clients.append(OAuthClientStatus(client_id, client_name, created_at, last_used))
        if client_count != len(clients):
            return None
        return OAuthRegistryStatus(storage_path, loaded, client_count, tuple(clients))

    @staticmethod
    def _reachable(url: str) -> bool:
        request = Request(url, method="GET")
        try:
            with urlopen(request, timeout=3):
                return True
        except HTTPError as error:
            return error.code < 500
        except (URLError, OSError, TimeoutError):
            return False

    @staticmethod
    def _cloudflared_running() -> bool:
        try:
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq cloudflared.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                creationflags=NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0 and "cloudflared.exe" in result.stdout.casefold()

    @staticmethod
    def cloudflared_version() -> str:
        try:
            result = subprocess.run(
                ["cloudflared", "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                creationflags=NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired):
            return "unavailable"
        if result.returncode != 0:
            return "unavailable"
        output = "\n".join(
            value for value in (getattr(result, "stdout", ""), getattr(result, "stderr", ""))
            if isinstance(value, str) and value.strip()
        )
        match = re.search(r"\b\d+\.\d+\.\d+\b", output)
        return match.group(0) if match else "unavailable"
