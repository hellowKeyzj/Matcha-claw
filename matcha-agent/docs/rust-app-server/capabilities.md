# 能力矩阵：原生引擎、外部入口与真实缺口

核查日期：**2026-10-16**。
核查方式：**当前源码静态核查，非运行验证**；未启动 CLI、服务、模型或安装依赖。
本文记录能力基线，不是实现计划、RPC 清单或 Rust 已交付声明。

## 1. 目标与事实分栏

- **目标**：独立、轻量、高并发、模块化的 Rust app-server；`runtime-host` 只作为客户端。
- **初期约束**：CLI 不改；原生 loop、builtin/MCP 工具、上下文组装和 transcript/recovery 继续由 CLI 执行。
- **当前事实**：已有 TypeScript app-server、原生 CLI/headless 控制协议，以及多类工具和扩展消费者；不能把 Rust 目标写成当前实现。
- **产品模型**：每个 Agent 独立一个 workspace，下面不再建立“项目”业务实体。
- CLI 的 `projects/<cwd 编码>/` 是原生 transcript/记忆的物理分桶，不是产品项目层，也不是新增多 workspace 授权的依据。
- Rust 新增管理面、状态投影或入口适配，不等于对应引擎缺失，更不意味着必须重写 builtin、微信或插件消费者。

证据入口：[CLI](../../src/main.tsx)、[QueryEngine](../../src/QueryEngine.ts)、[现有 worker](../../src/app-server/workers/workerSession.ts)、[原生存储路径](../../src/utils/sessionStorage.ts)。
架构 owner、运行目录、协议执行和诊断分别见 [architecture.md](architecture.md)、[runtime-layout.md](runtime-layout.md)、[protocol-execution.md](protocol-execution.md)、[diagnostics.md](diagnostics.md)。

## 2. 如何读矩阵

- **引擎已有**：存在实际执行、恢复或消费路径；仅有类型、目录、schema 不算完整可用。
- **外部已有**：不修改 CLI 即可通过现有命令、启动参数、文件配置或 headless 控制消息使用。
- **条件可用**：还依赖构建 feature、显式启用、平台依赖、授权、连接或交互上下文。
- **管理缺口**：原生可执行，但没有等价、完整、确定性的外部管理合同；不能用模型发起一次工具调用替代 CRUD 保证。
- 下表“外部入口”不自动表示现有 app-server 已转发，也不表示 Rust 已实现；具体接入面必须分别核对。

## 3. 能力矩阵

