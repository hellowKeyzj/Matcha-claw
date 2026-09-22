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
  → DirectRuntimeHost control 或 signed loopback product route
  → Rust Owner actor
  → Rust 内部 owner

Rust 替换 child 与其内部实现；Renderer/preload contract 不因迁移改变。
```

1. **Renderer 实际消费者优先。** 请求字段、返回字段、错误处理、timeout、轮询和事件消费以 `src/` 调用方为首要证据。
2. **Electron 是 child 的协议客户端。** 当前 Rust active path 是 `DirectRuntimeHost` private control + signed loopback product routes；旧 `/dispatch`、`/health`、root lifecycle compatibility endpoints 已废除。
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
- private control command timeout 上限为 **120s**，frame 上限为 **1MiB**；wire 只承载 `{ name, input }` 私有命令 envelope，具体 command vocabulary 来自 installed module descriptors/private-control snapshot，不是 HTTP route 透传，也不是业务 command enum。
- Host-owned loopback transport 已收敛为一个 Rust loopback server；route registry 来自 installed `ModuleCatalog` descriptors，SSE/WS 是 route outcome，不是独立 Host-owned listener。legacy `/health`、`/dispatch`、`/lifecycle/*` compatibility module 已删除；OpenClaw gateway、Matcha app-server、TeamRun MCP stdio 不属于此 server。
- Capability Catalog 与 Runtime Endpoint Directory 已由 Rust 投影 fixed OpenClaw/Matcha local peer surface；capability descriptors 来自 installed owner module providers，availability 可随 readiness 降级，不代表 owner cutover；capability list/describe 不进入 private control business command。
- Electron 主进程不再经 legacy child `/dispatch` 进入 Rust；产品请求走 signed loopback module routes，Host-private 状态走 private control。
- legacy dispatch envelope 的 `PAYLOAD_TOO_LARGE` / `INVALID_TRANSPORT_PAYLOAD` 只保留为历史测试/迁移证据，不是 Rust final-form active contract。
- Host private health/snapshot 与 Electron process-manager lifecycle 分层处理，不强行统一枚举。
- **旧 generic RuntimeJob public contract 已删除，不是待办：** 不存在 `runtimeHost.jobGet`、`runtime-job:*`、generic `RuntimeJob*` DTO 或 `job_compatibility`；文档中的这些名称只用于标识已删除项，禁止重新引入。
- **Toolchain final path 已冻结：** Setup 已退休；Renderer 进入主界面后 lazy 调 `hostToolchainPrepare()`，Electron `POST /api/toolchain/uv/prepare` 经 `toolchainTransport.prepare()` 调 modules/toolchain owner loopback，等待 `modules/toolchain::NativeToolchain` 真实结果后返回；`GET /api/toolchain/uv/check` 经 `toolchainTransport.status()` 并只投影 `{ installed }`。
- **ClawHub marketplace route 不变：** `POST /api/clawhub/search` 由 Rust external `ClawHubRegistryClient` 执行 registry HTTP search，不经 RuntimeDriver 或 OpenClaw Gateway；`POST /api/skills/clawhub/install` 仍经 Skills runtime ops，但底层执行 legacy ClawHub CLI + registry fallback。

## 当前迁移决定

- Renderer、Electron、preload 和页面 API **不因 Rust 移植而改动**。
- Rust 内部 **不建立跨 owner 的通用异步 operation queue、registry 或 compatibility projection**。
- 异步完成由具体 owner/facade 的 typed operation query/event 表达，详见 [async-projection.md](async-projection.md)。
- 新 Rust owner、crate、状态模型和切换顺序必须在本基线之上推导，不能从现有 `runtime-host-rust/` 目录反推契约。

## 完整性的边界

本基线已按所有进程边界和已注册 route 分类；它不把业务内部的每个 TS interface 再抄一遍。每个请求/响应的细粒度字段权威仍保留在对应 Renderer wrapper、route decoder 和 shared DTO 源码中，并由本目录给出入口和证据位置。

动态值如 `pid`、port、token、request ID、run ID、时间戳和 trace ID 在后续比对中必须归一化，不能作为字面 fixture 值冻结。
