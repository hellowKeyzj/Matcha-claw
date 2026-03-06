# Task Manager 插件接入与运维说明

## 1. 目标

本文档用于指导在 Matcha-claw 中启用 `task-manager` 插件，并说明回滚与常见故障处理。

## 2. 安装方式

### 2.1 UI 安装（推荐）

1. 打开应用设置页。
2. 进入 `Task Manager 插件` 卡片。
3. 点击 `安装并启用`。
4. 等待网关自动重启。

安装完成后，进入 `/tasks` 任务中心可查看任务列表。

### 2.2 开发环境本地路径

本地开发插件源路径：

`E:/code/Matcha-claw/packages/openclaw-task-manager-plugin`

主进程会按以下顺序寻找插件镜像并复制到 `~/.openclaw/extensions/task-manager`：

1. `build/openclaw-plugins/task-manager`
2. `packages/openclaw-task-manager-plugin`

## 3. 验证清单

1. 设置页 `Task Manager 插件` 状态显示为“已安装并启用”。
2. `~/.openclaw/openclaw.json` 中：
   - `plugins.enabled = true`
   - `plugins.allow` 包含 `task-manager`
   - `plugins.entries.task-manager.enabled = true`
   - `skills.entries.task-manager.enabled = true`
3. 打开任务中心 `/tasks`，可正常加载任务列表。
4. 任务创建后，`<workspace>/.task-manager/tasks.json` 出现并随进度更新。

## 4. 回滚方案

### 4.1 快速回滚（仅禁用插件）

1. 编辑 `~/.openclaw/openclaw.json`。
2. 将 `plugins.entries.task-manager.enabled` 设为 `false`。
3. 从 `plugins.allow` 中移除 `task-manager`（可选）。
4. 重启网关。

### 4.2 完全移除

1. 执行快速回滚步骤。
2. 删除目录 `~/.openclaw/extensions/task-manager`。
3. 如需清理任务数据，可删除各 workspace 下 `.task-manager/` 目录。

## 5. 故障排查

### 5.1 设置页显示未安装

检查：

1. `~/.openclaw/extensions/task-manager/openclaw.plugin.json` 是否存在。
2. 应用安装包中 `openclaw-plugins/task-manager` 是否被拷贝。
3. 打包阶段是否执行了 `scripts/bundle-openclaw-plugins.mjs`。

### 5.2 安装后仍未启用

检查 `~/.openclaw/openclaw.json` 是否包含：

1. `plugins.enabled = true`
2. `plugins.allow` 包含 `task-manager`
3. `plugins.entries.task-manager.enabled = true`
4. `skills.entries.task-manager.enabled = true`

并确认网关已重启。

### 5.3 任务中心无实时更新

1. 先确认网关状态为 `running`。
2. 检查 `gateway:notification` 是否收到 `task_*` 事件。
3. 任务中心有 5 秒轮询兜底，可先点击“刷新”确认数据是否落盘。

### 5.4 webhook 审批无法恢复

1. 确认 token 未过期（`expires_at`）。
2. token 仅可消费一次，重复调用会失败。
3. 校验回调 URL 的 `taskId` 与 `workspace` 参数是否匹配原任务。

### 5.5 schema 损坏导致任务丢失

当 `tasks.json` schema 不兼容或损坏时，系统会自动：

1. 备份旧文件为 `tasks.bak.<timestamp>.json`
2. 重建空 `tasks.json`

可从备份文件中手工恢复数据。

### 5.6 子会话完成后未自动清理

OpenClaw 的 `sessions_spawn` 默认行为是保留子会话（`cleanup: "keep"`）。  
若希望“任务完成后自动删除子会话”，必须在 spawn 参数中显式设置：

```json
{
  "mode": "run",
  "cleanup": "delete"
}
```

本项目的 `task-manager` Skill 已内置该约束。如果仍出现残留会话：

1. 确认网关已重启，Skill 与 Hook 已加载最新版本。
2. 用新任务复现（历史任务不会被追溯清理）。
3. 检查子会话是否是 `mode: "session"`（该模式设计为持久会话，不会自动清理）。

### 5.7 子步骤可视化混乱（步骤/说明分不清）

根因通常是计划 Markdown 不满足结构化约束，混入了裸文本段落。  
任务中心前端已按“结构化步骤协议”解析，建议统一使用：

1. 顶层步骤：`- [ ] 步骤N: 标题`
2. 子步骤：`  - [ ] 子步骤标题`
3. 说明：`  - 说明: ...`
4. 完成情况：`  - 完成情况: ...`
5. 完成明细：`    - 证据: ...`

