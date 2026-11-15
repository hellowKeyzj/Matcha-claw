# 架构与模块责任

状态：目标与模块基线已对齐，首次实现的源码目录和共享接口已在 [contracts.md](contracts.md) 冻结；实现与验证状态见 [progress.md](progress.md)。

## 1. 系统边界

```text
runtime-host / SDK / 控制台
          │ WebSocket + JSON-RPC
          ▼
Rust App Server（独立进程）
  接口 → 各能力模块 → CLI 执行适配
           │              │
       模块自有状态       多个 CLI 会话进程
                          │
                   原生 Agent 执行引擎
```

- App Server 是完整的 Agent 管理中枢，不是旧 Bun app-server 的新包装，也不是 `runtime-host` 的内部业务模块。
- CLI 是执行后端，不因此被视为无状态的单次函数；它继续拥有原生工具、上下文、子 Agent、Team、记忆加载及恢复行为。
- 不增加第二个 TS 管理服务。原则上利用现有 CLI 协议、子命令和配置入口；确实无法表达的操作标明缺口，不用模型 prompt 冒充确定性管理 API。
- `runtime-host` 适配新 Server；本设计不自动授权改变 Renderer、preload 或 Host API 的公开语义。

## 2. 模块框架

分组是阅读结构，不是额外 owner 层。标记：**接入**＝源码已有执行能力；**受限**＝部分入口/平台/门控限制；**服务端**＝Rust 要实现的管理责任。具体依据和限制见 [能力矩阵](capabilities.md)。

```text
App Server
├─ 薄装配：配置解析、依赖连接、启动与关闭
├─ 接口与基础
│  ├─ gateway          服务端：协议分发、连接与流
│  ├─ access           服务端：连接认证、管理调用授权
│  ├─ config           服务端：运行配置、来源与应用
│  ├─ secrets          服务端：私有凭据引用、解析与投影
│  ├─ events           服务端：有序提交、订阅与回放
│  └─ persistence      服务端：共用存储机制，不拥有全部业务事实
├─ Agent 资源
│  ├─ agent            接入/受限：定义、角色、能力绑定
│  ├─ prompt           接入：系统提示词、指令文件、输出风格
│  ├─ model/provider   接入/受限：模型、Provider 与原生认证入口
│  ├─ workspace        接入/服务端：Agent 工作目录、确定性文件操作
│  ├─ worktree         接入/受限：可选会话工作树，不是产品 Project
│  └─ memory           接入/受限：文本记忆与原生整理/召回
├─ 能力与策略
│  ├─ tool             接入/受限：目录、工具集与有限直调
│  ├─ permission       接入/受限：原生权限与规则应用
│  ├─ sandbox          受限：平台隔离与实际生效观察
│  ├─ mcp              接入/受限：定义、连接、认证与能力发现
│  ├─ skill            接入/受限：技能内容、来源与加载
│  ├─ plugin           接入/受限：市场、安装、启停与刷新
│  └─ hook             接入/受限：配置与原生 callback
├─ 会话与执行
│  ├─ session          服务端：会话身份、Agent 关联与执行资源
│  ├─ run              服务端：执行提交、队列、取消与终态
│  ├─ history/recovery 接入/受限：原生查询、resume、fork 与回退
│  ├─ approval         接入/服务端：等待、决定与取消关联
│  ├─ question         受限：用户问答与 elicitation
│  ├─ task/subagent    接入/受限：原生任务与子 Agent 观察/控制
│  ├─ team/workflow    接入/受限：原生协作执行，不伪造管理 RPC
│  └─ content          接入/服务端：大内容、附件与产物引用
├─ 接入与自动化
│  ├─ schedule         接入/服务端：定时定义、触发与执行状态
│  ├─ proactive        受限：原生主动执行与 Heartbeat
│  ├─ channel          受限：MCP Channel、微信等已有接入
│  └─ routing/delivery 服务端：来源绑定、投递与结果
├─ 运行治理
│  ├─ usage/budget     接入/服务端：原生用量、计量与预算语义
│  ├─ diagnostics     服务端：安全诊断与因果关联
│  └─ retention       服务端：各类数据保留与清理
└─ cli
   ├─ 会话协议：双向 stream-json
   ├─ 原生命令：auth/plugin/mcp/weixin 等
   ├─ 配置投影与原生文件定位
   └─ 子进程、stdio、退出与回收
```

