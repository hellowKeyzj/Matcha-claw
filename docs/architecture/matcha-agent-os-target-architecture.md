# Matcha 最终架构目标 v1

这版不是从当前业务目录推出来的，而是按你确认的系统原则收敛：

```text
Matcha = local-first Agent OS / Control Plane

不是：
- 又一个 LLM Tool Runtime
- OpenClaw / Claude Code 的替代品
- 把所有能力都塞进一个万能 Kernel
- 让 Electron 永远管理核心运行时
```

它的目标是：**长期管理、组织、编排、观察、迁移多个 peer Agent Runtime。**

---

## 1. 最终进程拓扑

```text
┌──────────────────────────────────────┐
│ Electron / CLI / Web / 自动化客户端   │
│                                      │
│ 只通过 Command / Query / Event API   │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ Rust Matcha Runtime Daemon            │
│                                      │
│ - Matcha 的唯一控制面                │
│ - Agent / Endpoint / Execution owner │
│ - Module composition                 │
│ - Canonical facts / projections       │
│ - 本地 Runtime 进程生命周期           │
└──────────────┬───────────────────────┘
               │
      ┌────────┴───────────────┐
      ▼                        ▼
┌───────────────┐      ┌──────────────────┐
│ Local Runtime │      │ Remote Node Host │
│ Process Host  │      │ 轻量 Rust agent  │
│               │      │                  │
│ OpenClaw      │      │ OpenClaw         │
│ matcha-agent  │      │ matcha-agent     │
│ future native │      │ future native    │
└───────────────┘      └──────────────────┘
```

最终责任：

| 层 | 拥有什么 |
|---|---|
| Electron | UI、窗口、系统桌面集成、Runtime API 客户端 |
| Rust Matcha Runtime | Agent、Endpoint、Execution、模块、状态、事件、调度决策、所有纳管 Runtime 的生命周期策略 |
| Local Process Host | Rust Runtime 内部的本机 PID / spawn / restart / log / shutdown 实现 |
| Remote Node Host | 远端机器上的 PID、日志、健康检查、进程树操作；执行中心 Runtime 下发的 desired state |
| OpenClaw / matcha-agent | 自己的 LLM loop、tool harness、sandbox、tool policy、内部 approval、provider/MCP 执行 |

关键点：

```text
Rust 最终拥有“是否应运行、何时重启、如何观察”的生命周期控制权。

Node Host 拥有远端机器上的物理 PID。

OpenClaw / matcha-agent 仍拥有自己内部的模型和工具执行权。
```

因此不会出现：

```text
Electron 管一半 PID
Rust 管另一半 PID
OpenClaw 又自行重启一部分进程
```

这种多 owner 结构。

---

# 2. 真正的核心不是很多“子系统”，而是三个不可替代核心

## A. Runtime Directory：运行时拓扑核心

它不理解 OpenClaw 的内部结构，也不理解 Claude SDK。

它只管理 Matcha 视角的运行时拓扑：

```text
AgentId
RuntimeEndpointId
AgentRuntimeBinding
RuntimeEndpointDefinition
RuntimeEndpointObservation
```

核心关系：

```text
Agent
≠ RuntimeEndpoint

Agent
= 长期身份、职责、配置、业务归属

RuntimeEndpoint
= 这个 Agent 当前在哪个 Runtime / 哪台机器 / 哪种协议上运行
```

例如：

```text
researcher Agent
→ 当前绑定本机 OpenClaw Endpoint

以后可切到：
→ 家里服务器的 OpenClaw Endpoint
→ Remote Node Host 上的 matcha-agent Endpoint
→ 未来 Matcha Native Runtime Endpoint
```

Agent 不因此变成新 Agent。

### Endpoint 必须分成两类状态

```rust
RuntimeEndpointDefinition {
    endpoint_id,
    runtime_kind,
    connection_config_ref,
    assigned_agents,
    desired_lifecycle,
}
```

这是长期配置：用户希望它存在、希望它运行在哪里。

```rust
RuntimeEndpointObservation {
    endpoint_id,
    health,
    capabilities,
    active_executions,
    last_seen_at,
}
```

这是实时观察：它此刻是否在线、健康、可否接受执行。

因此：

```text
远端机器关机
≠ 删除 Endpoint
≠ 删除 Agent
≠ 清空历史

只是：
endpoint.health = unavailable
```

这是 Runtime Directory 的硬模型，不是某个业务功能。

---

## B. Execution Kernel：长期执行与正式事实核心

`ExecutionRecord` 是内核原语，但不是父类继承体系。

```rust
ExecutionRecord {
    execution_id,
    owner,
    target,
    kind,
    status,
    started_at,
    terminal_outcome,
}
```

