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
            self.assertEqual(json.loads(runtime_path.read_text(encoding="utf-8"))["workspace"]["path"], str(selected_workspace))
            temporary_path.unlink()

    def test_runtime_config_uses_latest_saved_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "LocalReviewLauncher").mkdir()
            original_workspace = root / "original"
            selected_workspace = root / "selected"
            original_workspace.mkdir()
            selected_workspace.mkdir()
            self._write_production(root, {"workspace": str(original_workspace), "auth": {"token": "test"}})
            manager = ConfigManager(root)
            initial = manager.load()
            manager.save_workspace(initial, selected_workspace)

            runtime_path, temporary_path = manager.runtime_config(initial)

            self.assertIsNotNone(temporary_path)
            self.assertEqual(json.loads(runtime_path.read_text(encoding="utf-8"))["workspace"]["path"], str(selected_workspace))
            temporary_path.unlink()

    def test_registry_adds_two_workspaces_and_persists_the_active_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace_a = root / "workspace-a"
            workspace_b = root / "workspace-b"
            workspace_a.mkdir()
            workspace_b.mkdir()
            self._write_production(root, {"auth": {"token": "test"}})
            manager = ConfigManager(root)

            configuration = manager.load()
            configuration = manager.add_workspace(configuration, workspace_a, "Workspace A")
            configuration = manager.add_workspace(configuration, workspace_b, "Workspace B")
            reloaded = manager.load()
            document = json.loads(manager.path.read_text(encoding="utf-8"))

            self.assertEqual([record.name for record in reloaded.workspaces], ["Workspace A", "Workspace B"])
            self.assertEqual(document["active_workspace_id"], configuration.active_workspace_id)
            self.assertEqual(document["workspaces"], [
                {"id": record.id, "name": record.name, "path": record.path}
                for record in reloaded.workspaces
            ])
            self.assertEqual(reloaded.workspace, str(workspace_b.resolve()))
            self.assertNotEqual(reloaded.workspaces[0].id, reloaded.workspaces[1].id)

    def test_registry_rename_keeps_id_and_path_after_reload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            self._write_production(root, {"auth": {"token": "test"}})
            manager = ConfigManager(root)

            added = manager.add_workspace(manager.load(), workspace, "Original")
            record = added.workspaces[0]
            manager.rename_workspace(added, record.id, "Renamed")
            reloaded = manager.load()

            self.assertEqual(reloaded.workspaces[0].id, record.id)
            self.assertEqual(reloaded.workspaces[0].path, record.path)
            self.assertEqual(reloaded.workspaces[0].name, "Renamed")

    def test_registry_delete_keeps_workspace_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            self._write_production(root, {"auth": {"token": "test"}})
            manager = ConfigManager(root)

            added = manager.add_workspace(manager.load(), workspace, "Workspace")
            removed = manager.remove_workspace(added, added.active_workspace_id or "")

            self.assertEqual(removed.workspaces, ())
            self.assertIsNone(removed.active_workspace_id)
            self.assertTrue(workspace.is_dir())
            self.assertEqual(manager.load().workspaces, ())

    def test_runtime_config_passes_registry_and_active_workspace_to_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace_a = root / "workspace-a"
            workspace_b = root / "workspace-b"
            workspace_a.mkdir()
            workspace_b.mkdir()
            self._write_production(root, {"auth": {"token": "test"}})
            manager = ConfigManager(root)

            configuration = manager.add_workspace(manager.load(), workspace_a, "Workspace A")
            configuration = manager.add_workspace(configuration, workspace_b, "Workspace B")
            configuration = manager.set_active_workspace(configuration, configuration.workspaces[0].id)
            runtime_path, temporary_path = manager.runtime_config(configuration)
            try:
                runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
                self.assertEqual(runtime["workspace"], {
                    "id": configuration.workspaces[0].id,
                    "name": configuration.workspaces[0].name,
                    "path": configuration.workspaces[0].path,
                })
                self.assertEqual(runtime["workspaces"], [
                    {"id": record.id, "name": record.name, "path": record.path}
                    for record in configuration.workspaces
                ])
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)

    def test_runtime_config_preserves_identity_from_production_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            identity = {"id": "workspace-id", "name": "Workspace", "path": str(workspace)}
            self._write_production(root, {"workspace": identity, "auth": {"token": "test"}})

            runtime_path, temporary_path = ConfigManager(root).runtime_config(
                self._configuration(workspace),
            )
            try:
                runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
                self.assertEqual(runtime["workspace"], identity)
                self.assertEqual(runtime["workspaces"], [identity])
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)

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
            source.write_text(json.dumps({"workspace": str(workspace), "value": "first"}), encoding="utf-8")
            manager = ConfigManager(root)
            configuration = self._configuration(workspace)

            first = manager.backup_production_config(configuration)
            source.write_text(json.dumps({"workspace": str(workspace), "value": "second"}), encoding="utf-8")
            second = manager.backup_production_config(configuration)

            self.assertNotEqual(first, second)
            self.assertEqual(json.loads(first.read_text(encoding="utf-8"))["value"], "first")
            self.assertEqual(json.loads(second.read_text(encoding="utf-8"))["value"], "second")

    def test_backup_uses_latest_saved_workspace_and_preserves_production(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "LocalReviewLauncher").mkdir()
            original_workspace = root / "original"
            selected_workspace = root / "selected"
            original_workspace.mkdir()
            selected_workspace.mkdir()
            production = root / "config.production.json"
            production_document = {"workspace": str(original_workspace), "auth": {"token": "test"}}
            production.write_text(json.dumps(production_document), encoding="utf-8")
            manager = ConfigManager(root)

            initial = manager.load()
            manager.save_workspace(initial, selected_workspace)
            runtime_path, temporary_path = manager.runtime_config(initial)
            runtime_document = json.loads(runtime_path.read_text(encoding="utf-8"))
            if temporary_path is not None:
                temporary_path.unlink()
            backup = manager.backup_production_config(initial)

            backup_document = json.loads(backup.read_text(encoding="utf-8"))
            self.assertEqual(backup_document["workspace"]["path"], str(selected_workspace))
            self.assertEqual(backup_document, runtime_document)
            self.assertEqual(json.loads(production.read_text(encoding="utf-8")), production_document)

    def test_backup_uses_production_workspace_when_not_switched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            production = root / "config.production.json"
            production_document = {"workspace": str(workspace), "auth": {"token": "test"}}
            production.write_text(json.dumps(production_document), encoding="utf-8")

            backup = ConfigManager(root).backup_production_config(self._configuration(workspace))

            self.assertEqual(json.loads(backup.read_text(encoding="utf-8")), production_document)

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
