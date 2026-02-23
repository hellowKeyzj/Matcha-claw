---
date: 2026-02-21
status: draft
topic: Matcha-claw multi-agent collaboration (implementation details)
---

# 多 Agent 协作实现细节

## 范围
本文件将已确认的设计落到可执行的实现细节，重点覆盖桌面端编排、共享上下文与 REPORT 处理。

## 角色
- 用户：参与团队会话。
- 主控 agent：建议收敛、分配任务、汇总结果、更新共享上下文。
- 子 agent：自由讨论；执行阶段输出 REPORT。
- 桌面端：路由消息、收集输出、转发 REPORT 给主控。

## 存储
- 团队列表与团队元数据：桌面端全局存储（本地持久化）。
- 使用 Zustand + persist（参考 settings store）。
- 共享上下文按团队存储，并注入所有 agent 的运行。

## 团队组建与复用
- 主控提出角色清单，用户确认后开始组建。
- 桌面端读取 `ROLES_METADATA.md`，用 LLM 判断是否匹配已有 agent，优先复用。
- 无匹配则创建 agent（`agents.create`），并更新 openclaw md 与 `ROLES_METADATA.md`。
- 团队只保存 `agentId` 引用，单个 agent 可加入多个团队复用。
- 创建失败允许“仅使用已匹配角色继续”或“取消”。

## 进入团队会话的成员绑定
- 打开团队会话时，桌面端调用 `agents.list` 校验成员是否存在。
- 缺失成员时提示用户重新创建、替换或移除。
- 为每个成员生成稳定会话键，例如 `agent:<agentId>:team:<teamId>`。
- 可选加载最近历史：`chat.history(limit=1)` 或更高，视 UI 需求。
- 在 UI 建立“成员 -> 会话键”映射，标记消息来源。

## Agents 工作空间首页（双栏并列）
目标：在一个入口中并列呈现团队与单体 agent，保持团队优先但不遮蔽角色库。

布局：
- 顶部栏：标题“Agents 工作空间”，操作区仅保留 `新建团队`。
- 左栏：团队列表（TeamList）。
- 右栏：Agent 列表（AgentList）。

团队卡片（TeamCard）字段：
- 名称
- 成员数
- 阶段状态（讨论/计划/执行/完成）
- 最近活跃时间
- 标签（可选）

Agent 卡片（AgentCard）字段：
- 名称
- 角色标签
- 模型
- 状态
- 最近活跃时间

默认交互：
- 点击团队卡片：直接进入团队会话，触发成员绑定流程。
- 点击 Agent 卡片：进入该 Agent 的个人会话或配置页。

数据来源：
- TeamList 来自桌面端本地团队存储（全局）。
- AgentList 来自本地 agent 存储或 `agents.list`。

## 绑定流程（UI 交互状态机）
以下为“进入团队会话时”的 UI 交互流程与状态机描述。

状态：
- `idle`: 未进入团队会话
- `loading_members`: 读取团队成员与配置
- `validating_agents`: 调用 `agents.list` 校验成员存在性
- `missing_agents`: 存在缺失成员，等待用户处理
- `binding_sessions`: 生成会话键、建立成员映射
- `loading_history`: 加载会话历史（可选）
- `ready`: 会话可用（可讨论/可执行）
- `error`: 绑定失败或 RPC 错误

事件：
- `OPEN_TEAM(teamId)`: 用户进入团队会话
- `AGENTS_OK(existingIds)`: 成员校验通过
- `AGENTS_MISSING(missingIds)`: 校验发现缺失
- `USER_RESOLVE(action)`: 用户处理缺失成员
- `BIND_OK`: 会话绑定完成
- `HISTORY_OK`: 历史加载完成
- `RPC_ERROR`: RPC 调用失败

转移：
- `idle` --OPEN_TEAM--> `loading_members`
- `loading_members` --(成员加载完成)--> `validating_agents`
- `validating_agents` --AGENTS_OK--> `binding_sessions`
- `validating_agents` --AGENTS_MISSING--> `missing_agents`
- `missing_agents` --USER_RESOLVE(创建/替换/移除)--> `validating_agents`
- `binding_sessions` --BIND_OK--> `loading_history`
- `loading_history` --HISTORY_OK--> `ready`
- 任意状态 --RPC_ERROR--> `error`
- `error` --OPEN_TEAM--> `loading_members`

UI 行为要点：
- `missing_agents` 状态必须阻塞进入讨论与执行。
- `ready` 状态才允许消息输入与广播。
- `error` 状态允许重试并展示详细错误原因。

ASCII 流程图：
```
idle
  │ OPEN_TEAM
  ▼
loading_members
  │ loaded
  ▼
validating_agents
  ├─ AGENTS_OK ───────────────▶ binding_sessions ─▶ loading_history ─▶ ready
  └─ AGENTS_MISSING ─▶ missing_agents ─▶ USER_RESOLVE ─▶ validating_agents

any ─ RPC_ERROR ─▶ error ─ OPEN_TEAM ─▶ loading_members
```

