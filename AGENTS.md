# AGENTS.md

## Cursor Cloud specific instructions

### Overview

ClawX is a cross-platform **Electron desktop app** (React 19 + Vite + TypeScript) providing a GUI for the OpenClaw AI agent runtime. It uses pnpm as its package manager (pinned version in `package.json`'s `packageManager` field).

### Quick reference

Standard dev commands are in `package.json` scripts and `README.md`. Key ones:

| Task | Command |
|------|---------|
| Install deps + download uv | `pnpm run init` |
| Dev server (Vite + Electron) | `pnpm dev` |
| Lint (ESLint, auto-fix) | `pnpm run lint` |
| Type check | `pnpm run typecheck` |
| Unit tests (Vitest) | `pnpm test` |
| E2E tests (Playwright) | `pnpm run test:e2e` |
| Build frontend only | `pnpm run build:vite` |

### Non-obvious caveats

- **pnpm version**: The exact pnpm version is pinned via `packageManager` in `package.json`. Use `corepack enable && corepack prepare` to activate the correct version before installing.
- **Electron on headless Linux**: The dbus errors (`Failed to connect to the bus`) are expected and harmless in a headless/cloud environment. The app still runs fine with `$DISPLAY` set (e.g., `:1` via Xvfb/VNC).
- **`pnpm run lint` race condition**: If `pnpm run uv:download` was recently run, ESLint may fail with `ENOENT: no such file or directory, scandir '/workspace/temp_uv_extract'` because the temp directory was created and removed during download. Simply re-run lint after the download script finishes.
- **Build scripts warning**: `pnpm install` may warn about ignored build scripts for `@discordjs/opus` and `koffi`. These are optional messaging-channel dependencies and the warnings are safe to ignore.
- **`pnpm run init`**: This is a convenience script that runs `pnpm install` followed by `pnpm run uv:download`. Either run `pnpm run init` or run the two steps separately.
- **Gateway startup**: When running `pnpm dev`, the OpenClaw Gateway process starts automatically on port 18789. It takes ~10-30 seconds to become ready. Gateway readiness is not required for UI development—the app functions without it (shows "connecting" state).
- **No database**: The app uses `electron-store` (JSON files) and OS keychain. No database setup is needed.
- **AI Provider keys**: Actual AI chat requires at least one provider API key configured via Settings > AI Providers. The app is fully navigable and testable without keys.
- **Token usage history implementation**: Dashboard token usage history is not parsed from console logs. It reads OpenClaw session transcript `.jsonl` files under the local OpenClaw config directory, extracts assistant messages with `message.usage`, and aggregates fields such as input/output/cache/total tokens and cost from those structured records.

---

# Matcha-claw 开发规范

本文件用于约束在 `Matcha-claw` 仓库内工作的编码代理行为。目标是：稳定、可维护、可升级。

## 0. 角色定义

你是 Matcha-claw 项目的世界顶级架构编码助手。

- 核心职责：
  - 守护架构边界与依赖方向，避免局部修补破坏整体结构。
  - 在需求、复杂度、交付速度之间做清晰权衡并落地实现。
  - 交付可运行、可验证、可维护、可演进的代码与说明。
- 行为标准：
  - 先澄清边界再编码，结论基于代码与验证结果，不做猜测。
  - 正确性优先于速度，可维护性优先于炫技。
  - 明确说明风险、假设、未验证项与回滚路径。
  - 沟通友善直接，聚焦问题与可执行方案。

## 1. 语言与沟通

- 所有输出、注释、评审结论默认使用中文。
- 不确定的事实必须明确标注“待确认”，禁止猜测实现细节。
- 先给结论，再给依据与落点文件。

## 2. 架构边界（必须遵守）

- 严格遵守分层：`Renderer (src) -> Preload (electron/preload) -> IPC (electron/main/ipc-handlers) -> Main/Electron -> GatewayManager -> OpenClaw`.
- `src/*` 禁止直接访问 Node.js/Electron 敏感能力；只能通过 `window.electron` 白名单 API。
- 新增系统能力时，必须同时更新：
  - `electron/preload/index.ts` 白名单
  - `src/types/electron.d.ts` 类型声明
  - `electron/main/ipc-handlers.ts` 实际处理逻辑
- Gateway 生命周期管理（启动/停止/重连/健康）只能集中在 `electron/gateway/manager.ts`，禁止在页面层重复实现。

### 2.1 页面共置（Colocation）规则（强约束）

- 项目默认采用“按页面共置”组织：允许在 `src/pages/<Page>/` 下放该页面私有的业务逻辑文件（如 `*.logic.ts`、`*.mapper.ts`、`*utils.ts`）。
- `index.tsx` 只负责页面编排（组装数据、调用 action、渲染组件）；复杂流程逻辑必须下沉到同目录的 `*.logic.ts`。
- 页面共置逻辑必须满足“单页面私有”前提；一旦被第二个页面复用，必须上提到 `src/lib/*`（或后续 `src/features/*`）。
- OpenClaw RPC 相关调用不属于页面共置范围；页面层及其共置文件不得直接拼装 `gateway:rpc` 的 OpenClaw 方法细节，必须走 `src/lib/openclaw/*` 兼容层。
- 页面共置文件禁止反向依赖其他页面目录（例如 `src/pages/A` 直接依赖 `src/pages/B`）。

## 3. 技术栈约束

- 桌面运行时：Electron 40+
- 前端：React 19 + TypeScript + React Router + Zustand
- UI：TailwindCSS + Radix UI + Lucide + Framer Motion
- 构建：Vite + vite-plugin-electron + electron-builder
- 测试：Vitest + Playwright
- AI 内核：内嵌 `openclaw` npm 包（版本以根 `package.json` 为准）

新增库前先评估是否可由现有栈解决，避免重复引入同类依赖。

## 4. 状态与数据流

- 单一真相源：
  - 网关连接态以 `GatewayManager` 为真相源。
  - 前端 store 只存最小必要状态。
- 派生状态不落库，使用 selector/计算属性生成。
- 禁止跨 store 隐式写入；跨域更新必须有明确 action。

## 5. IPC 与协议规则

- 继续开发时，先参考 `Matcha-claw/doc/gateway-rpc-api.md`（RPC）与 `Matcha-claw/doc/gateway-events-api.md`（事件），作为 OpenClaw 协议基准。
- 涉及流式/订阅开发时，优先以 `Matcha-claw/doc/gateway-events-api.md` 的事件名、payload 与 `dropIfSlow` 语义为准。
- 所有 IPC 入参与返回值必须有明确 TypeScript 类型。
- 错误语义统一：返回结构化错误（`code`/`message`），不要仅返回模糊字符串。
- `gateway:rpc` 调用必须设置合理超时，超时后可见地反馈给 UI。
- 对 OpenClaw WS 事件做兼容处理时，优先保持协议原义，不“猜字段”。

## 6. 安全规则

- API Key 等敏感信息必须通过 `electron/utils/secure-storage.ts` 管理。
- 严禁把 token、key、完整凭据写入日志或上报到渲染层。
- Preload 白名单最小化，不得暴露通用执行入口。
- 修改 CSP/Headers 逻辑时，必须说明影响范围与回退策略。

## 7. 代码风格与规模

- 使用 TypeScript 严格类型，避免 `any`；若必须使用，写明原因与边界。
- 函数保持单一职责；重复逻辑抽到 `electron/utils/*` 或 `src/lib/*`。
- 注释只解释“为什么”，不解释显而易见的“做了什么”。
- 优先小步重构，不做无边界大改。

## 8. 测试与验证（必做）

- 改动前后至少执行与范围匹配的验证：
  - 单元/集成：`pnpm test`
  - 类型检查：`pnpm typecheck`
  - 关键 UI 或流程变更：补充/执行 Playwright 用例
- 涉及以下模块时必须补测试：
  - IPC handler
  - Gateway 重连与状态机
  - 聊天流式事件处理
  - 配置读写与密钥存储
- 若无法运行测试，必须在交付说明中明确“未验证项与风险”。

## 9. 构建与发布规则

- 不得破坏 `scripts/bundle-openclaw.mjs` 的可复现性与幂等性。
- 不得破坏 `scripts/download-bundled-uv.mjs` 的跨平台目标产物结构。
- 任何打包链路变更必须在至少一个目标平台做实际构建验证。

## 10. OpenClaw 集成策略

- 优先做“适配层”改造，避免直接改 `openclaw` 内核代码。
- 升级 `openclaw` 版本时：
  - 先记录 breaking change 风险
  - 再验证 Gateway 握手、chat 流、skills、cron、channels 基本功能
- 不允许依赖未文档化的私有行为。

### 10.1 兼容层（Adapter Layer）强约束

- 凡涉及 OpenClaw RPC 调用，`src/*` 业务代码（页面、store、业务 lib）必须优先调用兼容层接口，不得在调用点直接拼装 RPC 细节。
- 若兼容层暂无对应接口，先在兼容层新增封装，再由业务代码调用；禁止“先直连 RPC，后续再重构”。
- 新增封装必须按“可复用、跨场景”设计，禁止为单页面/单流程写一次性定制适配。
- 兼容层对上提供稳定 contract，对下吸收 OpenClaw 版本变化（参数、返回结构、状态语义、超时语义）。
- OpenClaw 升级时，优先只改兼容层实现；上层调用签名应保持稳定。
- 错误语义统一由兼容层映射后再抛给上层；禁止把底层模糊错误直接扩散到 UI。

### 10.2 兼容层目录规划（统一放置）

- 兼容层统一放在：`src/lib/openclaw/`
- 当前文件：
  - `src/lib/openclaw/agent-runtime.ts`（agent run 生命周期：`agent` / `agent.wait`）
  - `src/lib/openclaw/session-runtime.ts`（`chat.send` / `chat.history` / `sessions.*` + 消息提取工具）
  - `src/lib/openclaw/types.ts`（兼容层共享类型）
- 后续新增按职责拆分：
  - `src/lib/openclaw/errors.ts`（错误码映射与错误构造）

## 11. 提交与评审

- 一次提交只解决一个问题域（功能、重构、测试分离）。
- PR 描述必须包含：
  - 改动范围
  - 风险点
  - 验证清单
  - 回滚方案（如适用）
- Code Review 以“行为正确性、回归风险、测试覆盖”优先，不做风格争论。
- PR 必须补充结构边界自检：
  - 是否新增了页面私有逻辑文件；若是，是否仅服务单页面；
  - 是否出现跨页面复用但未上提；
  - 是否出现页面层/共置文件直调 OpenClaw RPC。

## 12. 禁止事项

- 禁止在渲染进程绕过 preload 直接访问 Node 能力。
- 禁止吞异常（空 `catch` 或只 `console.log` 后继续）。
- 禁止未验证即合并关键链路改动。
- 禁止在不说明影响的情况下更改协议、端口、默认安全策略。

---

如与更高优先级指令冲突，以系统/开发者/用户实时指令为准；本文件用于项目内默认协作规范。

## 13. 任务中心架构变更（2026-03-04）

### 13.1 新增目录树

```text
Matcha-claw/
├─ packages/
│  └─ openclaw-task-manager-plugin/
│     ├─ openclaw.plugin.json
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ skills/task-manager/SKILL.md
│     └─ src/
│        ├─ index.ts
│        ├─ progress-parser.ts
│        ├─ task-store.ts
│        └─ hooks/before-agent-start.ts
├─ src/
│  ├─ lib/openclaw/task-manager-client.ts
│  ├─ stores/task-center-store.ts
│  ├─ pages/Tasks/index.tsx
│  └─ i18n/locales/{zh,en,ja}/tasks.json
└─ tests/unit/
   ├─ task-manager-progress-parser.test.ts
   └─ task-manager-store.test.ts
```

### 13.2 文件职责（一句话）

- `packages/openclaw-task-manager-plugin/src/index.ts`：注册 task 工具、RPC、HTTP webhook 与事件发布。
- `packages/openclaw-task-manager-plugin/src/task-store.ts`：维护 `<workspace>/.task-manager/tasks.json`，提供原子读写、锁与状态迁移。
- `packages/openclaw-task-manager-plugin/src/progress-parser.ts`：解析 Markdown 勾选项进度，忽略 fenced code block。
- `packages/openclaw-task-manager-plugin/src/hooks/before-agent-start.ts`：主/子会话恢复注入与 session 重绑。
- `src/lib/openclaw/task-manager-client.ts`：Renderer 的 task-manager 兼容层，封装 Gateway RPC 与插件安装 IPC。
- `src/stores/task-center-store.ts`：任务中心页面状态管理与 `task_*` 事件处理。
- `src/pages/Tasks/index.tsx`：任务中心 UI（列表/详情/阻塞确认/恢复闭环）。
- `electron/main/ipc-handlers.ts`：task 插件安装与状态 IPC、OpenClaw 运行路径 IPC。
- `tests/unit/task-manager-*.test.ts`：覆盖进度解析与存储关键行为（schema 修复、token 过期/一次性消费）。

### 13.3 模块依赖与边界

- Renderer 不直接调用 Node/OpenClaw 内核，统一走 `window.electron.ipcRenderer` 与 `src/lib/openclaw/task-manager-client.ts`。
- 插件安装/启用属于主进程职责：`electron/main/ipc-handlers.ts` 负责镜像复制、`openclaw.json` 插件启用与网关重启。
- 任务执行状态事实源固定在 OpenClaw workspace：`<workspace>/.task-manager/tasks.json`。
- Gateway 事件通过 `gateway:notification` 下发，页面只消费 `task_*` 事件，不侵入 chat/channel 流程。

### 13.4 关键决策与原因

- 采用“OpenClaw 插件 + Matcha-claw 适配层”而非改 OpenClaw 内核：降低升级耦合和回归风险。
- 任务状态机落盘 JSON 并加文件锁：确保崩溃恢复与多会话并发下的一致性。
- webhook 使用一次性 token + TTL：控制审批回调暴露风险，避免重复消费。
- 在设置页与任务页都提供安装入口：一方面满足首次接入路径，另一方面降低故障恢复门槛。

### 13.5 本次变更日志

- 新增 `openclaw-task-manager-plugin` 包并完成 task 工具/RPC/事件/恢复 Hook。
- 打包链路支持 task-manager 本地插件镜像（`scripts/bundle-openclaw-plugins.mjs`、`scripts/after-pack.cjs`）。
- 主进程新增 `task:pluginStatus`、`task:pluginInstall` 及 OpenClaw 运行路径 IPC。
- Renderer 新增任务中心页面、状态 store、任务插件客户端适配层、侧边栏 `/tasks` 入口。
- 设置页新增 Task Manager 插件状态与安装卡片。
- i18n 新增 `tasks` 命名空间（中/英/日）并接入资源注册。
- 新增任务插件单元测试：Markdown 进度解析与任务存储行为。
- 新增运维文档：`doc/task-manager-plugin.md`（安装、回滚、故障排查）。
- `task-manager` Hook 改为“复杂度评估框架 + 动态切换建议”，移除执行期工具硬拦截策略。
- Task 插件安装流程新增 `skills.entries.task-manager.enabled = true` 对齐，避免“插件启用但 Skill 未加载”。
- 任务中心改为聚合“主 workspace + agents.list 配置的子 workspace”任务源，修复 `business-expert` 等子 Agent 创建任务在任务中心不可见的问题。

## 14. Chat 任务收件箱架构变更（2026-03-06）

### 14.1 新增目录树

```text
Matcha-claw/
├─ src/
│  ├─ lib/task-inbox.ts
│  ├─ stores/task-inbox-store.ts
│  └─ pages/Chat/
│     ├─ components/TaskInboxPanel.tsx
│     └─ index.tsx (双栏布局接入)
├─ src/i18n/locales/{zh,en,ja}/chat.json
├─ tests/unit/
│  ├─ task-inbox-domain.test.ts
│  ├─ task-inbox-store.test.ts
│  ├─ chat-task-inbox-panel.test.tsx
│  └─ chat-page-task-inbox.integration.test.tsx
└─ doc/task-manager-plugin.md
```

### 14.2 文件职责（一句话）

- `src/lib/task-inbox.ts`：封装未完成任务过滤、`assigned_session` 解析、`decision/free_text` 推断规则。
- `src/stores/task-inbox-store.ts`：聚合跨 workspace 未完成任务，处理 `task_resume -> wakeTaskSession` 与会话跳转动作。
- `src/pages/Chat/components/TaskInboxPanel.tsx`：右侧任务收件箱 UI，按输入模式渲染“按钮决策/文本提交”。
- `src/pages/Chat/index.tsx`：将 Chat 页面改为左聊天右任务收件箱双栏结构。
- `tests/unit/task-inbox-*.test.ts*`：覆盖领域规则、store 动作和 Chat 接入行为。

### 14.3 模块依赖与边界

- Chat 右栏不直接拼装 `gateway:rpc`，统一经 `src/lib/openclaw/task-manager-client.ts`。
- `task-inbox-store` 可以调用 `useChatStore.getState().switchSession`，但不反向依赖页面组件。
- UI 组件仅做交互分发与反馈（toast），任务事实源仍以 `task_list + task_*` 事件为准。

### 14.4 关键决策与原因

- 未完成任务状态统一为 `pending/running/waiting_for_input/waiting_approval`，与用户场景一致，避免“看不到运行中任务”。
- 会话跳转采用“优先 `assigned_session`，缺失即提示”，避免隐式建会话导致错误路由。
- `waiting_for_input` 强制按 `decision/free_text` 分流，降低并发任务恢复误判。
- 恢复动作固定为 `task_resume` 成功后立即 `wakeTaskSession`，保证提交后自动继续执行。

### 14.5 本次变更日志

- 新增 Chat 右侧任务收件箱及跨 Agent 未完成任务聚合能力。
- 新增任务卡片点击跳转子会话能力，并补齐“未绑定会话”显式提示。
- 新增 `decision/free_text` 分流交互，提交后自动唤醒目标子会话。
- 新增 4 组测试覆盖领域、状态层、组件与页面集成。
- 同步 `chat` 三语文案与 task-manager 运维文档说明。

### 14.6 布局补充变更（2026-03-07）

#### 14.6.1 目录树增量

```text
Matcha-claw/
└─ src/
   └─ components/layout/
      ├─ AgentSessionsPane.tsx   # 新增：聊天页独立 Agent 会话栏（位于 Sidebar 右侧）
      ├─ MainLayout.tsx          # 调整：聊天路由插入 AgentSessionsPane
      └─ Sidebar.tsx             # 调整：只保留菜单导航，不再承载 Agent 会话树
```

#### 14.6.2 文件职责（增量）

- `src/components/layout/AgentSessionsPane.tsx`：独立渲染“全部 Agent + 各自会话”，支持点击 Agent/会话切换到目标 chat session。
- `src/components/layout/MainLayout.tsx`：在聊天路由 `/` 下，把 Agent 会话栏插入到左侧菜单与主内容之间。
- `src/components/layout/Sidebar.tsx`：回归纯导航职责，避免菜单与会话树耦合。

#### 14.6.3 模块依赖与边界（增量）

- Agent 会话数据读取和会话切换统一在 `AgentSessionsPane` 内完成（`useSubagentsStore` + `useChatStore`）。
- `Sidebar` 不再依赖 chat/subagents store，降低菜单层职责复杂度。
- `MainLayout` 负责路由级布局编排，不承载会话业务逻辑。

#### 14.6.4 关键决策与原因（增量）

- 将会话树从菜单内嵌改为独立栏位，是为了匹配“红框区域”的信息密度和交互预期（导航与会话浏览分区）。
- 主 Agent (`main`) 强制纳入会话栏，确保“显示全部 Agent”的一致性。

## 15. 模型同步与设置路由收敛（2026-03-07）

### 15.1 目录树增量

```text
Matcha-claw/
└─ src/
   └─ lib/
      ├─ openclaw/
      │  └─ model-catalog.ts   # 新增：统一解析配置中的模型集合（providers + defaults.models）
      └─ settings/
         └─ sections.ts         # 新增：设置分区 key、query 解析与路由构造
```

### 15.2 文件职责（增量）

- `src/lib/openclaw/model-catalog.ts`：统一生成“配置中的模型 ID 集合”，供 providers/subagents 双侧复用。
- `src/lib/settings/sections.ts`：提供设置分区常量、`section` 查询参数解析和分区跳转链接构造。

### 15.3 模块依赖与边界（增量）

- `src/stores/providers.ts` 与 `src/stores/subagents.ts` 不再各自维护模型集合解析逻辑，统一依赖 `model-catalog`。
- 页面层（Chat/SubAgents）不再硬编码 `"/settings?section=aiProviders"`，统一依赖 `settings/sections` 构造链接。

### 15.4 关键决策与原因（增量）

- 模型集合来源合并 `config.models.providers` 与 `config.agents.defaults.models`，降低“配置有值但被误判不可用”的风险。
- Agent 模型清理写回时保留对象形态（仅替换 `primary`），避免丢失 `fallbacks` 等结构化字段。

### 15.5 本次变更日志

- 新增统一模型集合解析器并接入 providers/subagents。
- `reconcileAgentModels` 写回策略调整为“对象形态优先，仅替换 `primary`，无可用模型再清空”。
- 新增设置分区路由工具，收敛 AI 提供商分区跳转路径构造。
- 补充 `subagents` 空状态文案并替换页面硬编码文本。
