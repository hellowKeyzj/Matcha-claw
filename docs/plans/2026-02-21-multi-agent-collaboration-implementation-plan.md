---
date: 2026-02-21
status: draft
topic: Multi-agent collaboration implementation plan
---

# Multi-Agent Collaboration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在桌面端实现多 agent 协作流程（讨论、收敛、计划、执行、REPORT、共享上下文）。

**Architecture:** 新增团队域类型与 store；实现轻量编排器执行 agent 任务并从最终回复解析 REPORT；新增团队列表与团队会话 UI；OpenClaw 仅作为执行层，桌面端维护共享上下文与团队状态。

**Tech Stack:** React, Zustand (persist), TypeScript, Vitest, Electron IPC (`gateway:rpc`), i18n

---

## Task 1: Team 领域类型与 REPORT 解析

**Files:**
- Create: `src/types/team.ts`
- Create: `src/lib/report-parser.ts`
- Test: `tests/unit/report-parser.test.ts`
- Test: `tests/unit/team-types.test.ts`

**Step 1: 先写失败测试（REPORT 解析）**

```ts
import { describe, it, expect } from 'vitest';
import { parseReportFromText } from '@/lib/report-parser';

describe('parseReportFromText', () => {
  it('parses REPORT JSON from final reply text', () => {
    const text = 'Done.\nREPORT: {"reportId":"T-1:a:run-1","task_id":"T-1","agent_id":"a","status":"done","result":["x"]}';
    const report = parseReportFromText(text);
    expect(report?.reportId).toBe('T-1:a:run-1');
    expect(report?.status).toBe('done');
  });

  it('returns null when REPORT missing', () => {
    expect(parseReportFromText('no report')).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    const text = 'REPORT: {"bad": }';
    expect(parseReportFromText(text)).toBeNull();
  });
});
```

Run: `pnpm test -- tests/unit/report-parser.test.ts`
Expected: FAIL（模块缺失或函数不存在）

**Step 2: 最小实现解析器**

```ts
// src/lib/report-parser.ts
import type { TeamReport } from '@/types/team';

export function parseReportFromText(text: string): TeamReport | null {
  const idx = text.indexOf('REPORT:');
  if (idx < 0) return null;
  const jsonPart = text.slice(idx + 'REPORT:'.length).trim();
  try {
    const parsed = JSON.parse(jsonPart) as TeamReport;
    if (!parsed || typeof parsed.reportId !== 'string' || typeof parsed.status !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
```

**Step 3: 新增 Team 类型**

```ts
// src/types/team.ts
export type TeamReportStatus = 'done' | 'partial' | 'blocked';

export interface TeamReport {
  reportId: string;
  task_id: string;
  agent_id: string;
  status: TeamReportStatus;
  result: string[];
  evidence?: string[];
  next_steps?: string[];
  risks?: string[];
}

export interface TeamContext {
  goal: string;
  plan: string[];
  roles: string[];
  status: string;
  decisions: string[];
  openQuestions: string[];
  artifacts: string[];
  updatedAt: string;
}

export interface Team {
  id: string;
  name: string;
  controllerId: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}
```

**Step 4: 类型测试**

```ts
import { describe, it, expect } from 'vitest';
import type { TeamReport, Team } from '@/types/team';

describe('team types', () => {
  it('accepts required Team fields', () => {
    const team: Team = {
      id: 't1',
      name: 'Team',
      controllerId: 'main',
      memberIds: ['main'],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(team.controllerId).toBe('main');
  });

  it('accepts required TeamReport fields', () => {
    const report: TeamReport = {
      reportId: 'r1',
      task_id: 't1',
      agent_id: 'a1',
      status: 'done',
      result: ['x'],
    };
    expect(report.result.length).toBe(1);
  });
});
```

Run: `pnpm test -- tests/unit/team-types.test.ts`
Expected: FAIL then PASS

**Step 5: Commit**

