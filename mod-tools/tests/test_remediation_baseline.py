# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_remediation_baseline as baseline


class RemediationBaselineTests(unittest.TestCase):
    def _repo_fixture(self, root: Path) -> None:
        database_root = root / ".database"
        database_root.mkdir(parents=True)
        connection = sqlite3.connect(database_root / "wdfp_data.db")
        try:
            connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
            connection.execute("INSERT INTO sample(value) VALUES ('ok')")
            connection.commit()
        finally:
            connection.close()

        release_root = root / ".cdn" / "cn" / "character-releases"
        release_root.mkdir(parents=True)
        (release_root / "active.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "base_version": "1.4.133",
                    "releases": [
                        {
                            "from_version": "1.4.133",
                            "to_version": "1.4.134",
                            "archives": [],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

    def test_capture_baseline_redacts_secrets_and_preserves_dirty_paths(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self._repo_fixture(root)
            output_root = root / "work" / "remediation"

            def runner(argv: list[str], cwd: Path) -> str:
                self.assertEqual(root, cwd)
                if argv == ["git", "rev-parse", "HEAD"]:
                    return "a" * 40 + "\n"
                if argv == ["git", "status", "--short"]:
                    return " M assets/character.json\n?? work/\n"
                raise AssertionError(f"unexpected command: {argv}")

            run_dir = baseline.capture_baseline(
                root,
                output_root,
                {
                    "CN_LISTEN_HOST": "127.0.0.1",
                    "CN_ADMIN_TOKEN": "admin-secret",
                    "CDN_PUBLIC_ROOT": "D:/cdn",
                    "GITHUB_TOKEN": "github-secret",
                    "UNRELATED_SECRET": "other-secret",
                },
                runner=runner,
            )

            payload = json.loads((run_dir / "baseline.json").read_text(encoding="utf-8"))
            serialized = json.dumps(payload, ensure_ascii=False)
            self.assertNotIn("admin-secret", serialized)
            self.assertNotIn("github-secret", serialized)
            self.assertNotIn("other-secret", serialized)
            self.assertEqual(
                {"CN_LISTEN_HOST": "127.0.0.1", "CDN_PUBLIC_ROOT": "D:/cdn"},
                payload["environment"],
            )
            self.assertEqual("a" * 40, payload["git"]["head"])
            self.assertEqual(
                [" M assets/character.json", "?? work/"], payload["git"]["status"]
            )
            self.assertEqual("ok", payload["database"]["quick_check"])
            self.assertEqual([], payload["database"]["foreign_key_check"])
            self.assertEqual("1.4.133", payload["character_release"]["base_version"])
            self.assertEqual("1.4.134", payload["character_release"]["tail_version"])
            self.assertEqual(1, payload["character_release"]["release_count"])
            self.assertEqual(run_dir.name, payload["run_id"])
            self.assertEqual([], list(run_dir.glob("*.tmp")))

    def test_database_checks_report_missing_database_without_creating_one(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            result = baseline.database_checks(root)
            self.assertEqual("missing", result["status"])
            self.assertFalse((root / ".database").exists())

    def test_release_summary_rejects_duplicate_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            release_root = root / ".cdn" / "cn" / "character-releases"
            release_root.mkdir(parents=True)
            (release_root / "active.json").write_text(
                '{"base_version":"1.4.133","base_version":"1.4.999","releases":[]}',
                encoding="utf-8",
            )
            result = baseline.active_manifest_summary(root)
            self.assertEqual("invalid", result["status"])
            self.assertIn("duplicate JSON key", result["error"])

    def test_effective_environment_reads_dotenv_without_exposing_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".env").write_text(
                "\ufeff# local config\n"
                'CN_LISTEN_HOST="192.168.0.130"\n'
                "CN_ADMIN_TOKEN=must-not-escape\n"
                "CDN_PUBLIC_ROOT=D:/cdn # comment\n"
                "UNRELATED=value\n",
                encoding="utf-8",
            )
            result = baseline.effective_environment(
                root, {"CN_LISTEN_HOST": "127.0.0.1", "GITHUB_TOKEN": "also-secret"}
            )
            self.assertEqual(
                {"CDN_PUBLIC_ROOT": "D:/cdn", "CN_LISTEN_HOST": "127.0.0.1"}, result
            )
            self.assertNotIn("must-not-escape", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
