---
date: 2026-02-21
status: approved
topic: Matcha-claw multi-agent collaboration (desktop team chat)
---

# Matcha-claw 多 Agent 协作空间设计

## 目标
- 支持团队会话中的多 agent 自由讨论与发散。
- 主控 agent 自行判断时机，建议收敛，用户确认后进入结构化阶段。
- 执行阶段由子 agent 输出结构化 REPORT，主控汇总更新共享摘要。
- 任务完成为主目标，沉淀为 workflow/skill 为可选目标（主控建议 + 用户确认）。

## 非目标
- 不在 OpenClaw 内实现共享 sessionKey。
- 不依赖 agentToAgent 作为必要链路（V1 不启用）。
- 不要求每轮都生成 workflow/skill。

## 核心决策
- OpenClaw 作为执行与会话隔离层，协作与共享上下文在桌面端维护。
- 团队会话默认路由到主控；自由讨论阶段桌面端可并行广播给多 agent。
- 子 agent 仅在任务完成时输出 REPORT（JSON），桌面端只在运行结束后解析。
- 共享摘要仅在 status=done 时更新，partial/blocked 只记录状态。
- REPORT 由桌面端统一转发给主控汇总，无需 agentToAgent。

## 团队组建与复用
- 主控提出团队角色清单，用户确认后进入组建。
- 桌面端读取全局 `ROLES_METADATA.md`，用 LLM 判断是否有满足的既有 agent，优先复用。
- 无匹配则创建 agent（`agents.create`），同时更新 openclaw 识别的 md 与 `ROLES_METADATA.md`。
- 团队只保存 `agentId` 引用，单个 agent 可加入多个团队复用。
- 创建失败允许“仅使用已匹配角色继续”或“取消”。

## 进入团队会话的成员绑定
- 打开团队会话时，桌面端加载团队成员列表并调用 `agents.list` 校验存在性。
- 若缺失成员，提示重新创建、替换或移除。
- 为每个成员生成稳定会话键，例如 `agent:<agentId>:team:<teamId>`。
- 需要时加载该会话的最近历史（`chat.history`），并在 UI 建立成员会话映射。
- 默认输入路由到主控会话；讨论阶段可并行广播给团队成员。

## Agents 工作空间首页（双栏并列）
定位：聚合“团队协作入口 + 可复用角色库”的首页，团队优先但不遮蔽单体 agent。

布局与结构：
- 顶部栏：标题“Agents 工作空间”，右侧仅保留 `新建团队`。
- 左栏：团队列表。
- 右栏：Agent 列表。

列表内容（最小集）：
- 团队卡片：名称、成员数、阶段状态、最近活跃时间、标签（可选）。
- Agent 卡片：名称、角色标签、模型、状态、最近活跃时间。

默认交互：
- 点击团队卡片：直接进入团队会话（触发成员绑定流程）。
- 点击 Agent 卡片：进入该 Agent 的个人会话或配置页。

## 可视化输出策略（每个 agent 的会话输出）
- 每个 agent 都有独立会话，面板展示“最新输出/摘要”。
- V1 以块式为主：任务完成后通过 `chat.history(limit=1)` 取最后一条 assistant 消息。
- REPORT/PLAN 优先展示为摘要，普通讨论展示最后一条消息。
- 流式仅作为增强：显示“正在输出中…”，不参与完成判定。

## 协作流程
1. 讨论回合：多 agent 自由发言，用户与主控共同讨论。
2. 主控建议收敛：满足信号即建议，用户确认后进入收敛回合。
3. 收敛回合：各 agent 输出 PLAN，主控汇总为执行清单。
4. 执行回合：主控分配子任务，子 agent 完成后输出 REPORT。
5. 汇总完成：主控更新共享摘要并输出结论。
6. 可选沉淀：主控建议生成 workflow/skill，用户确认后生成。

## 共享上下文
桌面端保存单一 TEAM_CONTEXT，并在每次调用 agent 时注入。

```json
TEAM_CONTEXT: {
  "goal": "...",
  "plan": ["..."],
  "roles": ["..."],
  "status": "...",
  "decisions": ["..."],
  "open_questions": ["..."],
  "artifacts": ["..."],
  "updated_at": "..."
}
```

## REPORT 协议
REPORT 为 JSON，出现在任务最终回复中。

```json
REPORT: {
  "reportId": "T-123:agentA:run-001",
  "task_id": "T-123",
  "agent_id": "agentA",
  "status": "done|partial|blocked",
  "result": ["要点1", "要点2"],
  "evidence": ["可选证据"],
  "next_steps": ["可选下一步"],
  "risks": ["可选风险"]
}
```

解析规则:
- 只在运行结束后解析最终回复。
- status=done 才触发共享摘要更新。
- 未解析到 REPORT 时触发补交提示。

## RPC 绑定
- 任务执行: `agent`
- 等待完成: `agent.wait`
- 获取最终回复: `chat.history`(limit=1)
- agent 管理: `agents.list/create/update/files.set`
- 会话列表与预览: `sessions.list/preview`(可选)

## 并发与队列
- OpenClaw 有全局并发上限与队列机制。
- 桌面端不主动限并发，但要接受排队与延迟。
- 所有执行类请求带 `idempotencyKey`。

## 错误处理
- REPORT 缺失: 自动追问补交。
- REPORT 解析失败: 记录错误并提示重发。
- 子任务失败: 标记任务失败，不更新共享摘要。

## 测试与验证
- 最小团队 2-3 agent 覆盖全流程。
- 验证 REPORT 解析与主控汇总正确性。
- 验证自由讨论与收敛切换不会丢消息。
