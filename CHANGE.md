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
│   └── team/
│       └── roles-metadata.ts
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
- `src/lib/team/roles-metadata.ts`：角色元数据读写、合并与选择逻辑。
- `src/lib/openclaw/*`：草稿生成依赖的会话/运行时 RPC 抽象。
- `src/pages/SubAgents/*`：子代理页面与对话框组件。
- `src/constants/subagent-files.ts`：可管理目标文件白名单常量。
- `src/types/subagent.ts`：子代理领域类型定义。
- `src/i18n/locales/*/subagents.json`：子代理页面三语文案。

## 模块依赖与边界

- 渲染层统一通过 `src/lib/api-client.ts` 的 `invokeIpc` 调后端，不新增直连 `window.electron.ipcRenderer.invoke(...)`。
- `pages/SubAgents` 只依赖 `stores/subagents`，UI 不直接编排 RPC。
- `stores/subagents` 负责组合 `lib/subagent/*`、`lib/openclaw/*`、`lib/team/roles-metadata.ts` 完成业务流程。
- `App/Sidebar/i18n` 只负责路由、导航与文案注册，不承载业务逻辑。

## 关键决策与原因

1. 完整迁移 0001 功能，但按“最小依赖原则”仅抽取直接依赖模块。
2. 复用现有框架边界（`invokeIpc` + store 驱动 UI），移除补丁中冗余或越层调用模式。
3. 保持默认 `main` agent 只读策略，避免误删/误改核心代理。
4. 草稿输出强约束为结构化 JSON，并要求 `roleMetadata`，保证后续角色元数据同步可用。
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
