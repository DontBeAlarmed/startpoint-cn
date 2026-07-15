# -*- coding: utf-8 -*-
from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path


def _strip_inline_comment(raw: str) -> str:
    quote: str | None = None
    escaped = False
    for index, character in enumerate(raw):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if quote:
            if character == quote:
                quote = None
            continue
        if character in {"'", '"'}:
            quote = character
            continue
        if character == "#" and (index == 0 or raw[index - 1].isspace()):
            return raw[:index].rstrip()
    return raw.strip()


def _dotenv_values(repo_root: Path) -> dict[str, str]:
    path = Path(repo_root).resolve() / ".env"
    if not path.is_file():
        return {}
    result: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError):
        return {}
    for original in lines:
        line = original.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not key or not (key[0].isalpha() or key[0] == "_"):
            continue
        if not all(character.isalnum() or character == "_" for character in key):
            continue
        value = _strip_inline_comment(raw_value.strip())
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        result[key] = value
    return result


def _environment(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def load_admin_token(
    repo_root: Path,
    env: Mapping[str, str] | None = None,
) -> str | None:
    process_env = _environment(env)
    values = _dotenv_values(repo_root)
    for candidate in (
        process_env.get("WF_ADMIN_TOKEN"),
        process_env.get("CN_ADMIN_TOKEN"),
        values.get("WF_ADMIN_TOKEN"),
        values.get("CN_ADMIN_TOKEN"),
    ):
        if candidate:
            return str(candidate)
    return None


def admin_bearer_headers(
    repo_root: Path,
    env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    token = load_admin_token(repo_root, env)
    return {"Authorization": f"Bearer {token}"} if token else {}


def resolve_server_url(
    repo_root: Path,
    env: Mapping[str, str] | None = None,
) -> str:
    process_env = _environment(env)
    explicit = process_env.get("WF_SERVER_URL")
    if explicit:
        return str(explicit).rstrip("/")

    values = _dotenv_values(repo_root)
    host = str(process_env.get("CN_LISTEN_HOST") or values.get("CN_LISTEN_HOST") or "127.0.0.1")
    port = str(process_env.get("CN_LISTEN_PORT") or values.get("CN_LISTEN_PORT") or "8001")
    if host in {"", "0.0.0.0", "::"}:
        host = "127.0.0.1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}"
