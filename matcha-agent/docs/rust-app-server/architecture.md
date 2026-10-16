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
| 工具执行、上下文、压缩、原生 transcript | CLI 原生引擎 | Rust 不双写、不用展示消息重建 |
| 原生子 Agent/Team roster、邮箱和任务领取 | CLI 原生实现 | Rust 不直接改原生状态文件假装完成操作 |
| Proactive tick 与自主执行 | CLI 原生实现 | Session 只按实例转发开关、记录 ACK/未知与结果归属风险，不另建主动执行引擎 |
| 服务端事件、顺序、回放 | events 与所属业务模块 | 是管理事实，不是第二份 transcript |
| 审批关联和对外待办 | approval | 实际权限判定与生效仍由执行侧确认 |
| 诊断记录、查询与因果关联 | diagnostics | 不接管各模块错误和恢复决策 |
| 存储访问、原子文件/提交机制 | persistence | 不升级为全局业务状态容器 |

独立启动第二个 CLI 的服务端编排，不等于 CLI 内部 AgentTool 的原生子任务。两者可以关联，不混用身份或宣称等价。

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