## Agent 工作面板（右侧可折叠）
目标：在团队会话中可视化每个 agent 的工作情况，不干扰聊天主流程。

布局：
- 主区：团队聊天
- 右侧：可折叠面板（默认展开）
- 面板内：按 agent 卡片列表 + 详情抽屉

卡片字段（最小集）：
- agent 名称/头像
- 状态：`idle | discussing | planning | running | waiting | done | blocked | error`
- 当前任务标题（简短）
- 最近更新时间/耗时
- 最新输出摘要（1-2 行）
- 错误/阻塞提示（可选）

详情抽屉：
- 运行记录：`runId`、`sessionKey`
- 最近 REPORT/PLAN 原文
- 操作：查看会话、重试任务、取消任务（可选）

交互：
- 折叠/展开面板
- 点击卡片展开详情
- 状态颜色：绿色完成、黄色阻塞、红色错误、蓝色执行中

## 可视化数据来源（块式为主，流式可选）
V1 采用“块式”为主的可视化，不依赖流式内容。

块式来源（推荐）：
- 运行开始：调用 `agent` 后将状态置为 `running`
- 运行结束：`agent.wait` 返回 `ok/error` 后更新状态
- 结果摘要：从最终回复中解析 REPORT/PLAN

流式增强（可选）：
- 若监听 `chat` 流，可显示“正在输出中…”提示
- 不用于核心状态判断，仅作体验增强

## 输出可视化规则
- 每个 agent 绑定固定 `sessionKey`，面板按 `sessionKey` 归属输出。
- 任务完成后刷新该 agent 的最新输出：
  - 调用 `chat.history(limit=1)` 拉最后一条 assistant 消息
  - 若包含 REPORT/PLAN，则优先显示其摘要
- 讨论阶段可选择“发送后刷新一次”或“手动刷新”，避免频繁拉取。

## 组件级标注原型（团队会话 + Agent 工作面板）

布局示意（组件级）：
```
┌────────────────────────────────────────────────────────────────────────────┐
│ 顶部栏 TopBar                                                               │
│ [团队名称] [阶段状态: 讨论/收敛/执行] [收敛建议提示] [流程按钮]               │
└────────────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────┬────────────────────────────┐
│ 聊天主区 TeamChat                              │ 右侧面板 AgentPanel (可折叠)│
│ ┌───────────────────────────────────────────┐ │ ┌─────────────────────────┐ │
│ │ MessageList (TeamMessages)               │ │ │ AgentCardList           │ │
│ │ - 用户/主控/系统消息                      │ │ │ - AgentCard x N         │ │
│ │ - PLAN/REPORT 标识                         │ │ │ - 状态/任务/摘要/错误    │ │
│ └───────────────────────────────────────────┘ │ └─────────────────────────┘ │
│ ┌───────────────────────────────────────────┐ │ ┌─────────────────────────┐ │
│ │ MessageComposer                            │ │ │ AgentDetailDrawer        │ │
│ │ - 输入框/发送/停止                          │ │ │ - 运行记录/输出/操作      │ │
│ └───────────────────────────────────────────┘ │ └─────────────────────────┘ │
└───────────────────────────────────────────────┴────────────────────────────┘
```

组件清单与职责：
- `TeamChatPage`：页面容器，拉取团队数据与绑定状态。
- `TeamHeaderBar`：展示团队名称、阶段状态、收敛建议入口、执行入口。
- `TeamMessageList`：渲染团队会话消息流，标记 PLAN/REPORT。
- `TeamMessageComposer`：用户输入与发送，支持广播与主控路由。
- `AgentPanel`：右侧折叠面板容器。
- `AgentCardList`：按 agent 列表渲染卡片。
- `AgentCard`：显示 agent 状态、当前任务、最新摘要、错误提示。
- `AgentDetailDrawer`：展开查看 runId、sessionKey、PLAN/REPORT 原文与操作。

关键交互：
- 进入团队会话：触发成员绑定流程，绑定完成后解锁输入。
- 讨论阶段：用户消息默认发给主控，同时可广播给成员。
- 主控建议收敛：显示提示，用户确认后进入计划阶段。
- 计划阶段：AgentCard 显示 PLAN 摘要，主控汇总后进入执行。
- 执行阶段：AgentCard 显示 running/blocked/done 状态与 REPORT 摘要。
- 详情抽屉：点击 AgentCard 展开查看最新输出与运行信息。

数据绑定（主要字段）：
- `TeamHeaderBar`：`team.name`、`teamPhase`、`convergenceSuggestion`
- `TeamMessageList`：`teamMessages[]`
- `AgentCard`：`agentId`、`agentStatus`、`currentTask`、`latestOutput`、`updatedAt`
- `AgentDetailDrawer`：`runId`、`sessionKey`、`lastPlan`、`lastReport`

状态来源：
- `teamPhase` 由团队流程控制器维护。
- `agentStatus` 由任务执行与 REPORT 解析更新。
- `latestOutput` 通过 `chat.history(limit=1)` 拉取最终回复。

