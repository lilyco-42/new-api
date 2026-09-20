#!/usr/bin/env python3
"""Safely export selected cc-switch providers and idempotently import them into new-api.

The exporter is intentionally conservative: it only selects explicitly named,
OpenAI-compatible providers and emits an audit fingerprint instead of logging
secret values. The apply mode reads an envelope from stdin so keys and the admin
password never appear in the process arguments or repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable


def walk(value: Any, path: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            yield from walk(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, f"{path}[{index}]")
    else:
        yield path, value


def is_secret_path(path: str) -> bool:
    normalized = path.lower()
    return normalized.endswith(("apikey", "api_key", "auth_token", "token")) or \
        normalized.endswith("openai_api_key")


def looks_like_secret(value: Any) -> bool:
    return isinstance(value, str) and 20 <= len(value) <= 512 and \
        not value.startswith(("env.", "http://", "https://", "file://")) and \
        not any(ch.isspace() for ch in value)


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def read_password(source: Path) -> str:
    text = source.read_text(encoding="utf-8")
    match = re.search(r'^ADM_PASS\s*=\s*["\']([^"\']+)["\']', text, re.MULTILINE)
    if not match:
        raise RuntimeError(f"admin password constant not found in {source}")
    return match.group(1)


TARGETS = [
    # Imported channels start disabled. Enable only after a live, low-cost
    # health check confirms that the upstream key is still valid and permitted.
    {
        "provider_name": "DeepSeek",
        "app_type": "codex",
        "secret_path": "auth.OPENAI_API_KEY",
        "name": "cc-switch · DeepSeek Codex",
        "type": 43,
        "base_url": "https://api.deepseek.com/v1",
        "models": "deepseek-v4-flash,deepseek-v4-pro",
        "status": 2,
    },
    {
        "provider_name": "DeepSeek",
        "app_type": "claude",
        "secret_path": "env.ANTHROPIC_AUTH_TOKEN",
        "name": "cc-switch · DeepSeek Anthropic",
        "type": 14,
        "base_url": "https://api.deepseek.com/anthropic",
        "models": "deepseek-v4-flash,deepseek-v4-pro",
        "status": 2,
    },
    {
        "provider_name": "https://chat.b.ai/key",
        "app_type": "codex",
        "secret_path": "auth.OPENAI_API_KEY",
        "name": "cc-switch · b.ai",
        "type": 1,
        "base_url": "https://api.b.ai",
        "models": "deepseek-v4-flash,deepseek-v4-pro",
        "status": 2,
    },
    {
        "provider_name": "SenseNova",
        "app_type": "opencode",
        "secret_path": "options.apiKey",
        "name": "cc-switch · SenseNova",
        "type": 1,
        "base_url": "https://token.sensenova.cn/v1",
        "models": "*",
        "status": 2,
    },
    {
        "provider_name": "Command code",
        "app_type": "claude",
        "secret_path": "env.ANTHROPIC_AUTH_TOKEN",
        "name": "cc-switch · Command Code",
        "type": 1,
        "base_url": "https://api.commandcode.ai/provider/v1",
        "models": "*",
        "status": 2,
    },
]


OFFICIAL_OR_LOCAL_MARKERS = (
    "official",
    "newapi",
    "new api",
    "claude desktop",
    "openai official",
    "google official",
)


def normalize_upstream_url(value: str) -> str:
    """Normalize a cc-switch endpoint to the channel base URL.

    cc-switch stores both OpenAI-compatible URLs ending in
    ``/chat/completions`` and Anthropic URLs ending in ``/messages``.  New API
    appends the endpoint itself, so retaining those suffixes would produce a
    double path and a misleading health check.
    """

    url = value.strip().rstrip("/")
    for suffix in ("/chat/completions", "/messages"):
        if url.lower().endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
    return url


def extract_urls(obj: Any) -> list[str]:
    urls: list[str] = []
    for path, value in walk(obj):
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            if any(marker in path.lower() for marker in ("base_url", "baseurl", "endpoint", "url")):
                urls.append(normalize_upstream_url(value))
        # Codex providers store TOML as one string in ``config``.
        if isinstance(value, str) and path.lower().endswith("config"):
            urls.extend(
                normalize_upstream_url(match)
                for match in re.findall(r"base_url\s*=\s*[\"'](https?://[^\"']+)", value)
            )
    return list(dict.fromkeys(url for url in urls if url))


def extract_models(obj: Any) -> list[str]:
    candidates: list[str] = []
    model_key = re.compile(
        r"(?:^|_)(?:model|model_name|default_.*_model|subagent_model)$", re.IGNORECASE
    )
    for path, value in walk(obj):
        if not isinstance(value, str) or not value or len(value) > 160:
            continue
        leaf = path.rsplit(".", 1)[-1]
        if model_key.search(leaf) or leaf.lower() == "model":
            if not value.startswith(("http://", "https://", "env.", "file://")):
                candidates.append(value)
    result: list[str] = []
    for value in candidates:
        # Claude Code presets append a context-window marker that is not part
        # of the upstream model id.
        value = re.sub(r"\[[^\]]+\]$", "", value).strip()
        if value and value not in result and value not in {"custom", "default"}:
            result.append(value)
    return result[:32]


def is_openai_compatible(base_url: str, app_type: str) -> bool:
    lowered = base_url.lower()
    if app_type == "gemini":
        return False
    return any(
        marker in lowered
        for marker in (
            "/v1",
            "/compatible",
            "api.b.ai",
            "commandcode.ai",
            "integrate.api.nvidia.com",
            "sensenova.cn",
            "cloudstudio.club",
        )
    )


def canonical_provider_name(name: str) -> str:
    # cc-switch creates copies when a preset is duplicated.  Treat those as
    # one source while retaining the first source's key and model catalog.
    return re.sub(r"(?:\s+copy)+$", "", name.strip(), flags=re.IGNORECASE)


def discover_third_party(rows: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    """Discover configured third-party keys without exposing their values.

    Discovery is deliberately conservative about activation: all discovered
    channels start disabled (status=2).  The operator can then run a cheap
    metadata health check and enable only keys that are valid and intended for
    service use.
    """

    discovered: dict[tuple[str, str, int, str], dict[str, Any]] = {}
    # These channels were provisioned by the initial server bootstrap rather
    # than by the cc-switch migration table.  Keep discovery idempotent with
    # those names too.
    known_names = {str(target["name"]) for target in TARGETS} | {"NVIDIA Direct"}
    for app_type, raw_name, raw_settings in rows:
        name = canonical_provider_name(str(raw_name))
        lowered_name = name.lower()
        if any(marker in lowered_name for marker in OFFICIAL_OR_LOCAL_MARKERS):
            continue
        try:
            settings = json.loads(raw_settings)
        except (TypeError, json.JSONDecodeError):
            continue
        values = dict(walk(settings))
        secret_values: list[tuple[str, str]] = []
        for path, value in values.items():
            if not isinstance(value, str) or not looks_like_secret(value):
                continue
            path_lower = path.lower()
            if path_lower.endswith(("auth.anthropic_auth_token", "env.anthropic_auth_token")):
                secret_values.append((path, value))
            elif path_lower.endswith("auth.openai_api_key"):
                secret_values.append((path, value))
            elif path_lower.endswith(("options.apikey", "apikey")):
                secret_values.append((path, value))
            elif path_lower.endswith("env.gemini_api_key"):
                secret_values.append((path, value))
        if not secret_values:
            continue
        urls = extract_urls(settings)
        if not urls:
            continue
        base_url = urls[0]
        secret_path, secret = secret_values[0]
        if base_url.startswith(("http://lain42.top", "https://lain42.top", "http://127.0.0.1", "http://localhost")):
            continue
        if app_type == "gemini":
            channel_type = 24
        elif app_type == "codex" and "api.deepseek.com" in base_url.lower():
            channel_type = 43
        elif is_openai_compatible(base_url, str(app_type)):
            channel_type = 1
        else:
            channel_type = 14 if app_type == "claude" else 1
        # Keep the established names stable so a second discovery pass is
        # idempotent with the explicit migration table above.
        lower = lowered_name.replace("/", "")
        if "deepseek" in lower and "api.b.ai" in base_url.lower():
            channel_name = "cc-switch · b.ai"
        elif "deepseek" in lower and channel_type == 43:
            channel_name = "cc-switch · DeepSeek Codex"
        elif "deepseek" in lower and channel_type == 14:
            channel_name = "cc-switch · DeepSeek Anthropic"
        elif "b.ai" in lower or "bai" in lower:
            channel_name = "cc-switch · b.ai"
        elif "sensenova" in lower:
            channel_name = "cc-switch · SenseNova"
        elif "command code" in lower or "commandcode" in lower:
            channel_name = "cc-switch · Command Code"
        elif "cmdc" in lower:
            channel_name = "cc-switch · Command Code"
        elif "nvidia" in lower:
            channel_name = "NVIDIA Direct"
        else:
            suffix = {"claude": "Anthropic", "codex": "Codex"}.get(str(app_type), str(app_type))
            channel_name = f"cc-switch · {name} · {suffix}"
        if channel_name in known_names:
            # The explicit migration table has the authoritative models and
            # URL for these sources; do not create a duplicate on discovery.
            continue
        models = extract_models(settings)
        key = (fingerprint(secret), base_url, channel_type, channel_name)
        current = discovered.get(key)
        if current:
            merged = [*current["models"].split(","), *models]
            current["models"] = ",".join(dict.fromkeys(item for item in merged if item)) or "*"
            continue
        discovered[key] = {
            "name": channel_name,
            "type": channel_type,
            "base_url": base_url,
            "models": ",".join(models) or "*",
            "status": 2,
            "key": secret,
            "source": f"{app_type}:{name}:{secret_path}",
            "fingerprint": fingerprint(secret),
        }
    return list(discovered.values())


def export(
    db_path: Path,
    admin_source: Path | None,
    include_all_third_party: bool = False,
) -> dict[str, Any]:
    conn = sqlite3.connect(str(db_path))
    rows = conn.execute(
        "select app_type,name,settings_config from providers"
    ).fetchall()
    providers: list[dict[str, Any]] = []
    for target in TARGETS:
        matches = [
            row for row in rows
            if row[0] == target["app_type"] and row[1] == target["provider_name"]
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"expected one cc-switch provider {target['provider_name']!r}, got {len(matches)}"
            )
        _, _, raw = matches[0]
        obj = json.loads(raw)
        values = dict(walk(obj))
        value = values.get(target["secret_path"])
        if not looks_like_secret(value):
            raise RuntimeError(
                f"provider {target['provider_name']!r} has no usable secret at {target['secret_path']}"
            )
        entry = {k: v for k, v in target.items() if k not in {"provider_name", "app_type", "secret_path"}}
        entry["key"] = value
        entry["source"] = target["provider_name"]
        entry["fingerprint"] = fingerprint(value)
        providers.append(entry)
    if include_all_third_party:
        explicit_keys = {(provider["name"], provider["base_url"]) for provider in providers}
        for provider in discover_third_party(rows):
            if (provider["name"], provider["base_url"]) not in explicit_keys:
                providers.append(provider)

    envelope: dict[str, Any] = {
        "providers": providers,
        "generated_at": int(time.time()),
    }
    if admin_source:
        envelope["admin_username"] = "admin"
        envelope["admin_password"] = read_password(admin_source)
    return envelope


def api(base: str, method: str, path: str, data: Any = None, token: str | None = None) -> tuple[int, dict[str, Any]]:
    body = json.dumps(data).encode() if data is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(base.rstrip("/") + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            payload = {"message": raw[:200]}
        return exc.code, payload


def apply(base: str, envelope: dict[str, Any]) -> int:
    token = envelope.get("admin_token")
    if not token and envelope.get("use_server_admin_token"):
        token = subprocess.check_output(
            ["docker", "exec", "postgres", "psql", "-U", "root", "-d", "new-api", "-Atc",
             "select access_token from users where id=1"],
            text=True,
        ).strip()
    if not token:
        status, login = api(base, "POST", "/api/user/login", {
            "username": envelope["admin_username"],
            "password": envelope["admin_password"],
        })
        if not login.get("success"):
            print(f"login failed (http {status})")
            return 2
        token = login.get("data", {}).get("access_token") or login.get("data", {}).get("key")
    if not token:
        print("no admin access token available")
        return 2

    status, listing = api(base, "GET", "/api/channel/?p=1&page_size=200", token=token)
    page = listing.get("data")
    if isinstance(page, dict):
        existing = page.get("items") or page.get("data") or []
    elif isinstance(page, list):
        existing = page
    else:
        existing = []
    existing_keys = {(item.get("name"), item.get("base_url")) for item in existing}
    failures = 0
    for provider in envelope.get("providers", []):
        key = (provider["name"], provider["base_url"])
        if key in existing_keys:
            print(f"skip {provider['name']} fp={provider['fingerprint']} (already exists)")
            continue
        payload = {
            "mode": "single",
            "channel": {
                "name": provider["name"],
                "type": provider["type"],
                "key": provider["key"],
                "base_url": provider["base_url"],
                "models": provider["models"],
                "group": "default",
                "status": provider["status"],
                "weight": 1,
                "priority": 10,
                "auto_ban": 1,
                "remark": "Imported from local cc-switch; key stays server-side",
            },
        }
        status, response = api(base, "POST", "/api/channel/", payload, token=token)
        if not response.get("success"):
            print(f"failed {provider['name']} fp={provider['fingerprint']} (http {status})")
            failures += 1
            continue
        print(f"imported {provider['name']} fp={provider['fingerprint']}")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    export_parser = sub.add_parser("export")
    export_parser.add_argument("--db", type=Path, required=True)
    export_parser.add_argument("--admin-source", type=Path)
    export_parser.add_argument("--use-server-admin-token", action="store_true")
    export_parser.add_argument(
        "--all-third-party",
        action="store_true",
        help="also discover non-official configured providers; imported disabled",
    )
    apply_parser = sub.add_parser("apply")
    apply_parser.add_argument("--base", default="http://127.0.0.1:3000")
    args = parser.parse_args()
    if args.command == "export":
        payload = export(args.db, args.admin_source, args.all_third_party)
        if args.use_server_admin_token:
            payload["use_server_admin_token"] = True
            payload.pop("admin_username", None)
            payload.pop("admin_password", None)
        json.dump(payload, sys.stdout, ensure_ascii=False)
        return 0
    envelope = json.load(sys.stdin)
    return apply(args.base, envelope)


if __name__ == "__main__":
    raise SystemExit(main())
