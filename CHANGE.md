# CHANGE.md

## 本次变更日志（2026-03-15 Subagent 模板内置化 + 一键加载）

### 目录树

```text
Matcha-claw/
├── src/
│   ├── features/
│   │   └── subagents/
│   │       └── templates/
│   │           └── <144 template workspaces>/
│   │               ├── AGENTS.md
│   │               ├── SOUL.md
│   │               ├── TOOLS.md
│   │               ├── IDENTITY.md
│   │               └── USER.md
│   ├── pages/SubAgents/
│   │   ├── index.tsx
│   │   └── components/SubagentTemplateLoadDialog.tsx
│   ├── services/openclaw/subagent-template-catalog.ts
│   └── types/subagent.ts
├── electron/
│   ├── adapters/platform/ipc/openclaw-ipc.ts
│   └── preload/index.ts
```

### 文件职责

- `src/features/subagents/templates/*`：项目内置 subagent 模板库（打包资源源目录）。
- `electron/adapters/platform/ipc/openclaw-ipc.ts`：模板目录扫描、模板目录/模板详情 IPC 提供。
- `electron/preload/index.ts`：暴露模板目录相关安全 IPC 白名单。
- `src/services/openclaw/subagent-template-catalog.ts`：renderer 模板目录/详情读取服务。
- `src/pages/SubAgents/index.tsx`：模板展示与“加载模板”交互编排。
- `src/pages/SubAgents/components/SubagentTemplateLoadDialog.tsx`：仅模型选择的模板加载弹窗。
- `src/types/subagent.ts`：模板目录/模板详情类型定义。
- `electron-builder.yml`：将 `src/features/subagents/templates` 打包到 `resources/subagent-templates`。

### 模块依赖与边界

- 模板读取仍走 `renderer -> preload -> main ipc`，保持主进程文件系统访问边界。
- 业务编排保持在 `src/stores/subagents.ts`：创建 agent 后按模板拷贝 5 个 md 文件。
- 主进程仅提供模板元数据与文件内容，不做业务态创建决策。

### 关键决策与原因

1. 模板目录迁入 Matcha-claw 仓库，避免运行时依赖外部 `agency-agents` 邻仓存在。
2. 打包使用 `extraResources` 固化模板资源，保证安装包离线可用。
3. “加载模板”流程只要求选择模型，名称和 emoji 继承模板，满足快速创建诉求。

### 本次变更

- 将 `agency-agents/integrations/openclaw` 全量同步到 `Matcha-claw/src/features/subagents/templates`（144 模板）。
- 新增 `openclaw:getSubagentTemplateCatalog` 与 `openclaw:getSubagentTemplate` IPC。
- SubAgents 页面新增模板卡片与“加载模板”入口。
- 新增模板加载弹窗：只选择模型，创建后自动拷贝模板 md 文件。
- 验证通过：`pnpm run typecheck`、`pnpm test -- tests/unit/subagents.page.test.tsx tests/unit/subagents.store.test.ts`。

## 本次变更日志（2026-03-15 目录分层重构：services/features + team-runtime 迁移）

### 目录树

```text
electron/
├── adapters/
│   └── platform/
│       └── team-runtime/
│           ├── claim-lock.ts
│           ├── mailbox-store.ts
│           ├── runtime-store.ts
│           ├── schema.ts
│           ├── task-store.ts
│           └── types.ts
├── core/
│   └── application/
│       └── team-runtime-service.ts
└── main/
    └── team-ipc-handlers.ts

src/
├── features/
│   ├── subagents/
│   │   └── domain/
│   │       ├── prompt.ts
│   │       └── workspace.ts
│   └── teams/
│       ├── api/
│       │   └── runtime-client.ts
│       ├── domain/
│       │   └── runner-automation.ts
│       └── runtime/
│           └── orchestrator.ts
├── lib/
│   └── sections.ts
└── services/
    └── openclaw/
        ├── agent-runtime.ts
        ├── session-runtime.ts
        ├── task-manager-client.ts
        └── types.ts
```

### 文件职责

- `electron/adapters/platform/team-runtime/*`：团队运行时的文件存储、任务状态机、claim lock、邮箱与事件落盘实现（adapter 侧）。
- `electron/core/application/team-runtime-service.ts`：团队运行时 application service，统一编排 team IPC 的业务流程。
- `electron/main/team-ipc-handlers.ts`：仅做参数校验与 application service 调用，不再直接拼业务流程。
- `src/services/openclaw/*`：OpenClaw/Gateway 客户端能力，归并为基础设施服务层。
- `src/features/subagents/domain/*`：Subagent 领域规则（workspace/prompt）。
- `src/features/teams/api/runtime-client.ts`：Teams 运行时 IPC 客户端访问层。
- `src/features/teams/domain/runner-automation.ts`：Teams 自动仲裁与指令解析领域规则。
- `src/features/teams/runtime/orchestrator.ts`：Teams 运行时编排器，归并到 teams feature 域。
- `src/lib/sections.ts`：通用设置分区链接与解析函数（移除 `src/lib/settings` 目录层）。

### 模块依赖与边界

- `main -> core/application -> adapters` 方向收敛，主进程 team IPC 去业务化。
- `services/openclaw` 独立承载外部运行时访问能力，避免与 feature/domain 混杂。
- `features/subagents/domain` 与 `features/teams/runtime` 承载业务域规则与编排。

### 关键决策与原因

1. 将 `team-runtime` 从 `electron/main` 迁出，消除 host-shell 层业务实现堆积。
2. 用 `TeamRuntimeApplicationService` 承接 team 业务流程，确保 IPC handler 只承担输入边界职责。
3. 将 `src/lib/openclaw` 与 `src/lib/subagent` 拆分到 `services` 与 `features/*/domain`，按变化源分层。

### 本次变更