斜线并列表示相关责任，不冻结成一个大模块或多个 crate。实现时按真实状态与资源边界确定子模块，禁止为这张图预建全部空目录。

## 3. 状态和事实归属

| 内容 | 唯一责任方 | 其他模块的边界 |
|---|---|---|
| Agent 定义、服务配置、绑定 | 对应 Rust 管理模块 | CLI 只消费有效执行配置投影 |
| 逻辑 Session、业务 Run 与排队 | session / run | 进程模块不另建业务执行状态机 |
| CLI 句柄、stdio、退出事实及实际启动输入风险 | cli 的执行实例 | Session 消费实例启动快照，不从 Agent 配置重复推断；运行期歧义继续由原生观察累积 |
| Agent 原生 runtime 目录校验 | agent/storage | history 与 task 直接复用 `agent::runtime_directory`，由 `RuntimeDirectoryError` 返回内部失败事实，各自在调用边界映射既有业务 RPC 错误；Agent storage 不持有 History／Task 的错误分类。Session 不转导目录校验，执行 cwd 仍由其 Record.workspace 持有，不恢复 workspace 与 runtime 相邻的假设。 [VERIFY: matcha-agent/app-server/src/agent/storage.rs:413] [VERIFY: matcha-agent/app-server/src/session/history.rs:441] [VERIFY: matcha-agent/app-server/src/task/files.rs:223] |
| 连续空闲 5 分钟的实例休眠 | Session executor + CLI 原生握手 | CLI 原子封输入并检查 busy/resident/持久恢复条件，flush 后复查才返回 ready；Session 再 close、consumer join 并确认 graceful exit 才安全回收；不调用取消队列的 close_execution，不关闭逻辑 Session，新消息仍从原 durable 队列按同 UUID resume。 [VERIFY: matcha-agent/app-server/src/session/idle.rs] [VERIFY: matcha-agent/app-server/src/session/execution.rs] [VERIFY: matcha-agent/app-server/src/cli/idle.rs] [VERIFY: matcha-agent/src/cli/print.ts] |
| 工具执行、上下文、压缩、原生 transcript | CLI 原生引擎 | Rust 不双写、不用展示消息重建 |
| 后台 Agent／Workflow 通知、同一主 Agent 续执行与请求唯一 result | CLI `print`／QueryEngine 和原 tasks／命令队列 | App Server 只在当前 Active 核 root、真实 task/tool／parent、输入 ACK、唯一 result 与 idle；Host 消费已核证结果，不另建后台执行引擎或 Team 专用补救。[VERIFY: matcha-agent/src/cli/print.ts] [VERIFY: matcha-agent/src/QueryEngine.ts] [VERIFY: matcha-agent/app-server/src/session/observation.rs] [VERIFY: matcha-agent/app-server/src/session/run.rs] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/runtime.rs] |
| 新会话标题 | CLI 生成／写 native metadata；Session 私有 title 模块持一次尝试与目录 projection | 首条有效真人 UUID ACK 后锁内保存 attempt／文本兜底，锁外后台调用同 CLI；保留 native best-effort 保存 catch，响应 `{title}` 不当持久化回执，读回已落盘 `ai-title` 才投影。后续 ACK 不刷新标题，失败不重试；旧记录 attempt 缺省 true，不补 AI 生成，读取已有标题见下。 [VERIFY: matcha-agent/app-server/src/session/observation.rs:213-236] [VERIFY: matcha-agent/app-server/src/session/title.rs:18-128] [VERIFY: matcha-agent/src/cli/print.ts:4332-4369] |
| TaskList / Todo 写入 | CLI 原生 owner | Rust 只转发原生 mutation，保留 persisted/applied/unknown 回执 |
| TaskList / Todo 已落盘读取 | task 模块 | 始终读原生事项文件/会话 transcript 主链，不启动 CLI；TaskList 复用原生锁协议，Todo 不冒充实时 AppState；Session 只提供 native_files / persisted_history 窄接口。 [VERIFY: matcha-agent/app-server/src/task.rs] [VERIFY: matcha-agent/app-server/src/task/lock.rs] [VERIFY: matcha-agent/app-server/src/task/todos.rs] [VERIFY: matcha-agent/app-server/src/session/mod.rs] |
| 原生子 Agent/Team roster、邮箱和任务领取 | CLI 原生实现 | Rust 不直接改原生状态文件假装完成操作 |
| Proactive tick 与自主执行 | CLI 原生实现 | Session 只按实例转发开关、记录 ACK/未知与结果归属风险，不另建主动执行引擎 |
| 服务端事件、顺序、回放 | events 与所属业务模块 | 是管理事实，不是第二份 transcript |
| 审批关联和对外待办 | approval | 实际权限判定与生效仍由执行侧确认 |
| 诊断记录、查询与因果关联 | diagnostics | 不接管各模块错误和恢复决策 |
| 存储访问、原子文件/提交机制 | persistence | 每 handle 一个 writer、最多两个按需只读连接；取得异步租约后才执行 blocking SQL，业务 owner 自持事务，不升级为全局业务状态容器。 [VERIFY: matcha-agent/app-server/src/persistence/mod.rs] |