业务模型通过 `executionId` 关联它：

```rust
AgentTurn {
    turn_id,
    session_id,
    execution_id,
    // Agent turn 自己的语义
}

TeamNodeAttempt {
    attempt_id,
    team_run_id,
    execution_id,
    // TeamRun graph 自己的语义
}

RemoteCommand {
    command_id,
    endpoint_id,
    execution_id,
    // Remote ACK 自己的语义
}
```

不是：

```text
所有业务继承一个万能 Execution 父类
```

而是：

```text
所有长期执行都可统一：
- observe
- cancel
- wait
- terminal outcome
- event subscription
- supervisor ownership
```

但各业务仍拥有自己的状态机：

| 模块 | 自己拥有的语义 |
|---|---|
| Agent / Session | turn、message、stream、runtime approval |
| TeamRun | graph、node attempt、ledger、scheduler |
| Remote Fleet | command、ACK、lease、reconcile |
| Browser Flow | flow、page archive、step、verification |
| Skill | skill invocation、artifact、result |

## C. Process / Node Lifecycle Core：运行位置与进程生命周期核心

这是 Rust 最终接管的部分。

本机：

```text
Rust Runtime
→ spawn / attach / readiness / restart / backoff
→ log stream / process tree cleanup / shutdown drain
→ OpenClaw / matcha-agent / future local runtime
```

远端：

```text
Rust Runtime
→ Node Host protocol
→ Remote Node Host
→ spawn / PID / log / health / kill
→ Remote OpenClaw / matcha-agent
```

远端 Node Host 的规则已确定：

```text
- 只管理已经纳管的 Endpoint；
- 持有最后一份 desired state；
- 断线期间可维持或重启已纳管 Runtime；
- 不自行创建 Agent；
- 不自行发起 TeamRun；
- 不自行改 Agent/Endpoint 配置；
- 重连后只回报 observation、log、lifecycle facts。
```

所以系统始终只有一个逻辑控制面，不会演化为多个失控的独立 Runtime 中心。

---

# 3. Kernel 下面的基础设施，不应被误叫成业务子系统

这些是 Runtime 的基础能力，不是 TeamRun、Memory、Browser 等功能。

| 基础设施 | 最终职责 |
|---|---|
| Storage Kernel | 多 backend、数据 owner、迁移、备份、恢复、私密边界 |
| Canonical Event Kernel | 正式状态事实的追加、cursor、投影、补读 |
| Runtime Supervisor | 所有后台 worker/task 的启动、取消、健康、重启、drain |
| Static Module System | 第一方模块的 imports/exports/storage/worker owner 验证 |
| Public API Boundary | Command / Query / Event Subscription |
| Composition Root | 唯一同时看见所有模块并完成装配的位置 |

这里不再有之前错误的：

```text
Matcha Capability Gateway 接管所有 Runtime 内部工具
```

那会让 Matcha 变成另一个 OpenClaw，违背你要的 peer-runtime 架构。

---

# 4. 外部 Runtime 的正确位置：Peer Runtime，不是被 Matcha 接管的工具引擎

最终 Runtime Adapter 的最小方向：

```text
Matcha Service
→ RuntimeExecutionPort
→ Runtime Adapter
→ OpenClaw / matcha-agent 已有 API、session、event stream
```

例如 TeamRun 只会依赖：

```rust
trait RuntimeExecutionPort {
    async fn start_execution(&self, request: StartExecutionRequest)
        -> Result<RuntimeAccepted, RuntimeError>;

    async fn cancel_execution(&self, request: CancelExecutionRequest)
        -> Result<(), RuntimeError>;
}
```

它不会 import：

```text
OpenClaw SDK
Claude Code SDK
matcha-agent QueryEngine
浏览器实现
MCP client
```

各 Adapter 的职责是：

```text
1. 调用该 Runtime 原本支持的 API；
2. 接收该 Runtime 原本公开的 event / state；
3. 翻译为 Matcha Canonical Fact；
4. 保留 raw payload 作为调试附件；
5. 诚实暴露 Runtime 实际能力与限制。
```

不要求修改 OpenClaw、Claude Code 或第三方 Runtime 来适配 Matcha。

如果外部 Runtime 不支持某种恢复、状态查询或去重语义：

```text
Matcha 不伪造它支持。
```

只能如实表达：

```text
submitted
observed running
connection lost
outcome unknown
observed completed
```

这比虚构“exactly once”可靠得多。

---

# 5. Runtime 内部工具权限与 Matcha 平台彻底分层

必须永久区分：

