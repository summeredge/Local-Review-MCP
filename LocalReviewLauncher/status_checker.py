"""Read-only launcher health checks."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


LOCAL_HEALTH_URL = "http://127.0.0.1:12080/health"
LOCAL_OAUTH_CLIENTS_URL = "http://127.0.0.1:12080/oauth/clients"
REMOTE_STATUS_URL = "https://review.syqiu.kdns.fr/.well-known/oauth-protected-resource"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


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
class LauncherStatus:
    mcp_running: bool
    tunnel_connected: bool
    remote_online: bool
    cloudflared_version: str = "unavailable"
    oauth_registry: OAuthRegistryStatus | None = None


class StatusChecker:
    def __init__(
        self,
        auth_token: str | None = None,
        oauth_clients_url: str = LOCAL_OAUTH_CLIENTS_URL,
    ) -> None:
        self.auth_token = auth_token
        self.oauth_clients_url = oauth_clients_url

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
