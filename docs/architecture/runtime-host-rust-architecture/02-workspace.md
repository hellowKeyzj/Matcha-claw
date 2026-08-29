# 02. Workspace、crate 与 module

## 1. 目标 workspace

```text
runtime-host/
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── foundation/
├── platform/
├── domains/
│   ├── environment/
│   ├── fleet/
│   └── organization/
├── external/
│   └── clawhub/
├── integrations/
│   ├── matcha-agent/
│   └── openclaw/
└── host/
```

这是最终地址空间，不是要求一次性创建所有目录。`integrations/acp/` 保持 candidate，直到出现真实 active consumer、protocol contract、Foundation consumer、Host composition 和独立 oracle。

## 2. Foundation

```text
foundation/src/
├── lib.rs
├── execution/
│   ├── mod.rs
│   ├── task.rs       # OwnedTask、TaskHandle
│   ├── operation.rs  # OperationHandle<T>
│   └── service.rs    # ServiceHandle<T>
└── process/
    ├── mod.rs
    ├── authority.rs
    ├── launch.rs
    ├── observation.rs
    ├── termination.rs
    ├── supervision/
    └── system/
        ├── windows.rs
        └── posix/
```

Foundation 有两类互补机制：

- `execution` 提供业务可以持有的 in-process 后台 operation/service 生命周期，包括 cancellation、join 和 owned task；
- `process` 提供与具体 Runtime 无关的 process identity、provenance、authority observation、termination、supervision 和 platform adapter。

`execution` 不拥有业务状态，也不承担已删除的 Host-wide generic operation queue：不提供跨业务 priority、retry、retention、持久化 operation registry 或结果事实。具体 owner 使用 `OperationHandle<T>` / `ServiceHandle<T>` 后，仍须自己定义 operation 状态、错误、终态和恢复。

不放：产品配置、peer protocol、Domain facts、已删除的 Host-wide generic operation queue、全局 storage/secrets、Host composition。具体 Windows/POSIX custody mechanism 是实现候选，不反向决定 child API。

## 3. Platform

```text
platform/src/
├── lib.rs
├── identity/
│   ├── endpoint.rs
│   ├── session.rs
│   ├── run.rs
│   └── ids.rs
├── exchange/
│   ├── command.rs
│   ├── correlation.rs
│   ├── receipt.rs
│   └── outcome.rs
├── observation/
│   ├── state_plane.rs
│   ├── freshness.rs
│   └── epoch.rs
├── event/
│   ├── envelope.rs
│   └── cursor.rs
├── authorization/
│   └── decision.rs
└── trust/
    ├── listener_identity.rs
    └── pinned_tls.rs
```

Platform 是中性语言和校验工具，不是状态数据库。它不拥有 Session transcript、Approval、Lease、Reconciliation、generic operation 或 Domain state；也不定义 TS capability operation catalog。

只有被两个以上真实 consumer 使用的 contract 才上升为 Platform。单一 Integration 的 wire model 留在 Integration。

## 4. Domain crates

### Environment

```text
domains/environment/src/
├── lib.rs
├── definition/
├── connector/
├── provider/
├── settings/
├── security/
├── license/
├── toolchain/
├── ports/
├── reconcile/
└── store/
```

这些是 Environment 下的**独立 owner**，不是一个 `EnvironmentState`。每个子 owner 自己决定 desired/persisted/applied/observed、secret projection、apply/readback 和 recovery。若某个子域尚无 Rust consumer，只冻结语义地址，不创建空实现。

### Fleet

```text
domains/fleet/src/
├── lib.rs
├── topology/
├── target/
├── lease/
├── command/
├── reconcile/
├── ingress/
├── terminal/
├── audit/
├── ports/
└── store/
```

已证明的 endpoint identity、capacity lease、durable command/reconcile 属于 Fleet。remote executor、terminal、runtime-agent ingress、artifact 和 webhook 必须拥有各自 evidence；不能从“Fleet”名称推导能力。

### Organization

```text
domains/organization/src/
├── lib.rs
├── team/
├── run/
│   ├── graph/
│   ├── attempt/
│   ├── delivery/
│   ├── approval/
│   ├── evidence/
│   ├── trigger/
│   └── recovery/
├── ports/
└── store/
```

Organization 拥有 Team/TeamRun graph、attempt、delivery、approval、evidence、trigger、materialization ledger。它不依赖 OpenClaw 或 Matcha；具体 effect 通过 typed port 在 Host composition 注入。没有证据时，不让 `organization -> matcha-agent` 成为编译依赖。

## 5. External crates

### clawhub