- 完成 `electron/main/team-runtime/* -> electron/adapters/platform/team-runtime/*` 迁移。
- 新增 `electron/core/application/team-runtime-service.ts` 并导出到 application 入口。
- 重构 `electron/main/team-ipc-handlers.ts` 为“参数校验 + 调用 application service”模式。
- 完成 `src/lib/openclaw/* -> src/services/openclaw/*` 迁移并全量改引用。
- 完成 `src/lib/subagent/* -> src/features/subagents/domain/*` 迁移并全量改引用。
- 完成 `src/lib/team/* -> src/features/teams/*` 全量迁移（`runtime-client`、`runner-automation`、`background-orchestrator`）并清理 `src/lib/team`。
- 完成 `src/lib/settings/sections.ts -> src/lib/sections.ts` 迁移并清理 `src/lib/settings`。
- 验证通过：`pnpm run typecheck`、`pnpm run check:trait-boundary`、相关 unit tests（24 tests）。

## 本次变更日志（2026-03-14 Agent 平台化收口：C 阶段主进程瘦身）

### 目录树

```text
electron/
├── adapters/
│   └── platform/
│       └── ipc/
│           ├── cron-ipc.ts
│           ├── gateway-ipc.ts
│           ├── openclaw-ipc.ts
│           ├── provider-ipc.ts
│           └── skill-config-ipc.ts
└── main/
    └── ipc-handlers.ts

docs/
└── plans/
    └── 2026-03-14-agent-platform-cutover-checklist.md
```

### 文件职责

- `electron/adapters/platform/ipc/*.ts`：承接原主进程中的平台业务 IPC 处理逻辑，按能力域拆分（gateway/openclaw/cron/provider/skill-config）。
- `electron/main/ipc-handlers.ts`：收敛为注册与宿主壳层编排入口，减少平台业务细节内嵌。
- `docs/plans/2026-03-14-agent-platform-cutover-checklist.md`：同步 A/B/C 切流完成态与回滚策略。

### 模块依赖与边界

- 维持单向依赖：`core/contracts -> core/application -> adapters -> host-shell`。
- `main/ipc-handlers.ts` 仅依赖 adapter 注册函数，不再维护大段平台业务实现。
- 平台业务入口统一经 `platform-composition-root` / `platform-ipc-facade` 连接 application 层。

### 关键决策与原因

1. C 阶段优先做“主进程去业务化”，避免继续在宿主层堆叠平台语义。
2. 保留兼容链路（如 unified request）以降低切流回归风险。
3. 将 cutover checklist 与代码同步，避免迁移状态口径漂移。

### 本次变更

- 新增 `electron/adapters/platform/ipc/*` 五个模块并接入 `registerIpcHandlers`。
- 清理 `gateway-ipc.ts` 抽取残留与 `cron-ipc.ts` 导出边界问题。
- `ipc-handlers.ts` 迁出 gateway/openclaw/cron/provider/skill-config 业务大段逻辑。
- 同步更新 `2026-03-14-agent-platform-cutover-checklist.md`。
- 验证通过：`check:trait-boundary`、平台相关 unit/integration/contract、`pnpm test`、`pnpm run lint`。

## 本次变更日志（2026-03-14 Agent 平台 Trait 驱动 implementation plan）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-implementation-plan.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-implementation-plan.md`：基于 Trait 驱动架构设计的实施主计划，按任务给出分层落地路径、测试策略、迁移阶段与提交粒度。

### 模块依赖与边界

- 实施目标边界固定为：`core/contracts -> core/application -> adapters/*`，`host-shell` 只保留宿主职责。
- 计划要求 `application` 仅依赖契约，不得引用具体 OpenClaw/Platform 适配实现。
- 迁移按 A/B/C 分阶段推进（双写验证 -> 主链路切换 -> 冗余剥离），并要求三账本一致性验证。

### 关键决策与原因

1. 采用与现有 `implementation-plan` 一致的 TDD 任务模板，保障计划可执行、可审计。
2. 将 Trait 合规门禁与 contract tests 直接纳入实施计划，避免“先改造后补治理”的回归风险。
3. 将主进程迁移与回滚路径写入同一计划，确保架构迁移具备可控切换窗口。

### 本次变更

- 新增 `2026-03-14-agent-platform-implementation-plan.md`。
- 固化 9 个实施任务（contracts/application/adapters/host-shell/门禁/文档收口）。
- 明确最终 DoD：分层依赖、三账本调和、合规门禁、跨层测试与文档同步。

## 本次变更日志（2026-03-14 Agent 平台化实施计划逐文件映射）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-implementation.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-implementation.md`：平台化改造实施主计划，包含现有代码目录逐文件迁移映射、分阶段任务、验收标准与回滚策略。

### 模块依赖与边界

- 明确目标分层：`contracts -> application -> adapters/*`，`host-shell` 仅保留宿主能力。
- 明确 Electron 主进程迁移边界：迁移平台业务逻辑，保留窗口/托盘/系统集成逻辑。
- 明确三账本模型（`GatewayPluginState`/`LocalPluginState`/`ToolRegistry`）与调和路径。

### 关键决策与原因

1. 需求明确要求“按现有代码目录逐文件映射”，因此实施文档采用文件级矩阵而非抽象任务描述。
2. 现有仓库仍是 Electron 生产架构，先做分层收敛和职责拆分，再进行后续运行时演进，降低一次性重构风险。
3. 保留 `gateway-client` 并行客户端为可选路径，不作为主链路，避免与主进程治理路径混淆。

### 本次变更

- 新增 `2026-03-14-agent-platform-implementation.md`。
- 固化 6 组目录（`electron/main`、`electron/main/team-runtime`、`electron/gateway`、`electron/api`、`electron/services/*`、`src/lib/*`）逐文件映射。
- 提供 7 个可执行任务（含测试与提交粒度）和统一 DoD/回滚策略。

## 本次变更日志（2026-03-14 Cron 手动/定时双配置执行）

### 目录树

```text
electron/
├── utils/
│   └── cron-manual-trigger.ts
├── main/
│   └── ipc-handlers.ts
└── api/
    └── routes/
        └── cron.ts

tests/
└── unit/
    └── cron-manual-trigger.test.ts
```

### 文件职责

- `electron/utils/cron-manual-trigger.ts`：封装“手动执行临时切换配置 -> 触发 -> 后台恢复原配置”的统一流程。
- `electron/api/routes/cron.ts`：将 `/api/cron/trigger` 改为使用统一手动触发流程。
- `tests/unit/cron-manual-trigger.test.ts`：覆盖手动切换条件与 patch 生成逻辑。

