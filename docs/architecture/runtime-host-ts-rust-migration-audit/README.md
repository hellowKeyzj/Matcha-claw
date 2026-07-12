# runtime-host TS → Rust 迁移审计

> 状态：进行中。本文档组是**旧 `runtime-host` 的文件级事实审计和迁移证据库**，不是当前实现事实的替代，也不是已批准的 Rust 实施计划。
>
> 审计范围快照：`runtime-host` 下所有当前存在的 TypeScript 源文件；构建产物、依赖目录、测试输出和生成文件必须单列为排除项，不能静默遗漏。每个分片在完成时都要列出实际读取的路径、未读路径与排除原因。

## 目标

建立可追溯的 TS → Rust 迁移基线。迁移不是逐文件语法翻译，而是让 Rust 在未来完整接管每一个旧 owner 的状态、策略、副作用、恢复与公开契约。

每条结论都必须区分：

- **当前事实**：从现有 TypeScript 代码、调用链、测试或架构事实文档证实。
- **保留语义（Preserve）**：Rust 必须维持的可观察行为。
- **有意改进（Intentional Improvement）**：旧语义的明确替代；必须写出改变理由、兼容影响和验证 oracle。
- **缺陷/偶然行为（Defect / Accidental Behavior）**：不应为差分一致性复制的行为；必须提供证据。
- **待验证**：尚未由代码或测试闭环证明，不能当结论。

## 新架构 owner 枚举

未来落点只能从下列位置选择；不能用旧 R0–R6 目录名充当新 Rust owner：

| 新 owner | 可以拥有 | 不能拥有 |
|---|---|---|
| Foundation Kernel | 存储机制、任务监管、重试/取消/截止时间原语、进程/节点通信机制、事实追加/cursor 机制、模块装配校验、secret/redaction 机制 | TeamRun、Session UI、Plugin/MCP/Skill、任何 Runtime 私有业务状态机 |
| Matcha Platform Core | Agent/Endpoint identity 与 binding、Capability/Scope grammar、Execution/Receipt/Correlation、desired/applied/observed 共同协议 | 领域专属 graph、plugin catalog、session timeline、OpenClaw 配置 |
| Domain Module | 各自业务事实、状态机、领域 port、恢复策略；如 Session、TeamRun、Environment、Fleet、Skill、Knowledge、Browser Flow | 直接依赖 OpenClaw 或 matcha-agent 内部 SDK/存储 |
| Runtime Integration | 对 OpenClaw、matcha-agent 或未来 Runtime 的具体 port 实现、协议翻译、能力诚实声明、runtime-specific projection | Matcha 产品事实源或跨领域业务状态机 |
| Native Runtime Edge | Runtime 自己的 plugin、MCP、skill、config、native agent/session、SDK、协议习惯 | 定义 Matcha 核心模型 |
| Delivery | Electron、CLI、Web、Automation 的 Command/Query/Event 交付与桌面集成 | 业务事实源、Runtime 生命周期 owner、secret/token owner |

`Execution Kernel` 不是独立终态层名：跨 Runtime 的 execution identity、receipt、correlation 和 outcome grammar 归 **Matcha Platform Core**；task supervision、cancellation、deadline 与事实追加机制归 **Foundation Kernel**；领域状态机仍归各自 **Domain Module**。

## 当前实现与最终生命周期 owner 的判读规则

本审计必须同时记录当前 TypeScript 的实际 owner 和已确定的 Rust 终态 owner，二者不能互相冒充：当前 Electron `process-runtime` 是现行进程控制实现；最终目标中，Rust Matcha Runtime 的 Local Process Host 才拥有所有纳管 Runtime 的“是否应运行、何时重启、如何观察”、spawn/attach、readiness、restart/backoff、日志、shutdown、process-tree cleanup 与 PID/provenance 策略。当前 Electron 实现中承载这些语义的部分，因而是 **runtime-host 迁移的外部旧 owner 定位来源**，不是可按目录一概排除的参考材料。

