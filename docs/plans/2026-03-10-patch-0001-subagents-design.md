# 0001 SubAgents 迁移设计

日期：2026-03-10
范围：严格对应 patch/0001 的功能目标，完整交付 SubAgents 能力。

## 1. 目标
- 在现有 Matcha-claw 框架内落地 SubAgents 完整功能：
  - 子智能体列表与管理页面
  - 子智能体创建/编辑/删除
  - 基于提示词生成草稿
  - 多文件差异预览
  - 草稿应用到 agent files
  - 与主聊天入口联动跳转
- 不引入与该功能无关的团队/任务/发布能力。

## 2. 关键约束
- 迁移顺序固定：0001 -> 0008。
- 每个补丁原子提交。
- 每次提交前跑：pnpm run lint / pnpm run typecheck / pnpm test。
- Renderer 侧调用统一走 `src/lib/api-client.ts` 或 `src/lib/host-api.ts`，不新增页面组件直连 `window.electron.ipcRenderer.invoke`。

## 3. 依赖裁剪策略
0001 需要的直接依赖但当前仓库缺失：
- `src/lib/openclaw/types.ts`
- `src/lib/openclaw/session-runtime.ts`
- `src/lib/openclaw/agent-runtime.ts`
- `src/lib/settings/sections.ts`

这些依赖会从后续补丁抽取“最小必要完整实现”，但仅用于完成 0001 功能链路，并明确不引入辅助元数据文件链路。

## 4. 架构落点
- 页面：新增 `src/pages/SubAgents/*`。
- 状态：新增 `src/stores/subagents.ts`。
- 域逻辑：新增 `src/lib/subagent/*` + `src/lib/line-diff.ts`。
- 类型：新增 `src/types/subagent.ts`。
- 路由：`App.tsx` 接入 `/subagents`。
- 导航：`Sidebar.tsx` 接入 SubAgents 入口。
- 国际化：新增中英日 `subagents.json` 并注册到 `src/i18n/index.ts`。

## 5. 兼容与回归控制
- 不改写现有 Chat 主链路，只增加从 SubAgents 进入 Chat 的 query 跳转。
- 对 store 中并发与缓存逻辑保持原补丁行为，再按现有仓库 API 边界做适配。
- 新增/调整单测覆盖：
  - workspace/prompt/类型
  - subagents store CRUD 与草稿流水线
  - 页面导航与对话框行为

## 6. 验收标准
- SubAgents 功能路径可用：新增/编辑/删除/生成草稿/Diff 预览/应用/跳转聊天。
- lint/typecheck/test 全通过。
- 文档同步：CHANGE.md、README 三语按行为变化补充。