### 模块依赖与边界

- 渲染层不直接改动，仍通过 `IPC/Host API -> Gateway RPC`。
- Cron 触发行为统一收口到 `electron/utils/cron-manual-trigger.ts`，避免路由与 IPC 双实现漂移。
- 仅改“手动触发路径”，定时调度创建/执行路径保持不变。

### 关键决策与原因

1. 当前 OpenClaw 手动 `cron.run` 对 `isolated + agentTurn` 存在执行路径问题，导致手动触发不稳定。
2. 采用“双配置策略”：定时保留 `isolated + agentTurn`，手动临时切 `main + systemEvent` 后执行。
3. 为避免污染定时配置，手动执行完成后后台自动恢复原始字段。

### 本次变更

- 新增 Cron 手动触发统一工具，提供切换与恢复机制。
- `/api/cron/trigger` 改为复用该工具。
- 补充单测并通过（含既有 cron 会话回填用例回归）。

## 本次变更日志（2026-03-14 Trait 驱动架构强化 v2）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：严格 Trait 驱动版架构文档，新增契约层、依赖方向、合规门禁与测试基线。

### 模块依赖与边界

- 架构分层明确为 `core/contracts -> core/application -> adapters/*`，并隔离 `host-shell`。
- 核心边界由组件描述升级为 Trait 契约清单（不再只保留 RuntimeDriver 单点抽象）。
- 统一三账本模型与 `ReconcilerPort` 调和机制。

### 关键决策与原因

1. 修复“半 Trait 化”问题，避免应用层感知具体运行时实现。
2. 通过依赖方向禁令与 PR 合规门禁，避免后续架构回退。
3. 将主进程迁移策略与契约测试策略固化为可执行工程规则。

### 本次变更

- 全量重写架构文档为 Trait 驱动 v2。
- 新增核心 Trait：`ToolRegistryPort`、`ContextAssemblerPort`、`ToolExecutorPort`、`RuntimeManagerPort`、`PolicyEnginePort`、`AuditSinkPort`、`EventBusPort`、`ReconcilerPort`。
- 新增“Trait 驱动合规门禁”和“测试策略（Contract/Adapter/Migration）”章节。

## 本次变更日志（2026-03-14 架构最终定稿 + 主进程迁移矩阵）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：平台架构最终定稿，明确“统一控制面 + 被纳管运行时”模型，并加入 Electron 主进程逻辑迁移策略。

### 模块依赖与边界

- 新增 `AgentRuntimeDriver` 契约中心化表达，统一 Runtime 接入与工具纳管。
- 以三账本（`GatewayPluginState` / `LocalPluginState` / `ToolRegistry`）定义状态一致性边界。
- 明确主进程分层：平台业务逻辑迁入 Core，OS 集成能力保留在 Host Shell。

### 关键决策与原因

1. 采用“控制面/资源门户”定位，避免平台与 OpenClaw 职责重叠。
2. 将“Electron 主进程是否迁移”从口头结论固化为迁移矩阵与阶段顺序。
3. 用 Driver + Reconciler 约束上游变动风险和状态漂移风险。

### 本次变更

- 按最终定稿结构重写架构文档（原则、概念、分层、流程、状态同步、迁移、风险、冻结）。
- 新增第 6 章《Electron 主进程逻辑迁移策略（必答）》。
- 收敛并统一 OpenClaw 接入边界与工具治理口径。

## 本次变更日志（2026-03-14 架构文档重整）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：平台架构主文档（重整版），统一为“最小内核 + 平台能力插件域 + OpenClaw 接入契约”结构。

### 模块依赖与边界

- 内核边界与插件域边界分离，避免把具体业务语义放入内核。
- 明确 OpenClaw 原生插件/skill（上游）能力归属，平台只做接入、映射、治理。
- 将状态权威源、热插拔分级、迁移路线、冻结清单统一到同一结构中。

### 关键决策与原因

1. 原文档章节层次过深、重复描述较多，阅读路径不直观。
2. 通过“先总纲、再边界、再接入、再治理、再迁移”重排，降低认知跳转成本。
3. 统一术语后，避免将 `OpenClawPluginBridge` 误解为“实现 skill 能力”的组件。

### 本次变更

- 全量重写 `2026-03-14-agent-platform-full-architecture-design.md` 为简洁结构版。
- 统一 `OpenClaw 原生插件/skill（上游）` 口径。
- 收敛章节为：定位、架构、边界、接入、状态、治理、安全、版本、迁移、风险、冻结、准入。
- 补回 `AgentRuntimeProvider` 契约定义，并明确 `OpenClawCapabilityAdapter` 是当前默认 provider 实现。
- 将状态模型改为分账：`GatewayPluginState` / `LocalPluginState` / `ToolRegistry`（派生视图）。

## 本次变更日志（2026-03-14 OpenClaw 接口语义澄清）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：平台化架构设计主文档，明确“最小内核 + 能力插件域”边界与 OpenClaw 接入语义。

### 模块依赖与边界

- OpenClaw 能力来源明确为：Gateway RPC、Gateway 事件流、OpenClaw 插件 Hook 运行时。
- `OpenClawPluginBridge` 边界明确为：接口调用、状态同步、语义映射、审计纳管；不实现 skill 本体逻辑、不承载 Hook 执行器。
- 平台内核仅负责治理与基础设施，不在内核中二次实现 OpenClaw 原生机制。

### 关键决策与原因

1. 消除“Bridge 赋能 skill”语义歧义，避免错误实现方向（误把平台写成 OpenClaw 替代层）。
2. 把 OpenClaw 对外能力事实锚定到三份基线文档，确保后续开发有可核对依据。
3. 在插件纳管规则中显式写入 Hook 归属，防止团队重复造 Hook 执行框架。

### 本次变更

- 在架构文档新增“OpenClaw 对外接口事实”章节，引用 RPC/Event/Hook 基线。
- 将 `OpenClawPluginBridge` 相关描述统一为“接入/映射/治理”语义。
- 在 OpenClaw 插件纳管规则补充“Hook 归属”约束。

## 本次变更日志（2026-03-11 团队执行器闭环补齐）

### 目录树