```text
external/clawhub/src/
├── lib.rs
├── registry.rs
└── installer.rs
```

`clawhub` 只封装第三方 ClawHub registry 和 legacy CLI：registry base/token、HTTP catalog/search、CLI install registry fallback。它不拥有 durable product facts，不是 peer runtime，也不放进 Domain/Integration。

## 6. Integration crates

### matcha-agent

```text
integrations/matcha-agent/src/
├── lib.rs
├── lifecycle/
│   ├── launch.rs
│   ├── readiness.rs
│   ├── recovery.rs
│   └── shutdown.rs
├── protocol/
├── peer/
└── session/
    ├── client/
    ├── hydration/
    ├── events.rs
    ├── approval.rs
    └── receipt.rs
```

拥有 app-server protocol、peer lifecycle、native session/run/approval/event readback 和安全 projection。不得写 legacy transcript JSONL，不得拥有 Host canonical UI state，不得拥有 TeamRun ledger。

### openclaw

```text
integrations/openclaw/src/
├── lib.rs
├── lifecycle/
├── gateway/
├── session/
├── config/
├── projection/
│   ├── channel/
│   ├── connector/
│   ├── provider/
│   ├── security/
│   ├── settings/
│   └── organization/
├── cron/
├── skill/
├── workspace/
└── ports.rs
```

拥有 OpenClaw/Gateway native protocol、channel/cron/pairing/session facts、private config projection 和 native readback。Environment/Organization port 只能描述 effect；OpenClaw 不成为它们的 durable fact owner。

## 7. Host crate

```text
host/src/
├── main.rs
├── lib.rs
├── bootstrap/
├── composition/
│   ├── peers.rs
│   ├── domains.rs
│   └── shutdown.rs
├── owner/
├── control/
├── transport/
│   ├── compatibility/
│   │   ├── health.rs
│   │   ├── dispatch.rs
│   │   └── lifecycle.rs
│   ├── parent_callbacks.rs
│   ├── trusted/
│   ├── external_ingress/
│   ├── websocket.rs
│   └── authorization.rs
└── diagnostics/
```

Host 只做 composition、admission、command serialization、delivery adapter、safe projection、diagnostics 和 shutdown order。业务 owner 不再以 `host/src/session_*.rs`、`host/src/cron.rs`、`host/src/provider_*.rs` 形式散落在 Host；它们应归 Integration/Domain，Host 仅保留 typed transport adapter。

`projection/session.rs` 是可重建的 client projection，不是 transcript/native event authority；异步 operation projection 属于具体 owner/facade，不存在已删除的 Host-wide generic operation compatibility module。

## 8. 依赖 DAG

```text
foundation       platform       external/clawhub
    ▲               ▲                 ▲
    │               │                 │
environment       fleet       organization
    ▲               ▲              ▲
    │               │              │
    └───────────────┴──────┬───────┘
                           │ typed ports only
                    openclaw / matcha-agent
                           │
                           ▼
                      host composition
```

编译依赖规则：

- Foundation 不依赖上层；Platform 不依赖 Domain/Integration/Host；
- Domain 不依赖 Host 或具体 peer；
- External 不依赖 Domain、Integration 或 Host；第三方 HTTP/CLI client 只在 Host composition 注入；
- Integration 可依赖 Platform、Foundation，以及它实际实现的 Domain public port；
- Integration 之间不互相依赖；
- Host 可以依赖所有已落地 crate；
- `organization -> matcha-agent` 不因 TeamRun 概念存在而自动允许；没有真实 port consumer 就由 Host 注入 adapter；
- 不建立 alias crate、shared crate、generic runtime registry。

## 9. Foundation execution 的使用边界

业务 owner 可以直接使用 `foundation::execution::{OwnedTask, TaskHandle, OperationHandle, ServiceHandle}` 管理后台 operation：

```text
owner command
  -> OperationHandle<T> / ServiceHandle<T>
  -> owner-defined state and terminal outcome
  -> explicit cancel/join during shutdown
```

这些类型只管理 task 的 cancellation、join 和资源生命周期，不生成全局 generic operation id、不保存业务结果、不调度跨领域队列，也不替代 Domain/native owner 的 terminal oracle。需要对外暴露异步完成时，由具体 owner/facade 定义 typed operation query/event。

## 10. 文件与模块规范

目录名必须表示 owner；模块内聚表达一组共同生命周期/协议/状态转换。禁止 `common`、`utils`、`helpers`、`types` 垃圾桶和机械“一种 type 一个文件”。文件规模按职责判断，不用固定数字强制拆分；大文件应检查责任是否漂移，但内聚且单一责任的文件可以保留。
