# CHANGE.md

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
