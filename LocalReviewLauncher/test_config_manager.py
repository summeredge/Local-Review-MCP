"""Small runnable checks for launcher-only workspace persistence."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from config_manager import DEFAULT_REMOTE_ENDPOINT, ConfigManager, LauncherConfig


class ConfigManagerTests(unittest.TestCase):
    @staticmethod
    def _configuration(workspace: Path) -> LauncherConfig:
        return LauncherConfig(str(workspace), "config.production.json", False)

    @staticmethod
    def _write_production(root: Path, document: object) -> None:
        (root / "config.production.json").write_text(json.dumps(document), encoding="utf-8")

    def test_workspace_is_persisted_without_changing_production_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "LocalReviewLauncher").mkdir()
            original_workspace = root / "original"
            selected_workspace = root / "selected"
            original_workspace.mkdir()
            selected_workspace.mkdir()
            production = root / "config.production.json"
            production.write_text(json.dumps({"workspace": str(original_workspace), "auth": {"token": "test"}}), encoding="utf-8")
            manager = ConfigManager(root)

            initial = manager.load()
            self.assertEqual(initial.workspace, str(original_workspace))
            saved = manager.save_workspace(initial, selected_workspace)
            self.assertEqual(json.loads(production.read_text(encoding="utf-8"))["workspace"], str(original_workspace))

            runtime_path, temporary_path = manager.runtime_config(saved)
            self.assertIsNotNone(temporary_path)
            self.assertEqual(json.loads(runtime_path.read_text(encoding="utf-8"))["workspace"], str(selected_workspace))
            temporary_path.unlink()

    def test_production_path_is_absolute(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = ConfigManager(root).production_path("config.production.json")
            self.assertEqual(path, (root / "config.production.json").resolve())

    def test_runtime_info_reads_endpoint_and_tunnel_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            self._write_production(root, {
                "workspace": str(workspace),
                "remote": {"endpoint": "https://example.test/mcp", "token": "token"},
            })
            info = ConfigManager(root).runtime_info(self._configuration(workspace))
            self.assertEqual(info.workspace, str(workspace))
            self.assertEqual(info.remote_endpoint, "https://example.test/mcp")
            self.assertEqual(info.tunnel_mode, "token")

    def test_runtime_info_supports_named_and_default_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            manager = ConfigManager(root)
            configuration = self._configuration(workspace)

            self._write_production(root, {"remote": {"tunnelName": "review"}})
            self.assertEqual(manager.runtime_info(configuration).tunnel_mode, "named")

            self._write_production(root, {"remote": {}})
            info = manager.runtime_info(configuration)
            self.assertEqual(info.tunnel_mode, "missing")
            self.assertEqual(info.remote_endpoint, DEFAULT_REMOTE_ENDPOINT)

    def test_backup_is_complete_and_unique(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            source = root / "config.production.json"
            source.write_text("first", encoding="utf-8")
            manager = ConfigManager(root)
            configuration = self._configuration(workspace)

            first = manager.backup_production_config(configuration)
            source.write_text("second", encoding="utf-8")
            second = manager.backup_production_config(configuration)

            self.assertNotEqual(first, second)
            self.assertEqual(first.read_text(encoding="utf-8"), "first")
            self.assertEqual(second.read_text(encoding="utf-8"), "second")

    def test_validation_rejects_invalid_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config.production.json").write_text("{", encoding="utf-8")
            errors = ConfigManager(root).validate_production_config(self._configuration(root))
            self.assertTrue(any("invalid JSON" in error for error in errors))

    def test_validation_rejects_missing_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._write_production(root, {
                "workspace": str(root / "missing"),
                "auth": {"token": "auth-token"},
                "remote": {"enabled": True, "provider": "cloudflare", "endpoint": "https://example.test/mcp", "token": "tunnel-token"},
                "supervisor": {"enabled": True},
            })
            errors = ConfigManager(root).validate_production_config(self._configuration(root))
            self.assertIn("workspace directory does not exist", errors)

    def test_validation_rejects_missing_remote_tunnel(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            self._write_production(root, {
                "workspace": str(workspace),
                "auth": {"token": "auth-token"},
                "remote": {"enabled": True, "provider": "cloudflare", "endpoint": "https://example.test/mcp"},
                "supervisor": {"enabled": True},
            })
            errors = ConfigManager(root).validate_production_config(self._configuration(workspace))
            self.assertIn("remote.token or remote.tunnelName is missing", errors)


if __name__ == "__main__":
    unittest.main()
