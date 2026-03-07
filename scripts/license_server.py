#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MatchaClaw License 单文件工具

支持能力：
1) 生成 key: gen
2) 单个录入: add
3) 批量录入: import
4) 导出 key: export
5) 启动授权服务: serve

数据库结构：
{
  "licenses": {
    "MATCHACLAW-....": {
      "id": "lic_000001",
      "status": "active",
      "plan": "pro",
      "expiresAt": "2027-12-31T23:59:59Z",
      "maxDevices": 2,
      "devices": [],
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
}
"""

import argparse
import csv
import hashlib
import json
import os
import random
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Optional, Tuple

LICENSE_PREFIX = "MATCHACLAW"
LICENSE_PATTERN = re.compile(r"^MATCHACLAW-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$")
CHECKSUM_CONTEXT = "matchaclaw-license-v1"
CHECKSUM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
SEED_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

db_lock = threading.Lock()
audit_lock = threading.Lock()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso_datetime(text: Optional[str]) -> Optional[datetime]:
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None


def normalize_license_key(raw_key: str) -> str:
    return (raw_key or "").strip().upper()


def normalize_seed(raw_seed: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (raw_seed or "").upper())


def normalize_device_id(raw_device_id: str) -> str:
    return (raw_device_id or "").strip().lower()


def compute_checksum_segment(payload: str) -> str:
    digest = hashlib.sha256(f"{CHECKSUM_CONTEXT}:{payload}".encode("utf-8")).digest()
    return "".join(CHECKSUM_ALPHABET[digest[i] % len(CHECKSUM_ALPHABET)] for i in range(4))


def build_license_key_from_seed(seed: str) -> str:
    normalized = normalize_seed(seed)
    if len(normalized) != 12:
        raise ValueError("seed 标准化后必须是 12 位字母/数字")
    payload = f"{normalized[:4]}-{normalized[4:8]}-{normalized[8:12]}"
    checksum = compute_checksum_segment(payload)
    return f"{LICENSE_PREFIX}-{payload}-{checksum}"


def validate_license_key_format(key: str) -> bool:
    return bool(LICENSE_PATTERN.match(key))


def validate_license_key_checksum(key: str) -> bool:
    if not validate_license_key_format(key):
        return False
    segments = key.split("-")
    payload = f"{segments[1]}-{segments[2]}-{segments[3]}"
    expected = compute_checksum_segment(payload)
    return segments[4] == expected


def random_seed(length: int = 12) -> str:
    sys_rand = random.SystemRandom()
    return "".join(sys_rand.choice(SEED_ALPHABET) for _ in range(length))


def ensure_db_file(db_file: str) -> None:
    if os.path.exists(db_file):
        return
    os.makedirs(os.path.dirname(os.path.abspath(db_file)), exist_ok=True)
    with open(db_file, "w", encoding="utf-8") as f:
        json.dump({"licenses": {}}, f, ensure_ascii=False, indent=2)


def load_db(db_file: str) -> Dict:
    ensure_db_file(db_file)
    with open(db_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {"licenses": {}}
    if "licenses" not in data or not isinstance(data["licenses"], dict):
        data["licenses"] = {}
    return data


def save_db(db_file: str, data: Dict) -> None:
    with open(db_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def resolve_client_ip(handler: BaseHTTPRequestHandler) -> str:
    # 优先取反向代理透传地址；若无则退回直连地址。
    x_forwarded_for = (handler.headers.get("X-Forwarded-For") or "").strip()
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    x_real_ip = (handler.headers.get("X-Real-IP") or "").strip()
    if x_real_ip:
        return x_real_ip
    client_addr = handler.client_address[0] if handler.client_address else ""
    return client_addr or "unknown"


def append_audit_event(
    audit_file: str,
    *,
    code: str,
    ip: str,
    license_key: str = "",
    device_id: str = "",
) -> None:
    record = {
        "time": utc_now_iso(),
        "key": license_key,
        "deviceId": device_id,
        "ip": ip,
        "code": code,
    }
    os.makedirs(os.path.dirname(os.path.abspath(audit_file)), exist_ok=True)
    with audit_lock:
        with open(audit_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def next_license_id(existing_licenses: Dict) -> str:
    # 只保证本地单文件服务内递增，不做全局强一致 ID。
    return f"lic_{len(existing_licenses) + 1:06d}"


def parse_keys_from_text_lines(lines: List[str]) -> List[str]:
    keys: List[str] = []
    for raw in lines:
        line = (raw or "").strip()
        if not line:
            continue
        # 兼容 "1. MATCHACLAW-..." 这种编号形式
        if ". " in line:
            left, right = line.split(". ", 1)
            if left.isdigit():
                line = right.strip()
        candidate = normalize_license_key(line)
        if validate_license_key_format(candidate):
            keys.append(candidate)
    return keys


def write_keys_output(keys: List[str], out_file: Optional[str], fmt: str) -> None:
    if out_file is None:
        for i, key in enumerate(keys, start=1):
            print(f"{i}. {key}")
        return

    os.makedirs(os.path.dirname(os.path.abspath(out_file)), exist_ok=True)
    if fmt == "txt":
        with open(out_file, "w", encoding="utf-8") as f:
            for key in keys:
                f.write(f"{key}\n")
    elif fmt == "json":
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump({"keys": keys}, f, ensure_ascii=False, indent=2)
    elif fmt == "csv":
        with open(out_file, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["licenseKey"])
            for key in keys:
                writer.writerow([key])
    else:
        raise ValueError(f"不支持的输出格式: {fmt}")
    print(f"已输出 {len(keys)} 个 key -> {out_file}")


def add_or_update_license(
    db: Dict,
    key: str,
    plan: str,
    expires_at: Optional[str],
    max_devices: int,
    status: str,
    replace: bool,
    license_id: Optional[str],
) -> Tuple[str, bool]:
    licenses = db["licenses"]
    existing = licenses.get(key)
    if existing and not replace:
        return (existing.get("id", key), False)

    created_at = existing.get("createdAt") if isinstance(existing, dict) else utc_now_iso()
    resolved_id = license_id or (existing.get("id") if isinstance(existing, dict) else None) or next_license_id(licenses)
    record = {
        "id": resolved_id,
        "status": status,
        "plan": plan,
        "expiresAt": expires_at,
        "maxDevices": int(max_devices),
        "devices": existing.get("devices", []) if isinstance(existing, dict) else [],
        "createdAt": created_at,
        "updatedAt": utc_now_iso(),
    }
    licenses[key] = record
    return (resolved_id, True)


def cmd_gen(args: argparse.Namespace) -> None:
    if args.seed and args.count != 1:
        raise ValueError("指定 --seed 时不能同时使用 --count > 1")
    if args.count <= 0 or args.count > 100000:
        raise ValueError("--count 必须在 1 到 100000 之间")

    keys: List[str] = []
    if args.seed:
        keys.append(build_license_key_from_seed(args.seed))
    else:
        for _ in range(args.count):
            keys.append(build_license_key_from_seed(random_seed(12)))

    write_keys_output(keys, args.out, args.format)


def cmd_add(args: argparse.Namespace) -> None:
    key = normalize_license_key(args.key)
    if not validate_license_key_format(key):
        raise ValueError("key 格式无效")
    if args.strict_checksum and not validate_license_key_checksum(key):
        raise ValueError("key checksum 校验失败")

    with db_lock:
        db = load_db(args.db)
        license_id, changed = add_or_update_license(
            db=db,
            key=key,
            plan=args.plan,
            expires_at=args.expires_at,
            max_devices=args.max_devices,
            status=args.status,
            replace=args.replace,
            license_id=args.license_id,
        )
        if changed:
            save_db(args.db, db)
            print(f"已写入: {key} ({license_id})")
        else:
            print(f"已存在且未覆盖: {key} ({license_id})")


def cmd_import(args: argparse.Namespace) -> None:
    if not os.path.exists(args.file):
        raise FileNotFoundError(f"输入文件不存在: {args.file}")
    with open(args.file, "r", encoding="utf-8") as f:
        keys = parse_keys_from_text_lines(f.readlines())
    if not keys:
        raise ValueError("输入文件未解析到任何合法 key")

    invalid_checksum: List[str] = []
    if args.strict_checksum:
        for key in keys:
            if not validate_license_key_checksum(key):
                invalid_checksum.append(key)
        if invalid_checksum:
            raise ValueError(f"存在 checksum 无效 key，数量={len(invalid_checksum)}")

    inserted = 0
    skipped = 0
    with db_lock:
        db = load_db(args.db)
        for key in keys:
            _, changed = add_or_update_license(
                db=db,
                key=key,
                plan=args.plan,
                expires_at=args.expires_at,
                max_devices=args.max_devices,
                status=args.status,
                replace=args.replace,
                license_id=None,
            )
            if changed:
                inserted += 1
            else:
                skipped += 1
        save_db(args.db, db)
    print(f"导入完成: total={len(keys)}, inserted={inserted}, skipped={skipped}")


def cmd_export(args: argparse.Namespace) -> None:
    with db_lock:
        db = load_db(args.db)
    licenses = db.get("licenses", {})
    keys = sorted(list(licenses.keys()))

    if args.format == "txt":
        write_keys_output(keys, args.out, "txt")
        return

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    if args.format == "json":
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"licenses": licenses}, f, ensure_ascii=False, indent=2)
    elif args.format == "csv":
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["licenseKey", "id", "status", "plan", "expiresAt", "maxDevices", "deviceCount"])
            for key in keys:
                item = licenses.get(key) or {}
                devices = item.get("devices") if isinstance(item.get("devices"), list) else []
                writer.writerow([
                    key,
                    item.get("id", ""),
                    item.get("status", ""),
                    item.get("plan", ""),
                    item.get("expiresAt", ""),
                    item.get("maxDevices", ""),
                    len(devices),
                ])
    else:
        raise ValueError(f"不支持的导出格式: {args.format}")
    print(f"已导出 {len(keys)} 条 -> {args.out}")


def make_http_handler(db_file: str, refresh_after_sec: int, audit_file: str):
    class LicenseHandler(BaseHTTPRequestHandler):
        def send_json(self, status_code: int, body: Dict) -> None:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, {"ok": True})
                return
            self.send_json(404, {"valid": False, "code": "not_found", "message": "not found"})

        def do_POST(self):
            if self.path != "/v1/activate":
                self.send_json(404, {"valid": False, "code": "not_found", "message": "not found"})
                return

            ip = resolve_client_ip(self)
            license_key = ""
            device_id = ""

            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload_raw = self.rfile.read(length).decode("utf-8")
                payload = json.loads(payload_raw or "{}")
            except Exception:
                append_audit_event(audit_file, code="bad_json", ip=ip)
                self.send_json(400, {"valid": False, "code": "bad_json", "message": "invalid json payload"})
                return

            license_key = normalize_license_key(str(payload.get("licenseKey", "")))
            device_id = normalize_device_id(str(payload.get("deviceId", "")))
            if not license_key or not device_id:
                append_audit_event(
                    audit_file,
                    code="bad_request",
                    ip=ip,
                    license_key=license_key,
                    device_id=device_id,
                )
                self.send_json(400, {"valid": False, "code": "bad_request", "message": "licenseKey/deviceId required"})
                return

            if not validate_license_key_format(license_key):
                append_audit_event(
                    audit_file,
                    code="format_invalid",
                    ip=ip,
                    license_key=license_key,
                    device_id=device_id,
                )
                self.send_json(200, {"valid": False, "code": "format_invalid", "message": "invalid license format"})
                return

            with db_lock:
                db = load_db(db_file)
                item = db["licenses"].get(license_key)
                if not item:
                    append_audit_event(
                        audit_file,
                        code="not_found",
                        ip=ip,
                        license_key=license_key,
                        device_id=device_id,
                    )
                    self.send_json(200, {"valid": False, "code": "not_found", "message": "license not found"})
                    return

                if item.get("status", "active") != "active":
                    append_audit_event(
                        audit_file,
                        code="revoked",
                        ip=ip,
                        license_key=license_key,
                        device_id=device_id,
                    )
                    self.send_json(200, {"valid": False, "code": "revoked", "message": "license not active"})
                    return

                expires_at = item.get("expiresAt")
                exp_dt = parse_iso_datetime(expires_at)
                if exp_dt and datetime.now(timezone.utc) > exp_dt:
                    append_audit_event(
                        audit_file,
                        code="expired",
                        ip=ip,
                        license_key=license_key,
                        device_id=device_id,
                    )
                    self.send_json(200, {"valid": False, "code": "expired", "message": "license expired"})
                    return

                max_devices = int(item.get("maxDevices", 1))
                devices = [normalize_device_id(str(d)) for d in item.get("devices", []) if str(d).strip()]
                if device_id not in devices:
                    if len(devices) >= max_devices:
                        append_audit_event(
                            audit_file,
                            code="device_limit",
                            ip=ip,
                            license_key=license_key,
                            device_id=device_id,
                        )
                        self.send_json(200, {"valid": False, "code": "device_limit", "message": "device limit reached"})
                        return
                    devices.append(device_id)
                    item["devices"] = devices
                    item["updatedAt"] = utc_now_iso()
                    db["licenses"][license_key] = item
                    save_db(db_file, db)

            append_audit_event(
                audit_file,
                code="valid",
                ip=ip,
                license_key=license_key,
                device_id=device_id,
            )

            self.send_json(200, {
                "valid": True,
                "licenseId": item.get("id", license_key),
                "plan": item.get("plan", "default"),
                "expiresAt": item.get("expiresAt"),
                "refreshAfterSec": max(60, int(refresh_after_sec)),
            })

        def log_message(self, fmt, *args):
            # 避免噪音日志；生产建议接入结构化日志。
            return

    return LicenseHandler


def cmd_serve(args: argparse.Namespace) -> None:
    ensure_db_file(args.db)
    audit_file = args.audit or os.path.join(os.path.dirname(os.path.abspath(args.db)), "audit.jsonl")
    handler = make_http_handler(args.db, args.refresh_after_sec, audit_file)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"license server running: http://{args.host}:{args.port}")
    print(f"db file: {os.path.abspath(args.db)}")
    print(f"audit file: {os.path.abspath(audit_file)}")
    print("endpoint: POST /v1/activate, GET /health")
    server.serve_forever()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MatchaClaw License 单文件工具")
    sub = parser.add_subparsers(dest="command", required=True)

    p_gen = sub.add_parser("gen", help="生成 key")
    p_gen.add_argument("--count", type=int, default=1, help="生成数量")
    p_gen.add_argument("--seed", type=str, default="", help="指定 seed，仅支持单个 key")
    p_gen.add_argument("--out", type=str, default=None, help="输出文件路径")
    p_gen.add_argument("--format", type=str, default="txt", choices=["txt", "json", "csv"], help="输出格式")
    p_gen.set_defaults(func=cmd_gen)

    p_add = sub.add_parser("add", help="录入单个 key")
    p_add.add_argument("--db", type=str, default="./license-db.json", help="数据库文件路径")
    p_add.add_argument("--key", type=str, required=True, help="待录入 key")
    p_add.add_argument("--license-id", type=str, default=None, help="自定义 license id")
    p_add.add_argument("--plan", type=str, default="pro", help="套餐标识")
    p_add.add_argument("--expires-at", type=str, default="2027-12-31T23:59:59Z", help="过期时间（ISO8601）")
    p_add.add_argument("--max-devices", type=int, default=2, help="可绑定设备上限")
    p_add.add_argument("--status", type=str, default="active", choices=["active", "revoked"], help="状态")
    p_add.add_argument("--replace", action="store_true", help="已存在时覆盖")
    p_add.add_argument("--strict-checksum", action="store_true", help="要求 key checksum 有效")
    p_add.set_defaults(func=cmd_add)

    p_import = sub.add_parser("import", help="批量录入 key（每行一个，支持'1. KEY'格式）")
    p_import.add_argument("--db", type=str, default="./license-db.json", help="数据库文件路径")
    p_import.add_argument("--file", type=str, required=True, help="输入文件（txt）")
    p_import.add_argument("--plan", type=str, default="pro", help="套餐标识")
    p_import.add_argument("--expires-at", type=str, default="2027-12-31T23:59:59Z", help="过期时间（ISO8601）")
    p_import.add_argument("--max-devices", type=int, default=2, help="可绑定设备上限")
    p_import.add_argument("--status", type=str, default="active", choices=["active", "revoked"], help="状态")
    p_import.add_argument("--replace", action="store_true", help="已存在时覆盖")
    p_import.add_argument("--strict-checksum", action="store_true", help="要求 key checksum 有效")
    p_import.set_defaults(func=cmd_import)

    p_export = sub.add_parser("export", help="导出 key")
    p_export.add_argument("--db", type=str, default="./license-db.json", help="数据库文件路径")
    p_export.add_argument("--out", type=str, required=True, help="导出文件路径")
    p_export.add_argument("--format", type=str, default="csv", choices=["txt", "json", "csv"], help="导出格式")
    p_export.set_defaults(func=cmd_export)

    p_serve = sub.add_parser("serve", help="启动授权服务")
    p_serve.add_argument("--host", type=str, default="0.0.0.0", help="监听地址")
    p_serve.add_argument("--port", type=int, default=3187, help="监听端口")
    p_serve.add_argument("--db", type=str, default="./license-db.json", help="数据库文件路径")
    p_serve.add_argument("--audit", type=str, default="", help="审计日志文件路径（默认与 db 同目录下 audit.jsonl）")
    p_serve.add_argument("--refresh-after-sec", type=int, default=43200, help="建议客户端刷新时间（秒）")
    p_serve.set_defaults(func=cmd_serve)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
