# -*- coding: utf-8 -*-
"""Atomic, snapshot-bound publication regression tests."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_mod_tool as core  # noqa: E402
import wf_publish  # noqa: E402


class PublisherCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / "store"
        self.store.mkdir()
        self.cdn = self.root / "cdn"
        self.work = self.root / "work"
        self.work.mkdir()
        self.pending = self.work / "sync_pending.json"
        self.profile = core.VersionProfile(
            id="cn", label="CN", store=self.store, fallback=None
        )
        self.patchers = (
            mock.patch.object(wf_publish, "CDN_ROOT", self.cdn),
            mock.patch.object(
                wf_publish, "CDN_DIFF", self.cdn / "archive-common-diff"
            ),
            mock.patch.object(wf_publish, "WORK", self.work),
            mock.patch.object(wf_publish, "PENDING", self.pending),
            mock.patch.object(wf_publish, "CHANGELOG", self.work / "changelog.jsonl"),
            mock.patch.object(wf_publish, "CHANGELOG_MD", self.work / "changelog.md"),
            mock.patch.object(wf_publish, "current_max_version", return_value="1.4.54"),
            mock.patch.object(wf_publish, "stamp_changelog", return_value=0),
            mock.patch.object(wf_publish.time, "strftime", return_value="modfixture"),
        )
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_logical(self, logical: str, payload: bytes) -> str:
        digest = core.sha1_path(logical)
        relative = f"{digest[:2]}/{digest[2:]}"
        path = self.store / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return relative

    def write_snapshot(
        self,
        logicals: list[str],
        *,
        store: Path | None = None,
        entries: list[dict[str, object]] | None = None,
    ) -> Path:
        if entries is None:
            entries = []
            for logical in logicals:
                digest = core.sha1_path(logical)
                relative = f"{digest[:2]}/{digest[2:]}"
                payload = (self.store / relative).read_bytes()
                entries.append(
                    {
                        "logical": logical,
                        "relative": relative,
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "size": len(payload),
                    }
                )
        path = self.root / "release-snapshot.json"
        path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "profile_id": "cn",
                    "store": str((store or self.store).resolve()),
                    "entries": entries,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return path

    def run_publish(
        self,
        args: list[str],
        *,
        profiles: list[core.VersionProfile] | None = None,
    ) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        profile_patch = (
            mock.patch.object(core, "resolve_profile", side_effect=profiles)
            if profiles is not None
            else mock.patch.object(core, "resolve_profile", return_value=self.profile)
        )
        with (
            profile_patch,
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            result = wf_publish.main(args)
        return result, stdout.getvalue(), stderr.getvalue()

    def archives(self) -> list[Path]:
        return sorted(self.cdn.rglob("*.zip")) if self.cdn.exists() else []


class TestStrictSnapshotPublisher(PublisherCase):
    def test_snapshot_success_archives_the_exact_prevalidated_bytes(self):
        logicals = ["master/test/one.orderedmap", "item/test/two.png"]
        expected: dict[str, bytes] = {}
        for index, logical in enumerate(logicals):
            payload = f"validated-{index}".encode()
            relative = self.write_logical(logical, payload)
            expected[f"production/upload/{relative}"] = payload
        snapshot = self.write_snapshot(logicals)

        result, stdout, _stderr = self.run_publish(
            ["--tables", ",".join(logicals), "--snapshot", str(snapshot)],
            profiles=[self.profile, self.profile],
        )

        self.assertEqual(0, result)
        self.assertIn("[OK]", stdout)
        self.assertEqual(1, len(self.archives()))
        with zipfile.ZipFile(self.archives()[0]) as archive:
            self.assertEqual(set(expected), set(archive.namelist()))
            for name, payload in expected.items():
                self.assertEqual(payload, archive.read(name))

    def test_snapshot_hash_mismatch_creates_no_archive_or_success(self):
        logical = "master/test/one.orderedmap"
        relative = self.write_logical(logical, b"validated")
        snapshot = self.write_snapshot([logical])
        (self.store / relative).write_bytes(b"changed-after-gate")

        result, stdout, stderr = self.run_publish(
            ["--tables", logical, "--snapshot", str(snapshot)]
        )

        self.assertNotEqual(0, result)
        self.assertIn("snapshot", stderr.lower())
        self.assertNotIn("[OK]", stdout)
        self.assertEqual([], self.archives())

    def test_snapshot_allowlist_order_mismatch_creates_no_archive(self):
        logicals = ["master/test/one.orderedmap", "master/test/two.orderedmap"]
        for logical in logicals:
            self.write_logical(logical, logical.encode())
        snapshot = self.write_snapshot(list(reversed(logicals)))

        result, stdout, _stderr = self.run_publish(
            ["--tables", ",".join(logicals), "--snapshot", str(snapshot)]
        )

        self.assertNotEqual(0, result)
        self.assertNotIn("[OK]", stdout)
        self.assertEqual([], self.archives())

    def test_profile_store_change_after_snapshot_check_creates_no_archive(self):
        logical = "master/test/one.orderedmap"
        self.write_logical(logical, b"validated")
        snapshot = self.write_snapshot([logical])
        changed_store = self.root / "changed-store"
        changed_store.mkdir()
        changed_profile = core.VersionProfile(
            id="cn", label="CN changed", store=changed_store, fallback=None
        )

        result, stdout, stderr = self.run_publish(
            ["--tables", logical, "--snapshot", str(snapshot)],
            profiles=[self.profile, changed_profile],
        )

        self.assertNotEqual(0, result)
        self.assertIn("store", stderr.lower())
        self.assertNotIn("[OK]", stdout)
        self.assertEqual([], self.archives())

    def test_profile_id_change_with_same_store_creates_no_archive(self):
        logical = "master/test/one.orderedmap"
        self.write_logical(logical, b"validated")
        snapshot = self.write_snapshot([logical])
        changed_profile = core.VersionProfile(
            id="global", label="Wrong profile", store=self.store, fallback=None
        )

        result, stdout, stderr = self.run_publish(
            ["--tables", logical, "--snapshot", str(snapshot)],
            profiles=[self.profile, changed_profile],
        )

        self.assertNotEqual(0, result)
        self.assertIn("profile", stderr.lower())
        self.assertNotIn("[OK]", stdout)
        self.assertEqual([], self.archives())

    def test_explicit_missing_entry_fails_before_any_partial_archive(self):
        present = "master/test/present.orderedmap"
        missing = "master/test/missing.orderedmap"
        self.write_logical(present, b"present")

        result, stdout, stderr = self.run_publish(
            ["--tables", f"{present},{missing}"]
        )

        self.assertNotEqual(0, result)
        self.assertIn("missing", stderr.lower())
        self.assertNotIn("[OK]", stdout)
        self.assertEqual([], self.archives())

    def test_archive_build_failure_removes_temporary_output_and_success(self):
        logical = "master/test/one.orderedmap"
        self.write_logical(logical, b"validated")
        snapshot = self.write_snapshot([logical])

        with mock.patch.object(
            wf_publish.zipfile,
            "ZipFile",
            side_effect=RuntimeError("fixture zip failure"),
        ):
            result, stdout, _stderr = self.run_publish(
                ["--tables", logical, "--snapshot", str(snapshot)],
                profiles=[self.profile, self.profile],
            )

        self.assertNotEqual(0, result)
        self.assertNotIn("[OK]", stdout)
        self.assertEqual([], self.archives())
        leftovers = list(self.cdn.rglob("*.tmp")) if self.cdn.exists() else []
        self.assertEqual([], leftovers)

    def test_committed_archive_stat_failure_is_warning_only(self):
        logical = "master/test/one.orderedmap"
        self.write_logical(logical, b"validated")
        snapshot = self.write_snapshot([logical])
        real_stat = Path.stat

        def fail_committed_archive_stat(path, *args, **kwargs):
            candidate = Path(path)
            if candidate.suffix == ".zip" and self.cdn in candidate.parents:
                raise OSError("fixture committed archive stat failure")
            return real_stat(candidate, *args, **kwargs)

        with mock.patch.object(Path, "stat", new=fail_committed_archive_stat):
            result, stdout, stderr = self.run_publish(
                ["--tables", logical, "--snapshot", str(snapshot)],
                profiles=[self.profile, self.profile],
            )

        self.assertEqual(0, result)
        self.assertIn("[OK]", stdout)
        self.assertIn("[WARN]", stderr)
        self.assertIn("committed", stderr.lower())
        self.assertIn("stat", stderr.lower())
        self.assertEqual(1, len(self.archives()))

    def test_committed_archive_changelog_failure_is_warning_only(self):
        logical = "master/test/one.orderedmap"
        self.write_logical(logical, b"validated")
        snapshot = self.write_snapshot([logical])

        with mock.patch.object(
            wf_publish,
            "stamp_changelog",
            side_effect=OSError("fixture changelog failure"),
        ):
            result, stdout, stderr = self.run_publish(
                ["--tables", logical, "--snapshot", str(snapshot)],
                profiles=[self.profile, self.profile],
            )

        self.assertEqual(0, result)
        self.assertIn("[OK]", stdout)
        self.assertIn("[WARN]", stderr)
        self.assertIn("committed", stderr.lower())
        self.assertIn("changelog", stderr.lower())
        self.assertEqual(1, len(self.archives()))


class TestPendingCompatibility(PublisherCase):
    def test_pending_mode_still_skips_missing_entries_and_publishes_existing(self):
        logical = "master/test/pending.orderedmap"
        relative = self.write_logical(logical, b"pending-bytes")
        self.pending.write_text(
            json.dumps([relative, "ff/missing-pending-entry"]), encoding="utf-8"
        )

        result, stdout, _stderr = self.run_publish([])

        self.assertEqual(0, result)
        self.assertIn("[OK]", stdout)
        self.assertEqual(1, len(self.archives()))
        with zipfile.ZipFile(self.archives()[0]) as archive:
            self.assertEqual(
                b"pending-bytes",
                archive.read(f"production/upload/{relative}"),
            )

    def test_multi_group_rename_failure_rolls_back_already_published_archive(self):
        logical = "master/test/pending.orderedmap"
        relative = self.write_logical(logical, b"common-bytes")
        medium_relative = "12/medium-fixture"
        medium_path = self.store.parent / "medium_upload" / medium_relative
        medium_path.parent.mkdir(parents=True, exist_ok=True)
        medium_path.write_bytes(b"medium-bytes")
        self.pending.write_text(
            json.dumps([relative, f"medium:{medium_relative}"]), encoding="utf-8"
        )
        real_replace = wf_publish.os.replace
        calls = 0

        def fail_second_replace(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("fixture second rename failure")
            return real_replace(source, destination)

        with mock.patch.object(
            wf_publish.os,
            "replace",
            side_effect=fail_second_replace,
        ):
            result, stdout, _stderr = self.run_publish([])

        self.assertNotEqual(0, result)
        self.assertNotIn("[OK]", stdout)
        self.assertEqual([], self.archives())
        leftovers = list(self.cdn.rglob("*.tmp")) if self.cdn.exists() else []
        self.assertEqual([], leftovers)

    def test_backup_cleanup_failure_cannot_roll_back_committed_archives(self):
        logical = "master/test/pending.orderedmap"
        relative = self.write_logical(logical, b"new-common")
        medium_relative = "12/medium-fixture"
        medium_path = self.store.parent / "medium_upload" / medium_relative
        medium_path.parent.mkdir(parents=True, exist_ok=True)
        medium_path.write_bytes(b"new-medium")
        self.pending.write_text(
            json.dumps([relative, f"medium:{medium_relative}"]), encoding="utf-8"
        )

        archive_name = "pinball-1.4.54-1.4.55-1-modfixture.zip"
        common_final = self.cdn / "archive-common-diff" / archive_name
        medium_final = self.cdn / "archive-medium-diff" / archive_name
        for path, payload in (
            (common_final, b"old-common"),
            (medium_final, b"old-medium"),
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)

        real_unlink = Path.unlink
        cleanup_calls = 0

        def fail_second_populated_rollback(path, *args, **kwargs):
            nonlocal cleanup_calls
            candidate = Path(path)
            if (
                candidate.suffix == ".rollback"
                and candidate.exists()
                and candidate.stat().st_size > 0
            ):
                cleanup_calls += 1
                if cleanup_calls == 2:
                    raise OSError("fixture backup cleanup failure")
            return real_unlink(candidate, *args, **kwargs)

        with mock.patch.object(Path, "unlink", new=fail_second_populated_rollback):
            result, stdout, _stderr = self.run_publish([])

        self.assertEqual(0, result)
        self.assertIn("[OK]", stdout)
        with zipfile.ZipFile(common_final) as archive:
            self.assertEqual(
                b"new-common",
                archive.read(f"production/upload/{relative}"),
            )
        with zipfile.ZipFile(medium_final) as archive:
            self.assertEqual(
                b"new-medium",
                archive.read(f"production/medium_upload/{medium_relative}"),
            )


if __name__ == "__main__":
    unittest.main()
