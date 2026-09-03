"""Local-only settings for the Windows launcher."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


DEFAULT_CONFIG_FILE = "config.production.json"
DEFAULT_REMOTE_ENDPOINT = "https://review.syqiu.kdns.fr/mcp"


class LauncherConfigError(RuntimeError):
    """Raised when the launcher or production configuration is unusable."""


@dataclass(frozen=True)
class LauncherConfig:
    workspace: str
    config_file: str
    auto_start: bool


@dataclass(frozen=True)
class RuntimeInfo:
    workspace: str
    production_config: Path
    tunnel_mode: str
    remote_endpoint: str


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise LauncherConfigError(f"{label} was not found: {path}") from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise LauncherConfigError(f"{label} is not valid JSON: {path}") from error
    except OSError as error:
        raise LauncherConfigError(f"{label} could not be read: {path}: {error}") from error
    if not isinstance(value, dict):
        raise LauncherConfigError(f"{label} must be a JSON object: {path}")
    return value


class ConfigManager:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.launcher_directory = project_root / "LocalReviewLauncher"
        self.path = self.launcher_directory / "launcher.config.json"

    def load(self) -> LauncherConfig:
        values: dict[str, Any] = {}
        if self.path.exists():
            values = _read_json_object(self.path, "Launcher configuration")

        config_file = values.get("configFile", DEFAULT_CONFIG_FILE)
        if not isinstance(config_file, str) or not config_file.strip():
            raise LauncherConfigError("launcher.config.json configFile must be a non-empty string")
        workspace = values.get("workspace", "")
        if not isinstance(workspace, str):
            raise LauncherConfigError("launcher.config.json workspace must be a string")
        auto_start = values.get("autoStart", False)
        if not isinstance(auto_start, bool):
            raise LauncherConfigError("launcher.config.json autoStart must be true or false")

        if not workspace.strip():
            production_path = self.production_path(config_file)
            if production_path.exists():
                try:
                    source_workspace = _read_json_object(production_path, "Production configuration").get("workspace", "")
                except LauncherConfigError:
                    source_workspace = ""
                if isinstance(source_workspace, str):
                    workspace = source_workspace

        return LauncherConfig(workspace=workspace, config_file=config_file, auto_start=auto_start)

    def save_workspace(self, configuration: LauncherConfig, workspace: Path) -> LauncherConfig:
        resolved = workspace.resolve()
        if not resolved.is_dir():
            raise LauncherConfigError(f"Workspace is not an existing directory: {resolved}")
        updated = LauncherConfig(str(resolved), configuration.config_file, configuration.auto_start)
        self.launcher_directory.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({
            "workspace": updated.workspace,
            "configFile": updated.config_file,
            "autoStart": updated.auto_start,
        }, indent=2) + "\n", encoding="utf-8")
        return updated

    def runtime_config(self, configuration: LauncherConfig) -> tuple[Path, Path | None]:
        saved = self.load()
        workspace = saved.workspace or configuration.workspace
        source_path = self.production_path(configuration.config_file)
        source = _read_json_object(source_path, "Production configuration")
        if source.get("workspace") == workspace:
            return source_path, None

        runtime = dict(source)
        runtime["workspace"] = workspace
        descriptor, temporary_name = tempfile.mkstemp(prefix="local-review-launcher-", suffix=".json")
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(runtime, stream, indent=2)
                stream.write("\n")
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
        return temporary_path, temporary_path

    def production_path(self, config_file: str) -> Path:
        path = Path(config_file)
        return (path if path.is_absolute() else self.project_root / path).resolve()

    def runtime_info(self, configuration: LauncherConfig) -> RuntimeInfo:
        path = self.production_path(configuration.config_file)
        source = _read_json_object(path, "Production configuration")
        remote = source.get("remote")
        endpoint = DEFAULT_REMOTE_ENDPOINT
        tunnel_mode = "missing"
        if isinstance(remote, dict):
            configured_endpoint = remote.get("endpoint")
            if isinstance(configured_endpoint, str) and configured_endpoint.strip():
                endpoint = configured_endpoint.strip()
            if isinstance(remote.get("tunnelName"), str) and remote["tunnelName"].strip():
                tunnel_mode = "named"
            elif isinstance(remote.get("token"), str) and remote["token"].strip():
                tunnel_mode = "token"
        return RuntimeInfo(
            workspace=configuration.workspace,
            production_config=path,
            tunnel_mode=tunnel_mode,
            remote_endpoint=endpoint,
        )

    def backup_production_config(self, configuration: LauncherConfig) -> Path:
        source = self.production_path(configuration.config_file)
        if not source.is_file():
            raise LauncherConfigError(f"Production configuration was not found: {source}")
        runtime_path, temporary_path = self.runtime_config(configuration)

        try:
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            base_name = f"{source.stem}.backup-{timestamp}{source.suffix}"
            candidate = source.with_name(base_name)
            counter = 1
            while True:
                try:
                    with candidate.open("xb") as destination, runtime_path.open("rb") as original:
                        shutil.copyfileobj(original, destination)
                    shutil.copystat(source, candidate)
                    return candidate
                except FileExistsError:
                    candidate = source.with_name(f"{source.stem}.backup-{timestamp}-{counter}{source.suffix}")
                    counter += 1
                except OSError as error:
                    candidate.unlink(missing_ok=True)
                    raise LauncherConfigError(f"Could not back up production configuration: {error}") from error
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def validate_production_config(self, configuration: LauncherConfig) -> list[str]:
        path = self.production_path(configuration.config_file)
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return [f"production config does not exist: {path}"]
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            return [f"invalid JSON: {error}"]
        except OSError as error:
            return [f"production config could not be read: {error}"]
        if not isinstance(document, dict):
            return ["production config must be a JSON object"]

        missing = object()
        errors: list[str] = []

        def section(name: str) -> dict[str, Any] | None:
            value = document.get(name, missing)
            if value is missing:
                errors.append(f"{name} is missing")
                return None
            if not isinstance(value, dict):
                errors.append(f"{name} must be an object")
                return None
            return value

        workspace = document.get("workspace", missing)
        if workspace is missing:
            errors.append("workspace is missing")
        elif not isinstance(workspace, str) or not workspace.strip():
            errors.append("workspace must be a non-empty path")
        else:
            workspace_path = Path(workspace)
            if not workspace_path.is_absolute():
                workspace_path = self.project_root / workspace_path
            try:
                if not workspace_path.is_dir():
                    errors.append("workspace directory does not exist")
                else:
                    next(workspace_path.iterdir(), None)
            except OSError:
                errors.append("workspace directory is not accessible")

        auth = section("auth")
        if auth is not None:
            auth_token = auth.get("token")
            environment_token = os.environ.get("LOCAL_REVIEW_MCP_TOKEN")
            if not _valid_token(auth_token) and not _valid_token(environment_token):
                errors.append("auth.token is missing or invalid")

        remote = section("remote")
        remote_enabled = False
        if remote is not None:
            enabled = remote.get("enabled", missing)
            if enabled is missing:
                errors.append("remote.enabled is missing")
            elif not isinstance(enabled, bool):
                errors.append("remote.enabled must be true or false")
            else:
                remote_enabled = enabled

            provider = remote.get("provider", missing)
            if remote_enabled and provider is missing:
                errors.append("remote.provider is missing")
            elif provider is not missing and provider != "cloudflare":
                errors.append("remote.provider must be cloudflare")

            remote_endpoint = remote.get("endpoint", missing)
            if remote_endpoint is not missing and remote_endpoint != "" and not _valid_https_url(remote_endpoint):
                errors.append("remote.endpoint must be a valid HTTPS URL")
            elif remote_enabled and not _valid_https_url(remote_endpoint):
                errors.append("remote.endpoint is missing or invalid")

            token = remote.get("token")
            tunnel_name = remote.get("tunnelName")
            valid_token = _valid_token(token)
            valid_tunnel_name = _valid_tunnel_name(tunnel_name)
            if remote_enabled and not valid_token and not valid_tunnel_name:
                errors.append("remote.token or remote.tunnelName is missing")
            if valid_token and valid_tunnel_name:
                errors.append("remote.token and remote.tunnelName cannot both be set")

        port = document.get("port", 12080)
        try:
            numeric_port = float(port) if not isinstance(port, bool) else float("nan")
        except (TypeError, ValueError):
            numeric_port = float("nan")
        if not numeric_port.is_integer() or not 1 <= numeric_port <= 65535:
            errors.append("port must be an integer from 1 to 65535")

        section("supervisor")
        return errors


def _valid_token(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and not any(character.isspace() for character in value)


def _valid_tunnel_name(value: object) -> bool:
    return _valid_token(value)


def _valid_https_url(value: object) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = urlparse(value.strip())
        return parsed.scheme == "https" and bool(parsed.hostname) and parsed.username is None and parsed.password is None
    except ValueError:
        return False