```text
src/
├── components/runtime/
│   └── TeamsRuntimeDaemon.tsx
├── lib/team/
│   ├── background-orchestrator.ts
│   └── runner-automation.ts
├── stores/
│   └── teams-runner.ts
└── pages/Teams/
    ├── TeamChat.tsx
    └── useTeamAutoRunner.ts (已删除)

electron/main/team-runtime/
└── schema.ts

tests/unit/
├── team-runner-automation.test.ts
├── team-runtime-schema.test.ts
└── team-runtime-task-store.test.ts

docs/plans/
└── 2026-03-09-teams-minimal-pull-mailbox-design.md
```

### 文件职责

- `TeamsRuntimeDaemon.tsx`：应用级后台守护组件，负责启动/停止团队执行编排器。
- `background-orchestrator.ts`：后台常驻调度（自动认领、执行、阻塞决策、自动规划）。
- `runner-automation.ts`：阻塞决策解析、自动仲裁、proposal 标题提取等纯逻辑。
- `teams-runner.ts`：后台执行状态存储（开关、活跃成员、活跃任务、错误）。
- `TeamChat.tsx`：团队页展示与手动操作入口，消费全局 runner 状态，不再承载执行循环。
- `schema.ts`：任务状态机约束，新增 `blocked -> todo` 以支持重试回队列。

### 模块依赖与边界

- 执行循环从页面侧迁移到全局后台 daemon，UI 与执行编排解耦。
- 渲染层继续通过 `teams store -> runtime-client -> IPC(team:*)` 访问运行时。
- 阻塞决策/自动规划仅操作 `team:*` 契约，不新增旁路状态源。

### 关键决策与原因

1. 用全局 daemon 替代页面挂载执行，解决“切页即停工”的架构问题。
2. 阻塞流程改为 mailbox 决策闭环，避免失败后任务无人处理。
3. lead 自动处理 proposal 与超时仲裁，补齐最小自治协作能力。
4. 将“完成判定”收紧为“run 完成且产生新的 assistant 回复”，避免旧消息误判完成。

### 本次变更

- 新增后台常驻执行器、全局 runner store、自动决策工具模块。
- 删除旧 `useTeamAutoRunner.ts` 页面内执行器。
- 补齐 `blocked -> todo` 状态迁移与对应单测。
- 更新团队方案文档，补齐并发/接管/回归测试矩阵与验证命令。

## 本次变更日志（2026-03-11 团队自动执行首版）

- 新增 `src/pages/Teams/useTeamAutoRunner.ts`：团队成员自动执行循环（claim -> running -> chat.send -> done/failed -> release）。
- `src/pages/Teams/TeamChat.tsx` 接入自动执行开关与运行状态展示，支持一键暂停/恢复。
- 新增团队自动执行错误提示与活跃成员计数，便于观察任务分配与执行进度。
- 更新 `src/i18n/locales/{zh,en,ja}/teams.json`，补齐自动执行相关文案。

## 目录树（本次 0001 迁移相关）

```text
src/
├── constants/
│   └── subagent-files.ts
├── lib/
│   ├── line-diff.ts
│   ├── openclaw/
│   │   ├── types.ts
│   │   ├── session-runtime.ts
│   │   └── agent-runtime.ts
│   ├── settings/
│   │   └── sections.ts
│   ├── subagent/
│   │   ├── prompt.ts
│   │   └── workspace.ts
│   └── team/ (已移除 0001 临时依赖文件 `roles-metadata.ts`)
├── pages/
│   └── SubAgents/
│       ├── index.tsx
│       └── components/
│           ├── SubagentCard.tsx
│           ├── SubagentDeleteDialog.tsx
│           ├── SubagentDiffPreview.tsx
│           ├── SubagentFormDialog.tsx
│           └── SubagentManageDialog.tsx
├── stores/
│   └── subagents.ts
├── types/
│   └── subagent.ts
└── i18n/
    └── locales/
        ├── en/subagents.json
        ├── zh/subagents.json
        └── ja/subagents.json

tests/
└── unit/
    ├── subagent-types.test.ts
    ├── subagent-workspace.test.ts
    ├── subagents.crud.test.ts
    ├── subagents.default-agent.test.ts
    ├── subagents.diff-and-apply.test.ts
    ├── subagents.diff-preview.test.tsx
    ├── subagents.navigation.test.tsx
    ├── subagents.page.test.tsx
    ├── subagents.prompt-pipeline.test.ts
    └── subagents.store.test.ts
```

## 文件职责（关键模块）

- `src/stores/subagents.ts`：子代理领域状态、CRUD、草稿生成、Diff 预览与应用主流程。
- `src/lib/subagent/prompt.ts`：提示词拼装、模型输出解析与草稿结构校验。
- `src/lib/subagent/workspace.ts`：子代理目录与命名规范、冲突检测。
- `src/lib/openclaw/*`：草稿生成依赖的会话/运行时 RPC 抽象。
- `src/pages/SubAgents/*`：子代理页面与对话框组件。
- `src/constants/subagent-files.ts`：可管理目标文件白名单常量。
- `src/types/subagent.ts`：子代理领域类型定义。
- `src/i18n/locales/*/subagents.json`：子代理页面三语文案。

## 模块依赖与边界

- 渲染层统一通过 `src/lib/api-client.ts` 的 `invokeIpc` 调后端，不新增直连 `window.electron.ipcRenderer.invoke(...)`。
- `pages/SubAgents` 只依赖 `stores/subagents`，UI 不直接编排 RPC。
- `stores/subagents` 负责组合 `lib/subagent/*`、`lib/openclaw/*` 完成业务流程。
- `App/Sidebar/i18n` 只负责路由、导航与文案注册，不承载业务逻辑。

## 关键决策与原因

1. 完整迁移 0001 功能，但按“最小依赖原则”仅抽取直接依赖模块。
2. 复用现有框架边界（`invokeIpc` + store 驱动 UI），移除补丁中冗余或越层调用模式。
3. 保持默认 `main` agent 只读策略，避免误删/误改核心代理。
4. 草稿输出强约束为结构化 JSON，仅保留 `files` 草稿载荷，移除辅助元数据链路避免与现架构冲突。
5. 0001 范围测试与后续补丁能力解耦（导航测试移除 `AgentSessionsPane` 依赖）。