避免在步骤块中直接写不带前缀的普通段落，否则会被错误归类为子步骤或说明。

### 5.8 子会话上下文不足导致执行跑偏

当前插件在 `before_agent_start`（子会话）会注入 **Task Packet**，包含：

1. 任务 ID / 目标 / 状态
2. 工作区路径
3. 会话绑定关系
4. 进度摘要（completed/total）
5. 下一顶层步骤
6. 阻塞信息与恢复附加信息（若有）
7. 执行边界

同时会附带 `plan_markdown` 原文，但仅作为参考附件，不是主执行依据。  
如果发现子会话仍按 Markdown 自由发挥，优先检查：

1. 子会话启动消息是否包含 `task-...`（缺失则无法注入 Task Packet）
2. Hook 是否加载到最新版本
3. 任务 `assigned_session` 是否正确更新

### 5.9 多步骤场景未触发 Task Manager

插件现在采用“框架化引导 + 动态纠错”策略，而不是工具硬拦截：

1. `before_agent_start` 会做复杂度评估（步骤规模/依赖顺序/中断恢复成本），注入 `Task Manager 触发建议` 与评分说明。
2. 评估信号来源包含：
   - 当前用户请求
   - 最近助手输出（用于识别“执行中途已经变成多步骤”）
3. 触发后只给建议，不会阻断普通工具调用；Agent 可自行切换。
4. 若检测到上一轮已进入多步骤结构，会注入 `Task Manager 动态切换建议`，允许中途“反悔”切任务模式。

建议执行路径：

1. 先规划确认。
2. 再调用 `task_create -> task_set_plan_markdown -> sessions_spawn(mode="run", cleanup="delete") -> task_bind_session`。

### 5.10 本体构建场景触发 Task Manager

当前 Hook 不做“按身份抑制”。  
任何 Agent（包括本体创建型 Agent）只要命中触发条件，都会收到触发建议并可进入长任务流程：

1. 多步骤结构（如步骤标签、序列词、多条列表）
2. 显式 Task Manager 指令

这保证了：

1. 触发条件基于任务特征，而非 Agent 身份。
2. 本体创建型 Agent 在分阶段构建任务中同样能自动触发 task-manager。

### 5.11 并发确认场景的正确恢复方式

从当前版本开始，每次任务进入阻塞态（`waiting_for_input` / `waiting_approval`）都会生成唯一 `confirmId`，并随 `task_blocked` 事件下发。
其中 `task_request_user_input` 支持可选 `inputMode`：

1. `decision`：仅接受“批准/拒绝”类决策。
2. `free_text`：需要提交补充文本信息。

恢复协议如下：

1. 前端恢复请求必须携带 `taskId + confirmId + decision`。
2. 后端 `task_resume` 仅允许 `waiting_* -> running/completed` 状态跃迁。
3. `confirmId` 与任务当前阻塞记录不一致时，返回冲突错误（`conflict`）。
4. 已恢复或已完成任务重复提交恢复请求，返回冲突错误（幂等拒绝）。

聊天文本兜底策略：

1. 若待确认任务数 `> 1` 且用户文本未包含 `taskId/confirmId`，系统仅反问澄清，不自动恢复。
2. 仅当待确认任务数 `= 1` 时，允许“同意/拒绝”类短文本自动路由恢复。
3. 若目标任务是 `free_text`，系统会要求提供具体内容，纯“同意/拒绝”不会直接恢复。

### 5.12 Chat 右侧任务收件箱（跨 Agent）

Chat 页面右侧新增“任务收件箱”，用于在主聊天界面直接处理未完成任务。

展示范围：

1. 当前工作区（含主 workspace + 子 Agent workspace）聚合任务。
2. 仅展示未完成状态：`pending`、`running`、`waiting_for_input`、`waiting_approval`。

交互规则：

1. 点击任务卡片（或“进入会话”）优先跳到 `assigned_session`。
2. 若任务无 `assigned_session`，提示：`未绑定会话，先恢复任务`。
3. `waiting_for_input` 且 `inputMode=decision`：展示“批准/拒绝”按钮。
4. `waiting_for_input` 且 `inputMode=free_text`：展示输入框并提交补充文本。
5. 提交恢复后立即执行 `task_resume -> wakeTaskSession`，自动唤醒子会话继续执行。

事件同步策略：

1. 通过 `task_progress_update / task_status_changed / task_blocked / task_needs_resume` 实时 patch。
2. 保留 5 秒轮询兜底刷新，避免事件丢失导致侧栏状态滞后。
