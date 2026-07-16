# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from importlib import import_module
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_server_auth as auth


class ServerAuthTests(unittest.TestCase):
    def test_environment_token_overrides_dotenv_without_returning_other_values(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".env").write_text(
                "CN_ADMIN_TOKEN=dotenv-token\nCN_LISTEN_HOST=192.168.0.130\n",
                encoding="utf-8",
            )
            token = auth.load_admin_token(
                root,
                {"CN_ADMIN_TOKEN": "process-token", "UNRELATED_SECRET": "never-read"},
            )
            self.assertEqual("process-token", token)
            self.assertEqual(
                {"Authorization": "Bearer process-token"},
                auth.admin_bearer_headers(root, {"CN_ADMIN_TOKEN": "process-token"}),
            )

    def test_tool_specific_token_has_highest_priority(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.assertEqual(
                "tool-token",
                auth.load_admin_token(
                    root,
                    {"WF_ADMIN_TOKEN": "tool-token", "CN_ADMIN_TOKEN": "process-token"},
                ),
            )

    def test_dotenv_quotes_and_inline_comments_are_parsed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".env").write_text(
                '\ufeffCN_ADMIN_TOKEN="quoted-token" # local only\n'
                "CN_LISTEN_HOST='0.0.0.0'\n"
                "CN_LISTEN_PORT=8123\n",
                encoding="utf-8",
            )
            self.assertEqual("quoted-token", auth.load_admin_token(root, {}))
            self.assertEqual("http://127.0.0.1:8123", auth.resolve_server_url(root, {}))

    def test_explicit_server_url_wins_and_trailing_slash_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.assertEqual(
                "https://admin.example.test:8443",
                auth.resolve_server_url(
                    root,
                    {"WF_SERVER_URL": "https://admin.example.test:8443/"},
                ),
            )

    def test_missing_token_produces_no_authorization_header(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.assertIsNone(auth.load_admin_token(root, {}))
            self.assertEqual({}, auth.admin_bearer_headers(root, {}))

    def test_wf_gui_sends_bearer_to_mod_admin(self) -> None:
        # wf_gui 导入时就解析 WF 上传目录;干净检出(CI)既无模拟器路径也无
        # profiles.json,必须先把 WF_TARGET_STORE 指到一个存在的目录。
        with tempfile.TemporaryDirectory() as store_dir:
            with mock.patch.dict(os.environ, {"WF_TARGET_STORE": store_dir}):
                gui = import_module("wf_gui")
        captured = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self) -> bytes:
                return b'{"ok":true}'

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return Response()

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".env").write_text("CN_ADMIN_TOKEN=gui-token\n", encoding="utf-8")
            with (
                mock.patch.object(gui, "ROOT", root),
                mock.patch.object(gui, "SERVER_URL", "http://127.0.0.1:8001"),
                mock.patch.object(gui.urllib.request, "urlopen", side_effect=fake_urlopen),
                mock.patch.dict(gui.os.environ, {}, clear=True),
            ):
                self.assertEqual({"ok": True}, gui._server_call("/api/mod-admin/ping"))
        self.assertEqual("Bearer gui-token", captured[0][0].get_header("Authorization"))

    def test_rogue_save_sends_bearer_to_management_api(self) -> None:
        rogue = import_module("wf_rogue_save")
        captured = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self) -> bytes:
                return b'{"ok":true}'

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return Response()

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".env").write_text("CN_ADMIN_TOKEN=rogue-token\n", encoding="utf-8")
            with (
                mock.patch.object(rogue, "ROOT", str(root)),
                mock.patch.object(rogue.urllib.request, "urlopen", side_effect=fake_urlopen),
                mock.patch.dict(rogue.os.environ, {}, clear=True),
            ):
                self.assertEqual(
                    {"ok": True},
                    rogue.api_post("http://127.0.0.1:8001", "/api/server/cloneSave"),
                )
        self.assertEqual("Bearer rogue-token", captured[0][0].get_header("Authorization"))


if __name__ == "__main__":
    unittest.main()