## 本次变更日志

- 日期：2026-03-10
- 变更主题：`feat(subagents): migrate patch-0001 with framework adaptation`
- 主要结果：
  - 新增 SubAgents 页面、子代理 store、提示词/工作区/Diff 核心逻辑。
  - 接入路由 `/subagents`、侧边栏入口与三语文案命名空间。
  - 完成 0001 相关单元测试接入与适配。
  - 补齐三语 README 的子代理能力说明与结构说明同步。

---

## 目录树（本次 0003 迁移相关）

```text
packages/
└── openclaw-task-manager-plugin/
    ├── openclaw.plugin.json
    ├── package.json
    ├── tsconfig.json
    ├── skills/task-manager/SKILL.md
    └── src/
        ├── index.ts
        ├── progress-parser.ts
        ├── task-store.ts
        ├── trigger-detector.ts
        └── hooks/before-agent-start.ts

src/
├── lib/
│   ├── openclaw/task-manager-client.ts
│   └── task-inbox.ts
├── stores/
│   ├── task-center-store.ts
│   ├── task-inbox-store.ts
│   └── gateway.ts (task_* 事件分发)
├── pages/
│   ├── Tasks/
│   │   ├── index.tsx
│   │   └── checklist-parser.ts
│   └── Chat/
│       ├── index.tsx
│       └── components/TaskInboxPanel.tsx
├── i18n/
│   ├── index.ts
│   └── locales/*/(tasks.json, chat.json, common.json)
└── App.tsx / components/layout/Sidebar.tsx

electron/
├── main/ipc-handlers.ts
└── preload/index.ts

scripts/
├── bundle-openclaw-plugins.mjs
└── after-pack.cjs

tests/unit/
├── task-manager-client.test.ts
├── task-inbox-domain.test.ts
├── task-inbox-store.test.ts
├── task-center-store.test.ts
├── tasks-checklist-parser.test.ts
└── tasks.navigation.test.tsx
```

## 文件职责（关键模块）

- `packages/openclaw-task-manager-plugin/*`：OpenClaw task-manager 插件实现（任务创建/进度解析/阻塞恢复等网关方法）
- `src/lib/openclaw/task-manager-client.ts`：任务领域 RPC/IPC 客户端，统一通过 `invokeIpc`
- `src/stores/task-inbox-store.ts`：Chat 侧“任务收件箱”状态与恢复动作
- `src/stores/task-center-store.ts`：Tasks 页状态、插件安装状态、阻塞队列管理
- `src/stores/gateway.ts`：网关通知统一入口，新增 `task_*` 事件到任务 store 的分发
- `electron/main/ipc-handlers.ts`：任务插件安装/状态查询、workspace 目录查询 IPC
- `scripts/*openclaw-plugins*`：将本地 task-manager 插件纳入构建与打包资源

## 模块依赖与边界

- Renderer 侧新增任务能力全部走 `api-client`（`invokeIpc`），不新增页面直连 IPC invoke
- 页面组件仅依赖 task stores；网关事件由 `gateway store` 统一分发
- 任务插件安装与启用策略仅在 main 进程落地（renderer 不改写 openclaw 配置文件）
- Tasks 独立页面与 Chat 侧任务面板共享同一任务协议模型（`Task`, `TaskNotification`）

## 关键决策与原因

1. 复用现有 `host-api/api-client + zustand + i18n + 路由` 模式，避免补丁私有调用链侵入
2. 将 `task_*` 事件分发下沉到 `gateway store`，消除页面级 IPC 监听重复逻辑
3. 插件安装链路在 0003 内闭环（本地包 + 构建脚本 + main IPC），不依赖后续补丁
4. 任务详情进度采用 `checklist-parser` 解析 markdown，保证任务计划可视化可验证

## 本次变更日志

- 日期：2026-03-10
- 变更主题：`feat(tasks): migrate patch-0003 task-manager with framework adaptation`
- 主要结果：
  - 接入 `/tasks` 页面、侧边栏 Tasks 导航、Chat 任务收件箱
  - 新增 task 领域客户端与 stores，并纳入 gateway 通知总线分发
  - 新增 main/preload task 插件安装与状态 IPC，补齐 workspace 查询能力
  - 新增本地 task-manager 插件包并接入打包脚本
  - 新增任务领域与导航相关单测并通过全量测试

---

## 目录树（本次 0004 迁移相关）

```text
src/
├── components/layout/
│   ├── AgentSessionsPane.tsx
│   ├── PaneEdgeToggle.tsx
│   ├── VerticalPaneResizer.tsx
│   ├── MainLayout.tsx (改造：双侧分栏 + 拖拽宽度)
│   └── Sidebar.tsx (改造：导航职责收敛 + Chat 入口行为修正)
├── pages/Chat/
│   ├── ChatInput.tsx (新增 @mention、/skill、技能标签)
│   ├── ChatMessage.tsx (新增头像能力、文件路径 hint 链接化)
│   └── index.tsx (改造：任务收件箱分栏宽度持久化、会话 query 跳转)
├── stores/
│   └── chat.ts (统一会话标题提取与 loadHistory 竞态保护)
└── i18n/locales/*/common.json

tests/unit/
├── chat-input-mention.test.tsx
├── chat-message-avatar.test.tsx
├── chat-session-labeling.test.ts
└── sidebar.chat-nav.test.tsx
```

## 文件职责（关键模块）

- `src/components/layout/AgentSessionsPane.tsx`：按 agent 分组展示会话，负责组折叠、会话切换、新会话入口
- `src/components/layout/VerticalPaneResizer.tsx`：统一竖向分栏拖拽条组件
- `src/components/layout/PaneEdgeToggle.tsx`：统一边缘折叠/展开触发器
- `src/pages/Chat/ChatInput.tsx`：聊天输入增强（mention、技能快捷选择、发送前技能前缀拼装）
- `src/pages/Chat/ChatMessage.tsx`：消息展示增强（assistant emoji、user avatar、文件路径提示可点开目录）
- `src/stores/chat.ts`：会话标题提取策略与历史加载竞态保护

## 模块依赖与边界

