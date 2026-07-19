# -*- coding: utf-8 -*-
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import wf_openai
except ModuleNotFoundError:
    wf_openai = None


PNG_BYTES = b"\x89PNG\r\n\x1a\nunit-test-png"
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")


class HttpStatusError(RuntimeError):
    def __init__(self, code: int) -> None:
        super().__init__(f"HTTP {code}")
        self.code = code


class OpenAIClientTests(unittest.TestCase):
    def setUp(self) -> None:
        if wf_openai is None:
            self.skipTest("wf_openai module not implemented yet")

    def test_request_json_builds_bearer_request_and_uses_default_timeout(self) -> None:
        captured = []

        def transport(request, timeout):
            captured.append((request, timeout))
            return {"ok": True}

        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "process-secret"}, clear=True):
            result = wf_openai.request_json(
                {"answer": 42},
                "responses",
                transport=transport,
            )

        self.assertEqual({"ok": True}, result)
        request, timeout = captured[0]
        self.assertEqual("https://api.openai.com/v1/responses", request.full_url)
        self.assertEqual("Bearer process-secret", request.get_header("Authorization"))
        self.assertEqual("application/json", request.get_header("Content-type"))
        self.assertEqual({"answer": 42}, json.loads(request.data.decode("utf-8")))
        self.assertEqual(120, timeout)

    def test_settings_priority_is_process_then_registry_then_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config_path = Path(td) / "openai.json"
            config_path.write_text(
                json.dumps({"api_key": "file-secret", "base_url": "https://file.test/v1"}),
                encoding="utf-8",
            )
            with (
                mock.patch.object(wf_openai, "_CONFIG_PATH", config_path),
                mock.patch.object(
                    wf_openai,
                    "_registry_env_value",
                    side_effect=lambda name: {
                        "OPENAI_API_KEY": "registry-secret",
                        "OPENAI_BASE_URL": "https://registry.test/v1",
                    }.get(name),
                ),
                mock.patch.dict(
                    os.environ,
                    {
                        "OPENAI_API_KEY": "process-secret",
                        "OPENAI_BASE_URL": "https://process.test/v1",
                    },
                    clear=True,
                ),
            ):
                settings = wf_openai._load_settings()
            self.assertEqual("process-secret", settings.api_key)
            self.assertEqual("https://process.test/v1", settings.base_url)

            with (
                mock.patch.object(wf_openai, "_CONFIG_PATH", config_path),
                mock.patch.object(
                    wf_openai,
                    "_registry_env_value",
                    side_effect=lambda name: "registry-secret" if name == "OPENAI_API_KEY" else None,
                ),
                mock.patch.dict(os.environ, {}, clear=True),
            ):
                settings = wf_openai._load_settings()
            self.assertEqual("registry-secret", settings.api_key)
            self.assertEqual("https://file.test/v1", settings.base_url)

    def test_retries_429_and_5xx_with_exponential_backoff(self) -> None:
        attempts = []

        def transport(request, timeout):
            attempts.append(request)
            if len(attempts) == 1:
                raise HttpStatusError(429)
            if len(attempts) == 2:
                raise HttpStatusError(503)
            return {"ok": True}

        with (
            mock.patch.dict(os.environ, {"OPENAI_API_KEY": "secret"}, clear=True),
            mock.patch.object(wf_openai.time, "sleep") as sleep,
        ):
            self.assertEqual(
                {"ok": True},
                wf_openai.request_json({}, "responses", transport=transport),
            )
        self.assertEqual(3, len(attempts))
        self.assertEqual([mock.call(1.0), mock.call(2.0)], sleep.call_args_list)

    def test_stops_after_four_retryable_attempts(self) -> None:
        attempts = 0

        def transport(request, timeout):
            nonlocal attempts
            attempts += 1
            raise HttpStatusError(500)

        with (
            mock.patch.dict(os.environ, {"OPENAI_API_KEY": "secret"}, clear=True),
            mock.patch.object(wf_openai.time, "sleep"),
        ):
            with self.assertRaises(HttpStatusError):
                wf_openai.request_json({}, "responses", transport=transport)
        self.assertEqual(4, attempts)

    def test_json_cache_hits_without_transport_and_never_contains_key(self) -> None:
        calls = 0

        def transport(request, timeout):
            nonlocal calls
            calls += 1
            return {"cached": True}

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "never-persist-me"}, clear=True):
                first = wf_openai.request_json(
                    {"same": "payload"}, "responses", cache_dir=td, transport=transport
                )
                second = wf_openai.request_json(
                    {"same": "payload"}, "responses", cache_dir=td, transport=transport
                )
            self.assertEqual(first, second)
            self.assertEqual(1, calls)
            cache_text = "\n".join(
                path.read_text(encoding="utf-8") for path in Path(td).glob("*.json")
            )
            self.assertNotIn("never-persist-me", cache_text)

    def test_generate_image_decodes_pngs_and_caches_paths(self) -> None:
        captured = []

        def transport(request, timeout):
            captured.append((request, timeout))
            return {"created": 1, "data": [{"b64_json": PNG_B64}, {"b64_json": PNG_B64}]}

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.dict(os.environ, {}, clear=True):
                result = wf_openai.generate_image(
                    "white wolf",
                    "1024x1536",
                    n=2,
                    cache_dir=td,
                    transport=transport,
                )
                cached = wf_openai.generate_image(
                    "white wolf",
                    "1024x1536",
                    n=2,
                    cache_dir=td,
                    transport=transport,
                )
            self.assertEqual(result, cached)
            self.assertEqual(1, len(captured))
            request, timeout = captured[0]
            payload = json.loads(request.data.decode("utf-8"))
            self.assertEqual("gpt-image-1", payload["model"])
            self.assertEqual("transparent", payload["background"])
            self.assertEqual("png", payload["output_format"])
            self.assertEqual(2, payload["n"])
            self.assertEqual(300, timeout)
            for item in result["data"]:
                output = Path(item["path"])
                self.assertTrue(output.is_file())
                self.assertEqual(PNG_BYTES, output.read_bytes())
                self.assertNotIn("b64_json", item)

    def test_edit_image_sends_all_reference_images_in_multipart(self) -> None:
        captured = []

        def transport(request, timeout):
            captured.append((request, timeout))
            return {"data": [{"b64_json": PNG_B64}, {"b64_json": PNG_B64}]}

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            refs = []
            for index in range(3):
                path = root / f"ref{index}.jpeg"
                path.write_bytes(b"jpeg" + bytes([index]))
                refs.append(path)
            cache_dir = root / "cache"
            with mock.patch.dict(os.environ, {}, clear=True):
                result = wf_openai.edit_image(
                    "redraw as 2D anime",
                    refs,
                    "1024x1536",
                    n=2,
                    background="transparent",
                    output_format="png",
                    cache_dir=cache_dir,
                    transport=transport,
                )

            request, timeout = captured[0]
            body = request.data
            self.assertEqual(3, body.count(b'name="image[]"'))
            self.assertNotIn(b'name="image";', body)
            self.assertIn(b'name="model"\r\n\r\ngpt-image-1', body)
            self.assertIn(b'name="n"\r\n\r\n2', body)
            self.assertIn(b'name="background"\r\n\r\ntransparent', body)
            self.assertTrue(request.get_header("Content-type").startswith("multipart/form-data; boundary="))
            self.assertEqual(300, timeout)
            self.assertEqual(2, len(result["data"]))

    def test_chat_json_requests_json_and_parses_message_content(self) -> None:
        captured = []

        def transport(request, timeout):
            captured.append(json.loads(request.data.decode("utf-8")))
            return {"choices": [{"message": {"content": '{"name":"Gerald"}'}}]}

        with mock.patch.dict(os.environ, {}, clear=True):
            result = wf_openai.chat_json(
                "You write character cards.",
                "Create one.",
                {"name": "string"},
                transport=transport,
            )
        self.assertEqual({"name": "Gerald"}, result)
        payload = captured[0]
        self.assertEqual({"type": "json_object"}, payload["response_format"])
        self.assertIn("schema", payload["messages"][0]["content"].lower())

    def test_image_size_is_restricted_to_supported_values(self) -> None:
        with self.assertRaises(ValueError):
            wf_openai.generate_image("x", "512x512", transport=lambda *_args: {})


class OpenAIClientPresenceTests(unittest.TestCase):
    def test_module_exists(self) -> None:
        self.assertIsNotNone(wf_openai, "wf_openai.py must be implemented")


if __name__ == "__main__":
    unittest.main(verbosity=2)