| 主题 | 原生引擎事实 | 不改 CLI 的外部入口 | 条件、限制或真实缺口 | 关键源码 |
|---|---|---|---|---|
| 01 Agent 定义、Prompt 与输出风格 | Agent 定义支持 prompt、模型、工具、权限模式、skills、memory/isolation；输出风格有 Markdown 加载器。 | `agents` 列表、`--agent`、`--agents`、`--system-prompt`、`--append-system-prompt`，以及原生 agent/output-style 文件和设置。 | 定义与选择已有；产品 Agent 身份、独立 workspace 绑定及其管理面不能等同原生 subagent 定义列表。 | [定义加载](../../packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts)、[风格](../../src/outputStyles/loadOutputStylesDir.ts)、[参数](../../src/main.tsx) |
| 02 八类 provider | `firstParty`、`bedrock`、`vertex`、`foundry`、`openai`、`openaiResponses`、`gemini`、`grok` 均有选择及调用路径。 | 原生 settings/env/model 选择；`auth login/status/logout` 可复用其适用认证流程。 | 八类是协议/后端路径，不代表功能逐项等价；`set_model` 不替换 Provider client/凭据，Provider 切换需重建执行实例；不复制原生凭据事实源。 | [枚举与选择](../../src/utils/model/providers.ts)、[直连/云客户端](../../src/services/api/client.ts)、[适配分流](../../src/services/api/claude.ts)、[auth](../../src/cli/handlers/auth.ts) |
| 03 Resume、fork 与历史 | 原生 transcript 恢复、沿用会话或 fork 新会话均已有；历史读取另有只读模型。 | `--continue`、`--resume`、`--fork-session`、print 模式 `--resume-session-at`；Rust Session 连续空闲 5 分钟后可经 `prepare_to_sleep` 安全握手回收实例，新消息从原 durable 队列按同 UUID resume。 | busy/resident、非持久化或仅内存不可恢复状态不休眠；ready/flush/close/join/真实 graceful exit 才可确认安全。恢复不等于任意 CPU/工具执行点继续，fork 不是复制运行进程。 | [恢复与休眠分支](../../src/cli/print.ts)、[控制 schema](../../src/entrypoints/sdk/controlSchemas.ts)、[Rust 休眠](../../app-server/src/session/idle.rs)、[历史模型](../../src/utils/sessionHistoryReadModel.ts) |
| 04 Run 与 NDJSON | Headless 复用 `ask` 执行和原生上下文，收发 SDK 消息与双向 control 消息。 | `-p --input-format stream-json --output-format stream-json`；按需启用 partial messages、hook events。 | `interrupt` 是 abort，不是精确暂停；stdin 生命周期、控制响应和最终结果必须区分，不能只读 assistant 文本。 | [执行与控制分派](../../src/cli/print.ts)、[结构化 IO](../../src/cli/structuredIO.ts)、[控制 schema](../../src/entrypoints/sdk/controlSchemas.ts) |
| 05 Builtin 与 `mcp serve` | builtin 注册、工具池和真实工具实现已有；`mcp serve` 提供 `tools/list`、`tools/call`。 | 原生 loop 使用 builtin；独立工具客户端可连接 CLI 的 stdio MCP server。 | MCP server 的 messages/agents/MCP clients 是最小空上下文，不是完整会话；授权语义按 OPEN 处理，不推荐无鉴权公开。 | [工具池](../../src/tools.ts)、[MCP serve 调用](../../src/cli/handlers/mcp.tsx)、[工具服务实现](../../src/entrypoints/mcp.ts) |
| 06 权限与审批 | 模式、allow/deny/ask 规则、原生权限决策及审批回传已有。 | CLI 权限参数；headless `can_use_tool`/control response；现有 app-server `approval.respond`。 | 工具授权由原生执行链判定；token 鉴权不是 RBAC，文件规则也不是多租户隔离。 | [权限管道](../../src/utils/permissions/permissions.ts)、[SDK 审批](../../src/cli/structuredIO.ts)、[已有审批合同](../../src/app-server/protocol/types.ts) |
| 07 Sandbox | CLI 已接入 sandbox-runtime 的文件/网络限制和依赖检查。 | settings、原生 `/sandbox` 及 shell 工具链。 | 支持 macOS、Linux、WSL2；WSL1/原生 Windows 不等价支持，Linux/WSL 还依赖系统工具和实际环境。 | [平台、配置与依赖检查](../../src/utils/sandbox/sandbox-adapter.ts) |
| 08 MCP 配置与 OAuth | 原生多 scope 配置、连接、OAuth discovery/刷新及安全存储调用已有。 | `mcp add/remove/list/get`、`--mcp-config`、`--strict-mcp-config`；headless 有 status/set/reconnect/toggle/auth 控制处理。 | 管理配置不等于任意重写原生 credential 存储；控制分支与 schema 覆盖不能仅凭类型推断。 | [配置](../../src/services/mcp/config.ts)、[OAuth 实现](../../src/services/mcp/auth.ts)、[headless 消费](../../src/cli/print.ts) |
| 09 Skills | 文件发现、frontmatter、延迟正文加载、参数替换、技能 hooks 和工具调用已有。 | 原生 skills/commands 目录、`/skills` 与 Skill 工具；plugin/bundled/MCP 也可提供技能。 | 执行已有；产品库导入、编辑、启停和状态反馈不自动成为 app-server RPC。 | [加载器](../../src/skills/loadSkillsDir.ts)、[工具注册](../../src/tools.ts) |
| 10 Plugins | marketplace 安装/卸载/启停/更新，及原生技能、Agent、hooks、MCP 等消费者已有。 | `plugin` 子命令、`--plugin-dir`；headless `reload_plugins` 会刷新消费者并返回命令/Agent 等信息。 | 不要求 Rust 重写插件消费者；安装成功、启用成功与当前会话已刷新是不同事实。 | [插件操作](../../src/services/plugins/pluginOperations.ts)、[消费者刷新](../../src/cli/print.ts)、[builtin 插件注册](../../src/plugins/builtinPlugins.ts) |
| 11 Hooks、问答与 elicitation | 生命周期 hooks、AskUserQuestion、MCP elicitation 均有原生实现；SDK 可转发 hook callback 与交互请求。 | settings/skill/plugin hooks；headless `can_use_tool` 响应可携带更新输入，另有 `hook_callback`/`elicitation`。 | 问答不能压成 allow/reject；现有 app-server 工具批准只回填原 input，不代表已有完整结构化答案通道。 | [hooks](../../src/utils/hooks.ts)、[问答工具](../../packages/builtin-tools/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx)、[SDK IO](../../src/cli/structuredIO.ts)、[现有 worker 审批](../../src/app-server/workers/workerSession.ts) |
| 12 文本记忆 | `MEMORY.md`/主题文件、上下文注入、Agent memory，以及 LocalMemoryRecall 的列举/读取已有。 | 原生文件与工具，在对应 Agent workspace/cwd 和配置家目录下消费。 | 这是文本/键值记忆，不是向量 RAG；没有由这些入口证明的 embedding、向量检索或完整 RAG 管理面。 | [自动记忆](../../src/memdir/memdir.ts)、[本地 recall](../../packages/builtin-tools/src/tools/LocalMemoryRecallTool/LocalMemoryRecallTool.ts) |
| 13 Worktree | CLI 会话、subagent 的 worktree 创建/清理和相关 hooks 已有。 | `--worktree`、Agent isolation、EnterWorktree/ExitWorktree 原生工具。 | 是 Git 物理隔离方式，不新增产品“项目”；不等价目录权限 sandbox，也没有现成完整远程 worktree 管理 RPC。 | [worktree 实现](../../src/utils/worktree.ts)、[Agent 使用](../../packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx)、[工具注册](../../src/tools.ts) |
| 14 Subagent 与 tasks | Agent 前台/后台执行、恢复、进度、TaskOutput/TaskStop、TaskList 文件和 TodoWrite transcript 恢复已有。 | 主 loop 的 Agent/tasks 工具；SDK task 通知，headless `stop_task`；Rust `tasks.list/get(kind:"taskList")` / `todos.get` 始终只读原生落盘资料，写入仍经 CLI 原生 owner。 | 读取不启动 CLI、不取 Provider 凭据，Todo 只表示已落盘恢复值，不冒充实时 AppState；任务清单 CRUD 不等于内部 subagent CRUD。 | [Agent](../../packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx)、[原生绑定](../../src/utils/tasks.ts)、[Todo 恢复](../../src/utils/sessionRestore.ts)、[Rust task](../../app-server/src/task.rs) |
| 15 真实 Team | TeamCreate/TeamDelete、teammate spawn、SendMessage、共享任务和不同执行 backend 均有实际路径，不只是多进程名字。 | 原生 Agent/Team/SendMessage 工具及交互界面；受运行模式、backend 和禁用开关影响。 | 当前 team gate 默认允许，但不代表每种 backend 都能用；没有完整 team 管理 RPC，也不能把独立会话池称为原生 Team。 | [创建 Team](../../packages/builtin-tools/src/tools/TeamCreateTool/TeamCreateTool.ts)、[spawn](../../packages/builtin-tools/src/tools/shared/spawnMultiAgent.ts)、[消息](../../packages/builtin-tools/src/tools/SendMessageTool/SendMessageTool.ts)、[gate](../../src/utils/agentSwarmsEnabled.ts) |
| 16 真实 Workflow | 脚本解析/执行、Agent 调度、并发/预算、进度与 journal resume 已有，非仅 prompt 模板。 | `WORKFLOW_SCRIPTS` 构建 feature 下的原生 Workflow 工具，支持 inline/name/scriptPath/args/resumeFromRunId。 | 通过工具运行不等于已有外部 Workflow 管理 RPC；journal replay 不承诺任意副作用恰好一次。 | [工具接线](../../src/workflow/wiring.ts)、[现有服务](../../src/workflow/service.ts)、[执行与恢复](../../packages/workflow-engine/src/engine/runWorkflow.ts)、[输入](../../packages/workflow-engine/src/tool/schema.ts) |
| 17 Cron 与 proactive | CronCreate/List/Delete、持久/会话任务、headless scheduler；proactive tick 和自动任务状态已有。 | 原生工具、scheduled_tasks 配置；headless `set_proactive` 处理受 `PROACTIVE`/`KAIROS` feature 控制。 | 常驻调度取决于进程存活和 gate；headless 对 teammate 所属 cron 有显式失败分支，不是通用后台编排平台。 | [Cron 工具](../../packages/builtin-tools/src/tools/ScheduleCronTool/CronCreateTool.ts)、[scheduler](../../src/utils/cronScheduler.ts)、[headless 调度与控制](../../src/cli/print.ts)、[proactive](../../src/proactive/useProactive.ts) |
| 18 MCP channel 与微信 | 入站 channel 通知和会话注入、微信轮询/回复/媒体/配对/审批转发已有实现。 | `weixin login/serve/access pair`、`--channels plugin:weixin@builtin`；headless 也有 channel 消费。 | 需要显式会话启用及来源匹配；已有微信不等于具备多平台 bot 产品管理、账号路由或所有 channel 默认可用。 | [CLI 快速入口](../../src/entrypoints/cli.tsx)、[channel gate](../../src/services/mcp/channelNotification.ts)、[微信命令](../../packages/weixin/src/cli.ts)、[微信 MCP](../../packages/weixin/src/server.ts) |
| 19 浏览器与电脑操作 | Chrome MCP 的真实 call 分派、Computer-use 工具/执行器和 CLI 会话 wrapper 已有。 | Chrome `--chrome`/原生 MCP 快速入口；Computer-use 走交互式 CLI 的 MCP wrapper。 | **条件可用**，不是“缺失”或“默认可用”；独立 `--computer-use-mcp` 当前未绑定 session context，call 会落入 not-wired stub。 | [入口](../../src/entrypoints/cli.tsx)、[Chrome 调用](../../packages/@ant/claude-for-chrome-mcp/src/mcpServer.ts)、[CU wrapper](../../src/utils/computerUse/wrapper.tsx)、[CU server](../../packages/@ant/computer-use-mcp/src/mcpServer.ts) |
| 20 Remote 与 SSH | bridge/remote-control、远端会话和 SSH 探测/部署/认证代理/执行链已有。 | 对应 feature 下的 `remote-control`、remote 参数和 `ssh <host> [dir]`。 | SSH 当前 CLI 明确拒绝 `-p`；远控还有认证/策略/gate 前置条件，不是本地 node-device 管理或通用设备协议。 | [远控入口](../../src/entrypoints/cli.tsx)、[SSH 路由与限制](../../src/main.tsx)、[SSH 实现](../../src/ssh/createSSHSession.ts) |
| 21 Usage、配置与运维 | token/cost、原生 settings、auth、doctor 和运行诊断链已有。 | SDK result/usage、`/usage`、`auth status`、`doctor`；headless `get_settings`/`get_context_usage`。 | 会话 usage 不等于跨 Agent 账单；需要产品查询/投影不表示原生统计、配置或认证引擎缺失。 | [usage](../../src/commands/usage/usage.tsx)、[cost](../../src/cost-tracker.ts)、[settings](../../src/utils/settings/settings.ts)、[auth](../../src/cli/handlers/auth.ts)、[控制入口](../../src/cli/print.ts) |

