#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
License 数据库审计摘要脚本。

示例：
  python3 scripts/license_audit_summary.py --db /opt/claw-license/license-db.json
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


def parse_iso_datetime(text: Any) -> datetime | None:
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_db(db_path: Path) -> Dict[str, Any]:
    if not db_path.exists():
        raise FileNotFoundError(f"数据库文件不存在: {db_path}")
    with db_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("数据库 JSON 顶层必须是对象")
    licenses = data.get("licenses")
    if not isinstance(licenses, dict):
        raise ValueError('数据库缺少 "licenses" 对象')
    return data


def summarize(licenses: Dict[str, Any]) -> Dict[str, int]:
    now = datetime.now(timezone.utc)
    total = len(licenses)
    active = 0
    revoked = 0
    expired = 0
    bound = 0

    for _, item in licenses.items():
        if not isinstance(item, dict):
            continue

        if item.get("status") == "active":
            active += 1
        else:
            revoked += 1

        expires_at = parse_iso_datetime(item.get("expiresAt"))
        if expires_at is not None and now > expires_at:
            expired += 1

        devices = item.get("devices")
        if isinstance(devices, list) and len(devices) > 0:
            bound += 1

    return {
        "total": total,
        "active": active,
        "revoked": revoked,
        "expired": expired,
        "bound": bound,
    }


def main() -> None:
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
        help="格式化输出 JSON",
    )
    args = parser.parse_args()

    db_path = Path(args.db).expanduser().resolve()
    data = load_db(db_path)
    result = summarize(data["licenses"])
    if args.pretty:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
