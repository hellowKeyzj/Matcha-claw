# Runtime Host Contract Baseline v1

> Rust `runtime-host` 迁移的观察基线。它固定现有客户端可观察行为；不是新的 Rust 架构，也不授权修改 Renderer、preload 或 Electron API。

## 使用方式

| 需要回答的问题 | 文档 |
| --- | --- |
| 哪些边界属于本次替换，谁是权威来源？ | [scope.md](scope.md) |
| Electron 与 child 的 HTTP envelope、错误和超时是什么？ | [transport.md](transport.md) |
| Renderer 实际怎样调用 Host API 和 capability？ | [renderer-api.md](renderer-api.md) |
| 已注册的 child route、Host API 暴露与 legacy rejection 是什么？ | [routes.md](routes.md) |
| `host:event`、事件 payload、顺序和丢失语义是什么？ | [events.md](events.md) |
| child 如何调用 Electron parent？ | [parent-callbacks.md](parent-callbacks.md) |
| child 如何启动、ready、停止、重启和代理 WebSocket？ | [lifecycle.md](lifecycle.md) |
| 异步 operation 的 owner-local 终态契约是什么？ | [async-projection.md](async-projection.md) |
| 现有测试证明了什么，还缺什么？ | [verification.md](verification.md) |
| 当前源码、类型、文档之间有哪些未裁决差异？ | [open-items.md](open-items.md) |
| TS 真实行为对应哪些 owner、事实源和状态平面？ | [runtime-host-owner-model/README.md](../runtime-host-owner-model/README.md) |

## 冻结原则

```text
Renderer / page / store
  → preload IPC
  → Electron Host API
  → DirectRuntimeHost control 或 signed loopback product transport
  → Rust Owner actor
  → Rust 内部 owner

Rust 替换 child 与其内部实现；Renderer/preload contract 不因迁移改变。
```

1. **Renderer 实际消费者优先。** 请求字段、返回字段、错误处理、timeout、轮询和事件消费以 `src/` 调用方为首要证据。
2. **Electron 是 child 的协议客户端。** Rust 必须兼容 Electron 的 `/dispatch`、`/health`、生命周期和 parent callback 合同。
3. **TS 内部类型不是自动契约。** 只有经过 HTTP、IPC、事件或 CLI 可观察到的字段才进入本基线。
4. **显式 legacy rejection 也是现有行为。** 已禁用的旧 route 不能被 Rust 悄悄恢复成另一种成功语义。
5. **`OPEN` 不是设计建议。** 它表示源码、测试或旧文档之间的真实差异；在 Rust 实现前必须显式裁决，不能被默认猜测掩盖。

## 证据状态

| 标记 | 含义 |
| --- | --- |
| `CONFIRMED` | 当前源码已直接证明。 |
| `LEGACY-REJECTED` | child 仍注册该路径，但明确返回拒绝。 |
| `ALLOWLISTED-UNCONFIRMED` | 可被桥接，但当前盘点未找到已确认 producer 或 consumer。 |
| `OPEN` | 当前实现、类型、测试或旧文档存在差异，尚未作迁移裁决。 |

本目录记录的是当前仓库状态；不以旧的 [runtime-host-transport-v1.md](../runtime-host-transport-v1.md) 单独作为完整真相。后者是较早的最小 transport 说明，已知差异见 [open-items.md](open-items.md)。

## 已裁决事项

- Electron `DirectRuntimeHost` 通过 stdio 长度帧写入一次 bootstrap，并等待 Rust private control ready；Renderer 不直接接触该 private control。
- private control command timeout 上限为 **30s**，frame 上限为 **1MiB**；命令 vocabulary 是固定枚举，不是 HTTP route 透传。
- Capability Directory 与 Runtime Endpoint Directory 已由 Rust 投影 fixed OpenClaw/Matcha local peer surface；availability 可随 readiness 降级，不代表 owner cutover。
- Electron 主进程 → legacy child `/dispatch` 默认超时采用源码实际值 **30s**；旧 transport 文档的 15s 已修正。
- `PAYLOAD_TOO_LARGE` 是 legacy child 对超大 dispatch body 的真实 413 响应；Renderer 不需要感知新 API。
- `INVALID_TRANSPORT_PAYLOAD` 是 Electron 解析非法 child 响应时的本地错误；Rust 不主动返回该码。
- child health lifecycle 与 Electron process-manager lifecycle 分层处理，不强行统一枚举。
- **旧 generic RuntimeJob public contract 已删除，不是待办：** 不存在 `runtimeHost.jobGet`、`runtime-job:*`、generic `RuntimeJob*` DTO 或 `job_compatibility`；文档中的这些名称只用于标识已删除项，禁止重新引入。
- **Toolchain final path 已冻结：** `hostUvInstallAll` 直接调用 `platform.runtime` / `toolchain.installUv`，target 为 `platform-runtime`；Electron public adapter 调用 Rust private `openclaw.toolchain.install-uv`，等待真实结果后才返回。
- **ClawHub marketplace route 不变：** `POST /api/clawhub/search` 由 Rust external `ClawHubRegistryClient` 执行 registry HTTP search，不经 RuntimeDriver 或 OpenClaw Gateway；`POST /api/skills/clawhub/install` 仍经 Skills runtime ops，但底层执行 legacy ClawHub CLI + registry fallback。

## 当前迁移决定

- Renderer、Electron、preload 和页面 API **不因 Rust 移植而改动**。
- Rust 内部 **不建立跨 owner 的通用异步 operation queue、registry 或 compatibility projection**。
- 异步完成由具体 owner/facade 的 typed operation query/event 表达，详见 [async-projection.md](async-projection.md)。
- 新 Rust owner、crate、状态模型和切换顺序必须在本基线之上推导，不能从现有 `runtime-host-rust/` 目录反推契约。

## 完整性的边界

本基线已按所有进程边界和已注册 route 分类；它不把业务内部的每个 TS interface 再抄一遍。每个请求/响应的细粒度字段权威仍保留在对应 Renderer wrapper、route decoder 和 shared DTO 源码中，并由本目录给出入口和证据位置。

动态值如 `pid`、port、token、request ID、run ID、时间戳和 trace ID 在后续比对中必须归一化，不能作为字面 fixture 值冻结。