## 4. 关键条件与反例

### 4.1 现有 app-server 不是 CLI 全能力目录

现有 [ProtocolGateway](../../src/app-server/transport/protocolGateway.ts) 已有会话创建/加载/列表/关闭、prompt/cancel、snapshot、transcript/content、事件 replay/subscribe、审批、模型列表和模型/模式切换。
它没有因此覆盖 `print.ts` 的全部控制分支，更没有覆盖全部 CLI 子命令。
原生已有但尚未被该 gateway 暴露的能力，应标“入口/管理缺口”，不应标“引擎待实现”。

现有 [workerSession](../../src/app-server/workers/workerSession.ts) 直接组装 QueryEngine、Agent 定义、MCP 和工具池。
这能证明 TS 边界的执行复用，不能证明未来 Rust 已接好相同能力；也不要求 Rust 复制 TS worker 的内部 IPC。

### 4.2 Run 可中断、可恢复，不可宣称精确暂停

`interrupt` 分支调用 abort controller；`--resume`/fork 从原生记录恢复新的执行过程。
不能承诺暂停后保留某次工具调用栈、网络请求或模型采样状态再精确续跑。
Proactive 的暂停/禁用 tick、Workflow 的 journal resume，也不是精确暂停整个 Agent。
证据：[控制与恢复](../../src/cli/print.ts)、[Workflow replay](../../packages/workflow-engine/src/engine/runWorkflow.ts)。

