"""Local-only settings for the Windows launcher."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import tempfile
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


DEFAULT_CONFIG_FILE = "config.production.json"
DEFAULT_REMOTE_ENDPOINT = "https://review.syqiu.kdns.fr/mcp"


class LauncherConfigError(RuntimeError):
    """Raised when the launcher or production configuration is unusable."""


@dataclass(frozen=True)
class WorkspaceRecord:
    id: str
    name: str
    path: str


# Kept as an alias for callers that use the registry terminology.
WorkspaceEntry = WorkspaceRecord


@dataclass(frozen=True)
class LauncherConfig:
    workspace: str
    config_file: str
    auto_start: bool
    active_workspace_id: str | None = None
    workspaces: tuple[WorkspaceRecord, ...] = ()


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
    _WORKSPACE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    _MISSING = object()

    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.launcher_directory = project_root / "LocalReviewLauncher"
        self.path = self.launcher_directory / "launcher.config.json"

    def load(self) -> LauncherConfig:
        had_config = self.path.exists()
        values: dict[str, Any] = {}
        if had_config:
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

        production_values: dict[str, Any] = {}
        production_path = self.production_path(config_file)
        if production_path.exists():
            try:
                production_values = _read_json_object(production_path, "Production configuration")
            except LauncherConfigError:
                production_values = {}
        if not workspace.strip():
            workspace = self._workspace_path(production_values.get("workspace", ""))

        registry_value = values.get("workspaces", self._MISSING)
        migrated = False
        if registry_value is self._MISSING:
            records = self._legacy_records(production_values.get("workspaces"), production_path)
            identity_record = self._workspace_identity(production_values.get("workspace"))
            if not records and identity_record is not None:
                records.append(identity_record)
            if workspace.strip() and not self._find_record(records, workspace):
                records.append(self._new_record(workspace, records))
            active = self._find_record(records, workspace) or (records[0] if records else None)
            migrated = had_config
        else:
            records = self._parse_records(registry_value, "Launcher configuration")
            active_value = values.get("active_workspace_id", values.get("activeWorkspaceId", self._MISSING))
            if active_value is not self._MISSING and active_value is not None:
                if not isinstance(active_value, str) or not active_value.strip():
                    raise LauncherConfigError(
                        "launcher.config.json active_workspace_id must be a non-empty string"
                    )
                active = next((record for record in records if record.id == active_value), None)
                if active is None:
                    raise LauncherConfigError("launcher.config.json active_workspace_id is not registered")
            else:
                active = self._find_record(records, workspace)
                if active is None and workspace.strip():
                    records.append(self._new_record(workspace, records))
                    active = records[-1]
                    migrated = True
                elif active is None and records:
                    active = records[0]

        if active is None:
            workspace = ""
            active_workspace_id = None
        else:
            workspace = active.path
            active_workspace_id = active.id

        configuration = LauncherConfig(
            workspace=workspace,
            config_file=config_file,
            auto_start=auto_start,
            active_workspace_id=active_workspace_id,
            workspaces=tuple(records),
        )
        if had_config and (
            migrated
            or values.get("workspace") != configuration.workspace
            or values.get("active_workspace_id", self._MISSING) != configuration.active_workspace_id
            or values.get("workspaces", self._MISSING) != self._records_json(configuration.workspaces)
        ):
            self._write_configuration(configuration, values)
        return configuration

    def save_workspace(self, configuration: LauncherConfig, workspace: Path) -> LauncherConfig:
        return self.add_workspace(configuration, workspace)

    def add_workspace(
        self,
        configuration: LauncherConfig,
        workspace: Path,
        name: str | None = None,
    ) -> LauncherConfig:
        resolved = self._validate_workspace_path(workspace)
        current = self._configuration_for_update(configuration)
        existing = self._find_record(current.workspaces, str(resolved))
        if existing is None:
            workspace_name = (name or resolved.name or "Workspace").strip()
            if not workspace_name:
                raise LauncherConfigError("Workspace name must not be empty")
            existing = WorkspaceRecord(self._new_workspace_id(current.workspaces), workspace_name, str(resolved))
            records = (*current.workspaces, existing)
        else:
            records = current.workspaces
        updated = replace(
            current,
            workspace=existing.path,
            active_workspace_id=existing.id,
            workspaces=tuple(records),
        )
        return self._write_configuration(updated)

    def remove_workspace(self, configuration: LauncherConfig, workspace_id: str) -> LauncherConfig:
        current = self._configuration_for_update(configuration)
        records = [record for record in current.workspaces if record.id != workspace_id]
        if len(records) == len(current.workspaces):
            raise LauncherConfigError(f"Workspace is not registered: {workspace_id}")
        active = next((record for record in records if record.id == current.active_workspace_id), None)
        active = active or (records[0] if records else None)
        updated = replace(
            current,
            workspace=active.path if active else "",
            active_workspace_id=active.id if active else None,
            workspaces=tuple(records),
        )
        return self._write_configuration(updated)

    def rename_workspace(
        self,
        configuration: LauncherConfig,
        workspace_id: str,
        name: str,
    ) -> LauncherConfig:
        workspace_name = name.strip()
        if not workspace_name:
            raise LauncherConfigError("Workspace name must not be empty")
        current = self._configuration_for_update(configuration)
        for index, record in enumerate(current.workspaces):
            if record.id == workspace_id:
                records = list(current.workspaces)
                records[index] = replace(record, name=workspace_name)
                return self._write_configuration(replace(current, workspaces=tuple(records)))
        raise LauncherConfigError(f"Workspace is not registered: {workspace_id}")

    def set_active_workspace(self, configuration: LauncherConfig, workspace_id: str) -> LauncherConfig:
        current = self._configuration_for_update(configuration)
        active = next((record for record in current.workspaces if record.id == workspace_id), None)
        if active is None:
            raise LauncherConfigError(f"Workspace is not registered: {workspace_id}")
        return self._write_configuration(
            replace(current, workspace=active.path, active_workspace_id=active.id)
        )

    def runtime_config(self, configuration: LauncherConfig) -> tuple[Path, Path | None]:
        had_config = self.path.exists()
        saved = self.load()
        workspace = saved.workspace or configuration.workspace
        source_path = self.production_path(saved.config_file if had_config else configuration.config_file)
        source = _read_json_object(source_path, "Production configuration")
        runtime = dict(source)
        runtime["workspace"] = workspace
        has_registry = (
            bool(saved.workspaces)
            and (self.path.exists() or isinstance(source.get("workspaces"), list)
                 or isinstance(source.get("workspace"), dict))
        )
        if has_registry:
            active = next(
                (record for record in saved.workspaces if record.id == saved.active_workspace_id),
                None,
            ) or self._find_record(saved.workspaces, workspace)
            if active is None:
                raise LauncherConfigError("Active workspace is not registered")
            runtime["workspace"] = {
                "id": active.id,
                "name": active.name,
                "path": active.path,
            }
            runtime["workspaces"] = self._records_json(saved.workspaces)
        elif not workspace and "workspaces" in runtime:
            runtime.pop("workspaces")
        if runtime == source:
            return source_path, None

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
        had_config = self.path.exists()
        saved = self.load()
        path = self.production_path(saved.config_file if had_config else configuration.config_file)
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
            workspace=saved.workspace or configuration.workspace,
            production_config=path,
            tunnel_mode=tunnel_mode,
            remote_endpoint=endpoint,
        )

    def _configuration_for_update(self, configuration: LauncherConfig) -> LauncherConfig:
        had_config = self.path.exists()
        current = self.load()
        if not had_config:
            return replace(
                current,
                config_file=configuration.config_file,
                auto_start=configuration.auto_start,
            )
        return current

    def _write_configuration(
        self,
        configuration: LauncherConfig,
        base: dict[str, Any] | None = None,
    ) -> LauncherConfig:
        values = dict(base) if base is not None else {}
        if base is None and self.path.exists():
            values = _read_json_object(self.path, "Launcher configuration")
        values.update({
            "workspace": configuration.workspace,
            "configFile": configuration.config_file,
            "autoStart": configuration.auto_start,
            "active_workspace_id": configuration.active_workspace_id,
            "workspaces": self._records_json(configuration.workspaces),
        })
        self.launcher_directory.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(values, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return configuration

    def _validate_workspace_path(self, workspace: Path) -> Path:
        try:
            resolved = workspace.resolve(strict=True)
        except (FileNotFoundError, OSError, RuntimeError):
            resolved = workspace.absolute()
        if not resolved.is_dir():
            raise LauncherConfigError(f"Workspace is not an existing directory: {resolved}")
        return resolved

    def _parse_records(self, value: object, label: str) -> list[WorkspaceRecord]:
        if not isinstance(value, list):
            raise LauncherConfigError(f"{label} workspaces must be an array")
        records: list[WorkspaceRecord] = []
        ids: set[str] = set()
        paths: set[str] = set()
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise LauncherConfigError(f"{label} workspaces[{index}] must be an object")
            workspace_id = item.get("id")
            name = item.get("name")
            workspace_path = item.get("path")
            if (
                not isinstance(workspace_id, str)
                or not self._WORKSPACE_ID_PATTERN.fullmatch(workspace_id)
                or not isinstance(name, str)
                or not name.strip()
                or not isinstance(workspace_path, str)
                or not workspace_path.strip()
            ):
                raise LauncherConfigError(
                    f"{label} workspaces[{index}] must have a valid id, name, and path"
                )
            path_key = self._workspace_path_key(workspace_path)
            if workspace_id in ids:
                raise LauncherConfigError("Workspace registry contains duplicate ids")
            if path_key in paths:
                raise LauncherConfigError("Workspace registry contains duplicate paths")
            ids.add(workspace_id)
            paths.add(path_key)
            records.append(WorkspaceRecord(workspace_id, name.strip(), workspace_path))
        return records

    def _legacy_records(self, value: object, source: Path) -> list[WorkspaceRecord]:
        if not isinstance(value, list):
            return []
        try:
            return self._parse_records(value, f"Production configuration {source}")
        except LauncherConfigError:
            return []

    def _find_record(
        self,
        records: list[WorkspaceRecord] | tuple[WorkspaceRecord, ...],
        workspace: str,
    ) -> WorkspaceRecord | None:
        if not workspace.strip():
            return None
        key = self._workspace_path_key(workspace)
        return next((record for record in records if self._workspace_path_key(record.path) == key), None)

    def _new_record(
        self,
        workspace: str,
        records: list[WorkspaceRecord] | tuple[WorkspaceRecord, ...] = (),
    ) -> WorkspaceRecord:
        path = Path(workspace)
        return WorkspaceRecord(self._new_workspace_id(records), self._workspace_name(path), workspace)

    @staticmethod
    def _new_workspace_id(records: tuple[WorkspaceRecord, ...] | list[WorkspaceRecord]) -> str:
        used = {record.id for record in records}
        workspace_id = secrets.token_hex(6)
        while workspace_id in used:
            workspace_id = secrets.token_hex(6)
        return workspace_id

    def _workspace_path_key(self, workspace: str) -> str:
        path = Path(workspace)
        if not path.is_absolute():
            path = self.project_root / path
        try:
            path = path.resolve()
        except (OSError, RuntimeError):
            path = path.absolute()
        return os.path.normcase(str(path))

    @staticmethod
    def _workspace_name(workspace: Path) -> str:
        return workspace.name or "Workspace"

    @staticmethod
    def _workspace_path(value: object) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, dict) and isinstance(value.get("path"), str):
            return value["path"]
        return ""

    @classmethod
    def _workspace_identity(cls, value: object) -> WorkspaceRecord | None:
        if not isinstance(value, dict):
            return None
        workspace_id = value.get("id")
        name = value.get("name")
        workspace_path = value.get("path")
        if (
            not isinstance(workspace_id, str)
            or not cls._WORKSPACE_ID_PATTERN.fullmatch(workspace_id)
            or not isinstance(name, str)
            or not name.strip()
            or not isinstance(workspace_path, str)
            or not workspace_path.strip()
        ):
            return None
        return WorkspaceRecord(workspace_id, name.strip(), workspace_path)

    @staticmethod
    def _records_json(records: tuple[WorkspaceRecord, ...] | list[WorkspaceRecord]) -> list[dict[str, str]]:
        return [{"id": record.id, "name": record.name, "path": record.path} for record in records]

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

        workspace_value = document.get("workspace", missing)
        if workspace_value is missing:
            errors.append("workspace is missing")
            workspace = ""
        else:
            identity = self._workspace_identity(workspace_value)
            workspace = identity.path if identity is not None else self._workspace_path(workspace_value)
            if isinstance(workspace_value, dict) and identity is None:
                errors.append("workspace identity must have a valid id, name, and path")
        if not workspace:
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
