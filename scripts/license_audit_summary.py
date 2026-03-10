#!/usr/bin/env python3
"""
license-db.json 审计汇总工具
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


def parse_iso_datetime(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_db(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"数据库不存在: {path}")
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw) if raw.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("数据库根节点必须为 JSON 对象")
    licenses = data.get("licenses")
    if not isinstance(licenses, dict):
        raise ValueError('数据库缺少 "licenses" 对象')
    return data


def summarize(licenses: Dict[str, Any]) -> Dict[str, int]:
    total = len(licenses)
    active = 0
    revoked = 0
    expired = 0
    never_bound = 0
    full_bound = 0

    now = datetime.now(timezone.utc)
    for _, item in licenses.items():
        if not isinstance(item, dict):
            continue
        status = str(item.get("status", "active")).lower()
        if status == "active":
            active += 1
        else:
            revoked += 1

        expires_at = item.get("expiresAt")
        if isinstance(expires_at, str) and expires_at.strip():
            try:
                if now > parse_iso_datetime(expires_at):
                    expired += 1
            except ValueError:
                # 无法解析的时间按不过期统计
                pass

        devices = item.get("devices")
        bound_count = len(devices) if isinstance(devices, list) else 0
        if bound_count == 0:
            never_bound += 1

        max_devices = int(item.get("maxDevices", 1) or 1)
        if bound_count >= max_devices and max_devices > 0:
            full_bound += 1

    return {
        "total": total,
        "active": active,
        "revoked": revoked,
        "expired": expired,
        "neverBound": never_bound,
        "fullBound": full_bound,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="输出 license-db.json 的审计摘要")
    parser.add_argument(
        "--db",
        type=str,
        default="./license-db.json",
        help="license 数据库文件路径",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="美化输出 JSON",
    )
    args = parser.parse_args()

    data = load_db(Path(args.db))
    result = summarize(data["licenses"])
    if args.pretty:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
