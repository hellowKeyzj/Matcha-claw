#!/usr/bin/env python3
"""
MatchaClaw 授权服务工具

能力：
1. 生成授权码（gen）
2. 导入授权码到数据库（import）
3. 导出授权码（export）
4. 清理授权设备绑定（unbind）
5. 启动本地授权 HTTP 服务（serve）

数据库结构（JSON）：
{
  "licenses": {
    "MATCHACLAW-AAAA-BBBB-CCCC-DDDD": {
      "id": "lic_000001",
      "status": "active",
      "plan": "pro",
      "expiresAt": "2027-12-31T23:59:59Z",
      "maxDevices": 2,
      "devices": [
        {
          "installId": "device-a",
          "deviceId": "device-a",
          "hardwareId": "hash",
          "boundAt": "...",
          "lastSeenAt": "..."
        }
      ],
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
}
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LICENSE_PREFIX = "MATCHACLAW"
LICENSE_PATTERN = re.compile(r"^MATCHACLAW-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$")
CHECKSUM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CHECKSUM_CONTEXT = "matchaclaw-license-v1"
DEFAULT_DB = "./license-db.json"
DEFAULT_REFRESH_AFTER_SEC = 7 * 24 * 3600
DEFAULT_OFFLINE_GRACE_HOURS = 72


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso_datetime(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def normalize_license_key(raw_key: str) -> str:
    return raw_key.strip().upper()


def validate_license_key_format(key: str) -> bool:
    return bool(LICENSE_PATTERN.fullmatch(key))


def compute_checksum_segment(payload: str) -> str:
    digest = hashlib.sha256(f"{CHECKSUM_CONTEXT}:{payload}".encode("utf-8")).digest()
    return "".join(CHECKSUM_ALPHABET[digest[i] % len(CHECKSUM_ALPHABET)] for i in range(4))


def validate_license_key_checksum(key: str) -> bool:
    if not validate_license_key_format(key):
        return False
    segments = key.split("-")
    payload = f"{segments[1]}-{segments[2]}-{segments[3]}"
    expected = compute_checksum_segment(payload)
    return expected == segments[4]


def random_seed(length: int = 12) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(alphabet) for _ in range(length))


def build_license_key_from_seed(seed: str) -> str:
    compact = re.sub(r"[^A-Z0-9]", "", seed.upper())
    if len(compact) != 12:
        raise ValueError("seed 必须可归一化为 12 位字母数字")
    payload = f"{compact[:4]}-{compact[4:8]}-{compact[8:12]}"
    checksum = compute_checksum_segment(payload)
    return f"{LICENSE_PREFIX}-{payload}-{checksum}"


def ensure_db_shape(data: Dict[str, Any]) -> Dict[str, Any]:
    licenses = data.get("licenses")
    if not isinstance(licenses, dict):
        data["licenses"] = {}
    return data


def load_db(db_path: Path) -> Dict[str, Any]:
    if not db_path.exists():
        db_path.parent.mkdir(parents=True, exist_ok=True)
        initial = {"licenses": {}}
        save_db(db_path, initial)
        return initial
    raw = db_path.read_text(encoding="utf-8")
    parsed = json.loads(raw) if raw.strip() else {"licenses": {}}
    if not isinstance(parsed, dict):
        raise ValueError("授权数据库格式错误，根节点必须为对象")
    return ensure_db_shape(parsed)


def save_db(db_path: Path, data: Dict[str, Any]) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = db_path.with_suffix(db_path.suffix + ".tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(db_path)


def next_license_id(existing_licenses: Dict[str, Any]) -> str:
    max_num = 0
    for item in existing_licenses.values():
        if not isinstance(item, dict):
            continue
        raw_id = str(item.get("id", ""))
        matched = re.match(r"^lic_(\d+)$", raw_id)
        if matched:
            max_num = max(max_num, int(matched.group(1)))
    return f"lic_{max_num + 1:06d}"


def parse_keys_from_file(path: Path) -> List[str]:
    content = path.read_text(encoding="utf-8")
    keys: List[str] = []
    for line in content.splitlines():
        candidate = normalize_license_key(line)
        if validate_license_key_format(candidate):
            keys.append(candidate)
    return keys


def ensure_positive_int(name: str, value: int) -> None:
    if value <= 0:
        raise ValueError(f"{name} 必须大于 0")


def add_or_update_license(
    db: Dict[str, Any],
    key: str,
    *,
    plan: str,
    status: str,
    max_devices: int,
    expires_at: Optional[str],
    overwrite: bool,
    license_id: Optional[str] = None,
) -> Tuple[str, bool]:
    ensure_positive_int("max_devices", max_devices)
    licenses = db["licenses"]
    existing = licenses.get(key)
    now = now_iso()

    if existing is not None and not overwrite:
        return str(existing.get("id", "")), False

    resolved_id = (
        license_id
        or (str(existing.get("id")) if isinstance(existing, dict) and existing.get("id") else "")
        or next_license_id(licenses)
    )
    record = {
        "id": resolved_id,
        "status": status,
        "plan": plan,
        "expiresAt": expires_at,
        "maxDevices": max_devices,
        "devices": (existing.get("devices") if isinstance(existing, dict) else []) or [],
        "createdAt": (existing.get("createdAt") if isinstance(existing, dict) else now),
        "updatedAt": now,
    }
    licenses[key] = record
    return resolved_id, True


def command_gen(args: argparse.Namespace) -> int:
    keys: List[str] = []
    if args.seed:
        keys.append(build_license_key_from_seed(args.seed))
    else:
        ensure_positive_int("count", args.count)
        for _ in range(args.count):
            keys.append(build_license_key_from_seed(random_seed(12)))

    if not args.out:
        for key in keys:
            print(key)
        return 0

    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if args.format == "csv":
        with output_path.open("w", encoding="utf-8", newline="") as fp:
            writer = csv.writer(fp)
            writer.writerow(["licenseKey"])
            for key in keys:
                writer.writerow([key])
    else:
        output_path.write_text("\n".join(keys) + "\n", encoding="utf-8")
    print(f"已生成 {len(keys)} 个授权码 -> {output_path}")
    return 0


def command_import(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    source_path = Path(args.file)
    db = load_db(db_path)

    keys = parse_keys_from_file(source_path)
    if not keys:
        raise ValueError("未从输入文件解析到任何合法授权码")

    created = 0
    skipped = 0
    for key in keys:
        if args.strict_checksum and not validate_license_key_checksum(key):
            skipped += 1
            continue
        _, changed = add_or_update_license(
            db,
            key,
            plan=args.plan,
            status=args.status,
            max_devices=args.max_devices,
            expires_at=args.expires_at,
            overwrite=args.overwrite,
        )
        if changed:
            created += 1
        else:
            skipped += 1

    save_db(db_path, db)
    print(f"导入完成: 写入={created}, 跳过={skipped}, 数据库={db_path}")
    return 0


def command_export(args: argparse.Namespace) -> int:
    db = load_db(Path(args.db))
    licenses = db.get("licenses", {})
    keys = sorted(list(licenses.keys()))
    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if args.format == "json":
        payload = {"licenses": {k: licenses[k] for k in keys}}
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    elif args.format == "csv":
        with output_path.open("w", encoding="utf-8", newline="") as fp:
            writer = csv.writer(fp)
            writer.writerow(["licenseKey", "id", "status", "plan", "expiresAt", "maxDevices", "deviceCount"])
            for key in keys:
                item = licenses.get(key) or {}
                devices = item.get("devices")
                device_count = len(devices) if isinstance(devices, list) else 0
                writer.writerow([
                    key,
                    item.get("id", ""),
                    item.get("status", ""),
                    item.get("plan", ""),
                    item.get("expiresAt", ""),
                    item.get("maxDevices", ""),
                    device_count,
                ])
    else:
        output_path.write_text("\n".join(keys) + "\n", encoding="utf-8")

    print(f"导出完成: {len(keys)} 条 -> {output_path}")
    return 0


def command_unbind(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    key = normalize_license_key(args.key)
    if not validate_license_key_format(key):
        raise ValueError("授权码格式不正确")

    db = load_db(db_path)
    item = db.get("licenses", {}).get(key)
    if not isinstance(item, dict):
        raise ValueError(f"授权码不存在: {key}")
    item["devices"] = []
    item["updatedAt"] = now_iso()
    db["licenses"][key] = item
    save_db(db_path, db)
    print(f"已清理设备绑定: {key}")
    return 0


@dataclass
class ActivationResult:
    http_status: int
    payload: Dict[str, Any]


class AuditWriter:
    def __init__(self, path: Optional[Path]) -> None:
        self.path = path
        self._lock = threading.Lock()

    def append(self, record: Dict[str, Any]) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False) + "\n"
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fp:
                fp.write(line)


class LicenseRuntime:
    def __init__(self, db_path: Path, refresh_after_sec: int, offline_grace_hours: int, audit_path: Optional[Path]) -> None:
        self.db_path = db_path
        self.refresh_after_sec = refresh_after_sec
        self.offline_grace_hours = offline_grace_hours
        self.audit = AuditWriter(audit_path)
        self._lock = threading.Lock()

    def _save(self, db: Dict[str, Any]) -> None:
        save_db(self.db_path, db)

    def _load(self) -> Dict[str, Any]:
        return load_db(self.db_path)

    def _bind_device(self, item: Dict[str, Any], *, install_id: str, device_id: str, hardware_id: str) -> bool:
        devices = item.get("devices")
        if not isinstance(devices, list):
            devices = []
        now = now_iso()

        for device in devices:
            if not isinstance(device, dict):
                continue
            if str(device.get("installId", "")).strip().lower() == install_id.lower():
                device["lastSeenAt"] = now
                if device_id:
                    device["deviceId"] = device_id
                if hardware_id:
                    device["hardwareId"] = hardware_id
                item["devices"] = devices
                return True

        max_devices = int(item.get("maxDevices", 1) or 1)
        if len(devices) >= max_devices:
            return False

        devices.append(
            {
                "installId": install_id,
                "deviceId": device_id,
                "hardwareId": hardware_id,
                "boundAt": now,
                "lastSeenAt": now,
            }
        )
        item["devices"] = devices
        return True

    def activate(self, payload: Dict[str, Any]) -> ActivationResult:
        license_key = normalize_license_key(str(payload.get("licenseKey", "")))
        install_id = str(payload.get("installId", "")).strip()
        device_id = str(payload.get("deviceId", "")).strip() or install_id
        hardware_id = str(payload.get("hardwareId", "")).strip()

        if not license_key or not install_id:
            return ActivationResult(400, {"valid": False, "code": "bad_request", "message": "licenseKey/installId required"})

        if not validate_license_key_format(license_key):
            return ActivationResult(200, {"valid": False, "code": "format_invalid", "message": "invalid license format"})

        if not validate_license_key_checksum(license_key):
            return ActivationResult(200, {"valid": False, "code": "checksum_invalid", "message": "invalid license checksum"})

        with self._lock:
            db = self._load()
            item = db.get("licenses", {}).get(license_key)
            if not isinstance(item, dict):
                return ActivationResult(200, {"valid": False, "code": "not_found", "message": "license not found"})

            status = str(item.get("status", "active")).lower()
            if status != "active":
                return ActivationResult(200, {"valid": False, "code": "revoked", "message": "license not active"})

            expires_at = item.get("expiresAt")
            if isinstance(expires_at, str) and expires_at.strip():
                expires_dt = parse_iso_datetime(expires_at)
                if datetime.now(timezone.utc) > expires_dt:
                    return ActivationResult(200, {"valid": False, "code": "expired", "message": "license expired"})

            if not self._bind_device(item, install_id=install_id, device_id=device_id, hardware_id=hardware_id):
                return ActivationResult(200, {"valid": False, "code": "device_limit", "message": "max devices reached"})

            item["updatedAt"] = now_iso()
            db["licenses"][license_key] = item
            self._save(db)

        self.audit.append(
            {
                "ts": now_iso(),
                "event": "activate",
                "licenseKey": license_key,
                "installId": install_id,
                "deviceId": device_id,
                "hardwareId": hardware_id,
                "status": "ok",
            }
        )

        return ActivationResult(
            200,
            {
                "valid": True,
                "code": "valid",
                "licenseId": item.get("id", license_key),
                "plan": item.get("plan", "standard"),
                "expiresAt": item.get("expiresAt"),
                "refreshAfterSec": self.refresh_after_sec,
                "offlineGraceHours": self.offline_grace_hours,
            },
        )


class LicenseHttpHandler(BaseHTTPRequestHandler):
    runtime: LicenseRuntime

    def _write_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path.endswith("/health"):
            self._write_json(200, {"ok": True, "time": now_iso()})
            return
        self._write_json(404, {"error": f"no route: GET {self.path}"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.endswith("/activate"):
            self._write_json(404, {"error": f"no route: POST {self.path}"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            payload = json.loads(raw) if raw.strip() else {}
            if not isinstance(payload, dict):
                raise ValueError("payload must be object")
        except Exception as exc:  # pylint: disable=broad-except
            self._write_json(400, {"valid": False, "code": "bad_request", "message": str(exc)})
            return

        result = self.runtime.activate(payload)
        self._write_json(result.http_status, result.payload)


def command_serve(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    load_db(db_path)
    audit_path = Path(args.audit) if args.audit else None
    runtime = LicenseRuntime(
        db_path=db_path,
        refresh_after_sec=args.refresh_after_sec,
        offline_grace_hours=args.offline_grace_hours,
        audit_path=audit_path,
    )

    handler_cls = type("BoundLicenseHttpHandler", (LicenseHttpHandler,), {})
    handler_cls.runtime = runtime
    server = ThreadingHTTPServer((args.host, args.port), handler_cls)
    print(f"license server running: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n收到终止信号，正在关闭服务")
    finally:
        server.server_close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MatchaClaw 授权服务脚本")
    sub = parser.add_subparsers(dest="command", required=True)

    p_gen = sub.add_parser("gen", help="生成授权码")
    p_gen.add_argument("--seed", type=str, default="", help="12 位种子（可选）")
    p_gen.add_argument("--count", type=int, default=1, help="生成数量（seed 模式忽略）")
    p_gen.add_argument("--out", type=str, default="", help="输出文件路径")
    p_gen.add_argument("--format", choices=["txt", "csv"], default="txt", help="输出格式")
    p_gen.set_defaults(handler=command_gen)

    p_import = sub.add_parser("import", help="导入授权码到数据库")
    p_import.add_argument("--db", type=str, default=DEFAULT_DB, help="数据库路径")
    p_import.add_argument("--file", type=str, required=True, help="授权码文件")
    p_import.add_argument("--plan", type=str, default="standard", help="计划名")
    p_import.add_argument("--status", choices=["active", "revoked"], default="active", help="授权状态")
    p_import.add_argument("--max-devices", type=int, default=1, help="最大设备数")
    p_import.add_argument("--expires-at", type=str, default=None, help="过期时间 ISO8601（可选）")
    p_import.add_argument("--strict-checksum", action="store_true", help="仅导入 checksum 合法的 key")
    p_import.add_argument("--overwrite", action="store_true", help="已存在时覆盖授权信息")
    p_import.set_defaults(handler=command_import)

    p_export = sub.add_parser("export", help="导出授权码")
    p_export.add_argument("--db", type=str, default=DEFAULT_DB, help="数据库路径")
    p_export.add_argument("--out", type=str, required=True, help="导出文件")
    p_export.add_argument("--format", choices=["txt", "csv", "json"], default="csv", help="导出格式")
    p_export.set_defaults(handler=command_export)

    p_unbind = sub.add_parser("unbind", help="清除某个授权码的设备绑定")
    p_unbind.add_argument("--db", type=str, default=DEFAULT_DB, help="数据库路径")
    p_unbind.add_argument("--key", type=str, required=True, help="授权码")
    p_unbind.set_defaults(handler=command_unbind)

    p_serve = sub.add_parser("serve", help="启动授权 HTTP 服务")
    p_serve.add_argument("--host", type=str, default="127.0.0.1", help="监听地址")
    p_serve.add_argument("--port", type=int, default=3187, help="监听端口")
    p_serve.add_argument("--db", type=str, default=DEFAULT_DB, help="数据库路径")
    p_serve.add_argument("--audit", type=str, default="", help="审计日志 jsonl 路径")
    p_serve.add_argument("--refresh-after-sec", type=int, default=DEFAULT_REFRESH_AFTER_SEC, help="客户端建议刷新间隔")
    p_serve.add_argument("--offline-grace-hours", type=int, default=DEFAULT_OFFLINE_GRACE_HOURS, help="客户端离线宽限建议小时数")
    p_serve.set_defaults(handler=command_serve)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except Exception as exc:  # pylint: disable=broad-except
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