独立启动第二个 CLI 的服务端编排，不等于 CLI 内部 AgentTool 的原生子任务。两者可以关联，不混用身份或宣称等价。

`sessions.list` 仍以原 managed Session 为目录事实源。同一 `sessions` RwLock 内的私有 `Catalog` 保存 ID lookup、全局／按 Agent 的 `(created_at_ms, session_id)` 有序索引，只存不可变键与原 Session 的 Arc。Session 的唯一 Record 位于短时读写锁保护的 committed Arc，Execution 只拥有 mutation／执行状态；每次修改在 Execution owner 下从最新 committed 构造候选，持久化成功后发布，不保留第二份可变 Record。list 从索引倒序取 `limit+1` 个 Session Arc，出目录锁后截断，读取选中页的 committed Arc，再 hydrate／view；普通 get／list 不等待 Execution 的 DB I/O，也不深复制整页 Record。排序仍为创建时间、同时间 session ID 均降序；cursor 仍从全体 managed Session 解析，即使读取按 Agent 过滤，页内不承诺跨 Session 原子快照。history 保留原删除屏障，删除失败仍由独立准入 fence 拒绝 get，未提交 Deleting 不进入目录。[VERIFY: matcha-agent/app-server/src/session/catalog.rs] [VERIFY: matcha-agent/app-server/src/session/mod.rs] [VERIFY: matcha-agent/app-server/src/session/dispatch.rs] [VERIFY: matcha-agent/app-server/src/session/deletion.rs]

标题 projection 保存在原 managed Record：view 的 `title` 为 managed 显式名／native custom，`displayName` 为 AI／文本兜底，已有 projection 由目录／重启直接复用。[VERIFY: matcha-agent/app-server/src/session/record.rs] [VERIFY: matcha-agent/app-server/src/session/title.rs]

Agent gate 区分共享 Session 准入与独占生命周期／资源修改：普通 create、submit、启动与选择捕获快照时取 read；delete／retire、固定实例集合及既有 Agent 资源 writer 保留 write。跨模块的写准入经 `Sessions::agent_scope` 返回 crate 私有 `AgentScope`，私有绑定原 Sessions clone、Agent ID 与同一 Tokio 写租约；`agent_id`、`is_active`、`delete_sessions` 均使用该绑定，不另传 owner 或 Agent。普通 Session 准入在模型或长原生等待前释放；close_guard 与 Agent 采用 try-lock 握手，不持 close_guard 等 Agent。create／fork 目标／retire lookup 的全局 UUID 注册门只保留在途 Weak 项，顺序 Agent→UUID；live retire 进入删除前释放 UUID，fork 释放 source 操作后再创建目标，不将所有 Session 串成一个锁。[VERIFY: matcha-agent/app-server/src/session/mod.rs:49] [VERIFY: matcha-agent/app-server/src/session/mod.rs:303] [VERIFY: matcha-agent/app-server/src/session/deletion.rs:252] [VERIFY: matcha-agent/app-server/src/session/retirement.rs]

