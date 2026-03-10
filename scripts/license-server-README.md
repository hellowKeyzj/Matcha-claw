# License Server 运维说明

本目录提供 `scripts/license_server.py` 与 `scripts/license_audit_summary.py`，用于本地或内网授权服务。

## 1. 快速开始

1. 生成授权码：

```bash
python3 scripts/license_server.py gen --count 100 --out /opt/claw-license/keys.txt --format txt
```

2. 导入到数据库：

```bash
python3 scripts/license_server.py import \
  --db /opt/claw-license/license-db.json \
  --file /opt/claw-license/keys.txt \
  --plan pro \
  --max-devices 2 \
  --expires-at 2027-12-31T23:59:59Z \
  --strict-checksum
```

3. 启动服务：

```bash
python3 scripts/license_server.py serve \
  --host 127.0.0.1 \
  --port 3187 \
  --db /opt/claw-license/license-db.json \
  --audit /opt/claw-license/audit.jsonl \
  --refresh-after-sec 604800
```

## 2. HTTP 接口

- `GET /health`
- `POST /activate`

请求样例：

```bash
curl -i -X POST http://127.0.0.1:3187/activate \
  -H "Content-Type: application/json" \
  -d '{
    "licenseKey":"MATCHACLAW-AAAA-BBBB-CCCC-DDDD",
    "deviceId":"debug-install-1",
    "installId":"debug-install-1",
    "hardwareId":"debug-hardware-1"
  }'
```

## 3. 常用维护命令

导出授权：

```bash
python3 scripts/license_server.py export \
  --db /opt/claw-license/license-db.json \
  --out /opt/claw-license/licenses.csv \
  --format csv
```

清理单个授权设备绑定：

```bash
python3 scripts/license_server.py unbind \
  --db /opt/claw-license/license-db.json \
  --key MATCHACLAW-AAAA-BBBB-CCCC-DDDD
```

审计汇总：

```bash
python3 scripts/license_audit_summary.py --db /opt/claw-license/license-db.json --pretty
```

## 4. 与客户端配置对齐

客户端默认读取：

- `electron/utils/license-config.ts` 的 `BUILTIN_LICENSE_ENDPOINT`
- 或环境变量 `MATCHACLAW_LICENSE_ENDPOINT`

建议生产部署时显式配置 `MATCHACLAW_LICENSE_ENDPOINT`，避免发版时硬编码地址变更。