```bash
git add src/types/team.ts src/lib/report-parser.ts tests/unit/report-parser.test.ts tests/unit/team-types.test.ts
git commit -m "feat: add team types and report parser"
```

---

## Task 2: Team store（全局持久化）

**Files:**
- Create: `src/stores/teams.ts`
- Test: `tests/unit/teams.store.test.ts`

**Step 1: 先写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamsStore } from '@/stores/teams';

describe('teams store', () => {
  beforeEach(() => {
    useTeamsStore.setState({ teams: [], activeTeamId: null, teamContexts: {} });
  });

  it('creates and selects a team', () => {
    const { createTeam } = useTeamsStore.getState();
    const id = createTeam({ name: 'Team A', controllerId: 'main', memberIds: ['main'] });
    expect(useTeamsStore.getState().activeTeamId).toBe(id);
  });
});
```

Run: `pnpm test -- tests/unit/teams.store.test.ts`
Expected: FAIL（store 不存在）

**Step 2: 实现 store**

```ts
// src/stores/teams.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Team, TeamContext, TeamReport } from '@/types/team';

interface TeamsState {
  teams: Team[];
  activeTeamId: string | null;
  teamContexts: Record<string, TeamContext>;
  teamReports: Record<string, TeamReport[]>;
  teamSessionKeys: Record<string, Record<string, string>>;
  createTeam: (input: { name: string; controllerId: string; memberIds: string[] }) => string;
  setActiveTeam: (id: string | null) => void;
  updateTeam: (team: Team) => void;
  deleteTeam: (id: string) => void;
  updateTeamContext: (teamId: string, ctx: TeamContext) => void;
  appendReport: (teamId: string, report: TeamReport) => void;
  bindTeamMembers: (teamId: string, agentIds: string[]) => void;
}

export const useTeamsStore = create<TeamsState>()(
  persist(
    (set) => ({
      teams: [],
      activeTeamId: null,
      teamContexts: {},
      teamReports: {},
      teamSessionKeys: {},
      createTeam: (input) => {
        const now = Date.now();
        const id = `team-${now}`;
        const team: Team = { id, name: input.name, controllerId: input.controllerId, memberIds: input.memberIds, createdAt: now, updatedAt: now };
        set((state) => ({ teams: [...state.teams, team], activeTeamId: id }));
        return id;
      },
      setActiveTeam: (id) => set({ activeTeamId: id }),
      updateTeam: (team) => set((state) => ({ teams: state.teams.map(t => t.id === team.id ? team : t) })),
      deleteTeam: (id) => set((state) => ({
        teams: state.teams.filter(t => t.id !== id),
        activeTeamId: state.activeTeamId === id ? null : state.activeTeamId,
      })),
      updateTeamContext: (teamId, ctx) => set((state) => ({
        teamContexts: { ...state.teamContexts, [teamId]: ctx },
      })),
      appendReport: (teamId, report) => set((state) => ({
        teamReports: { ...state.teamReports, [teamId]: [...(state.teamReports[teamId] ?? []), report] },
      })),
      bindTeamMembers: (teamId, agentIds) => set((state) => ({
        teamSessionKeys: {
          ...state.teamSessionKeys,
          [teamId]: agentIds.reduce<Record<string, string>>((acc, id) => {
            acc[id] = `agent:${id}:team:${teamId}`;
            return acc;
          }, {}),
        },
      })),
    }),
    { name: 'clawx-teams' }
  )
);
```

**Step 3: 运行测试**

Run: `pnpm test -- tests/unit/teams.store.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/stores/teams.ts tests/unit/teams.store.test.ts
git commit -m "feat: add teams store with persistence"
```

---

## Task 2.5: 成员绑定校验与会话键生成

**Files:**
- Create: `src/lib/team-binding.ts`
- Test: `tests/unit/team-binding.test.ts`

**Step 1: 先写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { buildTeamSessionKey, filterMissingAgents } from '@/lib/team-binding';

describe('team binding', () => {
  it('builds team session key', () => {
    expect(buildTeamSessionKey('a1', 't1')).toBe('agent:a1:team:t1');
  });

  it('filters missing agents', () => {
    const missing = filterMissingAgents(['a1', 'a2'], ['a1']);
    expect(missing).toEqual(['a2']);
  });
});
```