### 4.3 `mcp serve` 是工具入口，不是等价会话

[实现](../../src/entrypoints/mcp.ts) 确实注册 list/call，并直接调用 builtin 的 `tool.call`。
其 messages、Agent 定义、MCP clients/resources 和状态 setter 不具备完整会话环境，且尚有输入 schema 校验 TODO。
因此不能承诺所有依赖会话状态或交互的 builtin 都能在该入口完整运行。
“授权等价 OPEN”指不能把此独立调用入口当作原生完整审批边界；工具内部收到权限回调不构成顶层完整授权保证。
保持 stdio/可信本地边界；不得因可列工具就推荐无鉴权公网暴露，也不必因此重写所有 builtin。

### 4.4 浏览器已有真实调用，电脑已有受限执行链

Chrome：`--claude-in-chrome-mcp` → [原生 context](../../src/utils/claudeInChrome/mcpServer.ts) → [包内 CallTool handler](../../packages/@ant/claude-for-chrome-mcp/src/mcpServer.ts) → bridge/native socket → 浏览器扩展。
[启用判断](../../src/utils/claudeInChrome/setup.ts) 默认关闭；非交互会话需显式 `--chrome`，还依赖扩展连接和所选传输的授权条件。
这不是仅有包名或空壳，也不是默认具备可用浏览器会话。

