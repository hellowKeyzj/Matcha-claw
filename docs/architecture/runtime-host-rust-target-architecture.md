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
        │ active child contract
        │ DirectRuntimeHost private control / signed loopback product routes / parent callbacks
        ▼
Rust runtime-host Delivery Adapter
  - private framed control
  - trusted signed product transports
  - installed module route DTO decode / auth / error projection
        ▼
Host composition + admission + command serialization
  - 只组装 owner
  - 只串行化 Host command
  - Root owner 只保留 lifecycle/state/shutdown/safe event/host-level join
  - product command 由 typed facades/owners 承接
  - 不拥有 Domain/native facts
        ├───────────────┬────────────────┬──────────────────┐
        ▼               ▼                ▼                  ▼
业务 owner modules  Fleet            Organization       Peer Integrations
provider/connectors 独立管理 owner   Team/TeamRun owner  OpenClaw / Matcha
settings/security
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

### 3.1 外部 child contract 已裁成 active delivery 面

Rust child 当前 active delivery contract 是：

- Electron `DirectRuntimeHost` 启动 Rust executable；
- stdin 写入一次 length-prefixed bootstrap；
- stdin/stdout private control framed wire 等待 `ready`，并只承载 Host-private command vocabulary；
- signed loopback product transports 调 installed module routes；
- Electron child process stop/restart 由 `DirectRuntimeHost` / `RuntimeHostLifecycleOwner` 管理；
- peer runtime stop/restart 使用 `/api/runtime-control/lifecycle/*` product routes；
- child → Electron parent 的 shell/gateway callback、token、version、15s/3s timeout 和 best-effort 语义；owner operation typed event 由具体 facade 定义；
- CLI、Team webhook、Remote Fleet agent ingress、terminal WebSocket 等非 Renderer 入口分别按所属 owner 验证。

旧 root `GET /health`、`POST /dispatch`、`POST /lifecycle/restart`、`POST /lifecycle/stop` compatibility island 已删除。Renderer/preload/Electron public API 仍不因该内部 delivery 裁剪而改变。

### 3.2 Root owner 不是业务 command/fact owner

Root owner 只保留：

- lifecycle/state；
- safe event projection；
- shutdown；
- host-level join。

Host composition 负责 command admission 与 Host-level serialization；product transport/control 不调用 Root owner product command，业务入口由 typed facades/owners 承接。

以下写入仍由各自 owner 完成：

- OpenClaw config/Gateway/channel/cron；
- Matcha app-server/session/run/transcript/event；
- `modules/provider`、`modules/connectors`、`modules/settings`、`modules/security` 各自的 durable stores，以及 Fleet、Organization facts；
- owner-local operation/task/receipt；
- sealed skill package 由 `runtime-host` host-level concrete owner/facade 管理；OpenClaw 与 matcha-agent 只消费已授权投影或 package artifact，不拥有该包事实。

对 OpenClaw native 配置，`openclaw.json` 只记录 `skills.<key>.enabled` 开关；明文 skill package material 不进入该文件。加密 package material 可落在 `runtime-local` owner-local 目录；需要修改 OpenClaw 源码行为时通过 bundle patch 投递。

不得建立 Host-wide ledger、global fact store 或 Host-wide generic operation owner。无消费者的旧 `domains/environment` 聚合模型退役，不建立 `modules/environment`，不把旧 revision/grant/reconciliation 声称为业务模块新增能力；OpenClaw 安装环境与 Fleet environment 生命周期不受影响。

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

### 3.4 异步使用 owner-local operation

内部已删除（仅作审计清单，不是现行组件）：

```text
RuntimeJobQueue / RuntimeJobRegistry
critical/default/low global queue
generic retry/retention/result store
```

外部已删除（仅作审计清单，不是现行 contract）：

```text
RuntimeJobSnapshot-shaped projection
generic RuntimeJob* public DTO
runtimeHost.jobGet
runtime-job:done
runtime-job:progress
job_compatibility
```

以上名称只用于说明本轮已经删除的旧 public/internal 面；它们不是当前 authority、route、DTO、事件或待办。

真实 operation/task/run 属于具体 owner；提交后是否等待真实业务结果由 owner 语义决定。Toolchain prepare 属于必须等待真实结果的调用：Renderer 进入主界面后 lazy 调 `hostToolchainPrepare()`，Electron `POST /api/toolchain/uv/prepare` 经 `toolchainTransport.prepare()` 调 modules/toolchain owner loopback，等待 `runtime-host/modules/toolchain::NativeToolchain` native result 后只返回 public outcome。其他只需要提交成功即可继续的慢操作返回 owner-local operationId，并通过该 owner/facade 的 typed query/event 观察完成、失败、进度和 unknown。

