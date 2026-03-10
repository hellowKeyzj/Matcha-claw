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