```text
OpenClaw / matcha-agent harness
= tool visibility
= MCP/tool policy
= sandbox
= runtime 内部 approval
= provider/tool 执行

Matcha Runtime
= Agent / Endpoint / Execution / TeamRun 等控制面
= 统一展示和转发 Runtime 上报的 approval
= 不重新决定 Runtime 内部工具是否允许执行
```

审批链最终应是：

```text
Runtime 内部判断需要 approval
→ Adapter 映射 RuntimeApprovalRequested
→ Matcha UI / CLI 统一展示
→ 用户决定
→ Matcha 将决定回传给同一 Runtime
→ Runtime 自己决定是否执行
```

Matcha 统一体验，但不夺走 Runtime harness 所有权。

---

# 6. Canonical Facts、Raw Archive、Telemetry 必须分开

一次执行中：

```text
ExecutionAccepted
ExecutionRunning
MessageProduced
RuntimeApprovalRequested
ExecutionCompleted
ExecutionInterrupted
```

这些是 **Canonical Facts**：

```text
- 会影响正式状态；
- Electron/CLI/Web 重连后必须补读；
- TeamRun 可依赖；
- Projection 可据此重建；
- 会影响恢复和后续调度。
```

而：

```text
token delta
SDK raw payload
SSE reconnect
HTTP trace
adapter debug log
task duration
```

这些是：

```text
Telemetry / Log / Raw Archive
```

它们可以保存、检索、导出，但不能直接驱动正式业务状态。

最终数据关系：

```text
External Runtime event
→ Adapter
  ├─ Canonical Fact Event
  │  → Execution / Session / TeamRun 等正式投影
  │
  └─ Raw Runtime Payload
     → 调试、适配器升级、问题追溯
```

这就是“统一模型”与“不丢失 Runtime 私有证据”同时成立的方式。

---

# 7. Storage Kernel：统一规则，不统一 SQLite

已确认：

```text
Storage Kernel
≠ 所有数据进入 SQLite
≠ 所有模块共享万能 Entity JSON 表
```

正确模型：

| 数据类型 | 合适 backend |
|---|---|
| 人会编辑、希望版本管理的配置 | JSON / TOML / YAML / 文件 |
| 原始 transcript、runtime raw archive | JSONL / 分段文件 archive |
| Execution、审批、队列、lease、索引、事务状态 | SQLite 或其他 transactional store |
| artifact、截图、文件、大 payload | filesystem / blob store |
| secret | OS keychain / 私有 secret resolver |

任何模块只要保存数据，必须声明：

```text
canonical owner
backend
是否允许人编辑
并发写入规则
版本与迁移规则
备份与恢复规则
公开 Projection / Port
```

严格禁止：

```text
TeamRun 直接读写 Remote Fleet 的表、JSONL 或文件
Browser Flow 直接改 Session 的状态
Adapter 直接篡改别的 Service 的私有存储
```

跨模块只能：

```text
调用公开 Port
或读取公开 Projection
```

---

# 8. 第一方模块模型：静态模块 + Manifest

最终第一方能力不是动态 native plugin。

```text
TeamRun
Browser Flow
Remote Fleet
Skill Runtime
Memory
Session
Agent Registry
未来其他 Service
```

都应是独立 Rust 模块；稳定后可以拆成独立 crate。

`crate` 只是 Rust 的编译/依赖包边界，类似一个带独立公开 API 和 `Cargo.toml` 的 Rust 库，不是运行时进程或插件。

每个模块提供 `ModuleManifest`：

```rust
ModuleManifest {
    id: "team-run",
    imports: [
        "execution.port",
        "runtime-directory.port",
    ],
    exports: [
        "team-run.port",
        "team-run.events",
    ],
    storage: [
        "team_run",
    ],
    background_workers: [
        "team-cron",
    ],
}
```

Composition Root 是唯一全局装配点，它验证：

```text
- import 是否有 export；
- 是否有依赖环；
- storage 是否存在双 owner；
- worker 是否有 owner；
- module 是否越权注册 API/后台任务。
```

这将当前 `RuntimeHostModuleManifest` 的雏形提升为最终静态模块系统。

严格区分：

```text
Matcha First-party Module
≠ OpenClaw plugin package
≠ MCP server
≠ Skill
≠ 第三方 native plugin
```

第三方未来走：

```text
版本化协议
MCP
或真正需要隔离时再引入 WIT/WASM
```

不是现在就冻结动态 ABI。

---

# 9. 模块通信规则

已确认：

```text
需要立即得到“受理 / 拒绝 / 当前读取结果”
→ Typed Port

已经发生、需要被 UI / 日志 / 投影 / 其他模块观察
→ Canonical Event
```

例如：

```rust
let accepted = runtime_execution.start(request).await?;
```