- Renderer 侧继续统一通过 `host-api/api-client`，未新增页面内直连 `window.electron.ipcRenderer.invoke`
- 会话/消息业务状态统一由 `chat store` 持有，UI 仅消费状态并派发动作
- 文案通过 i18n common 侧边栏 key 扩展，不在组件内硬编码导航文案
- 主布局分栏能力在 `layout` 组件层闭环，不向业务 store 泄漏拖拽细节

## 关键决策与原因

1. 0004 的“会话导航 + 聊天输入增强 + 分栏交互”按现框架落地，避免直接搬补丁私有实现
2. 会话标题统一为“用户有效内容优先，assistant 有效内容兜底（过滤模板句）”，解决纯 assistant 会话标题缺失
3. `loadHistory` 增加会话切换竞态丢弃，避免异步回包覆盖当前会话 UI
4. 侧边栏收敛为导航入口，Agent 会话列表下沉到独立 pane，降低单组件复杂度

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`feat(chat): migrate patch-0004 with framework adaptation`
- 主要结果：
  - 新增 AgentSessionsPane 与统一分栏组件，主布局支持双侧拖拽与折叠持久化
  - ChatInput 增加 `@mention`、`/skill` 与技能标签发送能力
  - ChatMessage 增加用户头像/assistant emoji 与文件路径 hint 可点击打开目录
  - Chat 页接入任务收件箱右侧分栏宽度持久化、`?session/?agent` 跳转
  - 补齐 0004 相关单测并通过 lint/typecheck/全量测试

---

## 目录树（本次 0005 迁移相关）

```text
electron/
├── api/
│   ├── server.ts (接入 license / diagnostics 路由)
│   └── routes/
│       ├── license.ts
│       └── diagnostics.ts
├── main/
│   └── index.ts (启动阶段引导 license gate bootstrap)
└── utils/
    ├── store.ts (新增 setupComplete 与 userAvatarDataUrl)
    ├── hardware-id.ts
    ├── license-config.ts
    ├── license-secret.ts
    └── license.ts

src/
├── App.tsx (setup/license 路由门禁)
├── stores/
│   └── settings.ts (初始化标记、setupComplete 同步、头像持久化)
├── pages/
│   ├── Setup/index.tsx (welcome 前置 license 校验)
│   ├── Settings/index.tsx (分栏结构 + license/taskPlugin/diagnostics/avatar)
│   └── Chat/index.tsx (接入用户头像)
└── i18n/locales/*/
    ├── settings.json
    └── setup.json

scripts/
├── license_server.py
├── license_audit_summary.py
├── license-server-README.md
└── license-release.md

tests/unit/
├── license-validation.test.ts
├── settings.section-switch.test.tsx
└── settings.user-avatar.test.tsx
```

## 文件职责（关键模块）

- `electron/utils/license.ts`：授权门禁核心逻辑（本地校验、在线校验、缓存宽限、重验调度、gate 快照）
- `electron/api/routes/license.ts`：License Host API 路由（gate/stored-key/validate/revalidate/clear）
- `electron/api/routes/diagnostics.ts`：本地诊断包采集与路径返回
- `src/stores/settings.ts`：统一设置状态，新增 setupComplete 与用户头像数据同步
- `src/pages/Setup/index.tsx`：向导 welcome 步骤执行 License 校验前置
- `src/pages/Settings/index.tsx`：设置页分栏入口与授权/诊断/插件/头像管理 UI
- `scripts/license_server.py`：授权码生成、导入导出、解绑、激活服务一体化运维脚本

## 模块依赖与边界

- Renderer 侧新增能力统一走 `hostApiFetch` / `invokeIpc`，未新增页面直连 `window.electron.ipcRenderer.invoke`
- 授权门禁状态只由 Main 侧 `license gate` 维护，前端仅读取快照并触发校验动作
- 设置页分栏复用现有路由 query 与 store 模式，不引入独立状态管理框架
- 诊断采集在 Main 侧聚合日志与设置，Renderer 仅触发并展示结果

## 关键决策与原因

1. 保留完整授权链路（校验、缓存、重验、清除、门禁），但按现有 host-api/api-client 边界落地
2. setup 与 runtime 统一走授权门禁，避免“向导通过但运行时未鉴权”的状态分裂
3. 设置页采用 query 驱动分栏，兼容现有路由与历史导航行为
4. 头像能力直接复用现有 settings store 持久化，不新增独立 profile 子系统
5. 诊断能力先提供本地可收集与可定位路径的最小闭环，再由后续补丁扩展上传/脱敏策略

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`feat(settings): migrate patch-0005 license gate with framework adaptation`
- 主要结果：
  - Setup 增加 License 前置校验，App 增加 setup/license 双重门禁
  - Settings 重构为分栏结构，新增 License、Task Plugin、Diagnostics、用户头像管理
  - Main 新增授权能力（hardware id、密文存储、gate bootstrap、重验调度）并提供 Host API 路由
  - 新增授权服务脚本与运维文档，补齐授权链路发布资料
  - 补齐 license/settings 相关测试并通过全量校验

---

## 目录树（本次 0007 迁移相关）

```text
.github/workflows/
├── check.yml
├── release.yml
└── debug-installer.yml

scripts/
└── update-release-README.md

repo root/
├── .gitattributes
└── .gitignore
```

## 文件职责（关键模块）

- `.github/workflows/release.yml`：统一 Release 构建矩阵、发布文案、OSS `release-info.json` 下载命名。
- `.github/workflows/check.yml`：PR 校验入口（路径忽略 + 并发互斥），降低无效 CI 占用。
- `.github/workflows/debug-installer.yml`：Windows 安装包调试专用工作流，快速定位构建/签名产物问题。
- `scripts/update-release-README.md`：发布链路实操说明（触发方式、通道规则、命名规范、验收清单）。
- `.gitattributes`：统一文本文件换行策略（LF），避免跨平台行尾漂移。
- `.gitignore`：补充本地工具目录忽略，防止无关文件进入版本库。

## 模块依赖与边界

- 仅调整构建与发布基础设施，不改动运行时业务链路（Renderer/Main/Gateway 协议保持不变）。
- 保留现有 `upload-oss` + channel 目录方案，继续兼容 `latest/alpha/beta` 的 updater 读取模式。
- 品牌迁移只做“安全替换层”（Release 文案与产物前缀），兼容层（如 OSS bucket 名）暂保留不动。

