# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import wf_voice
except ModuleNotFoundError:
    wf_voice = None


WAV_BYTES = b"RIFF\x24\x00\x00\x00WAVEfmt unit-test-wav"
VOICE_CARD = {
    "provider": "openai",
    "model": "gpt-4o-mini-tts",
    "voice": "onyx",
    "instructions": "低沉温厚、骑士的沉稳、轻微沙哑",
    "source_license": "AI original voice using an OpenAI built-in voice",
}


class HttpStatusError(RuntimeError):
    def __init__(self, code: int) -> None:
        super().__init__(f"HTTP {code}")
        self.code = code


class VoiceTests(unittest.TestCase):
    def setUp(self) -> None:
        if wf_voice is None:
            self.skipTest("wf_voice module not implemented yet")

    def test_openai_synth_builds_wav_request_without_persisting_key(self) -> None:
        captured = []

        def transport(request, timeout):
            captured.append((request, timeout))
            return WAV_BYTES

        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "voice-secret"}, clear=True):
            result = wf_voice.synth("我が剣に誓おう。", "ja", VOICE_CARD, transport=transport)

        self.assertEqual(WAV_BYTES, result)
        request, timeout = captured[0]
        self.assertEqual("https://api.openai.com/v1/audio/speech", request.full_url)
        self.assertEqual("Bearer voice-secret", request.get_header("Authorization"))
        self.assertEqual("application/json", request.get_header("Content-type"))
        self.assertEqual(120, timeout)
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual("gpt-4o-mini-tts", payload["model"])
        self.assertEqual("onyx", payload["voice"])
        self.assertEqual("我が剣に誓おう。", payload["input"])
        self.assertEqual(VOICE_CARD["instructions"], payload["instructions"])
        self.assertEqual("wav", payload["response_format"])
        self.assertNotIn("voice-secret", json.dumps(payload, ensure_ascii=False))

    def test_key_priority_is_process_then_hkcu_environment(self) -> None:
        with (
            mock.patch.dict(os.environ, {"OPENAI_API_KEY": "process-secret"}, clear=True),
            mock.patch.object(wf_voice, "_registry_env_value", return_value="registry-secret"),
        ):
            self.assertEqual("process-secret", wf_voice.load_api_key())

        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(wf_voice, "_registry_env_value", return_value="registry-secret"),
        ):
            self.assertEqual("registry-secret", wf_voice.load_api_key())

    def test_openai_synth_retries_three_times_and_redacts_failure(self) -> None:
        calls = 0

        def transport(_request, _timeout):
            nonlocal calls
            calls += 1
            raise HttpStatusError(503)

        with (
            mock.patch.dict(os.environ, {"OPENAI_API_KEY": "never-show-this"}, clear=True),
            mock.patch.object(wf_voice.time, "sleep") as sleep,
        ):
            with self.assertRaises(wf_voice.VoiceSynthesisError) as raised:
                wf_voice.synth("忠義を示せ。", "ja", VOICE_CARD, transport=transport)

        self.assertEqual(3, calls)
        self.assertEqual([mock.call(1.0), mock.call(2.0)], sleep.call_args_list)
        self.assertNotIn("never-show-this", str(raised.exception))

    def test_openai_synth_rejects_unlicensed_voice_card(self) -> None:
        card = dict(VOICE_CARD)
        card.pop("source_license")
        with self.assertRaisesRegex(ValueError, "source_license"):
            wf_voice.synth("test", "ja", card, transport=lambda *_args: WAV_BYTES)

    def test_local_http_provider_is_an_explicit_future_interface(self) -> None:
        card = {
            "provider": "local_http",
            "source_license": "user-owned reference recording",
        }
        with self.assertRaises(NotImplementedError):
            wf_voice.synth("test", "ja", card, transport=lambda *_args: WAV_BYTES)

    def test_find_ffmpeg_prefers_environment_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            expected = Path(td) / "ffmpeg.exe"
            expected.write_bytes(b"")
            with (
                mock.patch.dict(os.environ, {"WF_FFMPEG": str(expected)}, clear=True),
                mock.patch.object(wf_voice.shutil, "which", return_value="C:/other/ffmpeg.exe"),
            ):
                self.assertEqual(expected.resolve(), wf_voice.find_ffmpeg())

    def test_transcode_uses_strict_cbr_flags_and_atomic_output(self) -> None:
        captured = []

        def runner(command, **kwargs):
            captured.append((command, kwargs))
            Path(command[-1]).write_bytes(b"encoded-mp3")
            return subprocess.CompletedProcess(command, 0, "", "")

        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "battle" / "skill_0.mp3"
            result = wf_voice.transcode_wav_to_mp3(
                WAV_BYTES,
                output,
                ffmpeg=Path("C:/tools/ffmpeg.exe"),
                runner=runner,
            )
            self.assertEqual(output, result)
            self.assertEqual(b"encoded-mp3", output.read_bytes())

        command, kwargs = captured[0]
        self.assertIn("-ar", command)
        self.assertEqual("44100", command[command.index("-ar") + 1])
        self.assertEqual("1", command[command.index("-ac") + 1])
        self.assertEqual("96k", command[command.index("-b:a") + 1])
        self.assertEqual("0", command[command.index("-write_xing") + 1])
        self.assertTrue(kwargs["check"])


class VoiceModulePresenceTests(unittest.TestCase):
    def test_module_exists(self) -> None:
        self.assertIsNotNone(wf_voice, "wf_voice.py must be implemented")


if __name__ == "__main__":
    unittest.main(verbosity=2)