随后：

```text
ExecutionAccepted
ExecutionRunning
MessageProduced
ExecutionCompleted
```

是事件。

不能反过来：

```text
所有事情都 Event Bus 化
```

也不能：

```text
Service A import Service B 的具体实现，
然后直接读写其私有状态。
```

事件订阅者若想改变发布者状态，必须再次调用发布者公开的 Command/Port。

---

# 10. 后台任务规则

所有长期后台任务都必须受 Rust Runtime Supervisor 监管：

```text
TeamRun cron
Remote Node heartbeat
Runtime event consumer
延迟重试
连接维护
未来 Browser Flow 等待/恢复
Service Execution
```

每个任务都必须具备：

```text
owner module
executionId 或 workerId
cancellation path
health / liveness
restart policy
shutdown drain
```

禁止：

```rust
tokio::spawn(async move {
    // 没有 owner、不能取消、不能等待、不能解释
});
```

业务语义仍属于各 Service：

```text
TeamRun 决定 cron 到点后“做什么”
Supervisor 只负责任务是否可控、可停、可重启、可清理
```

---

# 11. 对外公共 API：Command / Query / Event 三分

Electron、CLI、Web、自动化脚本以后都是平等客户端。

```text
Command API
= 改正式状态
= create agent / start execution / cancel / modify TeamRun

Query API
= 读公开 Projection
= execution 状态 / endpoint 健康 / team graph / agent list

Event Subscription API
= 订阅 Canonical Facts
= cursor 补读
= 不作为写入入口
```

这不限制使用 HTTP、RPC、WebSocket、SSE 或 Unix socket。

```text
Transport
= 怎么传

Command / Query / Event
= 这次调用在语义上是什么
```

Electron 最终不能再：

```text
直接改 Runtime 数据文件
直接成为状态事实源
直接拥有 Runtime PID
```

---

# 12. 最终依赖方向

```text
┌──────────────────────────┐
│ Composition Root          │
│ 唯一看见所有模块          │
└──────┬─────────────┬─────┘
       │             │
       ▼             ▼
┌────────────┐  ┌───────────────┐
│ Services   │  │ Adapters       │
│ TeamRun    │  │ OpenClaw       │
│ Browser    │  │ matcha-agent   │
│ Fleet      │  │ Node Host      │
│ Skill      │  │ future runtime │
└─────┬──────┘  └──────┬────────┘
      │                │
      ▼                ▼
┌─────────────────────────────┐
│ Kernel / Substrate           │
│ Execution / Directory        │
│ Storage / Event / Supervisor │
│ Module contracts / API types │
└─────────────────────────────┘
```

硬规则：

```text
Kernel
不依赖 TeamRun、Browser Flow、OpenClaw、matcha-agent。

Service
只依赖 Kernel Ports、Kernel Types、其他 Service 的公开 Port。

Adapter
实现 Port，可依赖外部 SDK、协议和进程实现。

Composition Root
唯一同时依赖所有模块并完成注入、注册、验证。
```

---

# 13. 明确不做的事

这版最终架构明确排除：

```text
- 不把 TeamRun 变成所有业务的万能流程引擎；
- 不把 Matcha 变成统一 LLM tool harness；
- 不把 OpenClaw plugin 当作 Matcha Kernel module；
- 不要求改 OpenClaw / Claude Code 才能接入；
- 不伪造外部 Runtime 不具备的恢复/可靠性；
- 不把所有状态做 Event Sourcing；
- 不把所有数据塞 SQLite；
- 不把所有模块通信做 Event Bus；
- 不让每个 Service 自己随意 spawn 后台任务；
- 不让 Electron 与 Rust 双写进程生命周期；
- 不现在引入 Workspace/RBAC/Memory 细节来污染 Kernel。
```

---

# 14. 为什么这套底座能适配未知业务

未来新增一个业务，不需要修改 Kernel 的业务语义。

例如新增：

```text
Browser Flow
```

它只需要：

```text
1. 独立 ModuleManifest；
2. 自己拥有 page archive / flow / step state；
3. 使用 Storage Kernel；
4. 创建 ExecutionRecord；
5. 调用 RuntimeExecutionPort 或自己的公开 Port；
6. 发布 Canonical Facts；
7. 把长期 worker 注册到 Supervisor；
8. 暴露 Command / Query / Event Projection。
```

它不需要：

```text
修改 TeamRun graph；
修改 OpenClaw adapter；
修改 Electron；
修改 Kernel 的业务模型；
直接读写其他模块数据库。
```

这才是“业务由架构衍生”：

```text
新功能不是往核心塞概念，
而是在稳定原语上形成独立、可组合、可替换的 Service。
```