Run: `pnpm test -- tests/unit/team-binding.test.ts`
Expected: FAIL

**Step 2: 实现绑定工具**

```ts
// src/lib/team-binding.ts
export function buildTeamSessionKey(agentId: string, teamId: string): string {
  return `agent:${agentId}:team:${teamId}`;
}

export function filterMissingAgents(teamAgentIds: string[], existingAgentIds: string[]): string[] {
  const set = new Set(existingAgentIds);
  return teamAgentIds.filter((id) => !set.has(id));
}
```

**Step 3: 运行测试**

Run: `pnpm test -- tests/unit/team-binding.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/team-binding.ts tests/unit/team-binding.test.ts
git commit -m "feat: add team binding helpers"
```

---

## Task 3: 编排器（执行 + REPORT 采集）

**Files:**
- Create: `src/lib/team-orchestrator.ts`
- Test: `tests/unit/team-orchestrator.test.ts`

**Step 1: 先写失败测试（mock gateway:rpc）**

```ts
import { describe, it, expect, vi } from 'vitest';
import { runAgentAndCollectReport } from '@/lib/team-orchestrator';

describe('team orchestrator', () => {
  it('runs agent, waits, and parses report', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({ success: true, result: { runId: 'r1', status: 'accepted' } })
      .mockResolvedValueOnce({ success: true, result: { runId: 'r1', status: 'ok' } })
      .mockResolvedValueOnce({ success: true, result: { messages: [{ role: 'assistant', content: 'REPORT: {"reportId":"r1","task_id":"t1","agent_id":"a1","status":"done","result":["x"]}' }] } });

    const report = await runAgentAndCollectReport({
      agentId: 'a1',
      sessionKey: 'agent:a1:team-1',
      message: 'do task',
      idempotencyKey: 'k1',
    });

    expect(report?.status).toBe('done');
  });
});
```

Run: `pnpm test -- tests/unit/team-orchestrator.test.ts`
Expected: FAIL（模块缺失）

**Step 2: 实现编排器**

```ts
// src/lib/team-orchestrator.ts
import { parseReportFromText } from '@/lib/report-parser';
import type { TeamReport } from '@/types/team';

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const res = await window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs) as { success: boolean; result?: T; error?: string };
  if (!res.success) throw new Error(res.error || `RPC failed: ${method}`);
  return res.result as T;
}

export async function runAgentAndCollectReport(input: {
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<TeamReport | null> {
  const run = await rpc<{ runId: string }>('agent', {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    message: input.message,
    idempotencyKey: input.idempotencyKey,
  });
  await rpc('agent.wait', { runId: run.runId, timeoutMs: 180000 });
  const history = await rpc<{ messages?: Array<{ role?: string; content?: unknown }> }>('chat.history', {
    sessionKey: input.sessionKey,
    limit: 1,
  });
  const last = history.messages?.[0];
  const text = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content)
    ? last?.content.map((b: { text?: string }) => b.text ?? '').join('\n')
    : '';
  return parseReportFromText(text);
}
```

**Step 3: 运行测试**

Run: `pnpm test -- tests/unit/team-orchestrator.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/team-orchestrator.ts tests/unit/team-orchestrator.test.ts
git commit -m "feat: add team orchestrator for report collection"
```

---

## Task 4: 团队列表 UI + 路由

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Create: `src/pages/Teams/index.tsx`
- Test: `tests/unit/teams.page.test.tsx`

**Step 1: 先写失败 UI 测试**

```tsx
import { render, screen } from '@testing-library/react';
import { TeamsPage } from '@/pages/Teams';

it('renders team list heading', () => {
  render(<TeamsPage />);
  expect(screen.getByText(/Teams/i)).toBeInTheDocument();
});
```