## 组件级标注原型（Agents 工作空间首页）

布局示意（组件级）：
```
┌────────────────────────────────────────────────────────────────────────────┐
│ 顶部栏 TopBar                                                               │
│ [Agents 工作空间]                                            [新建团队]     │
└────────────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────┬────────────────────────────┐
│ 左栏 TeamList                                  │ 右栏 AgentList             │
│ ┌───────────────────────────────────────────┐ │ ┌─────────────────────────┐ │
│ │ TeamCard x N                               │ │ │ AgentCard x N           │ │
│ │ - 名称/成员数/阶段/最近活跃                │ │ │ - 名称/角色/模型/状态    │ │
│ │ - 标签(可选)                                │ │ │ - 最近活跃               │ │
│ └───────────────────────────────────────────┘ │ └─────────────────────────┘ │
└───────────────────────────────────────────────┴────────────────────────────┘
```

组件清单与职责：
- `AgentsWorkspacePage`：页面容器，加载团队与 Agent 列表数据。
- `TopBar`：标题与 `新建团队` 按钮。
- `TeamList`：团队列表容器。
- `TeamCard`：团队摘要卡片。
- `AgentList`：Agent 列表容器。
- `AgentCard`：Agent 摘要卡片。

关键交互：
- 点击 `TeamCard`：直接进入团队会话（触发成员绑定流程）。
- 点击 `AgentCard`：进入该 Agent 的个人会话或配置页。

数据绑定（主要字段）：
- `TeamCard`：`team.name`、`team.memberCount`、`team.phase`、`team.updatedAt`、`team.tags?`
- `AgentCard`：`agent.name`、`agent.role`、`agent.model`、`agent.status`、`agent.updatedAt`

## 数据模型
核心模型（TypeScript）：
- Team
  - id: string
  - name: string
  - controllerId: string
  - memberIds: string[]
  - createdAt: number
  - updatedAt: number
- TeamContext
  - goal: string
  - plan: string[]
  - roles: string[]
  - status: string
  - decisions: string[]
  - openQuestions: string[]
  - artifacts: string[]
  - updatedAt: string
- TeamTask
  - taskId: string
  - agentId: string
  - status: "pending" | "running" | "done" | "blocked" | "partial"
  - reportId?: string
  - updatedAt: number

## 阶段与触发
阶段：
1. 讨论：自由发散。
2. 收敛：主控建议，用户确认。
3. 计划：各 agent 输出 PLAN，主控汇总为执行清单。
4. 执行：主控分配任务，子 agent 输出 REPORT。
5. 完成：主控更新共享上下文，可选沉淀为 workflow/skill。

收敛触发信号（满足任一即可建议）：
- 目标清晰 + 共识达成
- 讨论开始重复
- 用户明确提出“开始收敛”

沉淀触发：主控建议 + 用户确认。

## 消息路由
- 团队会话输入：
  - 用户消息默认发送给主控。
  - 讨论阶段桌面端可并行广播给所有团队成员。
- 计划阶段：
  - 向所有团队成员广播 PLAN 请求。
  - 收集 PLAN 后交给主控汇总。
- 执行阶段：
  - 主控分配任务。
  - 桌面端调用对应 agent 并等待完成。

## OpenClaw RPC 映射
- 执行 agent：`agent`
- 等待完成：`agent.wait`
- 获取最终回复：`chat.history`（limit=1）
- agent 管理：`agents.list/create/update/files.set`
- 会话：`sessions.list/preview`（可选）

## REPORT 协议
仅允许 JSON；由子 agent 在任务最终回复中输出。

```json
REPORT: {
  "reportId": "T-123:agentA:run-001",
  "task_id": "T-123",
  "agent_id": "agentA",
  "status": "done|partial|blocked",
  "result": ["point 1", "point 2"],
  "evidence": ["optional evidence"],
  "next_steps": ["optional next steps"],
  "risks": ["optional risks"]
}
```

解析规则：
- 仅在运行结束后解析最终回复。
- 仅 `status = done` 更新共享上下文。
- `partial` / `blocked` 只更新任务状态。
- 缺失 REPORT 触发补交请求。

## 最终回复判定
推荐方式：
- 调用 `agent`。
- 使用 `agent.wait` 等待完成。
- `chat.history(limit=1)` 获取最终 assistant 消息。
- 从最终消息中解析 REPORT。

该方式避免流式片段误判。

## 错误处理
- 缺失 REPORT：主控提示补交。
- JSON 无效：记录错误并要求重发。
- 任务失败：标记失败，不更新共享上下文。

## 性能与并发
- 依赖 OpenClaw 内部队列与并发上限。
- 桌面端 V1 不做额外限流。
- 所有执行类 RPC 均带 `idempotencyKey`。

## 审计与可追踪性
- REPORT 记录在团队会话日志中。
- 保持映射：teamId -> taskId -> reportId -> runId。

## V1 决策
- 不使用 `agentToAgent`。
- REPORT 由桌面端统一转发给主控。
- 共享上下文仅由主控更新。
