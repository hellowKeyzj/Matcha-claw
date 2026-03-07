# MatchaClaw License Server README

本文档提供一套可直接复制执行的命令，分为：

1. 执行命令（发码、录入、导出、启动）
2. 定位命令（排障、日志、连通性、权限）
3. 部署命令（systemd 常驻、Caddy 反代）

---

## 1. 执行命令

### 1.1 生成 Key

```bash
python3 /opt/claw-license/license_server.py gen \
  --count 500 \
  --out /opt/claw-license/keys.txt \
  --format txt
```

### 1.2 批量录入 Key

```bash
python3 /opt/claw-license/license_server.py import \
  --db /opt/claw-license/license-db.json \
  --file /opt/claw-license/keys.txt \
  --plan pro \
  --max-devices 1 \
  --expires-at 2027-12-31T23:59:59Z \
  --strict-checksum
```

### 1.3 导出库存

```bash
python3 /opt/claw-license/license_server.py export \
  --db /opt/claw-license/license-db.json \
  --out /opt/claw-license/licenses.csv \
  --format csv
```

### 1.4 启动服务（前台）

```bash
python3 /opt/claw-license/license_server.py serve \
  --host 127.0.0.1 \
  --port 3187 \
  --db /opt/claw-license/license-db.json \
  --audit /opt/claw-license/audit.jsonl \
  --refresh-after-sec 604800
```

### 1.5 审计摘要（可选）

```bash
python3 /opt/claw-license/license_audit_summary.py --db /opt/claw-license/license-db.json --pretty
```

---

## 2. 定位命令（排障）

### 2.1 服务状态与日志

```bash
sudo systemctl status claw-license
sudo journalctl -u claw-license -f -n 200
```

### 2.2 Caddy 状态与日志

```bash
sudo systemctl status caddy
sudo journalctl -u caddy -f -n 200
```

### 2.3 本机连通性（绕过 Caddy）

```bash
curl -i http://127.0.0.1:3187/health
curl -i -X POST http://127.0.0.1:3187/v1/activate \
  -H "content-type: application/json" \
  -d '{"licenseKey":"MATCHACLAW-AAAA-BBBB-CCCC-DDDD","deviceId":"debug-device-1"}'
```

### 2.4 公网连通性（经过 Caddy）

```bash
curl -i https://www.supercnm.top/claw-license/health
curl -i -X POST https://www.supercnm.top/claw-license/activate \
  -H "content-type: application/json" \
  -d '{"licenseKey":"MATCHACLAW-AAAA-BBBB-CCCC-DDDD","deviceId":"debug-device-1"}'
```

### 2.5 审计日志与数据库观察

```bash
tail -f /opt/claw-license/audit.jsonl
cat /opt/claw-license/license-db.json | head -n 80
```

### 2.6 权限问题快速修复（Permission denied）

```bash
sudo systemctl stop claw-license
sudo chown -R www-data:www-data /opt/claw-license
sudo chmod 750 /opt/claw-license
sudo touch /opt/claw-license/license-db.json /opt/claw-license/audit.jsonl
sudo chown www-data:www-data /opt/claw-license/license-db.json /opt/claw-license/audit.jsonl
sudo chmod 640 /opt/claw-license/license-db.json /opt/claw-license/audit.jsonl
sudo systemctl start claw-license
```

---

## 3. 部署命令

### 3.1 准备目录与文件

```bash
sudo mkdir -p /opt/claw-license
sudo cp license_server.py /opt/claw-license/
sudo cp license_audit_summary.py /opt/claw-license/
sudo chown -R www-data:www-data /opt/claw-license
```

### 3.2 systemd 服务

创建 `/etc/systemd/system/claw-license.service`：

```ini
[Unit]
Description=Claw License Server
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/claw-license
ExecStart=/usr/bin/python3 /opt/claw-license/license_server.py serve --host 127.0.0.1 --port 3187 --db /opt/claw-license/license-db.json --audit /opt/claw-license/audit.jsonl --refresh-after-sec 604800
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/claw-license

[Install]
WantedBy=multi-user.target
```

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claw-license
sudo systemctl status claw-license
```

### 3.3 Caddy 反代（与现有站点共存）

`/etc/caddy/Caddyfile` 示例：

```caddy
www.supercnm.top {
  route {
    handle /claw-license/activate {
      rewrite * /v1/activate
      reverse_proxy 127.0.0.1:3187
    }

    handle /claw-license/health {
      rewrite * /health
      reverse_proxy 127.0.0.1:3187
    }

    handle {
      reverse_proxy 127.0.0.1:8081
    }
  }
}

supercnm.top {
  redir https://www.supercnm.top{uri}
}

www.supercnm.top:18970 {
  reverse_proxy 127.0.0.1:18789
}
```

应用配置：

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

---

## 4. 客户端对接

`electron/utils/license-config.ts`：

```ts
export const BUILTIN_LICENSE_ENDPOINT = 'https://www.supercnm.top/claw-license/activate';
export const BUILTIN_LICENSE_MODE = 'online-required' as const;
```

> 改完后需要重新打包客户端，内置地址才会生效。

---

## 5. 常见错误速查

1. `Unexpected end of JSON input`
   - 通常是授权接口返回空响应或非 JSON。
   - 先跑「2.3 + 2.4」两组 curl，定位是 license 服务问题还是 Caddy 路由问题。

2. `PermissionError: license-db.json`
   - 服务进程用户无写权限，执行「2.6 权限问题快速修复」。

3. `device_limit`
   - 已达到 `maxDevices` 上限；检查该 key 的 `devices` 数组。
