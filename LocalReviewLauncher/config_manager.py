"""Local-only settings for the Windows launcher."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONFIG_FILE = "config.production.json"


class LauncherConfigError(RuntimeError):
    """Raised when the launcher or production configuration is unusable."""


@dataclass(frozen=True)
class LauncherConfig:
    workspace: str
    config_file: str
    auto_start: bool


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise LauncherConfigError(f"{label} was not found: {path}") from error
    except json.JSONDecodeError as error:
        raise LauncherConfigError(f"{label} is not valid JSON: {path}") from error
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
                source_workspace = _read_json_object(production_path, "Production configuration").get("workspace", "")
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
        source_path = self.production_path(configuration.config_file)
        source = _read_json_object(source_path, "Production configuration")
        if source.get("workspace") == configuration.workspace:
            return source_path, None

        runtime = dict(source)
        runtime["workspace"] = configuration.workspace
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
        return path if path.is_absolute() else self.project_root / path