Computer-use：`CHICAGO_MCP` + 已识别平台 + 交互式会话 + `getChicagoEnabled()` 才进入 CLI 动态配置路径。
[main gate](../../src/main.tsx)、[运行 gate](../../src/utils/computerUse/gates.ts)、[client 接线](../../src/services/mcp/client.ts) 与 [wrapper](../../src/utils/computerUse/wrapper.tsx) 共同完成真实 `.call()` 分派。
还依赖 [host adapter](../../src/utils/computerUse/hostAdapter.ts)、原生/平台 backend、OS 权限及会话应用授权；包中存在多平台 backend 不等于本轮验证了各平台。
单独的 [CLI CU server](../../src/utils/computerUse/mcpServer.ts) 未传 session context；[包内 handler](../../packages/@ant/computer-use-mcp/src/mcpServer.ts) 对该路径明确返回 not-wired。
结论是“原生交互链条件可用；headless/独立 MCP 路径不自动等价”，不是要求 Rust 从零实现电脑操作。

### 4.5 Team、Workflow、tasks 不能互相冒充

原生 Team 有成员、消息和共享任务；Workflow 有脚本执行与 journal；后台 task 有自己的终止和通知语义。
这些机制可由原生工具驱动，但现有 gateway 没有完整 Team/Workflow 管理方法。
`stop_task` 只证明可停止已知任务，不证明通用内部 subagent CRUD。
外部创建多个顶层 Agent 会话也不自动获得原生 Team 的协作关系。
证据：[Team](../../packages/builtin-tools/src/tools/TeamCreateTool/TeamCreateTool.ts)、[Workflow](../../src/workflow/service.ts)、[task 控制](../../src/cli/print.ts)。

