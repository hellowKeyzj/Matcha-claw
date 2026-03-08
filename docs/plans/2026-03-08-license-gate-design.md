# MatchaClaw License 门禁与续校设计（2026-03-08）

## 1. 背景与目标

当前 License 校验只在 `/setup` 首步执行。存在两个问题：

1. 老用户（`setupComplete=true`）升级后可能完全绕过 License 校验。
2. 缓存过期后没有自动续校机制，用户体验不稳定。

本设计目标：

1. 无有效授权时，强制停留在设置页 License 区（可在设置页内切换区块）。
2. 缓存过期后自动在线续校，减少手工输入。
3. 本地保存 License Key（AES 加密文件，不依赖系统密钥链）。
4. 设备识别更友好：支持“同硬件换绑 + 人工解绑（按 key 清空绑定）”。

## 2. 范围与非目标

### 2.1 范围

1. 客户端：全局路由门禁、设置页 License 区、自动续校、本地 AES 密文存储。
2. 服务端：兼容扩展 `hardwareId/installId`，支持同硬件替换旧安装绑定。
3. 运维：人工解绑按 key 清空绑定，写入审计日志。

### 2.2 非目标

1. 不改动现有 API 路径（仍为 `/v1/activate`）。
2. 不改动 key 格式（仍为 `MATCHACLAW-XXXX-XXXX-XXXX-XXXX`）。
3. 不引入系统密钥链（Keychain/Credential Manager）作为本期方案。

## 3. 关键设计

## 3.1 客户端授权状态机

由主进程维护单一授权门禁状态：

1. `granted`: 放行全部路由。
2. `checking`: 启动或定时续校中。
3. `blocked`: 仅允许 `/settings`，其它路由跳转 `/settings?section=license`。

规则：

1. `blocked` 时，允许设置页内切换区块（网关/外观等）。
2. `blocked` 时，禁止离开设置页。

## 3.2 升级场景行为

1. 无 License 旧版本 -> 首次升级到 License 版本：
   - 若无有效授权记录，直接进入 `blocked`（不依赖 `/setup`）。
2. 已是 License 版本 -> 迭代升级：
   - 读取现有缓存与本地密文，后台自动续校，成功则无感放行。

## 3.3 设置页 License 区

新增 `settings section = license`，包含：

1. License Key 输入框。
2. `校验并保存` 按钮。
3. `重新校验` 按钮（立即触发在线同步）。
4. 状态展示（`valid/cache_grace_valid/network_error/...`）。
5. `清除 License` 按钮 + 二次确认弹窗（确认后删除本地密文与缓存并重新锁定）。

## 3.4 自动续校

1. 应用启动时读取本地密文并解密得到 key，自动调用 `license:validate`。
2. 按服务端返回的 `refreshAfterSec` 调度下一次续校。
3. 续校失败：
   - 若缓存仍在宽限期：可继续使用（`cache_grace_valid`）。
   - 若已超宽限：切换到 `blocked`。

## 3.5 本地 AES 密文存储

文件路径：`<userData>/license-secret.enc.json`

建议结构：

```json
{
  "version": 1,
  "alg": "aes-256-gcm",
  "kdf": "hkdf-sha256",
  "salt": "<base64>",
  "iv": "<base64>",
  "ciphertext": "<base64>",
  "tag": "<base64>",
  "updatedAt": "2026-03-08T00:00:00Z"
}
```

流程：

1. 校验成功后使用 AES-256-GCM 加密 License Key 并原子写盘（tmp + rename）。
2. 密钥由设备身份材料通过 HKDF 派生（不落盘明文密钥）。
3. 保留 `*.bak` 备份用于损坏恢复。

兼容原则：

1. 存储结构使用 `version` 管理。
2. 后续升级“只增版本，不破旧读”（新版本可读旧版本）。

## 3.6 设备识别（最小改造）

新增两个可选字段（保持 API 兼容）：

1. `hardwareId`: 稳定硬件指纹哈希（不上传原始机器标识）。
2. `installId`: 安装实例标识（可随重装变化）。

建议采集来源：

1. Windows: `MachineGuid`（注册表）。
2. macOS: `IOPlatformUUID`。
3. Linux: `/etc/machine-id`（或 `/var/lib/dbus/machine-id`）。

服务端绑定策略：

1. 命中同 `hardwareId`：允许替换旧 `installId`（同硬件换绑）。
2. 不同 `hardwareId`：按 `maxDevices` 计数。
3. 旧客户端未上传新字段时，回退到现有 `deviceId` 逻辑。

## 3.7 人工解绑兜底

本期仅提供最小运维能力：

1. 按 `licenseKey` 清空全部绑定（无需复杂后台界面）。
2. 操作写入 `audit.jsonl`（建议 `code=manual_unbind`）。

## 4. 数据与文件关系

1. `matchaclaw-license-device-identity.json`: 设备身份来源（用于生成/派生标识）。
2. `license-secret.enc.json`: License Key 密文存储。
3. `matchaclaw-license`（electron-store）: 校验结果缓存（宽限、过期、计划等）。

默认均位于同一 `userData` 目录下（不同文件职责分离）。

## 5. 验证清单

1. 老用户升级后（无授权）被锁定在设置页。
2. 设置页校验成功后立即解锁可访问全站。
3. 缓存过期时自动续校，成功无感；失败且超宽限进入锁定。
4. 同硬件重装后可替换 `installId`，无需新 key。
5. 清除 License（二次确认）后重新锁定。
6. 人工解绑后可重新激活。

## 6. 发布与回滚

发布顺序：

1. 先部署服务端兼容扩展（支持新旧字段）。
2. 再发布客户端（门禁 + 自动续校 + AES 存储）。

回滚策略：

1. 服务端保留旧字段与旧判定路径，避免一次性破坏。
2. 客户端异常时可临时降级到现有缓存判定流程。
