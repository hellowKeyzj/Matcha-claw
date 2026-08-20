# Runtime Host Rust 终态架构设计 v2

> 本文是重新设计后的目标架构，不是当前半成品目录的解释，也不是 cutover 已完成声明。
>
> 目标只有一个：在不修改 Renderer、preload、Electron Host API、page/store 调用代码的前提下，让 Rust runtime-host 逐 owner 提供原有可观察行为。

## 1. 权威层级

```text
外部客户端契约
  -> docs/runtime-host-contract-v1/
事实 owner / 状态源
  -> docs/runtime-host-owner-model/
本目标架构
  -> 本文及其分解文档
Rust 代码命名与文件规模规范
  -> RUNTIME_HOST_TS_RUST_IMPLEMENTATION_STANDARD.md
迁移实时状态
  -> docs/architecture/runtime-host-ts-rust-migration-progress.md
```

外部契约固定“客户端能观察什么”；owner/state mapping 固定“事实由谁拥有”；本文才决定 Rust 的边界、地址空间、数据模型和切换顺序。任何一层都不能由当前半成品目录反推。

当前尚未取得 owner cutover 证明；本设计不授权删除旧 owner、修改客户端或启动双写。

## 2. 终态总图

```text
Renderer / page / store
        │ 既有 preload IPC 与 Host API，不改
        ▼
Electron Delivery
  - IPC / Host API / route ownership
  - main-owned routes / WebSocket proxy
  - Rust child process lifecycle
  - parent callback ingress / event bridge
        │ 既有 child contract
        │ /health /dispatch /lifecycle/* / parent callbacks
        ▼
Rust runtime-host Delivery Adapter
  - compatibility HTTP ingress
  - optional private framed control
  - optional trusted signed product transports
  - wire DTO decode / auth / error projection
        ▼
Host composition + admission + command serialization
  - 只组装 owner
  - 只串行化 Host command
  - 不拥有 Domain/native facts
        ├───────────────┬────────────────┬──────────────────┐
        ▼               ▼                ▼                  ▼
Environment       Fleet            Organization       Peer Integrations
独立管理 owner    独立管理 owner   Team/TeamRun owner  OpenClaw / Matcha
        │               │                │                  │
        └───────────────┴────────────────┴──────────────────┘
                        ▼
                 Native Runtime Edge
             Gateway / app-server / config /
             channel / cron / plugin / skill
```

### 两个必须分开的进程平面

```text
Electron -> Rust runtime-host child
  Electron 仍是桌面 parent，负责 Rust child 的启动、ready、停止、重启和桌面交付。

Rust runtime-host -> OpenClaw / matcha-agent peer child
  Rust Foundation 提供 process authority/supervision mechanism；
  各 Integration 提供 launch/readiness/graceful-stop/recovery policy；
  Host 只组合实例并决定跨 peer shutdown order。
```

不能用一个 lifecycle enum、一个 process manager 或一个 Host state 抹平这两个平面。

## 3. 设计裁决

### 3.1 外部 child contract 不改变

Rust child 必须提供现有 child 可观察 contract：

- `GET /health`；
- `POST /dispatch` v1 envelope；
- `POST /lifecycle/restart`、`POST /lifecycle/stop`；
- `/dispatch` 的 1 MB body limit、413 `PAYLOAD_TOO_LARGE`、合法 v1 response envelope；
- Electron → child `/dispatch` 默认 30s，health 最多 3s；
- child → Electron parent 的 shell/gateway/runtime-job callback、token、version、15s/3s timeout 和 best-effort 语义；
- CLI、Team webhook、Remote Fleet agent ingress、terminal WebSocket 等非 Renderer 入口。

`DirectRuntimeHost`、stdin/stdout framed control 和 signed loopback transports 可以作为 Rust 内部或 Electron Delivery 的实现 seam，但它们不是自动替代 `/dispatch` 的新 public contract。它们与旧 seam 的 active/替代关系必须在同一个 delivery owner block 中用 route matrix 和 unchanged-client trace 证明。

### 3.2 Host actor 不是业务事实 owner

Host actor 只负责：

- command admission；
- Host-level serialization；
- owner handle 调用；
- safe projection；
- shutdown/join order。

以下写入仍由各自 owner 完成：