Run: `pnpm test -- tests/unit/teams.page.test.tsx`
Expected: FAIL

**Step 2: 加路由 + 侧边栏入口**

```tsx
// src/App.tsx
<Route path="/teams" element={<TeamsPage />} />

// src/components/layout/Sidebar.tsx
{ to: '/teams', icon: <Users className="h-5 w-5" />, label: t('sidebar.teams') },
```

**Step 3: 实现 TeamsPage**

```tsx
// src/pages/Teams/index.tsx
export function TeamsPage() {
  return <div>Teams</div>;
}
```

**补充：首页布局要求（双栏并列）**

- 页面定位：`Agents 工作空间`首页（非仅 Teams 独立页）。
- 顶部栏：标题“Agents 工作空间”，右侧仅 `新建团队`。
- 主体双栏：
  - 左栏 `TeamList`：团队卡片列表（名称/成员数/阶段/最近活跃）。
  - 右栏 `AgentList`：Agent 卡片列表（名称/角色/模型/状态/最近活跃）。
- 默认交互：
  - 点击团队卡片：直接进入团队会话（触发成员绑定流程）。
  - 点击 Agent 卡片：进入该 Agent 的个人会话/配置页。

**Step 4: 运行测试**

Run: `pnpm test -- tests/unit/teams.page.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/App.tsx src/components/layout/Sidebar.tsx src/pages/Teams/index.tsx tests/unit/teams.page.test.tsx
git commit -m "feat: add teams page and navigation"
```

---

## Task 5: 团队会话 UI（讨论 + 收敛）

**Files:**
- Create: `src/pages/Teams/TeamChat.tsx`
- Modify: `src/pages/Teams/index.tsx`
- Modify: `src/stores/teams.ts`
- Test: `tests/unit/team-chat.test.tsx`

**Step 1: 先写失败测试**

```tsx
import { render, screen } from '@testing-library/react';
import { TeamChat } from '@/pages/Teams/TeamChat';

it('renders team chat input', () => {
  render(<TeamChat />);
  expect(screen.getByPlaceholderText(/Send/i)).toBeInTheDocument();
});
```

Run: `pnpm test -- tests/unit/team-chat.test.tsx`
Expected: FAIL

**Step 2: 初始实现 TeamChat（复用 ChatInput/ChatMessage）**

```tsx
export function TeamChat() {
  return (
    <div>
      <ChatInput onSend={() => Promise.resolve()} onStop={() => Promise.resolve()} sending={false} disabled={false} />
    </div>
  );
}
```

**Step 3: 将 TeamChat 接入 TeamsPage**

```tsx
// TeamsPage: 选中 team 时展示 TeamChat
```

**Step 4: 运行测试**

Run: `pnpm test -- tests/unit/team-chat.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/pages/Teams/TeamChat.tsx src/pages/Teams/index.tsx tests/unit/team-chat.test.tsx src/stores/teams.ts
git commit -m "feat: add initial team chat UI"
```

---

## Task 5.5: Agent 面板输出可视化（块式）

**Files:**
- Modify: `src/stores/teams.ts`
- Create: `src/lib/team-output.ts`
- Modify: `src/pages/Teams/TeamChat.tsx`
- Test: `tests/unit/team-output.test.ts`

**Step 1: 先写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchLatestAgentOutput } from '@/lib/team-output';

describe('team output', () => {
  it('fetches latest assistant message', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: { messages: [{ role: 'assistant', content: 'hello' }] },
    });
    const text = await fetchLatestAgentOutput('agent:a1:team:t1');
    expect(text).toBe('hello');
  });
});
```

Run: `pnpm test -- tests/unit/team-output.test.ts`
Expected: FAIL

**Step 2: 实现输出获取工具**

```ts
// src/lib/team-output.ts
async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const res = await window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs) as { success: boolean; result?: T; error?: string };
  if (!res.success) throw new Error(res.error || `RPC failed: ${method}`);
  return res.result as T;
}