## 关键决策与原因

1. 0007 采用“发布链路增量重构”而非替换式重构，避免对现有 updater 通道策略引入回归。
2. `release-info.json` 下载前缀统一为 `MatchaClaw-*`，与当前打包产物命名一致，避免官网链接失配。
3. 新增 `debug-installer` 独立 workflow，缩短安装包问题定位回路，不污染主发布流水线。
4. 未迁移补丁中会改变现网通道语义或引入环境耦合的部分（例如通道改名、强行切换更新地址策略）。

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`chore(release): migrate patch-0007 build/release pipeline with framework adaptation`
- 主要结果：
  - CI/Release workflow 按现有架构完成适配：增加并发控制、手动平台矩阵、Windows 调试打包链路。
  - 发布文案、产物命名、`release-info.json` 链接统一为 MatchaClaw 品牌。
  - 新增发布说明文档 `scripts/update-release-README.md`，沉淀发布与验收标准操作。
  - 顺带修复 `electron/utils/diagnostics-bundle.ts` 两处 lint 阻塞（无行为变更）以通过全量校验。

---

## 目录树（本次 Gateway 插件镜像修复）

```text
electron/gateway/
├── bundled-plugins-mirror.ts (新增)
├── config-sync.ts (接入镜像目录与环境变量注入)
└── process-launcher.ts (启动日志补充镜像目录信息)

tests/unit/
└── bundled-plugins-mirror.test.ts (新增)
```

## 文件职责（关键模块）

- `electron/gateway/bundled-plugins-mirror.ts`：在 Gateway 启动前将 `openclaw/extensions` 镜像到本地目录，避免 pnpm 硬链接触发 OpenClaw 插件安全校验。
- `electron/gateway/config-sync.ts`：把镜像目录注入 `OPENCLAW_BUNDLED_PLUGINS_DIR`，强制 Gateway 从安全目录加载 bundled plugins。
- `tests/unit/bundled-plugins-mirror.test.ts`：验证“硬链接打断、镜像复用、打包模式直连”三类行为。

## 模块依赖与边界

- 仅改 Main/Gateway 启动层，不改 Renderer 业务逻辑与 host-api/api-client 边界。
- 不修改用户 `plugins.entries` 配置结构，仍沿用现有配置模型；只变更 bundled 插件发现目录来源。
- 打包模式保持原行为（直接使用 OpenClaw 自带 extensions 目录）。

## 关键决策与原因

1. 问题根因是 OpenClaw 在读取插件清单时默认 `rejectHardlinks=true`，pnpm `.pnpm` 目录中的文件常为硬链接，导致 `unsafe plugin manifest path`。
2. 采用“复制成普通文件镜像”而不是复用 pnpm 路径，才能从根上规避硬链接校验失败。
3. 增加镜像元信息缓存，源版本未变化时复用目录，避免每次启动全量复制。

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`fix(gateway): mirror bundled plugins to bypass pnpm hardlink validation`
- 主要结果：
  - 开发模式下自动镜像 OpenClaw bundled plugins 到用户目录并注入 `OPENCLAW_BUNDLED_PLUGINS_DIR`。
  - 修复因 pnpm 硬链接导致的 `unsafe plugin manifest path` 与 `plugins.slots.memory: plugin not found` 连锁启动失败。
  - 补齐单测并通过全量 lint/typecheck/test。

---

## 目录树（本次废弃 workspace context merge 流程）

```text
electron/
├── main/
│   └── index.ts (移除 workspace context merge 调用链)
└── utils/
    └── openclaw-workspace.ts (已删除)

resources/
└── context/ (已删除)
```

## 文件职责（关键模块）

- `electron/main/index.ts`：移除启动阶段与 Gateway running 回调中的 workspace `AGENTS/TOOLS` 合并流程，仅保留网关事件桥接。

## 模块依赖与边界

- 移除 Main 进程对 `resources/context` 的隐式文件注入流程，避免运行时对 `~/.openclaw/workspace*` 目录做反复轮询与写入。
- 不影响既有 `host-api/api-client`、Gateway 启动、subagents 主流程与 diagnostics 目录采集能力。

## 关键决策与原因

1. 启动日志中的 `Skipping AGENTS.md/TOOLS.md ... retry x/15` 来自 context merge 轮询，不属于核心运行能力，且会制造噪音。
2. 当前需求明确废弃该流程，因此应删除调用链与资源目录，而非仅降级日志级别。
3. 删除 `electron/utils/openclaw-workspace.ts` 与 `resources/context`，防止后续被误引用导致“逻辑已废弃但代码残留”。

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`refactor(main): remove workspace context merge bootstrap flow`
- 主要结果：
  - 删除 `openclaw-workspace` 全模块与 `resources/context` 目录
  - 移除 `main/index.ts` 中全部 context merge/repair 触发点
  - 启动阶段不再打印 `MatchaClaw context merge` 与 `Skipping AGENTS/TOOLS` 轮询日志

---

## 目录树（本次 Host API 代理与端口修复）

```text
electron/
├── main/
│   └── ipc-handlers.ts (新增 hostapi:fetch 主进程代理实现)
├── api/
│   └── server.ts (Host API 端口解析兜底)
├── utils/
│   └── config.ts (Host API 端口键切换为 MATCHACLAW_HOST_API)
└── gateway/
    └── bundled-plugins-mirror.ts (镜像日志改为 ASCII)

tests/unit/
└── config.ports.test.ts (端口键/环境变量规则测试更新)
```

## 文件职责（关键模块）

- `electron/main/ipc-handlers.ts`：注册 `hostapi:fetch`，统一把 renderer 请求代理到本地 Host API。
- `electron/api/server.ts`：以 `resolvedPort` 启动 Host API，避免非法端口导致 `undefined` 日志与监听异常。
- `electron/utils/config.ts`：Host API 端口主键统一为 `MATCHACLAW_HOST_API`，并约束 Host API 仅读取 `MATCHACLAW_PORT_MATCHACLAW_HOST_API`。
- `electron/gateway/bundled-plugins-mirror.ts`：镜像目录日志统一 ASCII 文案，避免控制台乱码。
- `tests/unit/config.ports.test.ts`：验证 Host API 端口新键读取与旧兼容变量失效行为。