### 4.6 以当前 gate 为准，不照抄过时注释

[Team gate](../../src/utils/agentSwarmsEnabled.ts) 当前默认返回允许，存在显式禁用开关；不能仅按函数名中的 experimental 判为不可用。
[channel gate](../../src/services/mcp/channelNotification.ts) 当前函数检查 capability、会话选择和 plugin marketplace 来源匹配；不能仅凭旧注释断言仍强制 OAuth-only。
[微信 CLI](../../packages/weixin/src/cli.ts) 与 [MCP server](../../packages/weixin/src/server.ts) 已有登录、配对、收发及审批依赖注入，不是“待 Rust 编写微信引擎”。
这些静态事实仍不证明安装产物的 feature、远端服务、账号或会话配置已经满足。

## 5. 与 OpenClaw 的对照边界

对照源：[core-descriptors.ts](../../../docs/openclaw-source/src/gateway/methods/core-descriptors.ts)。
该表显示 OpenClaw 的 agents/files、skills、tools、config、channels、tasks、审批/问答、worktrees 等管理方法，以及 operator/node 等 scope。
它是“外部管理面有多完整”的参照，不是 matcha-agent 的方法表，也不是要求两边引擎、权限或存储语义相同。

- 有原生能力而缺稳定管理入口：属于 Rust app-server 的接入/管理面问题，不是缺一套新 loop。
- OpenClaw 方法名、认证 scope、设备模型不能直接拷贝成 Rust 合同。
- 当前没有本地 node-device 控制面、完整多平台 bot 管理或 RBAC；已有 SSH、Chrome、Computer-use 不会自动补齐这些能力。

## 6. 真正新增能力与静态验证限制

### 真正新增的产品/管理能力

- 独立 Rust app-server 本身，以及跨 CLI 会话的轻量、高并发服务管理；当前 TS 源码不能充当其性能验收。
- 产品 Agent 身份、每 Agent 独立 workspace 绑定与生命周期管理；不在 workspace 下新增项目实体。
- 对既有配置、skills/plugins、历史、审批/问答、usage、任务/协作状态的产品级查询、管理与投影入口。
- 当明确需要时，补齐尚无稳定外部合同的管理能力；是否能适配原生入口、是否确有引擎缺口，需分别判断。
- 精确暂停、通用内部 subagent CRUD、完整 Team 管理 RPC、向量 RAG、多平台 bot、本地 node-device、RBAC 均不是现有基线保证，也不因列出就自动进入交付范围。

以上是新增边界的识别，不冻结未讨论的 RPC 名称、端口、存储引擎、并发数或硬限制。
认证优先复用 [native auth 命令与存储流程](../../src/cli/handlers/auth.ts)；Rust 管理登录状态/流程不要求复制 native credential truth。

### 本轮检查能证明什么

- 已先读两份指定架构文档，再定点检查上述入口、消费路径和关键 gate；未做全仓审计。
- 证明的是源码存在相应分派、执行、恢复或限制；不证明当前构建产物包含该 feature，或所有依赖已可用。
- 未读取账号、token、credential 文件；文中的认证判断来自源代码，不来自本机凭据。
- 未验证模型/provider 兼容性、扩展连接、微信登录、OAuth 回调、sandbox 隔离效果、远端 SSH 或平台 backend 的运行结果。
- 未测并发、内存、吞吐、延迟、故障恢复或交付包；“轻量/高并发”仍是目标，不是实测结论。
- 两份旧架构文档的历史读取说明有新旧口径并存；本表采用当前 gateway/history reader 的事实，不把旧描述升级为新 Rust 约束。