| 语义切片 | 当前工作树事实 | Rust 终态 owner | 不随之迁移的边界 |
|---|---|---|---|
| 受管 Runtime lifecycle policy 与 Local Process Host | Electron `process-runtime` 当前实现 launch/attach、readiness、restart/backoff、log、shutdown、PID/provenance 与 process-tree 语义 | Rust Matcha Runtime：由 Foundation Kernel 提供进程/任务原语，由 Runtime Integration 提供 runtime-specific prepare/recovery，由 Runtime/Domain policy 决定 desired lifecycle | Electron UI/window/tray/桌面集成；peer Runtime 内部 worker/LLM/tool harness/approval/store |
| Electron 桌面壳与客户端 transport | Electron main/preload/Host API/IPC、窗口、系统集成、renderer proxy | **Delivery** | 不能成为 Runtime PID、生命周期事实或业务状态权威 |
| peer Runtime internals | OpenClaw、matcha-agent 等各自的 LLM loop、tool harness、sandbox、native approval、worker/session/store | **Native Runtime Edge**；runtime-host 仅迁移自身 adapter/translation | 不迁入 Platform Core、Foundation 或 Session/Fleet Domain |
| renderer read model | React/Zustand/local cache/draft/toast/locale/terminal view | **Delivery** | 不能反推 canonical state 或外部 effect completion |
| CI、package、tests | Node/Electron delivery topology、构建输入与 oracle | delivery constraint / verification evidence | 不能证明 Rust workspace、cutover 或 semantic owner |

因此，外部路径只能逐项按语义归类：不能把整个 Electron、renderer、app-server 或 CI 当作旧 owner；也不能把 Electron 中已经承载的受管 Runtime lifecycle 语义误写为永久保留的 Delivery owner。任何未来 cutover 都必须先把这张表拆到具体功能块，并以支持入口、状态转换、副作用、故障类别和 oracle 证明 Rust 已成为唯一 active semantic owner。

## 每文件审计记录格式

每个分片必须为它负责的每一个 `.ts` 文件生成一条 `### <relative path>` 记录，至少含：

```md
### runtime-host/path/file.ts

- **当前 owner：** <真实 state/strategy/side-effect owner；“pure helper”也要明确>
- **职责与关键 symbols：** <导出/私有关键符号及其责任>
- **旧语义与策略：** <正常与非 happy path：顺序、幂等、拒绝、默认、转换、retry/backoff、cancel、恢复、secret/redaction 等>
- **状态、存储与副作用：** <内存/文件/配置/网络/进程/事件；读写边界>
- **并发与性能特征：** <串行键、队列、锁、扫描、复制、JSON、I/O、复杂度；没有则明确>
- **调用/依赖边界：** <上游、下游、跨模块契约；至少指出 runtime-host 内的关系>
- **故障、恢复与安全：** <错误映射、unknown、cleanup、replay、private/secret 约束；没有则明确>
- **迁移分类：** <Preserve / Intentional Improvement / Defect / 待验证，逐条列出>
- **未来 Rust owner：** <上表之一；需要分拆时明确每个切片 owner>
- **Rust 重写与性能判断：** <数据结构、算法、actor/task、storage、I/O、背压；只在有证据时提出“极致优化”>
- **验证 oracle：** <现有测试/fixture/trace/differential/fault injection/benchmark；待补什么>
- **证据：** <调用方、测试、关键函数或文档路径>
```

禁止把“迁移到 Rust”当成性能结论。每项性能重写必须同时说明：

1. 消除的旧成本（例如重复 JSON 往返、全量重建、无界队列、重复扫描）；
2. 所保持的旧行为；
3. 可测量指标（延迟、吞吐、内存、I/O、恢复时间或事件丢失语义）；
4. 回归 oracle。

## 覆盖与完成门禁

- 每个当前存在的生产 `.ts` 文件必须恰好出现在一个分片的“已读文件”列表和一条文件记录中。
- 文件在 Git 中为 tracked、untracked 或 ignored 不影响是否审计；排除必须明确理由。
- 只有实现、测试或调用链确实证明时，才标记缺陷；否则为“待验证”。
- 最终汇总必须反向核验：文件 inventory → 分片记录 → composition root / route registry / test 调用链。
- 不创建 Rust crate，不改变 TS 行为，不以 TS fallback、双写或长期 bridge 作为迁移方案。
