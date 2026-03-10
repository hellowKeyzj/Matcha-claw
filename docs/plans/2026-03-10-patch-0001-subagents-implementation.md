# Patch 0001 SubAgents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有框架内完整迁移 0001 SubAgents 功能，并保持与项目 API/路由/i18n/测试规范一致。

**Architecture:** 以 `stores/subagents + pages/SubAgents + lib/subagent` 为核心，前置补齐直接依赖库（openclaw runtime/settings sections），再进行路由与导航接入，最后通过全量校验与文档同步收口。

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, i18next, Electron IPC(API client/host-api)

---

### Task 1: 导入 0001 主体文件并修正依赖

**Files:**
- Create: `src/constants/subagent-files.ts`
- Create: `src/lib/line-diff.ts`
- Create: `src/lib/subagent/prompt.ts`
- Create: `src/lib/subagent/workspace.ts`
- Create: `src/pages/SubAgents/**/*`
- Create: `src/stores/subagents.ts`
- Create: `src/types/subagent.ts`
- Create: `src/i18n/locales/{en,ja,zh}/subagents.json`

**Step 1: 写失败测试（依赖缺失）**
- 新增最小 smoke 测试，验证 `useSubagentsStore` 与 `SubAgents` 页面可被 import。

**Step 2: 运行测试确认失败**
- Run: `pnpm test -- tests/unit/subagents.store.test.ts`

**Step 3: 迁移 0001 主体代码**
- 从 patch 抽取主体文件。
- 将直接 IPC 调用改为 `invokeIpc` 封装。

**Step 4: 运行测试确认转绿**
- Run: `pnpm test -- tests/unit/subagents.store.test.ts tests/unit/subagents.page.test.tsx`

**Step 5: 提交检查点（暂不 commit）**
- 记录编译/测试状态。

### Task 2: 前置补齐直接依赖（仅 0001 所需）

**Files:**
- Create: `src/lib/openclaw/types.ts`
- Create: `src/lib/openclaw/session-runtime.ts`
- Create: `src/lib/openclaw/agent-runtime.ts`
- Create: `src/lib/settings/sections.ts`

**Step 1: 写失败测试**
- 验证 subagents store 依赖函数可调用。

**Step 2: 运行测试确认失败**
- Run: `pnpm test -- tests/unit/subagents.prompt-pipeline.test.ts`

**Step 3: 实现依赖并做边界适配**
- runtime 统一走 `invokeIpc('gateway:rpc', ...)`。
- 不引入 `ROLES_METADATA` 辅助元数据链路，避免与现行架构冲突。

**Step 4: 运行测试确认转绿**
- Run: `pnpm test -- tests/unit/subagents.prompt-pipeline.test.ts tests/unit/subagents.diff-and-apply.test.ts`

**Step 5: 提交检查点（暂不 commit）**
- 记录依赖收敛情况。

### Task 3: 路由、侧栏、i18n 集成

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/i18n/index.ts`

**Step 1: 写失败测试**
- 导航测试验证 `/subagents` 路由可达，侧栏出现入口。

**Step 2: 运行测试确认失败**
- Run: `pnpm test -- tests/unit/subagents.navigation.test.tsx`

**Step 3: 实现集成**
- 注册 namespace `subagents`。
- 侧栏新增条目并保持现有顺序风格。

**Step 4: 运行测试确认转绿**
- Run: `pnpm test -- tests/unit/subagents.navigation.test.tsx tests/unit/subagents.page.test.tsx`

**Step 5: 提交检查点（暂不 commit）**
- 记录 UI 集成验证。

### Task 4: 测试清理与稳定化

**Files:**
- Modify/Create: `tests/setup.ts`
- Modify/Create: `tests/unit/subagents*.test*`

**Step 1: 写/改失败测试**
- 剔除对后续补丁组件的强耦合断言（仅保留 0001 能力断言）。

**Step 2: 运行定向测试确认失败**
- Run: `pnpm test -- tests/unit/subagents*.test*`

**Step 3: 修复实现或测试夹具**
- 对 mock 与 store reset 做统一处理。

**Step 4: 运行定向测试确认转绿**
- Run: `pnpm test -- tests/unit/subagents*.test*`

**Step 5: 提交检查点（暂不 commit）**
- 保证子功能测试稳定。

### Task 5: 全量验证、文档同步、提交

**Files:**
- Create: `CHANGE.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja-JP.md`

**Step 1: 全量验证**
- Run: `pnpm run lint`
- Run: `pnpm run typecheck`
- Run: `pnpm test`

**Step 2: 文档同步**
- 更新 CHANGE.md（目录树、职责、边界、关键决策、变更日志）。
- README 三语补充 SubAgents 功能说明。

**Step 3: 提交**
- `git add -A`
- `git commit -m "feat(subagents): migrate patch-0001 with framework adaptation"`