## 模块依赖与边界

- Renderer 仍经 `host-api/api-client` 调用，不新增页面直连 IPC 。
- 主进程通过 `hostapi:fetch` 代理访问 Host API；Host API 与 Gateway 通信边界不变。
- 端口配置权责集中到 `electron/utils/config.ts`，避免多处硬编码。

## 关键决策与原因

1. `hostapi:fetch` 需要主进程实际 handler，避免 `No handler registered for 'hostapi:fetch'`。
2. Host API 启动使用 `resolvedPort`，避免端口空值污染监听与日志。
3. 按要求去除 `CLAWX_HOST_API` 兼容，防止配置源混杂。
4. 日志改 ASCII，规避 Windows 控制台编码导致的中文乱码。

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`fix(host-api): wire hostapi proxy and normalize MATCHACLAW host api port`
- 主要结果：
  - 新增主进程 `hostapi:fetch` 代理实现，前端 Host API 调用链恢复可用。
  - 修复 Host API 端口解析兜底，消除 `http://127.0.0.1:undefined`。
  - Host API 端口键统一为 `MATCHACLAW_HOST_API`，并移除 `CLAWX_HOST_API` 兼容读取。
  - 插件镜像日志改为 ASCII 文案并补齐端口配置单测。

---

## 目录树（本次发布链路切换到 supercnm 更新目录）

```text
.github/workflows/
└── release.yml (移除 upload-oss/finalize，改为 publish 内服务器推送)

electron/
├── main/
│   └── updater.ts (移除运行时强制 OSS feed 覆盖)
└── ../electron-builder.yml (publish.generic 改为 supercnm 更新地址)

scripts/
└── update-release-README.md (发布文档改为服务器目录发布模型)
```

## 文件职责（关键模块）

- `.github/workflows/release.yml`：在 `publish` 作业中聚合产物、推送更新文件到远端目录、创建 GitHub Release。
- `electron-builder.yml`：定义更新主源为 `https://www.supercnm.top/claw-update`，并保留 GitHub fallback。
- `electron/main/updater.ts`：按版本设置 `autoUpdater.channel`，不再在代码里硬编码 OSS feed URL。
- `scripts/update-release-README.md`：同步更新发布参数、通道规则与排障预期。

## 模块依赖与边界

- 更新源选择交由 `electron-builder` 的 publish 配置主导，主进程不再重写 feed URL。
- 发布链路不再依赖阿里云 OSS 专用流程（`upload-oss`、`finalize` 已废弃）。
- 仍保留 GitHub Release 作为分发与回退通道。

## 关键决策与原因

1. 与 `patch/0007` 意图对齐，统一更新入口到 `https://www.supercnm.top/claw-update`。
2. 消除“workflow 指向新域名但客户端仍指向旧 OSS 域名”的双源漂移风险。
3. 将发布步骤收敛到单一 `publish` 作业，减少跨作业时序与通道状态复杂度。

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`chore(release): switch updater source to supercnm claw-update and retire oss pipeline`
- 主要结果：
  - `release.yml` 删除 `upload-oss/finalize`，新增服务器目录推送步骤与缺参跳过策略
  - `electron-builder.yml` 更新主更新源到 `https://www.supercnm.top/claw-update`
  - `updater.ts` 移除硬编码 OSS feed 覆盖，改为仅设置 `autoUpdater.channel`
  - 发布说明文档同步为新发布模型

---

## 目录树（本次任务可见性修复）

```text
electron/
├── main/
│   └── ipc-handlers.ts (任务 workspace scope 解析改造)
└── utils/
    └── task-workspace-scope.ts (新增：主工作区/任务 scope 统一解析)

src/stores/
├── task-inbox-store.ts (兼容 task_created/task_create 等 task_* 事件兜底入列)
└── task-center-store.ts (兼容 task_created/task_create 等 task_* 事件兜底入列)

tests/unit/
├── task-workspace-scope.test.ts (新增：scope 回退与合并规则)
├── task-inbox-store.test.ts (新增 task_created 入列用例)
└── task-center-store.test.ts (新增 task_created 入列用例)
```

## 文件职责（关键模块）

- `electron/utils/task-workspace-scope.ts`：统一解析主工作区与任务读取 scope；配置缺失时回退到 `<openclawConfigDir>/workspace`。
- `electron/main/ipc-handlers.ts`：`openclaw:getWorkspaceDir` 与 `openclaw:getTaskWorkspaceDirs` 改为复用统一解析器，避免主工作区漏读。
- `src/stores/task-inbox-store.ts`：在保留既有事件分支的同时，对携带 `params.task` 的 `task_*` 通知做兜底 upsert。
- `src/stores/task-center-store.ts`：同上，补齐任务页对新增任务事件的实时入列能力。

## 模块依赖与边界

- 仅调整 Main 的任务 scope 计算与 Renderer 任务 store 事件消费，不改变 `host-api/api-client` 通信边界。
- 不改 Task Manager 插件协议与任务持久化格式；仍沿用 `task_list/task_get/task_resume`。
- UI 侧继续通过 store 拉取与订阅，不引入页面级临时协议分支。

## 关键决策与原因

1. 任务创建成功但 UI 不显示的主因是 scope 漏读主工作区：当 `agents.defaults.workspace`/`main.workspace` 缺失时，原实现无法覆盖 `~/.openclaw/workspace`。
2. 任务实时事件存在名称漂移风险（如 `task_created`），仅匹配少数固定方法会导致“创建后不立即出现”。
3. 采用“主因修复 + 事件兜底”组合方案，既保证读取范围正确，也保证新任务实时可见。

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`fix(tasks): 修复任务创建后在收件箱与任务页不可见`
- 主要结果：
  - 任务 workspace scope 统一解析：主工作区缺失配置时回退到 `<openclawConfigDir>/workspace`
  - `openclaw:getTaskWorkspaceDirs` 始终包含主工作区，并合并子代理 workspace
  - 任务收件箱与任务页 store 兼容 `task_created/task_create` 等 `task_*` 新增事件入列
  - 补齐 scope 解析与事件入列单测，防止回归