### 3.5 Module platform contract 已落地

Rust platform 当前用 `ModuleDescriptor` 声明 module id、provides/requires/effects 与可选 loopback descriptor；`ModuleCatalog` 同时提供 capability dependency 校验和 scoped effect registration 校验能力：`validate_effects()` 会拒绝 unknown module、未声明 effect 与缺失 scoped effect，可选 loopback descriptor 会自动计入该 module 的 scoped `Route` registration。[VERIFY: runtime-host/platform/src/module.rs:31-99] [VERIFY: runtime-host/platform/src/module.rs:141-204] [VERIFY: runtime-host/platform/src/module.rs:239-304]

当前 Host composition 收集 Foundation `ModuleScope` registrations，`module_registry/install` 调用 `ModuleCatalog::install_with_capabilities_and_effects()` 安装 modules，并输出 installed route registry、private-control snapshot 与 capability catalog projection；loopback router 只消费 installed route descriptors。legacy compatibility module 已删除，不在 router 或 module registry 中保留 root endpoint；Organization/Team、Sessions、Fleet 等业务 HTTP/SSE/WS 入口由各自 module descriptor 注册。普通模块不拥有 Host transport/listener，也不能把 route descriptor 反推为通用 Host registry。[VERIFY: runtime-host/host/src/module_registry/install.rs] [VERIFY: runtime-host/host/src/http/router.rs] [VERIFY: runtime-host/modules/organization/src/adapters/loopback/mod.rs:50-58] [VERIFY: runtime-host/modules/fleet/src/lib.rs:63-74] [VERIFY: runtime-host/modules/fleet/src/adapters/loopback/mod.rs:61-69] [VERIFY: runtime-host/modules/sessions/src/adapters/loopback/mod.rs:73-85]

Platform loopback outcome 类型是 `Response`、`Stream`、`Upgrade`；Host 统一 loopback server 直接写回该 outcome，Session events 走 stream，Remote Fleet terminal 走 Fleet module route upgrade。统一 listener 自身作为 Host HTTP extension scope 管理，不归普通模块所有。[VERIFY: runtime-host/platform/src/loopback.rs:152-218] [VERIFY: runtime-host/host/src/http/server.rs:20-40] [VERIFY: runtime-host/host/src/http/server.rs:83-104] [VERIFY: runtime-host/modules/fleet/src/adapters/loopback/mod.rs:120-164] Foundation `ModuleScope` 是运行期 mechanism：注册 disposer/owned task/process/listener/runtime endpoint 并 LIFO dispose，`EffectGuard` 仅保存 scope/effect id；它向 Platform catalog 提供 scoped registration 事实，但不替代 Platform descriptor/effect 契约。[VERIFY: runtime-host/foundation/src/lifecycle.rs:9-74] [VERIFY: runtime-host/foundation/src/lifecycle.rs:131-214] [VERIFY: runtime-host/host/src/composition/host/owner_runtime.rs:55-107]

### 3.6 Foundation execution 机制保留

`foundation::execution` 是 runtime-host 已有的通用后台执行机制，供 Host、Domain 和 Integration 持有自己的异步工作：

```text
OwnedTask<T>
  -> TaskHandle（取消句柄）
  -> OperationHandle<T>（一次可 join 的业务 operation）
  -> ServiceHandle<T>（长生命周期 service）
```

它负责 cancellation、join 和 owned task 生命周期；它不负责业务事实、队列调度、优先级、通用重试、结果 retention、持久化、全局 generic operation id 或 owner operation projection。业务 owner 可以使用它，但必须自己定义 operation 的状态、错误、terminal oracle 和恢复语义。

因此：

```text
Foundation execution primitive != deleted Host-wide generic operation queue
Foundation operation handle  != Domain fact owner
Foundation cancellation       != business terminal outcome
```

不得因为删除通用 operation model 而删除或遗漏这套底层执行机制；也不得把它扩展成新的全局任务事实源。

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

第三方、非业务、非 peer runtime 的 capability 放在 `runtime-host/external/`；例如 ClawHub registry/CLI client 属于 `external/clawhub`，不归 `domains` 或 `integrations`。
