# -*- coding: utf-8 -*-
"""Small, dependency-free OpenAI client used by the character generator.

The public helpers deliberately accept an injectable ``transport`` so all
request construction, retry, and cache behavior can be exercised offline.
Secrets are read only when a request is built and are never included in cache
keys or cache payloads.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping


DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_IMAGE_MODEL = "gpt-image-1"
DEFAULT_CHAT_MODEL = "gpt-4.1-mini"
JSON_TIMEOUT_SECONDS = 120
IMAGE_TIMEOUT_SECONDS = 300
MAX_ATTEMPTS = 4
SUPPORTED_IMAGE_SIZES = frozenset({"1024x1024", "1024x1536", "1536x1024"})
_CONFIG_PATH = Path(__file__).resolve().parent / "work" / "openai.json"

Transport = Callable[[urllib.request.Request, int], Any]


@dataclass(frozen=True)
class Settings:
    api_key: str | None
    base_url: str
    models: Mapping[str, str]


def _registry_env_value(name: str) -> str | None:
    """Read a user-level Windows environment variable without mutating it."""

    if os.name != "nt":
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _kind = winreg.QueryValueEx(key, name)
    except (FileNotFoundError, OSError):
        return None
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _read_config() -> dict[str, Any]:
    if not _CONFIG_PATH.is_file():
        return {}
    try:
        value = json.loads(_CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read OpenAI config: {_CONFIG_PATH}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"OpenAI config must contain a JSON object: {_CONFIG_PATH}")
    return value


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _load_settings() -> Settings:
    config = _read_config()
    api_key = (
        _clean_string(os.environ.get("OPENAI_API_KEY"))
        or _clean_string(_registry_env_value("OPENAI_API_KEY"))
        or _clean_string(config.get("api_key"))
    )
    base_url = (
        _clean_string(os.environ.get("OPENAI_BASE_URL"))
        or _clean_string(_registry_env_value("OPENAI_BASE_URL"))
        or _clean_string(config.get("base_url"))
        or DEFAULT_BASE_URL
    ).rstrip("/")
    raw_models = config.get("models")
    models = {
        str(key): str(value)
        for key, value in (raw_models.items() if isinstance(raw_models, dict) else [])
        if _clean_string(value)
    }
    return Settings(api_key=api_key, base_url=base_url, models=models)


def _endpoint_url(base_url: str, endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        return endpoint
    return f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"


def _canonical_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _cache_path(cache_dir: str | os.PathLike[str], cache_key: str) -> Path:
    return Path(cache_dir) / f"{cache_key}.json"


def _cached_result(path: Path) -> Any | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if isinstance(value, dict):
        for item in value.get("data", []):
            if isinstance(item, dict) and "path" in item and not Path(item["path"]).is_file():
                return None
    return value


def _write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{secrets.token_hex(4)}.tmp")
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _decode_json_result(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        return json.loads(value)
    if hasattr(value, "read"):
        return _decode_json_result(value.read())
    raise TypeError(f"Unsupported transport result: {type(value).__name__}")


def _stdlib_transport(request: urllib.request.Request, timeout: int) -> Any:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _retryable_status(exc: BaseException) -> bool:
    status = getattr(exc, "code", None)
    if status is None:
        status = getattr(exc, "status", None)
    return status == 429 or (isinstance(status, int) and 500 <= status <= 599)


def _execute(request: urllib.request.Request, timeout: int, transport: Transport | None) -> Any:
    operation = transport or _stdlib_transport
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _decode_json_result(operation(request, timeout))
        except Exception as exc:
            if not _retryable_status(exc) or attempt + 1 >= MAX_ATTEMPTS:
                raise
            time.sleep(float(2**attempt))
    raise AssertionError("retry loop exhausted")


def _authorization_key(settings: Settings, transport: Transport | None) -> str:
    if settings.api_key:
        return settings.api_key
    if transport is not None:
        # Offline transports must remain usable on machines without a key.
        return "injected-transport"
    raise RuntimeError(
        "OPENAI_API_KEY is not configured in the process, HKCU\\Environment, "
        f"or {_CONFIG_PATH}"
    )


def _json_request(
    payload: Mapping[str, Any],
    endpoint: str,
    *,
    timeout: int,
    transport: Transport | None,
) -> tuple[Any, str]:
    settings = _load_settings()
    url = _endpoint_url(settings.base_url, endpoint)
    api_key = _authorization_key(settings, transport)
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    return _execute(request, timeout, transport), url


def request_json(
    payload: Mapping[str, Any],
    endpoint: str,
    *,
    cache_dir: str | os.PathLike[str] | None = None,
    transport: Transport | None = None,
    timeout: int = JSON_TIMEOUT_SECONDS,
) -> Any:
    """POST JSON and return decoded JSON, with optional content-addressed cache."""

    if not isinstance(payload, Mapping):
        raise TypeError("payload must be a mapping")
    settings = _load_settings()
    url = _endpoint_url(settings.base_url, endpoint)
    cache_key = _canonical_hash({"kind": "json", "endpoint": url, "payload": payload})
    cache_path = _cache_path(cache_dir, cache_key) if cache_dir is not None else None
    if cache_path is not None:
        cached = _cached_result(cache_path)
        if cached is not None:
            return cached
    result, _url = _json_request(payload, endpoint, timeout=timeout, transport=transport)
    if cache_path is not None:
        _write_json_atomic(cache_path, result)
    return result


def _validate_image_options(size: str, n: int, output_format: str) -> None:
    if size not in SUPPORTED_IMAGE_SIZES:
        raise ValueError(
            f"Unsupported image size {size!r}; expected one of {sorted(SUPPORTED_IMAGE_SIZES)}"
        )
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError("n must be a positive integer")
    if output_format.lower() != "png":
        raise ValueError("Only PNG output is supported by this character-generation client")


def _image_model(settings: Settings, explicit: str | None) -> str:
    return explicit or settings.models.get("image") or DEFAULT_IMAGE_MODEL


def _image_cache_key(
    kind: str,
    endpoint_url: str,
    fields: Mapping[str, Any],
    image_paths: Iterable[Path] = (),
) -> str:
    images = [
        {
            "index": index,
            "suffix": path.suffix.lower(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for index, path in enumerate(image_paths)
    ]
    return _canonical_hash(
        {"kind": kind, "endpoint": endpoint_url, "fields": fields, "images": images}
    )


def _decode_image_response(
    response: Any,
    cache_dir: str | os.PathLike[str] | None,
    cache_key: str,
    output_format: str,
) -> Any:
    if cache_dir is None or not isinstance(response, dict):
        return response
    normalized = dict(response)
    normalized_data = []
    for index, raw_item in enumerate(response.get("data", [])):
        if not isinstance(raw_item, dict):
            normalized_data.append(raw_item)
            continue
        item = dict(raw_item)
        encoded = item.pop("b64_json", None)
        if encoded is not None:
            try:
                image_bytes = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise RuntimeError(f"Invalid base64 image at response index {index}") from exc
            output = Path(cache_dir) / f"{cache_key}_{index}.{output_format.lower()}"
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary = output.with_suffix(output.suffix + f".{secrets.token_hex(4)}.tmp")
            try:
                temporary.write_bytes(image_bytes)
                temporary.replace(output)
            finally:
                if temporary.exists():
                    temporary.unlink()
            item["path"] = str(output.resolve())
        normalized_data.append(item)
    normalized["data"] = normalized_data
    return normalized


def generate_image(
    prompt: str,
    size: str,
    n: int = 1,
    background: str = "transparent",
    output_format: str = "png",
    *,
    cache_dir: str | os.PathLike[str] | None = None,
    transport: Transport | None = None,
    model: str | None = None,
) -> Any:
    """Generate one or more images and materialize cached base64 PNG outputs."""

    _validate_image_options(size, n, output_format)
    settings = _load_settings()
    endpoint = "images/generations"
    url = _endpoint_url(settings.base_url, endpoint)
    payload = {
        "model": _image_model(settings, model),
        "prompt": prompt,
        "size": size,
        "n": n,
        "background": background,
        "output_format": output_format,
    }
    cache_key = _image_cache_key("image-generation", url, payload)
    manifest = _cache_path(cache_dir, cache_key) if cache_dir is not None else None
    if manifest is not None:
        cached = _cached_result(manifest)
        if cached is not None:
            return cached
    response, _url = _json_request(
        payload,
        endpoint,
        timeout=IMAGE_TIMEOUT_SECONDS,
        transport=transport,
    )
    result = _decode_image_response(response, cache_dir, cache_key, output_format)
    if manifest is not None:
        _write_json_atomic(manifest, result)
    return result


def _multipart_body(
    fields: Mapping[str, Any],
    image_paths: Iterable[Path],
) -> tuple[bytes, str]:
    boundary = f"wf-openai-{secrets.token_hex(16)}"
    body = bytearray()

    def add_line(value: bytes = b"") -> None:
        body.extend(value)
        body.extend(b"\r\n")

    for name, value in fields.items():
        add_line(f"--{boundary}".encode("ascii"))
        add_line(f'Content-Disposition: form-data; name="{name}"'.encode("utf-8"))
        add_line()
        add_line(str(value).encode("utf-8"))
    for path in image_paths:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        add_line(f"--{boundary}".encode("ascii"))
        add_line(
            (
                'Content-Disposition: form-data; name="image[]"; '
                f'filename="{path.name}"'
            ).encode("utf-8")
        )
        add_line(f"Content-Type: {content_type}".encode("ascii"))
        add_line()
        body.extend(path.read_bytes())
        body.extend(b"\r\n")
    add_line(f"--{boundary}--".encode("ascii"))
    return bytes(body), boundary


def edit_image(
    prompt: str,
    image_paths: Iterable[str | os.PathLike[str]],
    size: str,
    n: int = 1,
    background: str = "transparent",
    output_format: str = "png",
    *,
    cache_dir: str | os.PathLike[str] | None = None,
    transport: Transport | None = None,
    model: str | None = None,
) -> Any:
    """Generate an image edit using one or more reference images."""

    _validate_image_options(size, n, output_format)
    paths = [Path(path).resolve() for path in image_paths]
    if not paths:
        raise ValueError("image_paths must contain at least one reference image")
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Reference image not found: {missing[0]}")

    settings = _load_settings()
    endpoint = "images/edits"
    url = _endpoint_url(settings.base_url, endpoint)
    fields = {
        "model": _image_model(settings, model),
        "prompt": prompt,
        "size": size,
        "n": n,
        "background": background,
        "output_format": output_format,
    }
    cache_key = _image_cache_key("image-edit", url, fields, paths)
    manifest = _cache_path(cache_dir, cache_key) if cache_dir is not None else None
    if manifest is not None:
        cached = _cached_result(manifest)
        if cached is not None:
            return cached

    api_key = _authorization_key(settings, transport)
    body, boundary = _multipart_body(fields, paths)
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )
    response = _execute(request, IMAGE_TIMEOUT_SECONDS, transport)
    result = _decode_image_response(response, cache_dir, cache_key, output_format)
    if manifest is not None:
        _write_json_atomic(manifest, result)
    return result


def _message_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        if parts:
            return "".join(parts)
    raise RuntimeError("Chat response did not contain textual message content")


def chat_json(
    system: str,
    user: str,
    schema_hint: Any,
    *,
    cache_dir: str | os.PathLike[str] | None = None,
    transport: Transport | None = None,
    model: str | None = None,
) -> Any:
    """Request a JSON-only chat response and return the parsed message value."""

    settings = _load_settings()
    schema_text = json.dumps(schema_hint, ensure_ascii=False, sort_keys=True)
    payload = {
        "model": model or settings.models.get("chat") or DEFAULT_CHAT_MODEL,
        "messages": [
            {
                "role": "system",
                "content": f"{system}\nReturn only valid JSON matching this schema hint: {schema_text}",
            },
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
    }
    response = request_json(
        payload,
        "chat/completions",
        cache_dir=cache_dir,
        transport=transport,
        timeout=JSON_TIMEOUT_SECONDS,
    )
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("Chat response is missing choices[0].message.content") from exc
    try:
        return json.loads(_message_content_text(content))
    except json.JSONDecodeError as exc:
        raise RuntimeError("Chat response content is not valid JSON") from exc


__all__ = ["request_json", "generate_image", "edit_image", "chat_json"]