export async function fetchLatestAgentOutput(sessionKey: string): Promise<string> {
  const history = await rpc<{ messages?: Array<{ role?: string; content?: unknown }> }>('chat.history', {
    sessionKey,
    limit: 1,
  });
  const last = history.messages?.[0];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map((b: { text?: string }) => b.text ?? '').join('\n');
  }
  return '';
}
```

**Step 3: 扩展 teams store 保存最新输出**

```ts
// src/stores/teams.ts
agentLatestOutput: Record<string, Record<string, string>>;
setAgentLatestOutput: (teamId: string, agentId: string, text: string) => void;
```

**Step 4: 在 TeamChat 中更新面板输出**

- 任务完成（或 REPORT 解析后）调用 `fetchLatestAgentOutput(sessionKey)`
- 调用 `setAgentLatestOutput(teamId, agentId, text)`
- 面板卡片显示该文本摘要

**Step 5: 运行测试**

Run: `pnpm test -- tests/unit/team-output.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/team-output.ts src/stores/teams.ts src/pages/Teams/TeamChat.tsx tests/unit/team-output.test.ts
git commit -m "feat: show latest agent output in team panel"
```

---

## Task 6: i18n（teams 命名空间）

**Files:**
- Modify: `src/i18n/index.ts`
- Create: `src/i18n/locales/en/teams.json`
- Create: `src/i18n/locales/zh/teams.json`
- Create: `src/i18n/locales/ja/teams.json`
- Modify: `src/components/layout/Sidebar.tsx`

**Step 1: 注册 i18n namespace**

```ts
// src/i18n/index.ts
import enTeams from './locales/en/teams.json';
import zhTeams from './locales/zh/teams.json';
import jaTeams from './locales/ja/teams.json';
// include teams in resources and ns list
```

**Step 2: 添加最小字符串**

```json
// en/teams.json
{ "title": "Teams" }
```

**Step 3: 使用 t('teams:title') 替换硬编码**

**Step 4: 运行测试**

Run: `pnpm test -- tests/unit/teams.page.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/i18n/index.ts src/i18n/locales/en/teams.json src/i18n/locales/zh/teams.json src/i18n/locales/ja/teams.json src/components/layout/Sidebar.tsx
git commit -m "feat: add teams i18n namespace"
```

---

## Task 7: 协作流程（讨论 -> 收敛 -> 计划 -> 执行）

**Files:**
- Modify: `src/pages/Teams/TeamChat.tsx`
- Modify: `src/stores/teams.ts`
- Modify: `src/lib/team-orchestrator.ts`
- Test: `tests/unit/team-flow.test.tsx`

**Step 1: 先写失败测试**

```tsx
it('sends discussion broadcast to team members', async () => {
  // simulate send; expect orchestrator broadcast to be called
});
```

Run: `pnpm test -- tests/unit/team-flow.test.tsx`
Expected: FAIL

**Step 2: 增加最小流程控制**

- 发送消息时：
  - 讨论阶段广播给所有 team 成员。
  - 主控可在 UI 上触发“建议收敛”。
- 收敛确认后：
  - 请求各 agent 输出 PLAN。
  - 主控合并为执行清单。
- 执行阶段：
  - 分派任务并调用 `runAgentAndCollectReport`。
  - REPORT 转发给主控并更新共享上下文。

**Step 3: 运行测试**

Run: `pnpm test -- tests/unit/team-flow.test.tsx`
Expected: PASS

**Step 4: Commit**

```bash
git add src/pages/Teams/TeamChat.tsx src/stores/teams.ts src/lib/team-orchestrator.ts tests/unit/team-flow.test.tsx
git commit -m "feat: implement team collaboration flow"
```

---

## 最终验证

Run:
- `pnpm test`
- `pnpm typecheck`

Expected:
- All tests pass.
- Typecheck passes.
