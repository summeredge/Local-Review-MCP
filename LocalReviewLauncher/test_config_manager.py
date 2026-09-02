"""Small runnable checks for launcher-only workspace persistence."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from config_manager import ConfigManager


class ConfigManagerTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
