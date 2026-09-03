"""Read-only launcher health checks."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


LOCAL_HEALTH_URL = "http://127.0.0.1:12080/health"
REMOTE_STATUS_URL = "https://review.syqiu.kdns.fr/.well-known/oauth-protected-resource"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


@dataclass(frozen=True)
class LauncherStatus:
    mcp_running: bool
    tunnel_connected: bool
    remote_online: bool
    cloudflared_version: str = "unavailable"


class StatusChecker:
    def check(self) -> LauncherStatus:
        mcp_running = self._reachable(LOCAL_HEALTH_URL)
        return LauncherStatus(
            mcp_running=mcp_running,
            tunnel_connected=mcp_running and self._cloudflared_running(),
            remote_online=self._reachable(REMOTE_STATUS_URL),
        )

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