- OpenClaw config/Gateway/channel/cron；
- Matcha app-server/session/run/transcript/event；
- Environment、Fleet、Organization durable facts；
- owner-local operation/task/receipt。

不得建立 Host-wide ledger、global fact store 或 Host-wide RuntimeJob owner。

### 3.3 Capability 是两套边界，不强行合并

```text
Renderer compatibility plane
  TS dynamic descriptor / RuntimeScope / CapabilityTarget
  /api/capabilities/list|describe|execute

Trusted Rust delivery plane
  Electron issuer / signed decision / fixed product transport
  endpoint + scope + capability + subject + expiry + replay
```

Rust signed decision verifier 已是安全 transport 机制，但不能据此宣称已经替代 TypeScript dynamic capability contract。`policyScope`、`ownerModuleId`、`routeOwnerId`、`bootstrap` scope 和 target/input binding 必须逐 route 裁决。

### 3.4 异步只保留兼容投影

内部删除：

```text
RuntimeJobQueue / RuntimeJobRegistry
critical/default/low global queue
generic retry/retention/result store
```

外部保留：

```text
RuntimeJobSnapshot-shaped projection
runtimeHost.jobGet
runtime-job:done
runtime-job:progress
```

真实 operation/task/run 属于具体 owner；旧 job id 只是一层兼容查询键。事件是 hint，`jobGet` 是恢复路径。

### 3.5 Foundation execution 机制保留

`foundation::execution` 是 runtime-host 已有的通用后台执行机制，供 Host、Domain 和 Integration 持有自己的异步工作：

```text
OwnedTask<T>
  -> TaskHandle（取消句柄）
  -> OperationHandle<T>（一次可 join 的业务 operation）
  -> ServiceHandle<T>（长生命周期 service）
```

它负责 cancellation、join 和 owned task 生命周期；它不负责业务事实、队列调度、优先级、通用重试、结果 retention、持久化、全局 job id 或 `runtime-job:*` projection。业务 owner 可以使用它，但必须自己定义 operation 的状态、错误、terminal oracle 和恢复语义。

因此：

```text
Foundation execution primitive != Host-wide RuntimeJobQueue
Foundation operation handle  != Domain fact owner
Foundation cancellation       != business terminal outcome
```

不得因为删除通用 RuntimeJob 架构而删除或遗漏这套底层执行机制；也不得把它扩展成新的全局任务事实源。

## 4. 不建立的东西

- `runtime-core`、`runtime-kernel`、`common`、`shared`、`utils`、`types` 垃圾桶 crate；
- 全局 `Session`、`Approval`、`Reconciliation`、`Storage`、`Facts`、`Secrets` crate；
- Host canonical transcript writer；
- Host 第二套 peer session/run/approval/tool/model/lifecycle owner；
- 一个跨所有领域的 desired/applied/observed 数据库；
- 一个把 Electron、Host、Gateway、peer 和 operation 合并的 lifecycle enum；
- ACP、Knowledge、Browser Flow 的空 crate；当前没有足够的 active consumer 证明。

Foundation 的 Windows Job Object、POSIX guardian/sentinel 等是机制候选，不是由外部契约直接冻结的产品架构假设。

## 5. 设计分解

- [边界与 Delivery](runtime-host-rust-architecture/01-boundaries.md)
- [Workspace、crate 与 module](runtime-host-rust-architecture/02-workspace.md)
- [数据结构与状态模型](runtime-host-rust-architecture/03-data-model.md)
- [owner cutover 顺序](runtime-host-rust-architecture/04-cutover.md)
- [未关闭的设计前置条件](runtime-host-rust-architecture/05-open-decisions.md)

## 6. 物理地址裁决

最终 Rust workspace 的目标根目录是 `runtime-host/`；历史 staging 目录 `runtime-host-rust/`（若存在）不是第二个最终 workspace，也不是 owner 依据。目录迁移、旧 TS 删除和 Electron package 接入必须作为同一 delivery/cutover 证据组完成，本文不在设计阶段执行这些动作。

目标 crate 地址只冻结语义地址，不要求现在预建空 crate。每个 crate 只有在真实 consumer、public contract、side effect、验证和 composition 能同一 owner block 闭合时才加入 workspace。
