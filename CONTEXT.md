# MatchaClaw

MatchaClaw 是本仓库中的桌面应用。它集成 OpenClaw 作为 agent runtime substrate，并在桌面壳内托管本地 runtime 能力。

## Language

**MatchaClaw**:
本仓库中的桌面应用与产品。
_Avoid_: OpenClaw desktop

**OpenClaw**:
MatchaClaw 集成并适配的 agent runtime substrate。
_Avoid_: MatchaClaw runtime

**Host API**:
Renderer 与桌面应用之间稳定且必须保持功能等价的产品 API contract；runtime-host owner 迁移不得删除、重命名或改变既有 route、IPC channel、DTO、event、error semantics 或产品功能。旧 TypeScript owner 可以被等价 Rust owner 替换，但 Host API 仍由 Electron Main 适配到新的 runtime-host。Host API 只投影公开 capability/DTO，不等同于 Rust internal control protocol，也不允许内部 command 自动穿透为 Renderer API。
_Avoid_: runtime-host internal protocol, renderer-to-Rust API, deleting a legacy API because its new owner is incomplete

**runtime-host**:
由 MatchaClaw 拥有的本地常驻 runtime process。
_Avoid_: backend service, server

**Runtime Endpoint**:
一个可被 Matcha 寻址、观察并调用能力的具体 Runtime 实例，统一覆盖本地和远端 Runtime；Endpoint identity 回答“连接哪个实例”，Runtime Integration binding 回答“如何连接”，连接方式变化不改变 Endpoint identity。每个 Endpoint 只声明当前实例真实支持的 capability，不能从 Runtime 类型推断全部能力。
_Avoid_: Fleet endpoint record, Runtime type, protocol identity, connector identity, process ID, type-level capability assumption

**Supported Capability**:
Endpoint 按当前 Runtime 版本、配置与 discovery 真实支持的能力；Endpoint 暂时离线不会移除该声明。
_Avoid_: Runtime kind assumption, current availability

**Capability Availability**:
Supported Capability 当前是否可调用的动态观察，至少区分 available、unavailable 与 unknown；调用边界必须重新校验，不能只信 Delivery 缓存。
_Avoid_: Capability support, UI enablement

**Domain Contract**:
Domain Module 对外提供的 Command、Query 与 Event contract；它表达领域行为，不注册成 Runtime Endpoint capability。Domain 需要 Runtime 时只消费对应 Endpoint capability，并由自身保存需要恢复的业务执行状态。
_Avoid_: Runtime capability, transport route

**Execution Exchange**:
Platform Core 定义的跨 Runtime 调用协议，统一 Endpoint 路由、capability invocation、correlation 与 Immediate Receipt；它不建立全局 execution 状态库，也不取代 Runtime 或 Domain 的执行事实。
_Avoid_: execution database, Domain workflow state, Native Session history

**Immediate Receipt**:
Execution Exchange 在调用边界即时返回的已知结果，例如拒绝、同步完成或已被目标接受并关联；它不承诺最终执行成功，也不取代事实 owner 的长期状态。
_Avoid_: final outcome, durable job, execution record

**Approval Correlation**:
跨边界寻址并关联一次 approval 请求与决定的公共语言；approval 的可操作状态与业务推进仍由产生它的 Runtime 或 Domain 拥有。
_Avoid_: global approval store, shared approval state machine, approval authority

**Reconciliation**:
Domain 对自身 Desired、Applied 与 Observed 三个状态面进行比较并推动收敛的过程；Applied 是某一 revision 已物化的证据，不等同于当前观察，具体状态、策略与恢复仍由该 Domain 拥有。
_Avoid_: Platform resource database, global reconciler, Applied-is-Observed assumption

**Lease**:
事实 owner 对具体资源授予的有期限占用或 authority；资源、容量、续期、释放与过期语义由该 owner 定义，不能当作跨 Domain 的通用任务锁。
_Avoid_: global lock, generic job ownership, permanent allocation

**Process Supervisor**:
一个受管进程实例的唯一生命周期 owner，独占其 process handle、provenance 与 lifecycle state；其他模块只能请求动作或读取观察，不能并发修改该实例。
_Avoid_: Agent, OS thread, global process manager, shared mutable process state

**Environment**:
可复用的 Runtime 环境定义与期望配置，包括 provider、connector、extension、channel、credential reference、policy 与 toolchain。
_Avoid_: deployment, workload, node

**Workload**:
由 Fleet 放置并管理的已部署运行单元，例如 container、pod 或其他可执行部署实例。
_Avoid_: environment

**Organization**:
管理可复用 Team、Member、Role 及其组织策略和关系的 Runtime Management Domain。
_Avoid_: TeamRun, team execution

**TeamRun**:
由 Organization 中的 Team 定义创建的一次执行聚合，拥有 graph instance、attempt、调度、delivery、trigger 与 execution evidence；不预设独立执行目录。
_Avoid_: Organization, Team template

**Session**:
由支持会话能力的 Runtime 暴露的长期 Agent 交互；消息、执行历史、模型上下文、工具执行与 transcript 由该 Runtime 唯一拥有。
_Avoid_: Chat view, Matcha transcript

**Session Address**:
由 Runtime Endpoint 与该 Runtime 提供的不透明 Session handle 组成，用于在 endpoint 内唯一查找会话；它只负责寻址，不表达 execution、approval、transcript generation 或永久产品身份。Session title 也由对应 Runtime 保存，Matcha 只投影 title 与来源。Session 必须属于 Runtime，但只在 Runtime 原生支持 Agent 时才关联 Native Agent。
_Avoid_: Native transcript ID, Execution ID, permanent Session identity, Matcha title override, fabricated Agent identity

**Native Session**:
具体 Runtime 内部实现并持久化的 Session；其 handle grammar、存储布局和 transcript generation 只由对应 Runtime Integration 解释。Reset 保留同一 Session，Delete 终结并移出正常列表，但必须诚实报告 Runtime 实际执行了删除、关闭或保留数据；删除后复用同一 handle 创建的是新 Session。Session lifecycle 不包含 Archive。
_Avoid_: Matcha-owned transcript, restored deleted Session, archived Session, implied secure erasure

**Raw Thinking**:
Runtime 产生的原始中间推理流，不属于 Matcha 的长期产品历史；只有 Runtime 明确提供的可公开 summary 才可作为产品内容保留。
_Avoid_: Assistant message, thinking summary

**Tool Summary**:
由 Native Session 历史投影出的安全工具调用摘要；它不是 Matcha 单独持久化的工具事实，也不取代 TeamRun 对 execution evidence 的记录。
_Avoid_: Native tool payload, durable Matcha tool record

**Outcome Unknown**:
Execution command 已可能到达 Runtime，但 Matcha 未获得可判定结果的状态；不得自动重试或伪装成明确失败。
_Avoid_: Delivery failed, retryable failure

**Workspace**:
由用户明确创建、选择或纳入管理的产品工作空间。
_Avoid_: Agent Workspace, TeamRun execution directory

**Agent Workspace**:
具体 Runtime 为 agent 提供的原生工作目录；由 Runtime Integration 进行 materialization，不属于产品 Workspace。
_Avoid_: Workspace

**Evidence Reference**:
TeamRun 对执行证据的引用，可指向路径、URI、artifact identity 或 inline text；引用不代表 TeamRun 拥有底层目录，也不代表内容已纳入 Workspace。
_Avoid_: TeamRun workspace, published artifact

**OpenClaw plugins**:
通过 OpenClaw plugin interface 接入的 plugin packages。
_Avoid_: MatchaClaw packages
