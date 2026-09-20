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
]


def export(db_path: Path, admin_source: Path | None) -> dict[str, Any]:
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
    apply_parser = sub.add_parser("apply")
    apply_parser.add_argument("--base", default="http://127.0.0.1:3000")
    args = parser.parse_args()
    if args.command == "export":
        payload = export(args.db, args.admin_source)
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