`Sessions::stable_agent_instances` 返回 crate 私有 `AgentInstances`，私有持有上述作用域与原固定 `(sessionId,instanceId)` 集合，只以 `instances()` 借用 slice。遇 launching 先释放 Execution、再释放作用域，等待 changed 后重新固定。`skills.configure` 始终持有该值直到配置提交、JoinSet 并发应用确认及借用集合构建收据完成；权限仍经 `Sessions::apply_instance_permissions`，不新增 Agent read。固定集合不是实例应用成功的证明，原生 ACK／超时与逐实例 acknowledged／unconfirmed 仍独立表达。[VERIFY: matcha-agent/app-server/src/session/mod.rs:66] [VERIFY: matcha-agent/app-server/src/session/instance.rs:13] [VERIFY: matcha-agent/app-server/src/session/instance.rs:20] [VERIFY: matcha-agent/app-server/src/session/instance.rs:56] [VERIFY: matcha-agent/app-server/src/skill.rs:224]

旧目录已有标题由 Session-owned `hydrate_titles(records)` 读取：只补 `native_title=None` 且非 Deleting 的 managed 记录，list 先分页后补选中页，get 复用；按 runtime/workspace 分组 `history::metadata_batch`，每组单次 project 目录枚举、每文件头尾各64KiB，不扫全文、不启动 CLI。有效已有 custom／AI／文本 projection 成功保存原 Record 后复用，空／缺文件不保存空 projection；metadata 读取或辅助 projection 保存失败均记安全 diagnostic、保留原记录／名称，目录保持可用，未保存者下次仍可重读。不另建 store／迁移 job／前端标题逻辑；新 create/fork 的 `Some(empty)`／attempt=false 不受影响，旧记录仍不补 AI。metadata 文本支持原生 bash 文字与 command 末级兜底，不扩大 AI 的真人 prose 资格。[VERIFY: matcha-agent/app-server/src/session/title.rs:131-216] [VERIFY: matcha-agent/app-server/src/session/title.rs:239-383] [VERIFY: matcha-agent/app-server/src/session/dispatch.rs:308-357] [VERIFY: matcha-agent/app-server/src/session/history.rs:127-261]

目录另提供 `sessions.subscribeCatalog {}` → `{delivery:"live_invalidation"}`，ACK 后发送初始及 watch 合并的 `sessions.catalogChanged`（`params:{}`），仅要求消费者回读目录，不复用聊天 replay／UI lease。Host 映射 title→label、displayName→display_name，沿中性 catalog 交付，公共 RPC／title／displayName／Host／Renderer 链不变。[VERIFY: matcha-agent/app-server/src/gateway/subscriptions.rs:119-178] [VERIFY: matcha-agent/app-server/src/gateway/socket.rs:79-91] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/runtime.rs:111-122]

## 4. 模块化的实现原则

- 一个模块聚合自己的接口、规则、状态、错误和所持资源；没有资源就不制造空的 start/stop。
- 业务调用通过窄接口直接表达；事件表示已发生的事实，不将全部命令广播进通用事件总线。
- 薄装配连接依赖，不判断业务状态；模块间不直接读取对方私有存储。
- 配置/目录、进程/任务、传输/存储机制共用；不共享一份巨大的可变业务上下文。
- 优先 Rust module 和直接类型组合。只有真实替换、测试副作用或独立依赖边界需要时才引入 trait/crate。
- 模块可以按需要配置和装配，不等于承诺运行中任意卸载、原子热替换或动态二进制 ABI。

## 5. 轻量与完整不冲突

省掉的是重复扫描、跨层搬运、泛化策略、重复状态与无消费者的抽象；不能省掉真实错误、退出回收、权限强制、原生恢复或诊断证据。

不默认引入全局进程内核、泛型任务平台、多层 Supervisor/Owner/Adapter、资源配额框架或每模块一套 actor。必要的有序访问和异步任务由实际共享资源决定，不能靠架构图提前制造。

## 6. 非现成能力与 OPEN

通用节点/设备管理、多租户 RBAC、向量知识库、完整云环境、统一多平台 Bot、通用语音服务、跨引擎分布式编排，均不能视为现有 CLI 已提供；需要时单独立项，不创建空壳显示支持。

首次实现采用独立 `matcha-agent/app-server/` 单 crate、Tokio/Axum、SQLite 与原子文件持久化；精确共享接口见 [contracts.md](contracts.md)。上图是职责基线，不是每项均已有独立文件或管理 RPC 的交付声明；实际落盘、接线与验证按 [progress.md](progress.md) 记录。
