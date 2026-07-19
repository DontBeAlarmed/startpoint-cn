#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Voice-provider boundary and strict WAV -> CBR MP3 compilation helpers.

The public provider interface is ``synth(text, lang, voice_card) -> wav bytes``.
Only the OpenAI provider is active for the current character-generation unit;
``local_http`` remains an explicit extension point for a future GPT-SoVITS
adapter. API keys are read from the process environment or HKCU\\Environment and
are never persisted or included in exception text.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Mapping


DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini-tts"
DEFAULT_TIMEOUT = 120
DEFAULT_ATTEMPTS = 3

Transport = Callable[[urllib.request.Request, int], bytes]


class VoiceSynthesisError(RuntimeError):
    """A sanitized provider failure safe to show in logs and status files."""


class VoiceEncodingError(RuntimeError):
    """ffmpeg did not produce the requested strict CBR artifact."""


def _registry_env_value(name: str) -> str | None:
    """Read one user environment value from HKCU without mutating the registry."""
    if os.name != "nt":
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _kind = winreg.QueryValueEx(key, name)
    except (FileNotFoundError, OSError):
        return None
    value = str(value).strip()
    return value or None


def load_api_key() -> str:
    """Return OPENAI_API_KEY using process > HKCU\\Environment precedence."""
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        api_key = (_registry_env_value("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise VoiceSynthesisError(
            "OPENAI_API_KEY is missing (checked process environment and HKCU\\Environment)"
        )
    return api_key


def _base_url() -> str:
    value = os.environ.get("OPENAI_BASE_URL") or _registry_env_value("OPENAI_BASE_URL")
    return (value or DEFAULT_BASE_URL).rstrip("/")


def _default_transport(request: urllib.request.Request, timeout: int) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _is_retryable(error: BaseException) -> bool:
    code = getattr(error, "code", None)
    if isinstance(code, int):
        return code == 429 or 500 <= code <= 599
    return isinstance(error, (TimeoutError, OSError, urllib.error.URLError, VoiceSynthesisError))


def _is_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def _openai_synth(
    text: str,
    lang: str,
    voice_card: Mapping[str, object],
    *,
    transport: Transport | None,
    timeout: int,
    attempts: int,
) -> bytes:
    del lang  # Language is expressed by the input text; the speech endpoint has no lang field.
    api_key = load_api_key()
    payload = {
        "model": str(voice_card.get("model") or DEFAULT_MODEL),
        "voice": str(voice_card.get("voice") or "onyx"),
        "input": text,
        "instructions": str(voice_card.get("instructions") or ""),
        "response_format": "wav",
    }
    request = urllib.request.Request(
        f"{_base_url()}/audio/speech",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "audio/wav, application/octet-stream",
        },
        method="POST",
    )
    send = transport or _default_transport
    attempts = max(1, int(attempts))
    last_error: BaseException | None = None
    for attempt in range(attempts):
        try:
            wav = send(request, timeout)
            if not isinstance(wav, bytes) or not _is_wav(wav):
                raise VoiceSynthesisError("OpenAI TTS returned a non-WAV payload")
            return wav
        except BaseException as error:
            last_error = error
            if attempt + 1 >= attempts or not _is_retryable(error):
                break
            time.sleep(float(2**attempt))
    error_name = type(last_error).__name__ if last_error is not None else "unknown"
    raise VoiceSynthesisError(
        f"OpenAI TTS failed after {attempts} attempt(s): {error_name}"
    ) from None


def synth(
    text: str,
    lang: str,
    voice_card: Mapping[str, object],
    *,
    transport: Transport | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    attempts: int = DEFAULT_ATTEMPTS,
) -> bytes:
    """Synthesize text using the selected provider and return standard WAV bytes."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text must be a non-empty string")
    if not isinstance(lang, str) or not lang.strip():
        raise ValueError("lang must be a non-empty string")
    if not str(voice_card.get("source_license") or "").strip():
        raise ValueError("voice_card.source_license is required")
    provider = str(voice_card.get("provider") or "openai").strip().lower()
    if provider == "openai":
        return _openai_synth(
            text.strip(),
            lang.strip(),
            voice_card,
            transport=transport,
            timeout=timeout,
            attempts=attempts,
        )
    if provider == "local_http":
        raise NotImplementedError("local_http voice provider interface is reserved for GPT-SoVITS")
    raise ValueError(f"unsupported voice provider: {provider}")


def find_ffmpeg() -> Path | None:
    """Resolve ffmpeg using WF_FFMPEG > PATH > D:\\WF\\voice-tools."""
    configured = (os.environ.get("WF_FFMPEG") or "").strip().strip('"')
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return candidate.resolve()
    on_path = shutil.which("ffmpeg")
    if on_path:
        return Path(on_path).resolve()
    fallback = Path(r"D:\WF\voice-tools")
    if fallback.is_dir():
        matches = sorted(fallback.rglob("ffmpeg.exe"))
        if matches:
            return matches[0].resolve()
    return None


def transcode_wav_to_mp3(
    wav: bytes,
    output_path: str | os.PathLike[str],
    *,
    ffmpeg: str | os.PathLike[str] | None = None,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> Path:
    """Compile WAV to 44.1 kHz mono 96 kbps CBR MP3 and replace atomically."""
    if not _is_wav(wav):
        raise ValueError("input is not a WAV payload")
    executable = Path(ffmpeg) if ffmpeg is not None else find_ffmpeg()
    if executable is None:
        raise VoiceEncodingError(
            "ffmpeg not found (checked WF_FFMPEG, PATH, and D:\\WF\\voice-tools)"
        )
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    wav_handle = tempfile.NamedTemporaryFile(
        prefix="wf-voice-", suffix=".wav", dir=output.parent, delete=False
    )
    mp3_handle = tempfile.NamedTemporaryFile(
        prefix="wf-voice-", suffix=".mp3", dir=output.parent, delete=False
    )
    wav_temp = Path(wav_handle.name)
    mp3_temp = Path(mp3_handle.name)
    try:
        wav_handle.write(wav)
        wav_handle.close()
        mp3_handle.close()
        command = [
            str(executable),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav_temp),
            "-vn",
            "-c:a",
            "libmp3lame",
            "-ar",
            "44100",
            "-ac",
            "1",
            "-b:a",
            "96k",
            "-minrate",
            "96k",
            "-maxrate",
            "96k",
            "-bufsize",
            "96k",
            "-write_xing",
            "0",
            str(mp3_temp),
        ]
        try:
            runner(command, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or error.stdout or "ffmpeg failed").strip()
            raise VoiceEncodingError(detail[-500:]) from None
        if not mp3_temp.is_file() or mp3_temp.stat().st_size == 0:
            raise VoiceEncodingError("ffmpeg completed without producing MP3 bytes")
        os.replace(mp3_temp, output)
        return output
    finally:
        wav_handle.close()
        mp3_handle.close()
        wav_temp.unlink(missing_ok=True)
        mp3_temp.unlink(missing_ok=True)
