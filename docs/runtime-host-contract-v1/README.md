# Runtime Host Contract Baseline v1

> Rust `runtime-host` 迁移的观察基线。它固定现有客户端可观察行为；仅本轮显式批准的 call-log/Calls 与具体 admit consumer 作为契约增量，不授权其他 Renderer、preload 或 Electron API 改动。

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
| 统一 call log 与原 owner 长操作怎样分工？ | [async-projection.md](async-projection.md) |
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
- **Toolchain final path 已冻结：** Setup 已退休；Renderer 进入主界面后 lazy 调 `prepareToolchain()`，Electron `POST /api/toolchain/uv/prepare` 经 `toolchainTransport.prepare()` 调 modules/toolchain 原 owner bounded queue，持久 accepted 后返回 202 `CallReceipt`；MainLayout warmup 只需接单，不等待安装终态。真实 prepare outcome 由 owner 写入 call-log typed detail，不等同 receipt；`GET /api/toolchain/uv/check` 仍经 `toolchainTransport.status()` 只投影 UV `{ installed }`。[VERIFY: runtime-host/modules/toolchain/src/api.rs:91-130] [VERIFY: runtime-host/modules/toolchain/src/adapters/loopback.rs:94-111] [VERIFY: electron/api/routes/toolchain.ts:16-35] [VERIFY: src/lib/toolchain.ts:1-7] [VERIFY: src/App.tsx:70-83]
- **ClawHub marketplace route 不变：** `POST /api/clawhub/search` 由 Rust external `ClawHubRegistryClient` 执行 registry HTTP search，不经 RuntimeDriver 或 OpenClaw Gateway；`POST /api/skills/clawhub/install` 仍经 Skills runtime ops，但底层执行 legacy ClawHub CLI + registry fallback。

## 当前迁移决定

- Renderer、Electron、preload 和页面 API **不因 Rust 移植任意改动**；本轮显式批准的 Calls 页面、查询/提示与具体 admit consumer 属于契约增量，不授权其他 API 重裁。
- Rust 内部 **不建立跨 owner 的通用执行 queue、registry 或 compatibility projection**；新增 `modules/call-log` 只持久化调用记录与 revision history，业务执行仍入原 owner queue。
- 已批准后台化由原八项扩展至 Provider discover、Connector probe/status/sessionStatus、Channel disconnect/logout、Cron create/update/delete（toggle→update）、Skills 配置/启停/批量/卸载/产物、Subagents 创建/更新/删除/配置/包安装/export/exportCloud、Team materialize/manual create/runDelete/delete、Wiki rescan/applyGeneratedPages/deleteSource/source-task.retry/source-task.resume、Runtime stop；这些公共长操作成功接单只返回 strict 202 `CallReceipt`，原 execution owner/queue 不迁入 CallLog。必要完整 payload 由具体模块有限、非消费 typed result 领取，不存入审计 detail；sealed cloud 包只走 Main 私有交接。Sessions 整块、team.runCreate 与条件候选不在此批；原 MCP/内部完成屏障保留 await。各模块接线与实际验证分开记录，详见 [async-projection.md](async-projection.md)。[VERIFY: runtime-host/modules/provider/src/api.rs] [VERIFY: runtime-host/modules/connectors/src/api.rs] [VERIFY: runtime-host/modules/skills/src/result.rs] [VERIFY: runtime-host/modules/subagents/src/application/results.rs] [VERIFY: runtime-host/modules/organization/src/call.rs] [VERIFY: runtime-host/modules/wiki/src/api.rs] [VERIFY: runtime-host/host/src/composition/peer/handle.rs]
- Main 六个长入口不迁入 Rust CallLog：完整 child restart 返回 restartId、读取同次状态；updater download 短返 accepted、沿原事件完成；Cloud package download/install preparation/agent upload/skill upload confirm 返回独立 operationId，通过 `/api/packages/operation-result` 领取闭合 typed result。包字节、授权 lease 与凭证不公开，native install/export 仍使用独立 CallReceipt。[VERIFY: electron/api/routes/runtime-host-process.ts] [VERIFY: electron/main/updater.ts] [VERIFY: electron/api/routes/packages.ts] [VERIFY: src/types/cloud-package-operation.ts]
- `platform::call` 字段、安全 detail、commit 后 `call.changed {callId, revision}` 与 original await/admit 分界见 [async-projection.md](async-projection.md)；当前真实覆盖与 PASS/FAIL/未测只维护于 [Call Log / Calls 唯一验收账](../architecture-knowledge/modules/call-log/dev.md#接线--验证-open)。[VERIFY: runtime-host/platform/src/call.rs:126-179] [VERIFY: runtime-host/modules/call-log/src/lib.rs:169-195]
- 新 Rust owner、crate、状态模型和切换顺序必须在本基线之上推导，不能从现有 `runtime-host-rust/` 目录反推契约。

## 完整性的边界

本基线已按所有进程边界和已注册 route 分类；它不把业务内部的每个 TS interface 再抄一遍。每个请求/响应的细粒度字段权威仍保留在对应 Renderer wrapper、route decoder 和 shared DTO 源码中，并由本目录给出入口和证据位置。

动态值如 `pid`、port、token、request ID、run ID、时间戳和 trace ID 在后续比对中必须归一化，不能作为字面 fixture 值冻结。
