# License 商用发布说明

本文档用于正式商用场景：**在线激活 + 离线短期宽限缓存**。

当前版本采用“内置固定授权地址”策略：客户端默认读取代码内置地址，不要求你在每台机器手工配置环境变量。

## 1. 商用模式默认行为

在打包产物中（`app.isPackaged=true`），默认策略为 `online-required`：

1. 校验 key 格式：`MATCHACLAW-XXXX-XXXX-XXXX-XXXX`
2. 调用授权服务（默认使用内置地址）
3. 服务返回有效后写入本地授权缓存
4. 服务短暂不可用时，允许在宽限期内使用缓存通过（`cache_grace_valid`）

> 结论：正式商用必须部署授权服务。

## 2. 内置地址与可选覆盖

内置配置文件：

- `electron/utils/license-config.ts`
- 默认值：
  - `BUILTIN_LICENSE_ENDPOINT=https://license.intelli-spectrum.com/v1/activate`
  - `BUILTIN_LICENSE_MODE=online-required`
  - `BUILTIN_LICENSE_PRODUCT=matchaclaw-desktop`

如果你要换成你自己的地址，改这个文件后重新打包即可。

## 3. 可选环境变量（调试/灰度）

```text
MATCHACLAW_LICENSE_ENDPOINT=https://license.example.com/v1/activate   # 选填：覆盖内置地址
MATCHACLAW_LICENSE_PRODUCT=matchaclaw-desktop                              # 选填
MATCHACLAW_LICENSE_TIMEOUT_MS=8000                                    # 选填，默认 8000
MATCHACLAW_LICENSE_OFFLINE_GRACE_HOURS=72                             # 选填，默认 72
MATCHACLAW_LICENSE_MODE=online-required                               # 选填；覆盖内置策略
```

说明：

- `MATCHACLAW_LICENSE_MODE=online-required`：无服务即拒绝（商用默认）
- `MATCHACLAW_LICENSE_MODE=online-optional`：仅建议开发调试
- `MATCHACLAW_LICENSE_MODE=offline-local`：纯本地校验，不建议商用

## 4. 授权服务 API 约定（最小集）

请求（POST JSON）：

```json
{
  "licenseKey": "MATCHACLAW-XXXX-XXXX-XXXX-XXXX",
  "product": "matchaclaw-desktop",
  "deviceId": "sha256...",
  "appVersion": "0.1.23",
  "platform": "win32",
  "machineName": "PC-001"
}
```

响应（通过）：

```json
{
  "valid": true,
  "licenseId": "lic_123",
  "plan": "pro",
  "expiresAt": "2027-12-31T23:59:59.000Z",
  "refreshAfterSec": 43200
}
```

响应（拒绝）：

```json
{
  "valid": false,
  "code": "revoked",
  "message": "license revoked"
}
```

## 5. License 服务与发码（单文件 Python）

统一入口：`scripts/license_server.py`

启动：

```bash
python3 scripts/license_server.py serve --host 0.0.0.0 --port 3187 --db /opt/matchaclaw-license/license-db.json
```

默认监听：`http://127.0.0.1:3187/v1/activate`

数据库示例（`/opt/matchaclaw-license/license-db.json`）：

```json
{
  "licenses": {
    "MATCHACLAW-AAAA-BBBB-CCCC-DDDD": {
      "id": "lic_001",
      "status": "active",
      "plan": "pro",
      "expiresAt": "2027-12-31T23:59:59.000Z",
      "maxDevices": 2,
      "devices": []
    }
  }
}
```

> 单文件实现适合快速落地；正式商用建议后续补鉴权、审计、加密和高可用。

常用命令：

```bash
# 启动服务
python3 scripts/license_server.py serve --host 0.0.0.0 --port 3187 --db /opt/matchaclaw-license/license-db.json

# 批量生成 key（保存到文件）
python3 scripts/license_server.py gen --count 500 --out /opt/matchaclaw-license/keys.txt --format txt

# 批量录入 key（每行一个，支持 "1. KEY"）
python3 scripts/license_server.py import --db /opt/matchaclaw-license/license-db.json --file /opt/matchaclaw-license/keys.txt --plan pro --max-devices 2 --expires-at 2027-12-31T23:59:59Z

# 导出当前库中的 key（CSV）
python3 scripts/license_server.py export --db /opt/matchaclaw-license/license-db.json --out /opt/matchaclaw-license/licenses.csv --format csv
```

说明：

- `import` 默认不会覆盖已存在 key；如需覆盖，加 `--replace`。
- 需要严格校验 checksum 时，加 `--strict-checksum`。
- 服务端接口保持一致：`GET /health`、`POST /v1/activate`。

## 7. 关于 `MATCHACLAW_LICENSE_KEYS`

`MATCHACLAW_LICENSE_KEYS` 是本地白名单（离线模式/开发模式用），不是给最终用户配置的。

- 商用在线模式：不依赖 `MATCHACLAW_LICENSE_KEYS`
- 开发或应急离线场景：可临时用它做白名单

## 8. 上线前自检清单

1. 确认 `electron/utils/license-config.ts` 内置地址已改为你的生产授权服务地址
2. 确认内置模式为 `online-required`
3. 合法 key 在线可通过并进入下一步
4. 吊销/过期 key 在线被拒绝
5. 断网后在宽限期内可通过缓存，超过宽限期后拒绝
6. 更换设备后同 key 按服务端策略校验（设备绑定/席位数）
