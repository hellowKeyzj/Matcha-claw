# CHANGE.md

## 本次变更日志（2026-03-25 Chat 虚拟列表语义重构）

### 目录树

```text
src/pages/Chat/
├── chat-row-model.ts（新增：统一聊天行建模，历史消息与底部临时内容合流）
├── chat-scroll-machine.ts（新增：显式滚动模式与命令状态机）
├── useChatScrollOrchestrator.ts（新增：虚拟列表执行器与视口/内容观察协调层）
└── index.tsx（改：聊天页改为只消费 ChatRow[] + 滚动状态机/执行器）

tests/unit/
├── chat-scroll-bottom.test.ts（改：覆盖聊天行模型与底部命令语义）
├── chat-scroll-machine.test.ts（新增：覆盖状态机纯函数流转）
├── chat-agent-click-scroll.test.tsx（新增：覆盖点击左侧 AGENT 的真实链路）
└── chat-session-switch-ux.test.tsx（改：覆盖切会话到底部与底部附近追加吸底）

spec/001-chat-virtual-list-refactor/
├── requirements.md
├── design.md
├── tasks.md
└── docs/README.md
```

### 文件职责（关键模块）

- `src/pages/Chat/chat-row-model.ts`：把历史消息、流式消息、处理中提示、打字提示统一建模成 `ChatRow[]`，让“最后一条聊天行”只有一个来源。
- `src/pages/Chat/chat-scroll-machine.ts`：维护 `opening / sticky / detached` 三种滚动模式，以及 `open-to-latest / follow-append` 两种待消费命令。
- `src/pages/Chat/useChatScrollOrchestrator.ts`：协调 virtualizer、视口和内容容器；把程序化滚动和用户主动滚动分开，并在高度继续变化时重试命令。
- `src/pages/Chat/index.tsx`：聊天页组合层；只负责把 store 运行时状态转成 `ChatRow[]`，交给虚拟列表渲染，并转发真实用户输入事件。
- `tests/unit/chat-scroll-bottom.test.ts`：验证统一聊天行模型、底部阈值判断和打开/追加命令语义。
- `tests/unit/chat-scroll-machine.test.ts`：验证纯状态机在切会话、追加消息、用户脱离底部时的流转规则。
- `tests/unit/chat-agent-click-scroll.test.tsx`：验证点击左侧 `AGENT` 后，即使行数不变也必须滚到当前会话最新消息底部。
- `tests/unit/chat-session-switch-ux.test.tsx`：验证“切会话默认到底部”“底部附近追加消息继续吸底”“用户上翻后不被强拉”的页面语义。

### 模块依赖与边界

- 仅改 Renderer 聊天页渲染层，不改 `src/stores/chat.ts` 的会话协议、Gateway RPC 和 Main 进程 IPC。
- 滚动定位统一依赖 `@tanstack/react-virtual` 的 `scrollToIndex(...)`、virtualizer 更新回调和内容容器 `ResizeObserver`，不再由额外 DOM 底部锚点承担主职责。
- 审批 dock 继续保留在输入框上方独立区域，没有被强行并入聊天行模型，避免本次重构扩大到审批 UI。

### 关键决策与原因

1. 旧实现同时维护“虚拟历史消息 + 列表外 streaming/activity/typing + DOM 底部锚点”，导致“最后一条”没有单一事实源，滚动语义只能靠 effect 时序拼出来。
2. 先把历史消息和底部临时内容统一成 `ChatRow[]`，才能让“切会话到底部”和“当前会话继续吸底”都只依赖同一个坐标系。
3. 吸底命令不会再被程序化滚动产生的中间 `scroll` 误判为“用户上翻”，只有真实用户输入才会打断 sticky 语义。
4. 内容高度继续变化时，由 `ResizeObserver` 和 virtualizer 更新共同驱动重试，不再靠多段 `requestAnimationFrame` 猜测测量完成时机。
5. 滚动语义收敛成显式状态后，测试可以直接围绕“为什么这次要吸底 / 不吸底”断言，而不是跟着实现细节波动。

### 本次变更

- 新增 `ChatRow` 建模层：
  - 历史消息、流式消息、处理中提示、打字提示全部统一成 `ChatRow[]`。
  - 去掉聊天页里“列表内消息”和“列表外临时行”并存的结构。
- 新增虚拟滚动控制层：
  - 用 `ChatScrollMachine` 显式表达 `opening / sticky / detached` 三种模式。
  - 用 `open-to-latest / follow-append` 命令表达“切会话到底部”和“底部附近追加后继续吸底”两种待执行语义。
  - 只有真实用户输入触发的滚动才会把状态切到 `detached`。
- 清理旧滚动补丁：
  - 删除 `messagesEndRef`、会话滚动快照恢复、`scrollIntoView(...)` 主路径、旧 `useChatVirtualScrollController.ts` 和双重定位 helper。
  - 聊天页只保留一套基于 `ChatRow[]` 末尾索引的底部定位逻辑，并在内容高度变化时通过观察器重试。
- 回归测试重写：
  - 纯函数测试覆盖聊天行合成、滚动状态流转和程序化滚动不中断命令的语义。
  - 页面级测试覆盖点击左侧 AGENT、切会话与当前会话追加消息三条主路径。

### 验证

- `pnpm test -- tests/unit/chat-scroll-machine.test.ts tests/unit/chat-agent-click-scroll.test.tsx tests/unit/chat-scroll-bottom.test.ts tests/unit/chat-session-switch-ux.test.tsx` 通过。
- `pnpm run typecheck` 通过。

## 本次变更日志（2026-03-23 Chat 真虚拟化落地）

### 目录树

```text
package.json（新增 @tanstack/react-virtual 依赖）
src/pages/Chat/
└── index.tsx（消息列表改为真实虚拟化：完整高度占位 + 会话锚点恢复）
```

### 文件职责（关键模块）

- `src/pages/Chat/index.tsx`：聊天消息渲染与滚动控制；本次将长会话从全量挂载升级为虚拟化挂载，仅渲染可视区消息并保持完整滚动高度语义。
- `package.json`：新增 `@tanstack/react-virtual`，作为消息列表虚拟化引擎。

### 模块依赖与边界

- 仅改 Renderer 聊天页渲染层，不改 `stores/chat` 协议与 Main 进程 IPC。
- 保持现有消息模型、审批模型、流式消息模型不变。

### 关键决策与原因

1. 全量渲染长会话会在切会话时触发大量 `beginWork/createTask`，形成 100ms+ 主线程长任务。
2. 之前 `slice(startIndex)` 截断方案破坏了滚动语义，本次改为“真实虚拟化 + 完整占位高度”从结构上修复。
3. 增加“每会话滚动锚点快照”与“切回恢复”，避免切换会话时总是丢失用户阅读位置。

### 本次变更

- 接入 `useVirtualizer`：
  - 消息列表改为虚拟项绝对定位渲染；
  - 使用 `messageVirtualizer.getTotalSize()` 维持完整滚动高度。
- 新增滚动快照机制：
  - 记录 `atBottom + anchorKey + anchorOffsetWithin + fallbackScrollTop`；
  - 切会话后按锚点或回退偏移恢复滚动位置。
- 继续保留粘底自动滚动（`behavior: 'auto'`）以降低滚动动画虚影风险。

### 验证

- `pnpm exec eslint src/pages/Chat/index.tsx` 通过。
- `pnpm run typecheck` 通过。

## 本次变更日志（2026-03-23 Chat 滚动语义止血修复）

### 目录树

```text
src/pages/Chat/
└── index.tsx（移除 slice 截断窗口化，恢复完整消息滚动语义）
```

### 文件职责（关键模块）

- `src/pages/Chat/index.tsx`：消息列表渲染与滚动控制；本次移除“截断渲染窗口”逻辑，恢复完整消息列表渲染，确保滚动条位置与真实历史一致。

### 模块依赖与边界

- 仅改 Renderer 聊天页渲染层，不改 `stores/chat` 协议与 Main 进程 IPC。
- 不改变发送、流式、审批、会话切换数据链路。

### 关键决策与原因

1. 现有 `messages.slice(startIndex)` 属于“数据截断渲染”，未配套虚拟化占位高度，导致滚动条语义失真（切会话后滑块位置不稳定）。
2. 先做止血：回退截断窗口化，优先恢复滚动行为可预测性。
3. 后续若需继续压渲染成本，应采用完整虚拟化方案（top/bottom spacer + 锚点恢复），而非再次截断数据。

### 本次变更

- 移除 `INITIAL_VISIBLE_MESSAGES / MESSAGE_GROW_BATCH / MESSAGE_GROW_TOP_THRESHOLD_PX` 相关窗口化常量和状态。
- 删除“向上增量展开 + 高度补偿”相关 effect 逻辑。
- 消息列表恢复为全量渲染：`ChatMessageHistoryList` 直接接收 `messages`。
- 保留粘底判断与自动滚动（`behavior: 'auto'`），避免滚动动画虚影。

### 验证

- `pnpm exec eslint src/pages/Chat/index.tsx` 通过。
- `pnpm run typecheck` 通过。

## 本次变更日志（2026-03-23 前端性能专项：会话切换与首屏交互卡顿治理）

### 目录树

```text
Matcha-claw/src/
├── lib/idle-ready.ts (新增：统一 idle/timeout 就绪调度)
├── stores/chat.ts (改：历史加载增量探测 + 指纹短路 + 合并状态提交)
├── components/layout/
│   ├── MainLayout.tsx (改：resize 链路 rAF 节流 + 值未变短路)
│   └── AgentSessionsPane.tsx (改：拆分 memo 子组件 + 分桶/展示缓存 + startTransition 切会话)
└── pages/
    ├── Chat/index.tsx (改：resize 链路 rAF 节流 + 值未变短路)
    ├── Dashboard/index.tsx (改：统一 idle-ready 调度，减少短定时器并发提交)
    ├── Skills/index.tsx (改：统一 idle-ready 调度，避免 ready 阶段同帧 setTimeout 堆叠)
    └── Tasks/index.tsx (改：统一 idle-ready + 任务列表窗口化渲染)
```

### 文件职责

- `lib/idle-ready.ts`：封装 `requestAnimationFrame + requestIdleCallback + shared timeout fallback`，用于重内容“延迟就绪”统一调度。
- `stores/chat.ts`：负责会话历史拉取、历史应用、会话标签/活动时间维护；新增 quiet 探测窗口与历史指纹短路。
- `components/layout/MainLayout.tsx` / `pages/Chat/index.tsx`：负责 pane resize 自适应；统一改为 rAF 节流并在值未变化时跳过 setState。
- `components/layout/AgentSessionsPane.tsx`：负责子代理会话列表展示；拆分为 memo 行组件，缓存分桶/展示文案，切会话改为 transition 更新。
- `pages/Tasks/index.tsx`：任务列表窗口化渲染，滚动时仅渲染可视区附近卡片，降低长列表渲染成本。

### 模块依赖与边界

- `Skills/Dashboard/Tasks` 的重内容 ready 调度统一依赖 `lib/idle-ready.ts`，避免各页重复实现。
- `chat.ts` 仅通过 `useGatewayStore.rpc('chat.history')` 与 `loadCronFallbackMessages` 获取历史，不引入新的跨层调用。
- 渲染层优化集中在 `src/` 内部，不改变主进程 IPC 协议边界。

### 关键决策与原因

1. quiet 轮询先小窗口探测再按需全量拉取：降低高频轮询成本，避免每次 200 条全量解析。
2. 历史应用阶段合并多次 `set`：减少同一帧多次提交导致的 `performWorkUntilDeadline` 累积。
3. resize 统一 rAF 节流：避免窗口拖拽/布局变化触发高频同步计算。
4. 列表窗口化优先落地在任务长列表：该路径数据量大且渲染成本稳定可控，收益确定性高。

### 本次变更

- 聊天历史：
  - `loadHistory` 增加 quiet probe（64）与指纹短路；
  - 有变化时才走 full window（200）与完整应用；
  - 历史应用阶段整合为单次 `set` 提交，减少重复状态写入。
- 布局链路：
  - `MainLayout`、`Chat` 的 resize 全改 rAF 调度；
  - `setSidebarWidth`、`setAgentSessionsWidth`、`setTaskInboxWidth` 均加“值不变不更新”短路。
- 会话面板：
  - 拆分 `AgentListItem` / `SessionListItem` memo 子组件；
  - 新增全局会话分桶和会话展示信息缓存；
  - 会话切换与新建切换使用 `startTransition`。
- 定时器就绪：
  - 新增 `scheduleIdleReady`，并接入 `Skills/Dashboard/Tasks`。
- 第二刀（安全子集）：
  - `Dashboard` 将 usage 图表/明细的两路 idle 定时合并为一路触发，降低同阶段多次 `Timer fired` 提交；
  - `Dashboard` 的 usage retry 在页面不可见时自动降频；
  - `Dashboard/Tasks` 的分钟/秒级时间刷新加入 `visibility` 保护，仅在可见时推进 state。
- Skills 首击链路补完：
  - `INITIAL_SKILLS_BATCH` 从 `12` 下调到 `8`，降低首次 `createTask` 负载；
  - all tab 计算链路按 `activeTab` 真短路（筛选/排序/分页仅在 `activeTab=all` 执行）；
  - 技能卡片拆分为 `SkillGridCard (memo)`，并使用稳定回调，减少父级状态变更带来的整批卡片重算。
- 第三刀（窗口化）：
  - `Skills` 卡片列表接入固定行高窗口化（阈值启用，含 overscan + 上下 spacer），不引入动态测高复杂度；
  - 窗口化开启时关闭旧的追加分页渲染路径，避免双路径重复计算。
- 聊天渲染链路（click 长任务治理）：
  - `Chat` 消息列表改为“最近 N 条先渲染 + 顶部滚动触发向上增量展开”，降低首击与切会话的初始渲染成本；
  - `ChatMessage` 的 `MessageBubble / ToolCard / AssistantHoverBar` 提取为 `memo`，减少父级更新时的重复子树渲染；
  - markdown 文本预处理（本地文件链接迁移 + filehint linkify）改为 `useMemo` 缓存，避免每次渲染重复字符串扫描；
  - 会话切换后的 `loadHistory(true)` 延后一帧执行，优先释放点击反馈主线程预算。
- 列表虚拟化：
  - `Tasks` 长任务列表改为窗口化渲染（可视区 + overscan + spacer）。

### 验证

- `pnpm run typecheck` 通过。
- `pnpm exec eslint ...`（本次改动相关文件）存在既有规则告警/错误：
  - `react-hooks/set-state-in-effect` 在 `Dashboard/Tasks` 旧逻辑中仍有历史问题；
  - 本次改动未新增新的 TypeScript 错误。

## 本次变更日志（2026-03-22 任务中心：共性层视觉统一（标题区/统计卡/基础卡片））

### 目录树

```text
Matcha-claw/src/
├── components/task-center/page-title.tsx (新增)
├── components/task-center/stat-card.tsx (新增)
├── components/task-center/styles.ts (新增)
├── pages/Tasks/index.tsx (改：统计卡改为复用共享组件)
└── pages/Cron/index.tsx (改：统计卡/标题区/基础卡片改为复用共享样式)
```

### 文件职责

- `components/task-center/page-title.tsx`：任务中心页标题区统一组件（标题 + 副标题）。
- `components/task-center/stat-card.tsx`：任务中心统计卡统一视觉组件，支持可点击/不可点击两种模式。
- `components/task-center/styles.ts`：任务中心卡片基础样式常量。
- `pages/Tasks/index.tsx`：长任务页接入统一标题区、统计卡与基础卡片样式。
- `pages/Cron/index.tsx`：定时任务页接入统一标题区、统计卡与基础卡片样式。

### 本次变更

- 抽取共享标题组件 `TaskCenterPageTitle`，统一标题区层级与副标题字号。
- 抽取共享统计卡组件 `TaskCenterStatCard`，统一图标容器、数字字号、标签字号、间距与激活态样式。
- 抽取 `TASK_CENTER_SURFACE_CARD_CLASS`，统一任务中心基础卡片边框与阴影风格。
- 长任务页与定时任务页均改为复用上述共性组件/样式；操作区仍按场景分化（长任务：筛选；定时任务：新建/编辑/执行）。

### 验证

- `pnpm -C Matcha-claw typecheck` 通过。

## 本次变更日志（2026-03-19 security-core：恢复 MEM-004/COST-004/DEGRAD 可配置语义并迁移到 canonical 字段）

### 目录树

```text
Matcha-claw/
├── packages/openclaw-security-plugin/
│   ├── openclaw.plugin.json
│   └── src/
│       ├── core/{types.ts,policy.ts}
│       ├── application/security-runtime.ts
│       └── vendor/
│           ├── secureclaw-runtime-bridge.ts
│           └── secureclaw-runtime/src/{types.ts,auditor.ts}
├── electron/utils/security-policy.ts
└── src/pages/Security/index.tsx
```

### 新增 canonical 字段

- `runtime.auditEgressAllowlist: string[]`（MEM-004）
- `runtime.auditDailyCostLimitUsd: number`（COST-004）
- `runtime.auditFailureMode: "block_all" | "safe_mode" | "read_only" | null`（DEGRAD）

### 本次变更

- 类型与策略解析：
  - `core/types.ts` 与 `core/policy.ts` 新增并解析上述 3 个字段。
  - `application/security-runtime.ts` 的不可变快照加入 `auditEgressAllowlist` 冻结。
- 审计运行时：
  - `secureclaw-runtime-bridge.ts` 将 runtime canonical 字段注入 `context.config.securityCore`。
  - `secureclaw-runtime/src/auditor.ts`：
    - MEM-004 改为优先读取 `securityCore.auditEgressAllowlist`（为空回退内置基线）。
    - COST-004 改为读取 `securityCore.auditDailyCostLimitUsd`（非法值回退 5）。
    - 恢复 DEGRAD-001，读取 `securityCore.auditFailureMode`。
  - `secureclaw-runtime/src/types.ts` 增加 `SecurityCoreAuditConfig` 与 `OpenClawConfig.securityCore`。
- 配置与前端：
  - `openclaw.plugin.json` 新增 3 个 canonical 字段 schema（并移除 `allowlist.pathPrefixes/domains`）。
  - `electron/utils/security-policy.ts` 与 `src/pages/Security/index.tsx` 同步支持这 3 个字段的模板/归一化/编辑。

### 验证

- `pnpm typecheck` 通过。
- `pnpm exec vitest run tests/unit/security-core-plugin.test.ts tests/unit/security-routes.test.ts tests/unit/security.page.api.test.tsx tests/unit/security-destructive-detector.test.ts` 通过（47/47）。

## 本次变更日志（2026-03-19 security-core：清理剩余兼容语义入口）

### 目录树

```text
Matcha-claw/
├── packages/openclaw-security-plugin/src/core/policy.ts
├── electron/utils/security-policy.ts
├── src/pages/Security/index.tsx
└── packages/openclaw-security-plugin/src/vendor/secureclaw-runtime/src/{auditor.ts,types.ts}
```

### 文件职责

- 策略解析链路改为只接受 canonical 字段，不再接受历史别名字段。
- 审计子集移除 `gateway.authToken` 的 legacy 兼容读取，统一走 `gateway.auth.*`。
- 前端策略归一化与后端保持一致，去掉 `allowlist` 中 path/domain 旧别名解析。

### 本次变更

- `core/policy.ts`
  - `allowlistedTools` / `allowlistedSessions` 仅从 `allowlist.tools/sessions` 读取。
  - `allowPathPrefixes` / `allowDomains` 仅从顶层 `runtime.allowPathPrefixes/allowDomains` 读取。
- `electron/utils/security-policy.ts`
  - 删除 `allowlist.pathPrefixes/allowPathPrefixes`、`allowlist.domains/allowDomains` 兼容解析。
  - `SecurityRuntimePolicy.allowlist` 收敛为仅 `{ tools, sessions }`。
- `src/pages/Security/index.tsx`
  - 前端归一化删除同样的 alias 读取，保持与后端 canonical 一致。
- `vendor/secureclaw-runtime/src/auditor.ts`
  - 移除 `gateway.authToken` legacy fallback。
  - 移除对 `secureclaw.failureMode` 的审计依赖。
  - `MEM-004` 的域名白名单改为固定基线，不再读取 `secureclaw.network.egressAllowlist`。
- `vendor/secureclaw-runtime/src/types.ts`
  - 删除 `GatewayConfig.authToken` 字段定义。

### 验证

- `pnpm typecheck` 通过。
- `pnpm exec vitest run tests/unit/security-core-plugin.test.ts tests/unit/security-routes.test.ts tests/unit/security.page.api.test.tsx tests/unit/security-destructive-detector.test.ts` 通过（47/47）。

## 本次变更日志（2026-03-19 security-core：移除兼容转发层，统一直连分层实现）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/src/
├── index.ts
├── adapters/openclaw/plugin.ts
├── application/security-runtime.ts
├── core/{types,policy,runtime-guard}.ts
├── infrastructure/{actions,auditor,monitors/selected-monitors.ts}
└── vendor/secureclaw-runtime-bridge.ts

已删除兼容转发文件：
- src/actions.ts
- src/auditor.ts
- src/policy.ts
- src/runtime-guard.ts
- src/types.ts
- src/monitors/selected-monitors.ts
```

### 文件职责

- `src` 顶层不再保留 re-export 兼容壳，调用方统一走 `application/core/infrastructure` 分层路径。
- `secureclaw-runtime-bridge.ts` 改为直接依赖 `core/types.ts`，不再经过顶层 `src/types.ts` 转发。

### 模块依赖与边界

- 运行时主链路不变：`adapters -> application -> core/infrastructure/vendor`。
- 删除兼容层后，模块边界更清晰，消除“同名目录 + 转发壳”带来的歧义。

### 关键决策与原因

1. 当前仓库内已无业务代码依赖这些转发壳，保留只会增加维护噪音。
2. 用户明确“不需要向后兼容”，因此执行彻底净化。
3. 保持行为不变，只做路径收敛和边界清理。

### 验证

- `pnpm typecheck` 通过。
- `pnpm exec vitest run tests/unit/security-core-plugin.test.ts tests/unit/security-routes.test.ts tests/unit/security.page.api.test.tsx tests/unit/security-destructive-detector.test.ts` 通过（47/47）。

## 本次变更日志（2026-03-19 security-core：废除 Capability 矩阵）

### 目录树

```text
Matcha-claw/
├── packages/openclaw-security-plugin/
│   ├── openclaw.plugin.json (改：删除 capability 配置项)
│   └── src/
│       ├── application/security-runtime.ts (改：删除 capability 快照冻结字段)
│       ├── core/policy.ts (改：删除 capability 解析)
│       ├── core/types.ts (改：删除 capability 类型定义)
│       ├── core/runtime-guard.ts (改：删除 capability 启用判定)
│       └── core/runtime-engine/detector.ts (改：删除 capability 规则)
├── electron/utils/security-policy.ts (改：删除 capability 字段及预设)
├── src/pages/Security/index.tsx (改：删除 capability 开关与矩阵 UI)
└── tests/unit/security-core-plugin.test.ts (改：删除 capability 相关用例)
```

### 文件职责

- security-core 仅保留 destructive / secrets / path / domain / prompt-injection 策略语义。
- 前端安全页不再暴露 capability 配置入口，策略配置统一收敛到当前可执行语义。

### 模块依赖与边界

- `before_tool_call` 不再执行 capability 判定分支。
- 策略持久化与 plugin schema 不再接受 capability 字段。
- 单测移除 capability 场景，保持现有策略链路覆盖。

### 关键决策与原因

1. capability 不属于 openclaw 基础工具约束模型，保留会增加无效认知负担。
2. 废除后策略表达更直接，避免“配置存在但运行价值不明确”的伪能力。
3. 删除整条链路后可降低维护成本与误配置风险。

### 本次变更

- 后端：删除 capability 类型、解析、运行时判定、schema 字段。
- 前端：删除 capability 开关、capabilityTokens、toolCapabilityRequirements 可视化矩阵。
- 测试：删除 capability 守卫与免检工具测试。

### 验证

- `pnpm typecheck` 通过。
- `pnpm exec vitest run tests/unit/security-core-plugin.test.ts tests/unit/security-routes.test.ts tests/unit/security.page.api.test.tsx tests/unit/security-destructive-detector.test.ts` 通过（47/47）。

## 本次变更日志（2026-03-19 security-core：策略快照“写时替换 + 共享只读引用”）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/src/application/
└── security-runtime.ts (改：runtimeConfig 快照不可变 + 指针替换)
```

### 文件职责

- `security-runtime.ts`：策略同步链路采用“生成不可变快照 -> 原子替换引用”的运行时配置管理方式。

### 模块依赖与边界

- 所有 hook 判定共享同一 `runtimeConfig` 引用，不做判定时深拷贝。
- 策略更新仅在 `security.policy.sync` 中发生，更新方式为引用替换，不在原对象上就地修改。

### 关键决策与原因

1. 避免大对象深拷贝带来的 CPU/内存消耗。
2. 避免并发判定过程中出现“对象被中途改写”的状态不一致。
3. 去除 `JSON.stringify` 全量比较，改为监控相关字段定向比较，降低同步开销。

### 本次变更

- 新增 `freezeRuntimeConfigSnapshot(...)`：对策略对象及其关键嵌套结构做冻结。
- `runtimeConfig` 初始化与同步更新统一走快照化。
- `security.policy.sync`：
  - 先算 `mergedRuntimeConfig`
  - 再按引用切换 `runtimeConfig`
  - 监控重配使用 `shouldReconcileMonitors(...)` 定向比较。
- `startSelectedMonitors` 改为读取同一份 `activeRuntimeConfig` 快照，避免异步过程中读到不同版本。

### 验证

- `pnpm typecheck` 通过。
- `pnpm vitest run tests/unit/security-core-plugin.test.ts tests/unit/security-routes.test.ts tests/unit/security.page.api.test.tsx` 通过（32/32）。

## 本次变更日志（2026-03-19 security-core：Policy Guard 改为 Rule Pipeline）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/src/core/runtime-engine/
└── detector.ts (改：policy 检测改为规则数组 + 统一执行器)
```

### 文件职责

- `detector.ts`：policy 检测从“顺序 if 判断”重构为 `POLICY_RULE_PIPELINE`，并通过统一执行器短路返回。

### 模块依赖与边界

- 规则执行顺序保持不变：`capability -> allowPathPrefixes -> allowDomains -> promptInjection`。
- 引入 `PolicyRuleContext` 惰性缓存，避免单次请求中重复提取 path/domain/capability 数据。

### 关键决策与原因

1. 扩展性：新增规则只需追加 pipeline 项，不需要改主流程控制分支。
2. 可维护性：规则逻辑和执行机制分离，降低函数复杂度。
3. 性能：保留短路语义与缓存策略，不增加热路径额外扫描次数。

### 本次变更

- 新增 `PolicyRule` / `PolicyRuleContext` / `executePolicyRulePipeline`。
- capability/path/domain/prompt 四类策略重构为独立规则执行函数。
- `buildPolicyDetection` 改为 pipeline 执行入口。
- 验证：
  - `pnpm typecheck` 通过
  - `pnpm vitest run tests/unit/security-core-plugin.test.ts tests/unit/security-destructive-detector.test.ts` 通过

## 本次变更日志（2026-03-19 security-core：高性能策略守卫补齐 1/2/3）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/src/core/
├── runtime-engine/detector.ts (重写：新增 policy guard + 缓存化检测)
└── runtime-guard.ts (新增：无检测项时快速短路)

Matcha-claw/src/pages/Security/
└── index.tsx (新增 runtime 字段映射与配置 UI)

Matcha-claw/tests/unit/
└── security-core-plugin.test.ts (新增 policy guard 行为用例)
```

### 文件职责

- `runtime-engine/detector.ts`：统一执行 `before_tool_call` 检测，新增路径白名单、域名白名单、prompt injection、capability token 四类 policy 检测。
- `runtime-guard.ts`：新增“检查项关闭时快速返回”逻辑，降低无策略场景下的调用开销。
- `src/pages/Security/index.tsx`：前端策略模型与保存链路同步新增字段，避免“后端支持但保存丢字段”。
- `security-core-plugin.test.ts`：覆盖新增策略检测与放行/阻断行为。

### 模块依赖与边界

- `before_tool_call` 新顺序：`policy guard -> destructive -> secret`，策略违规优先硬阻断。
- policy guard 在引擎内独立于 destructive/secrets 语义，决策层统一走 `kind: policy` 的 block 分支。

### 关键决策与原因

1. 以“短路优先”保证性能：先做 capability/path/domain 快速判定，再做 destructive/secret 扫描。
2. 以“缓存优先”减少热路径分配：正则编译与 allowlist 归一化结果全部做模块级缓存。
3. 保持契约稳定：不改 gateway method 与 hook 入口，只增强检测器能力和前端策略表达。

### 本次变更

- `detector.ts` 新增：
  - `allowPathPrefixes` 硬拦截（含 `apply_patch` 文件路径解析）
  - `allowDomains` 硬拦截（URL/域名提取 + 子域匹配）
  - `enablePromptInjectionGuard` 检测（基线 + 扩展 regex，缓存编译）
  - `capabilityGuardEnabled` + `toolCapabilityRequirements` + `capabilityTokens` 判定
- `runtime-guard.ts` 新增 `hasBeforeToolChecksEnabled()` 快速短路。
- `Security` 页面新增字段并可编辑：
  - `enablePromptInjectionGuard`
  - `capabilityGuardEnabled`
  - `allowPathPrefixes`
  - `allowDomains`
  - `capabilityTokens`
  - `promptInjectionPatterns`
  - `toolCapabilityRequirements`
- 新增单测：
  - 路径越界阻断
  - 域名越界阻断
  - prompt injection 阻断
  - capability token 缺失阻断

### 验证结果

- `pnpm vitest run tests/unit/security-core-plugin.test.ts tests/unit/security-routes.test.ts tests/unit/security.page.api.test.tsx tests/unit/security-destructive-detector.test.ts` 通过（48/48）。
- `pnpm typecheck` 通过。
- `SECURITY_BENCH=1 pnpm vitest run tests/benchmark/security-runtime-benchmark.test.ts` 实测：
  - benign p95 `0.1852ms`
  - destructive block p95 `0.1682ms`
  - secret block p95 `0.1893ms`
  - secret redact p95 `0.1963ms`

## 本次变更日志（2026-03-19 security-core：Destructive 检测器切换为“外置规则 + 预编译缓存引擎”）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/src/vendor/clawguardian-destructive/
├── detector.ts (重写：配置驱动 + 编译缓存)
└── destructive-rules.json (新增：Destructive 全量规则外置文件)
```

### 文件职责

- `detector.ts`：负责规则加载、正则预编译、command -> bucket 分发与检测执行。
- `destructive-rules.json`：承载 destructive 规则数据（system/sql/path/rce/powershell/truncation）。

### 模块依赖与边界

- 运行时链路：`runtime-engine/detector -> vendor/clawguardian-destructive/detector -> destructive-rules.json`。
- 检测热路径不再创建规则对象与正则，全部使用模块级缓存。
- 规则改动主入口从 TS 代码迁移为 JSON 配置文件。

### 关键决策与原因

1. 满足“改规则不改代码”诉求：规则从代码常量迁移到 JSON。
2. 保持性能稳定：采用“首次编译 + 内存缓存”，避免每次 `before_tool_call` 重复编译。
3. 保持语义一致：保留原有导出函数与检测流程，先通过单测确保行为未缩水。

### 本次变更

- 新增 `destructive-rules.json`，覆盖：
  - SQL destructive 正则
  - 系统命令规则（universal/linux/windows/macos）与命令集合
  - 敏感路径规则
  - RCE 模式
  - 截断文件规则
  - PowerShell destructive 规则
- 重写 `detector.ts`：
  - `command -> rule bucket` 分发
  - 规则/正则预编译缓存
  - 保留 `detectDestructive/isDestructiveSystem/isDestructiveGit/...` 对外函数
- 新增缓存重置测试钩子：`resetDestructiveRuleCacheForTests()`
- 验证结果：
  - `tests/unit/security-destructive-detector.test.ts` 通过（16/16）
  - `tests/unit/security-core-plugin.test.ts` 通过（21/21）
  - `tests/unit/security-routes.test.ts` + `tests/unit/security.page.api.test.tsx` 通过（7/7）
  - `pnpm typecheck` 通过
  - `SECURITY_BENCH=1` 实测：
    - benign p95 `0.1688ms`
    - destructive p95 `0.1626ms`
    - secret block p95 `0.1731ms`
    - secret redact p95 `0.1791ms`

## 本次变更日志（2026-03-18 security-core：移除 `agent-confirm`，统一 `confirm` 可配置语义）

### 关键决策与原因

1. 废弃 `agent-confirm`，避免用户在动作矩阵里出现重复语义（`confirm` 与 `agent-confirm`）造成认知负担。
2. 保留 `confirm` 并覆盖所有工具：exec-style 继续走 `ask: "always"`，非 exec-style 走 `_clawguardian_confirm` 二次确认闸门。

### 本次变更

- `SecurityGuardAction` 从 `block/redact/confirm/agent-confirm/warn/log` 收敛为 `block/redact/confirm/warn/log`。
- `before_tool_call` 决策分支移除 `agent-confirm`，审计 decision 改为 `confirm-required/confirm-approved` 语义。
- `tool_result_persist` 同步 hook 的 `confirm` 继续安全降级为 `block`。
- 同步更新：
  - `packages/openclaw-security-plugin/openclaw.plugin.json` 动作枚举
  - `electron/utils/security-policy.ts` 策略归一化
  - `src/pages/Security/index.tsx` 前端动作枚举（secrets 支持显式配置 `confirm`）
  - `tests/unit/security-core-plugin.test.ts` 用例与断言

## 本次变更日志（2026-03-18 security-core v2 Phase D+：彻底干净化，移除顶层 vendor 快照目录）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/
├── src/vendor/
│   ├── secureclaw-runtime-bridge.ts
│   └── secureclaw-runtime/...
└── vendor/ (已删除)
```

### 文件职责

- `src/vendor/secureclaw-runtime/*`：唯一审计运行时来源。
- `src/vendor/secureclaw-runtime-bridge.ts`：唯一审计桥接入口。
- 顶层 `packages/openclaw-security-plugin/vendor`：已彻底移除，不再保留快照副本。

### 关键决策与原因

1. 用户要求“完全新模块、无快照残留”，因此删除顶层 `vendor` 目录。
2. 不迁移许可证声明，按当前交付要求保持最小变更面。

### 本次变更

- 删除 `packages/openclaw-security-plugin/vendor` 全目录。
- 更新 `MODULE_BOUNDARIES.md`，去除快照目录现态描述。
- 更新 `src/vendor/secureclaw-runtime/README.md`，去除对顶层快照目录的依赖说明。

## 本次变更日志（2026-03-18 security-core v2 Phase D：桥接重命名 + 规则引擎三层拆分）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/src/
├── vendor/
│   ├── secureclaw-runtime-bridge.ts (由 secureclaw-original-bridge.ts 重命名)
│   └── secureclaw-runtime/...
└── core/
    ├── runtime-guard.ts (改：仅保留编排职责)
    └── runtime-engine/ (新增)
        ├── types.ts
        ├── detector.ts
        ├── decision.ts
        ├── action.ts
        └── shared.ts
```

### 文件职责

- `vendor/secureclaw-runtime-bridge.ts`：审计桥接入口，语义与目录名统一为 runtime。
- `core/runtime-engine/detector.ts`：检测层，仅负责 destructive/secrets 命中识别与证据聚合。
- `core/runtime-engine/decision.ts`：决策层，仅负责 `severity -> action` 与确认语义决策。
- `core/runtime-engine/action.ts`：动作层，仅负责把决策物化为 `block/params/audit` 输出。
- `core/runtime-guard.ts`：编排层，串联“三层引擎”并处理 allowlist/confirm 标记清理。

### 模块依赖与边界

- 新运行时链路：`runtime-guard(orchestrator) -> detector -> decision -> action`。
- 各层单一职责，不再在一个文件中混合“检测 + 决策 + 动作”逻辑。
- 审计桥接命名统一为 `secureclaw-runtime-bridge`，与 `src/vendor/secureclaw-runtime` 保持一致。

### 关键决策与原因

1. 先改名桥接文件，消除 `original` 与 `runtime` 混用导致的语义歧义。
2. 规则引擎按“检测/决策/动作”硬拆层，降低 `before_tool_call` 路径的分支耦合度。
3. 保留外部契约不变（Gateway 方法、5 hooks、策略字段），仅做内部结构升级。

### 本次变更

- 重命名桥接文件：`secureclaw-original-bridge.ts` -> `secureclaw-runtime-bridge.ts`。
- 新增 `core/runtime-engine/*` 五个文件并完成 `before_tool_call` 逻辑迁移。
- `core/runtime-guard.ts` 收敛为编排器实现，复用三层引擎输出。

## 本次变更日志（2026-03-18 security-core v2 Phase C：审计运行时与上游快照解耦）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/
├── src/vendor/
│   ├── secureclaw-runtime-bridge.ts (改：导入改为本地 runtime 子集)
│   └── secureclaw-runtime/ (新增)
│       ├── README.md
│       ├── src/
│       │   ├── auditor.ts
│       │   ├── types.ts
│       │   └── utils/{hash.ts,ioc-db.ts}
│       └── ioc/indicators.json
├── MODULE_BOUNDARIES.md (更新)
└── vendor/secureclaw-original/ (保留：上游快照，仅参考)
```

### 文件职责

- `src/vendor/secureclaw-runtime/*`：安全插件运行时实际使用的 secureclaw 审计最小子集。
- `src/vendor/secureclaw-runtime-bridge.ts`：审计桥接层，统一从 `src/vendor/secureclaw-runtime` 导入审计实现与类型。
- `vendor/secureclaw-original/*`：上游原版镜像，仅用于溯源/比对，不再被运行时代码导入。
- `MODULE_BOUNDARIES.md`：新增“禁止运行时直连顶层 vendor/src”边界约束。

### 模块依赖与边界

- 新运行时链路：`infrastructure/auditor -> secureclaw-runtime-bridge -> src/vendor/secureclaw-runtime`。
- 旧链路 `-> vendor/secureclaw-original/src/*` 已移除。
- 顶层 `vendor` 目录从“运行时依赖”降级为“上游快照仓”。

### 关键决策与原因

1. 解决 `vendor` 与 `src/vendor` 双层并存导致的语义混乱，先切断运行时跨层导入。
2. 保留上游快照可追溯性（许可证、对比、后续升级 diff），同时保证运行时模块内聚。
3. 采用最小子集迁移而非全量搬迁，降低重构风险并保持现有行为稳定。

### 本次变更

- 新增 `src/vendor/secureclaw-runtime` 最小运行时子集。
- 修改 `src/vendor/secureclaw-runtime-bridge.ts` 导入路径，移除对 `vendor/secureclaw-original/src/*` 的运行时依赖。
- 更新模块边界文档并新增子集说明文档。

## 本次变更日志（2026-03-18 security-core v2 Phase B：模块分层落地）

### 目录树

```text
Matcha-claw/packages/openclaw-security-plugin/src/
├── adapters/
│   └── openclaw/plugin.ts
├── application/
│   └── security-runtime.ts
├── core/
│   ├── policy.ts
│   ├── runtime-guard.ts
│   └── types.ts
├── infrastructure/
│   ├── actions.ts
│   ├── auditor.ts
│   └── monitors/selected-monitors.ts
├── index.ts
├── actions.ts (re-export)
├── auditor.ts (re-export)
├── policy.ts (re-export)
├── runtime-guard.ts (re-export)
├── monitors/selected-monitors.ts (re-export)
└── types.ts (re-export)
```

### 文件职责

- `adapters/openclaw/plugin.ts`：插件适配入口，固定插件元信息并委派到应用层。
- `application/security-runtime.ts`：承接原 `index.ts` 的运行时编排逻辑（hook/gateway 注册与流程控制）。
- `core/{types,policy,runtime-guard}.ts`：安全核心模型、策略决策与运行时拦截内核。
- `infrastructure/{actions,auditor,monitors}.ts`：基础设施能力下沉，负责安全动作、启动审计与监控实现。
- `src/{types,policy,runtime-guard,actions,auditor,monitors/*}.ts`：保留为薄 re-export 层，避免外部引用一次性断裂。
- `MODULE_BOUNDARIES.md`：记录新分层边界与依赖方向约束。

### 模块依赖与边界

- 新依赖方向：`adapters -> application -> core`。
- `vendor` 仍保留，但只在 `core/runtime-guard` 与桥接层被消费，不再由插件入口直接拼装。

### 关键决策与原因

1. 先做“无行为变化的结构迁移”，把单文件入口拆成分层，降低后续继续内聚重构风险。
2. 通过 re-export 过渡，保证路径迁移不会影响现有测试与集成点。

### 本次变更

- `src/index.ts` 降级为适配入口 re-export。
- 抽出 `application/security-runtime.ts` 承载编排逻辑。
- 建立 `core` 层并下沉 `types/policy/runtime-guard` 实现。
- 建立 `infrastructure` 层并下沉 `actions/auditor/monitors` 实现。
- 新增模块边界文档 `packages/openclaw-security-plugin/MODULE_BOUNDARIES.md`。
- 安全相关单测全量通过（33/33）。

## 本次变更日志（2026-03-18 security-core 语义纯化：移除 guardian/secureclaw 兼容入口）

### 目录树

```text
Matcha-claw/
├── packages/openclaw-security-plugin/src/
│   ├── index.ts
│   ├── policy.ts
│   └── types.ts
├── electron/utils/security-policy.ts
└── tests/unit/security-core-plugin.test.ts
```

### 文件职责

- `packages/openclaw-security-plugin/src/index.ts`：仅暴露 `security.*` 网关方法，不再注册 `guardian.*` 别名。
- `packages/openclaw-security-plugin/src/policy.ts`：运行时配置只接受 `runtime` 主语义，不再接受 `secureclaw` 兼容字段。
- `packages/openclaw-security-plugin/src/types.ts`：删除 `SecurityPolicyPayload.secureclaw` 兼容字段定义。
- `electron/utils/security-policy.ts`：策略文件读取只认 `security.policy.json`，不再回退 `guardian.policy.json`。
- `tests/unit/security-core-plugin.test.ts`：同步断言到纯 `security.*` 方法集合。

### 模块依赖与边界

- 前端/Host API/插件的策略主链路统一为：`security.policy.json` -> `/api/security` -> `security.policy.sync` -> `runtime`。
- 插件不再承担 guardian 命名兼容层；上层如果仍调用 `guardian.*`，将显式失败。

### 关键决策与原因

1. 当前处于未发布阶段，按要求执行“一次性彻底切换”，避免继续维持双语义模型。
2. 删除 `secureclaw` payload 兼容字段，防止配置源出现多份事实源（`runtime` vs `secureclaw`）。
3. 删除 `guardian.policy.json` 回退，避免重启后误读旧策略文件导致行为漂移。

### 本次变更

- 移除 gateway 方法兼容别名：`guardian.policy.sync`、`guardian.audit.query`、`guardian.audit.latest`。
- 移除策略字段兼容入口：`payload.secureclaw`、`pluginConfig.secureclaw`。
- 移除策略文件兼容回退：`guardian.policy.json`。
- 更新单测断言，确保纯 `security-core` 语义下通过。
- 新增重构护栏文档：`packages/openclaw-security-plugin/REFACTOR_ACCEPTANCE_CHECKLIST.md`。
- 补齐重构前缺口测试（`message_received`、`after_tool_call`、allowlist、扩展 patterns、skills/advisories/remediation 返回语义）。

## 本次变更日志（2026-03-17 secureclaw 原版迁移 + security 插件独立化）

### 目录树

```text
Matcha-claw/
├── packages/
│   ├── openclaw-security-plugin/
│   │   ├── openclaw.plugin.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── policy.ts
│   │   │   ├── auditor.ts
│   │   │   ├── runtime-guard.ts
│   │   │   ├── types.ts
│   │   │   └── vendor/
│   │   │       ├── secureclaw-runtime-bridge.ts
│   │   │       ├── clawguardian-destructive/
│   │   │       └── shield-core/
│   │   └── vendor/
│   │       └── secureclaw-original/
│   └── openclaw-task-manager-plugin/
│       └── src/index.ts
├── electron/
│   ├── utils/
│   │   ├── security-policy.ts
│   │   └── guardian-policy.ts
│   ├── api/routes/security.ts
│   └── main/index.ts
├── src/pages/Security/index.tsx
└── tests/unit/
    ├── security-core-plugin.test.ts
    ├── security-routes.test.ts
    └── security.page.api.test.tsx
```

### 文件职责

- `packages/openclaw-security-plugin/vendor/secureclaw-original/*`：拷贝上游 secureclaw 原版代码作为底座镜像，不在该目录直接改业务逻辑。
- `packages/openclaw-security-plugin/src/vendor/secureclaw-runtime-bridge.ts`：封装原版审计入口与状态目录解析，提供本项目可控桥接层。
- `packages/openclaw-security-plugin/src/vendor/clawguardian-destructive/detector.ts`：移植 clawguardian destructive 规则集，作为破坏性命令检测基线。
- `packages/openclaw-security-plugin/src/runtime-guard.ts`：在 before_tool_call 中执行 destructive/secret 双检测，secret 正则走缓存编译。
- `packages/openclaw-security-plugin/src/index.ts`：统一插件入口，主接口切换到 `security.*`，保留 `guardian.*` 兼容别名。
- `electron/utils/security-policy.ts`：安全策略文件读写与标准化（`security.policy.json`）。
- `electron/api/routes/security.ts`、`electron/main/index.ts`：主进程与 Host API 统一使用 `security.policy.sync / security.audit.query`。

### 模块依赖与边界

- Task Manager 插件不再承担安全职责，安全能力全部收敛到 `security-core` 独立插件。
- `security-core` 采用“双层架构”：
  1. secureclaw 原版审计层（gateway_start）
  2. shield 风格运行时拦截层（before_tool_call）
- 上游镜像代码与项目适配代码分层，降低后续升级 secureclaw 原版时的冲突风险。

### 关键决策与原因

1. 先拷贝 secureclaw 原版再裁剪，避免“参考实现”丢失导致后续无法对齐上游。
2. 运行时拦截继续保留，并切换到 shield 模式扫描器，维持你们现有前置阻断能力。
3. 主链路全面从 guardian 命名迁移到 security 命名，但保留 gateway 方法别名，避免迁移期断连。

### 本次变更

- 废弃 `riskProfile / failureMode` 的运行时可配置能力，避免“可选但不生效”的策略项继续暴露到 UI。
- 安全页移除“风险档位 / 失效模式”下拉，运行时策略只保留真实生效的开关与动作矩阵。
- `electron/utils/security-policy.ts` 与 `packages/openclaw-security-plugin/src/policy.ts` 同步移除上述字段的读写与标准化逻辑。
- `packages/openclaw-security-plugin/openclaw.plugin.json` 删除 `riskProfile / failureMode` 配置 schema。
- 审计桥接 `secureclaw-runtime-bridge.ts` 不再把 `riskProfile / failureMode` 写入 `config.secureclaw.*`，彻底取消对齐原版该语义的桥接行为。

- 完成 secureclaw 原版代码镜像导入（`vendor/secureclaw-original`）。
- 重构 `security-core` 插件：
  - 启动审计改为调用 secureclaw 原版 `runAudit`
  - before_tool_call 改为 `clawguardian` destructive 规则 + shield 风格 secret 基线 + `policy.ts` 扩展规则
  - 移除 kill switch 运行时阻断机制（不再在 hook 与应急动作中写入/依赖 killswitch 文件）
  - 启动审计过滤 `SC-KILL-001`，避免 UI 与日志继续暴露 kill switch 语义
  - 运行时动作从“单一 block”升级为完整策略动作：`block / confirm / agent-confirm / warn / log / redact`
  - destructive 支持分类开关（fileDelete/git/sql/system/process/network/privilegeEscalation）与按严重级别动作映射
  - secret 支持按严重级别动作映射，`redact`/`confirm` 分支会对参数执行脱敏改写后再放行
  - 支持 runtime allowlist（tools/sessions）与检测日志开关（`logging.logDetections`）
  - 接入 5 个运行时 hook：`before_agent_start`、`before_tool_call`、`tool_result_persist`、`message_received`、`after_tool_call`
  - 新增 hook 耗时统计：按 hook 维度记录 `count / p50 / p95 / last / max`，通过 `security.monitor.status` 返回
  - `tool_result_persist` 增加输出扫描与脱敏/阻断（secret + PII）策略链，避免仅依赖输入侧阻断
  - `tool_result_persist` 升级为严格按 `severity -> action` 分流：`block/redact/warn/log`；`confirm/agent-confirm` 在该同步 hook 内安全降级为 `block`
  - secret 扩展正则编译增加缓存，避免每次工具调用重复编译
  - 新增运行时审计事件记录并支持分页查询
  - 启用可选监控服务并默认开启 `credential-monitor` 与 `memory-integrity`（`cost-monitor` 默认关闭）
  - 监控实现采用项目内精简实现（无 `chokidar` 额外依赖），并接入 gateway 生命周期启动/停止
- 主应用侧 `guardian-policy` 能力迁移到 `security-policy`：
  - 策略文件默认路径改为 `~/.openclaw/policies/security.policy.json`
  - 读取时兼容旧 `guardian.policy.json`
- 前后端接口迁移：
  - `security.policy.sync` 取代 `guardian.policy.sync`
  - `security.audit.query` 取代 `guardian.audit.query`
- Security 页面审计查询改用 `security.audit.query`。
- 新增桌面一键安全动作（替代原 skill CLI 脚本）：
  - 一键体检：`/api/security/quick-audit` → `security.quick_audit.run`
  - 一键应急：`/api/security/emergency-response` → `security.emergency.run`
  - 完整性校验/重建：`security.integrity.check / security.integrity.rebaseline`
  - 技能扫描：`security.skills.scan`
  - 通告检查：`security.advisories.check`
  - 修复动作（预览/应用/回滚）：`security.remediation.preview / apply / rollback`

## 本次变更日志（2026-03-17 安全策略模型一次性切换到 runtime config）

### 目录树

```text
Matcha-claw/
├── electron/
│   └── utils/
│       ├── security-policy.ts
│       └── guardian-policy.ts
├── packages/
│   └── openclaw-security-plugin/
│       └── src/
│           ├── index.ts
│           ├── policy.ts
│           └── types.ts
└── src/pages/Security/index.tsx
```

### 文件职责

- `electron/utils/security-policy.ts`：策略文件结构从旧 guardian 字段改为 `runtime` 全量配置（destructive/secrets/severity/actions/categories/allowlist/patterns）。
- `packages/openclaw-security-plugin/src/index.ts`：`security.policy.sync` 不再只同步 preset，新增 runtime 热应用并在配置变更后重协同监控状态。
- `packages/openclaw-security-plugin/src/policy.ts`：新增 `mergeRuntimeConfig`，把策略 payload 的 runtime 归一化并覆盖当前运行配置。
- `src/pages/Security/index.tsx`：前端策略页彻底改为 runtime config 编辑器，移除旧 `allowTools/confirmTools/denyTools` 表达。

### 模块依赖与边界

- 前端 `/api/security` 与插件 `security.policy.sync` 统一使用同一 runtime 模型，避免“前端可配但插件不消费”。
- 兼容别名仅保留在 gateway 方法命名层（`guardian.*`），策略字段层不再做旧模型兼容编辑。

### 关键决策与原因

1. 用户明确要求“未发布阶段一次性改好”，因此直接放弃兼容层，做模型直切。
2. 如果不改 `policy.sync` 热应用，前端保存策略仍然无法实时影响 runtime guard，必须在插件侧补齐。
3. 策略页保留“安全动作中心”能力，避免在模型切换时损失现有桌面化运维入口。

### 本次变更

- 安全策略持久化改为：
  - `preset`
  - `securityPolicyVersion`
  - `runtime`（完整运行时配置）
- `security-core` 插件新增 runtime 热更新能力：
  - `security.policy.sync` 收到 `runtime` 后立即覆盖当前配置
  - 配置变化后自动重协同监控启动状态（stop/start）
- Security 页面完成一次性重构：
  - 新增 destructive/secrets 默认动作与 severity 动作矩阵配置
  - 新增 destructive 分类开关配置
  - 新增 allowlist 与扩展 regex 配置
  - 保留一键体检/一键应急/完整性/扫描/修复预览与回滚等动作入口

## 本次变更日志（2026-03-16 Dashboard Token 分阶段渲染：先摘要后明细）

### 目录树

```text
Matcha-claw/
└── src/
    └── pages/Dashboard/index.tsx
```

### 文件职责

- `src/pages/Dashboard/index.tsx`：Token 历史面板拆分为两阶段渲染，先显示摘要区（窗口/分组/图表），再延后挂载明细列表与分页。

### 模块依赖与边界

- 不改 token 数据来源与统计口径，不改接口协议。
- 仅调整 Dashboard renderer 渲染时序，降低首帧明细列表挂载带来的主线程峰值。

### 关键决策与原因

1. Dashboard token 面板中“明细列表 + 分页”属于重渲染区域，和摘要区同帧挂载会放大首屏延时。
2. 用户感知优先级应是“先看到可用摘要，再补全明细”，符合首屏体感优化目标。

### 本次变更

- 新增 `usageChartReady` 与 `usageChartPrimedRef`：
  - 在 token 数据可用后，图表区延后到下一帧 + idle 再挂载；
  - 与明细列表解耦，形成“摘要 -> 图表 -> 明细”的三段式渲染节奏。
- 新增轻量摘要卡：
  - 先展示 `total/input/output/cache` 汇总数值；
  - 用户先看到可用信息，再等待图表与明细补齐。
- 新增 `usageDetailListReady` 与 `usageDetailPrimedRef`：
  - 首次有 token 历史数据时，先渲染摘要区；
  - 明细列表在下一帧 + idle/timeout 后再显示。
- 新增明细区占位骨架：
  - 明细未就绪时仅展示轻量 placeholder；
  - 就绪后再渲染真实列表与分页交互。
- Gateway 停止时重置明细阶段状态，避免状态残留影响下次进入页面。

## 本次变更日志（2026-03-16 四页首屏体感优化：stale-first、静默刷新、合帧去重）

### 目录树

```text
Matcha-claw/
└── src/
    ├── pages/
    │   ├── Channels/index.tsx
    │   ├── Dashboard/index.tsx
    │   ├── Skills/index.tsx
    │   └── Tasks/index.tsx
    └── stores/channels.ts
```

### 文件职责

- `src/pages/Tasks/index.tsx`：进入页面优先复用已有列表，初始化与刷新分流；任务列表增加容器自动补批，降低首屏“空壳等待”。
- `src/pages/Skills/index.tsx`：已有技能缓存时直接进入重内容渲染，不再每次切页都等待 idle 门控。
- `src/pages/Dashboard/index.tsx`：渠道拉取改静默刷新；缓存存在时立即释放重内容区；token 历史到达后立即解锁面板渲染。
- `src/pages/Channels/index.tsx`：`gateway:channel-status` 事件刷新改为 `requestAnimationFrame` 合帧 + 冷却，抑制高频重复刷新。
- `src/stores/channels.ts`：静默拉取加最小间隔与并发去重；通道列表等价判断（无变化不 set），减少无效重渲染。

### 模块依赖与边界

- 不改 Gateway 协议，不改业务语义。
- 仅优化 renderer 侧页面渲染时序和 store 更新策略，目标是降低切页后首帧阻塞与刷新抖动。

### 关键决策与原因

1. 切页动作已快，但页内首帧仍慢，主要来自“每次重挂载都等待重内容门控 + 高频刷新重复 setState”。
2. 页面切回时应优先显示已有数据（stale-first），后台再静默刷新，而不是再次走完整等待链路。
3. `channels` 高频状态事件若逐条触发拉取与 set，会放大 UI 卡顿，需要合帧和去重。

### 本次变更

- Tasks：
  - `initialized` 后切回页面不再重复走 `init` 阻塞路径，改为后台 `refreshTasks()`。
  - `taskHeavyContentReady` 初值改为“已有任务即就绪”，并在已有数据时立即解除重内容门控。
  - 任务列表增加“容器未占满时自动追加批次”，减少首屏显示数量过小导致的空白感。
- Skills：
  - `skillsHeavyContentReady` 初值改为“已有技能即就绪”。
  - 进入页面后若已有数据，直接解锁重内容，减少切页后占位延时。
- Dashboard：
  - 页面拉取 channels 改为 `fetchChannels({ silent: true })`。
  - `dashboardHeavyContentReady` 初值支持缓存命中立即就绪。
  - `visibleUsageHistory` 不再依赖 `dashboardHeavyContentReady`，并在历史数据到达时立即 `usagePanelReady=true`。
- Channels：
  - `gateway:channel-status` 监听改为 raf 合帧调度 + 400ms 冷却，避免事件风暴反复触发刷新。
  - store 层新增 `areChannelsEquivalent`，列表无变化直接跳过 set。
  - 静默刷新加入最小间隔（1200ms）和 inflight 复用，减少重复请求与解析峰值。

## 本次变更日志（2026-03-16 Chat 首屏会话补全分阶段优化：当前优先 + 小批量 + 后台串行）

### 目录树

```text
Matcha-claw/
└── src/
    └── stores/chat.ts
```

### 文件职责

- `src/stores/chat.ts`：`loadSessions` 会话补全改为分阶段调度，降低首屏与切页时的渲染峰值。

### 模块依赖与边界

- 不改 Gateway 协议，不改 `sessions.list/chat.history` 接口语义。
- 仅调整 renderer 侧会话补全的调度顺序、批次大小与并发策略。

### 关键决策与原因

1. 原逻辑对待补全会话一次性 `Promise.all + limit:1000`，会造成首开和切页时主线程压力峰值。
2. 体感目标是“当前会话优先可用”，其余信息后台渐进补齐，而不是首帧争抢全部补全任务。
3. 连续触发 `loadSessions` 时，旧补全任务会滞后回写，需要 runId 终止机制避免过期结果干扰。

### 本次变更

- 新增会话补全调度常量：
  - `SESSION_HYDRATE_HEAD_LIMIT=80`
  - `SESSION_HYDRATE_BACKGROUND_LIMIT=80`
  - `SESSION_HYDRATE_HEAD_BATCH_SIZE=2`
  - `SESSION_HYDRATE_BACKGROUND_DELAY_MS=120`
- 新增 `fetchSessionHydrationRecord(sessionKey, limit)`：按会话拉取最小历史并提取 `label/lastActivity`。
- `loadSessions` 改为三阶段补全：
  1. 当前会话优先补全（同步优先）
  2. 首屏小批量补全（最多 2 个会话并行）
  3. 其余会话后台串行补全（定时分发）
- 新增 runId + timer 终止机制：
  - 每次 `loadSessions` 启动新轮次并清理上一轮定时任务；
  - 过期轮次结果不再应用，避免旧任务回写触发无效重渲染。

## 本次变更日志（2026-03-16 Cron 切页体验优化：去除整页转圈）

### 目录树

```text
Matcha-claw/
└── src/
    ├── pages/Cron/index.tsx
    └── stores/cron.ts
```

### 文件职责

- `src/stores/cron.ts`：`fetchJobs` 增加 `silent` 选项，支持静默拉取任务列表。
- `src/pages/Cron/index.tsx`：挂载刷新改为静默，不再整页 loading 早返回；刷新按钮保留局部加载反馈。

### 关键决策与原因

1. Cron 页面原先 `if (loading) return <LoadingSpinner />` 会在切页时出现整页转圈，体感不符合“瞬开”目标。
2. 挂载时的后台数据拉取不应阻塞页面壳子渲染，需改为静默模式。

### 本次变更

- `fetchJobs(options?)` 新增 `options.silent`。
- 挂载时调用 `fetchJobs({ silent: true })`。
- 移除 Cron 页整页 loading 早返回。
- 刷新按钮改为局部 loading（旋转 + disabled）。

## 本次变更日志（2026-03-16 Channels 切页体验优化：去除整页转圈）

### 目录树

```text
Matcha-claw/
└── src/
    └── pages/Channels/index.tsx
```

### 文件职责

- `src/pages/Channels/index.tsx`：改为“页面先渲染 + 后台静默刷新”，去掉切页时整页 loading 早返回。

### 关键决策与原因

1. 从 Tasks/Skills 切到 Channels 时的转圈来自 `loading` 的整页早返回。
2. 切页体验应优先保留页面壳子与布局稳定，加载状态下沉到局部按钮更平滑。

### 本次变更

- 移除 `if (loading) return <LoadingSpinner />` 整页阻塞逻辑。
- 页面挂载与 `gateway:channel-status` 事件刷新改为 `fetchChannels({ silent: true })`。
- 顶部刷新按钮保留显式加载反馈（`RefreshCw` 旋转 + 按钮禁用）。

## 本次变更日志（2026-03-16 定向回退：仅回退 Tasks 的 deferred 任务源）

### 目录树

```text
Matcha-claw/
└── src/
    └── pages/Tasks/index.tsx
```

### 文件职责

- `src/pages/Tasks/index.tsx`：仅回退 Tasks 页面中的 `useDeferredValue(tasks)`，恢复任务列表计算直接使用 `tasks` 源。

### 模块依赖与边界

- 只影响 Tasks 页面任务数据计算路径。
- `Skills` 和 `Sidebar` 的 deferred 降优先级逻辑保持不变。

### 本次变更

- 删除 `useDeferredValue` 引入。
- `tasksForView` 从 `taskHeavyContentReady ? deferredTasks : []` 改为 `taskHeavyContentReady ? tasks : []`。

## 本次变更日志（2026-03-16 Agent 会话列表流畅性优化：deferred + store 去抖更新）

### 目录树

```text
Matcha-claw/
└── src/
    ├── components/layout/AgentSessionsPane.tsx
    └── stores/chat.ts
```

### 文件职责

- `src/components/layout/AgentSessionsPane.tsx`：会话列表订阅改为 deferred 数据源并加 memo/callback，减少高频更新时的重排抖动。
- `src/stores/chat.ts`：`loadSessions` 改为“无变化不 set + 批量合并更新”，避免多次小更新触发列表反复重渲染。

### 关键决策与原因

1. Agent 会话列表原先直接订阅 `sessions/sessionLabels/sessionLastActivity`，高频状态变化会导致整列重算。
2. `loadSessions` 原逻辑会为每个 session 单独 set 标签/活跃时间，长列表下会造成明显卡顿。

### 本次变更

- AgentSessionsPane：
  - `sessions/sessionLabels/sessionLastActivity` 使用 `useDeferredValue`。
  - 组件升级为 `memo`，交互函数使用 `useCallback` 稳定引用。
- chat store / loadSessions：
  - 新增 `areSessionsEquivalent`，会话列表无变化时不更新 `sessions`。
  - `discoveredActivity` 增量合并，仅在值变化时更新 `sessionLastActivity`。
  - 会话历史补全改为“仅补缺失字段 + Promise.all 后单次批量 set”，不再每个 session 单独 set。

## 本次变更日志（2026-03-16 Chat 热修：修复 Maximum update depth exceeded）

### 目录树

```text
Matcha-claw/
└── src/
    └── pages/Chat/index.tsx
```

### 文件职责

- `src/pages/Chat/index.tsx`：修复审批列表 selector 的空值回退引用不稳定问题，避免 React/Zustand 订阅层循环更新。

### 关键决策与原因

1. `useChatStore((s) => s.pendingApprovalsBySession[s.currentSessionKey] ?? [])` 每次会创建新数组，违反 `useSyncExternalStore` 快照稳定性要求。
2. 在高频订阅下会触发 `Maximum update depth exceeded`。

### 本次变更

- 新增稳定空数组常量 `EMPTY_APPROVAL_ITEMS`。
- 将 selector 的空值回退改为稳定引用：`?? EMPTY_APPROVAL_ITEMS`。

## 本次变更日志（2026-03-16 Chat 渲染流畅性优化：子树 memo + 历史等价去重）

### 目录树

```text
Matcha-claw/
└── src/
    ├── pages/
    │   └── Chat/
    │       ├── ChatInput.tsx
    │       ├── ChatToolbar.tsx
    │       └── components/TaskInboxPanel.tsx
    └── stores/chat.ts
```

### 文件职责

- `src/pages/Chat/ChatInput.tsx`：输入区组件改为 memo，避免流式更新时无关重渲染。
- `src/pages/Chat/ChatToolbar.tsx`：工具栏组件改为 memo，降低父级高频更新传播。
- `src/pages/Chat/components/TaskInboxPanel.tsx`：任务收件箱面板改为 memo，减少聊天流式阶段的额外重绘。
- `src/stores/chat.ts`：为 `loadHistory(quiet)` 增加消息等价判断与会话元信息去重更新，避免静默轮询触发无效重渲染。

### 模块依赖与边界

- 不改 Gateway 协议、不改会话数据语义，仅优化 renderer 渲染调度与组件更新边界。
- 聊天功能、审批流程、任务收件箱行为保持一致。

### 关键决策与原因

1. Chat 页在流式阶段会频繁更新，输入区/工具栏/任务收件箱若跟随父级重渲染会放大卡顿。
2. `chat.history` 静默轮询在无数据变化时重复 `set(messages)`，会触发整页更新与 markdown 重算。
3. 通过“组件 memo + store 等价去重”可以在不改业务语义的前提下降低渲染峰值。

### 本次变更

- 渲染边界优化：
  - `ChatInput` / `ChatToolbar` / `TaskInboxPanel` 改为 memo 组件。
- store 去重优化：
  - 新增 `areMessagesEquivalent` 与附件等价比较，`loadHistory` 无变化时跳过 `messages` 更新。
  - `sessionLabels` / `sessionLastActivity` 仅在值发生变化时更新，减少会话侧边栏连带重渲染。

## 本次变更日志（2026-03-16 频道静默预取：修复频道页悬停仪表盘触发转圈）

### 目录树

```text
Matcha-claw/
└── src/
    ├── components/layout/Sidebar.tsx
    └── stores/channels.ts
```

### 文件职责

- `src/stores/channels.ts`：为 `fetchChannels` 增加 `silent` 选项，支持“后台预取不切换 loading”。
- `src/components/layout/Sidebar.tsx`：将 `/dashboard` 的悬停预取改为静默拉取 channels。

### 模块依赖与边界

- 不改接口协议与频道数据结构，仅调整预取时是否触发全局 `loading`。
- 显式刷新/进入页面的正常加载语义保持不变。

### 关键决策与原因

1. 频道页订阅了 `channels.loading` 且使用整页 loading 早返回，悬停预取会造成可见转圈。
2. “后台预取”和“前台加载提示”应解耦，预取不应打断当前页面交互。

### 本次变更

- `fetchChannels(options?)` 新增 `options.silent`。
- `silent=true` 时：
  - 请求前不设置 `loading=true`；
  - 请求失败不清空列表、不改 loading；
  - 请求成功仅更新 `channels` 数据。
- Sidebar `/dashboard` 预取改为 `fetchChannels({ silent: true })`。

## 本次变更日志（2026-03-15 Sidebar 导航优化恢复：startTransition + 交互前多页面预取）

### 目录树

```text
Matcha-claw/
└── src/
    └── components/layout/Sidebar.tsx
```

### 文件职责

- `src/components/layout/Sidebar.tsx`：恢复导航点击 `startTransition` 与导航交互前预取（hover/focus/mousedown）。

### 模块依赖与边界

- 保留既有 Sidebar 阻塞卡片 deferred/限流逻辑，仅恢复导航交互路径的调度与预取行为。
- 不改业务接口，不改页面内部渲染逻辑。

### 关键决策与原因

1. 用户要求复测第4项体感收益，需要恢复导航级优化进行 A/B 对比。
2. 恢复后可再次观察切页瞬间的交互流畅度变化。

### 本次变更

- 恢复 `NavItem` 的 `onFocus/onMouseDown/onNavigate` 事件路径。
- 恢复 `startTransition` 导航。
- 恢复按页面路径的交互预取：
  - `/skills`：预取 skills 数据
  - `/dashboard`：预取 channels 数据
  - `/tasks`：初始化并刷新 task center
  - `/subagents`：预取模板目录

## 本次变更日志（2026-03-15 路由层 fallback 策略恢复：主页面改回直接渲染）

### 目录树

```text
Matcha-claw/
└── src/
    └── App.tsx
```

### 文件职责

- `src/App.tsx`：按用户复测反馈，恢复主页面路由直接渲染策略（Dashboard/SubAgents/Tasks/Skills/Settings），去掉路由级 `Suspense` fallback。

### 模块依赖与边界

- 不改业务接口，不改页面内部数据加载逻辑，仅调整主路由层渲染策略。
- 保留页面内部的分阶段渲染与列表增量优化。

### 关键决策与原因

1. 用户反馈回退后“流畅感变差”，需要恢复此前体感更好的路由策略。
2. 路由级 fallback 会引入“页面加载中”视觉切换与额外调度，直接渲染更符合当前交互目标。

### 本次变更

- 移除 `lazy + Suspense + RouteLoadingFallback` 的主路由包裹。
- 移除 App 层重路由 chunk 空闲预热 effect。
- 恢复主页面直接 `import` + 直接 `element` 渲染。

## 本次变更日志（2026-03-15 定向回退：导航预取/主进程 GPU 策略/路由层 fallback）

### 目录树

```text
Matcha-claw/
├── src/
│   ├── App.tsx
│   └── components/layout/Sidebar.tsx
└── electron/
    └── main/index.ts
```

### 文件职责

- `src/components/layout/Sidebar.tsx`：回退导航 `startTransition` 与 `hover/focus/mousedown` 预取逻辑，保留侧边栏高频订阅降载与 deferred 聚合逻辑。
- `electron/main/index.ts`：回退到固定软件渲染与开发环境默认打开 DevTools 的策略。
- `src/App.tsx`：回退主路由为 `lazy + Suspense fallback` 策略，并恢复重路由 chunk 空闲预热。

### 模块依赖与边界

- 仅回退用户指定的三个优化项，不触及 Tasks/Skills/Dashboard/SubAgents 的分阶段渲染与列表增量策略。
- store 侧高频事件批处理与静默刷新保持不变。

### 关键决策与原因

1. 用户明确要求先撤回“收益不稳定或非渲染主路径”的优化项，聚焦保留渲染线程直接收益改动。
2. 本次回退采取“最小范围”方式，避免影响已验证有效的页面级渲染优化。

### 本次变更

- 回退项 1（原第4项）：
  - Sidebar 导航 `startTransition` 回退为默认导航。
  - 导航交互前预取（skills/channels/tasks/subagents）回退，仅保留原有 `skills` hover 预取。
- 回退项 2（原第7项）：
  - 主进程 GPU 策略回退为 `app.disableHardwareAcceleration()`。
  - Dev 模式回退为默认自动打开 DevTools。
- 回退项 3（原第6项）：
  - 主路由回退为 `lazy + Suspense + RouteLoadingFallback`。
  - 恢复 App 级重路由 chunk 空闲预热 effect。

## 本次变更日志（2026-03-15 模板库滚动增量：容器内滚动 + 接近底部自动追加）

### 目录树

```text
Matcha-claw/
└── src/
    └── pages/
        └── SubAgents/index.tsx
```

### 文件职责

- `src/pages/SubAgents/index.tsx`：模板库卡片区改为固定高度滚动容器，滚动接近底部时自动追加下一批模板卡片，不再依赖按钮手动“加载更多”。

### 模块依赖与边界

- 不改变模板目录数据、模板详情加载与预取协议，只调整模板列表的渲染调度和交互方式。
- 继续保留首批小批量渲染，自动追加仅在用户滚动触底附近时触发。

### 关键决策与原因

1. 手动“加载更多”虽然降了首帧峰值，但用户滚动时仍存在额外点击动作，交互链路不够顺滑。
2. 容器内滚动 + 近底自动追加可把追加成本分散到滚动过程中，进一步降低卡顿感。
3. 增加“容器未撑满时自动补批”逻辑，避免首批数量较小导致滚动容器空洞。

### 本次变更

- 新增模板卡片滚动阈值常量 `TEMPLATE_CARD_SCROLL_THRESHOLD_PX`。
- 模板卡片区改为 `max-h + overflow-y-auto` 的容器，并绑定 `onScroll` 自动追加。
- 新增 `templateCardScrollRef` 与“容器未撑满自动补批”effect，确保初始展示稳定。
- 保留底部“已显示 x / y”提示，移除手动“加载更多”按钮。

## 本次变更日志（2026-03-15 模板库展开卡顿优化：SubAgents 模板卡片按需增量渲染）

### 目录树

```text
Matcha-claw/
└── src/
    ├── pages/SubAgents/index.tsx
    └── i18n/locales/
        ├── zh/subagents.json
        ├── en/subagents.json
        └── ja/subagents.json
```

### 文件职责

- `src/pages/SubAgents/index.tsx`：模板库展开后改为“首批卡片 + 加载更多”增量渲染，避免一次性挂载全量模板卡片造成首开卡顿。
- `src/i18n/locales/*/subagents.json`：新增模板分页文案（showing/loadMore）。

### 模块依赖与边界

- 不改模板 API、模板目录数据结构与加载流程，仅优化模板库展开阶段的渲染策略。
- 模板详情预取与加载对话框逻辑保持不变。

### 关键决策与原因

1. 反馈“打开模板库仍卡顿”对应的是展开瞬间渲染峰值过高，而非网络请求慢。
2. 将全量卡片渲染改为增量渲染，优先确保点击展开动作先反馈，再按需追加内容。
3. 使用 deferred 过滤结果与单次本地化字符串计算，进一步减少展开帧内计算量。

### 本次变更

- SubAgents 模板库：
  - 新增 `INITIAL_TEMPLATE_CARD_BATCH=9`、`TEMPLATE_CARD_BATCH_SIZE=18`。
  - 模板卡片网格从 `filteredTemplates.map` 改为 `visibleTemplates.map`。
  - 新增“已显示 x / y + 加载更多模板”交互。
  - `filteredTemplates` 增加 `useDeferredValue`，展开与筛选切换时降低同步阻塞。
  - 模板卡片内名称/摘要本地化结果改为单次计算，避免重复 `tTemplate` 调用。

## 本次变更日志（2026-03-15 Dashboard/SubAgents 首屏分阶段渲染）

### 目录树

```text
Matcha-claw/
└── src/
    └── pages/
        ├── Dashboard/index.tsx
        └── SubAgents/index.tsx
```

### 文件职责

- `src/pages/Dashboard/index.tsx`：新增页面级重内容阶段门控，仪表盘先渲染壳子（统计卡与快捷操作），Recent Activity 与 Token History 在空闲阶段再挂载。
- `src/pages/SubAgents/index.tsx`：新增页面级重内容阶段门控，模板分类/模板卡片与 Agent 卡片网格改为“先骨架后细节”。

### 模块依赖与边界

- 不改 Gateway API、store 协议与业务行为，仅调整页面渲染时序和计算时机。
- 模板目录、模板预取、Agent 增删改、模板加载对话框等流程保持不变。

### 关键决策与原因

1. 用户反馈 Dashboard / SubAgents 首次进入仍有短暂“加载中 + 卡一下”，瓶颈在首挂载阶段重计算与重列表渲染。
2. 采用与 Tasks/Skills 一致的 `requestAnimationFrame + requestIdleCallback` 分阶段渲染，优先保障点击后的首帧反馈。
3. 数据请求继续在后台进行（不牺牲预热），仅把重 UI 渲染延后，兼顾“首开不卡”和“二次进入快”。

### 本次变更

- Dashboard：
  - 新增 `dashboardHeavyContentReady`（idle 阶段置为 `true`）。
  - Recent Activity 与 Recent Token History 增加骨架占位，未就绪时不挂载重内容。
  - token 历史相关聚合计算在 heavy ready 前短路，降低首开计算压力。
- SubAgents：
  - 新增 `subagentsHeavyContentReady`（idle 阶段置为 `true`）。
  - `templateCategoryCountById` / `templateCategories` / `filteredTemplates` 在 heavy ready 前早返回，避免首帧执行重筛选链路。
  - 模板区展开后先展示骨架，再渲染真实模板筛选与卡片。
  - Agent 卡片网格首帧显示骨架，heavy ready 后再渲染真实卡片与空态。

## 本次变更日志（2026-03-15 全页面统一首开策略：移除主路由懒加载 fallback）

### 目录树

```text
Matcha-claw/
└── src/
    ├── App.tsx
    ├── components/layout/Sidebar.tsx
    └── lib/
        └── route-prewarm.ts (removed)
```

### 文件职责

- `src/App.tsx`：主应用页面路由（Dashboard/SubAgents/Tasks/Skills/Settings）统一改为直接渲染，不再通过 `Suspense` 显示整页“页面加载中”。
- `src/components/layout/Sidebar.tsx`：移除路由 chunk 预热逻辑，仅保留数据预取（tasks/skills/channels/subagent templates）。
- `src/lib/route-prewarm.ts`：删除已不再使用的路由预热工具，避免死代码与多余调度。

### 模块依赖与边界

- 不改变业务接口和页面功能，仅统一路由首开渲染策略。
- 仅移除“路由级 loading fallback”，页面内部必要的局部 loading 保留。

### 关键决策与原因

1. 用户明确反馈多个页面首次进入仍会看到短暂“加载中”，这属于路由级懒加载体验问题。
2. 既然要求“每个页面都统一处理”，应去掉主路由层的懒加载差异，避免页面体验不一致。
3. 在主路由统一直接渲染后，原路由预热逻辑失去价值，继续保留只会增加复杂度。

### 本次变更

- `App.tsx`：
  - 移除 `lazy` + `Suspense` + `RouteLoadingFallback`。
  - `Dashboard/SubAgents/Settings` 改为直接 import + 直接 route element（Tasks/Skills 已是直接 route）。
  - 移除全局 `routeChunksPrefetchedRef` 与 route chunk 预热 effect。
- `Sidebar.tsx`：
  - 移除 `prewarmRouteChunk` 相关逻辑与依赖，导航预取只保留业务数据预取。
- 删除 `src/lib/route-prewarm.ts`。

## 本次变更日志（2026-03-15 首屏分阶段渲染：Tasks/Skills 先壳子后细节）

### 目录树

```text
Matcha-claw/
└── src/
    └── pages/
        ├── Tasks/index.tsx
        └── Skills/index.tsx
```

### 文件职责

- `src/pages/Tasks/index.tsx`：新增“重内容空闲阶段挂载”机制，进入页面先渲染壳子与基础交互，任务列表与详情的重渲染区在 idle 阶段再加载。
- `src/pages/Skills/index.tsx`：新增“重内容空闲阶段挂载”机制，进入页面先渲染壳子与筛选控件，技能卡片网格在 idle 阶段再加载。

### 模块依赖与边界

- 不改接口与 store 语义，只调整页面渲染时序。
- 现有分页/增量加载策略保持不变，仅改变“何时开始渲染重内容”。

### 关键决策与原因

1. 首次点击卡顿主要发生在“页面首次挂载时即执行大量过滤、排序、列表渲染”。
2. 分阶段渲染将重内容后移到浏览器空闲窗口，优先保障点击后的首帧反馈。
3. 先壳子后细节比直接整页 loading 更符合“瞬开体感”目标。

### 本次变更

- Tasks：
  - 新增 `taskHeavyContentReady` 阶段状态（`requestAnimationFrame + requestIdleCallback` 调度）。
  - 重筛选链路改为仅在阶段就绪后启用（未就绪时显示轻量占位骨架）。
  - 列表区与详情区增加骨架占位，避免首开空白等待。
- Skills：
  - 新增 `skillsHeavyContentReady` 阶段状态（`requestAnimationFrame + requestIdleCallback` 调度）。
  - 重筛选链路改为仅在阶段就绪后启用（未就绪时显示轻量卡片骨架）。

## 本次变更日志（2026-03-15 首开体验修正：任务中心/技能页移除路由级加载闪屏）

### 目录树

```text
Matcha-claw/
├── src/
│   ├── App.tsx
│   └── pages/
│       └── Skills/index.tsx
```

### 文件职责

- `src/App.tsx`：`/tasks` 与 `/skills` 路由由懒加载改为直接加载，避免首次点击进入时出现 `Suspense` 的整页“页面加载中”。
- `src/pages/Skills/index.tsx`：移除整页早返回 loading，改为页面内局部 loading 呈现，避免首开“白屏+转圈”体感。

### 模块依赖与边界

- 不改变任务中心/技能页业务逻辑，仅调整首次进入时的加载策略与视觉反馈层级。
- 仍保留 Dashboard/SubAgents/Settings 懒加载，不影响其分包策略。

### 关键决策与原因

1. 用户反馈“首开显示加载中才出页面”是明显的路由级 fallback 感知问题，应优先消除整页 fallback。
2. Skills 即使数据尚未就绪，也应优先渲染页面结构，避免“整页阻塞式 loading”。

### 本次变更

- `tasks`/`skills` 路由移除 `Suspense` 包裹，改为直接元素渲染。
- Skills 首次加载时改为页面内局部 loading 卡片，不再整页替换为 loading 视图。

## 本次变更日志（2026-03-15 任务中心与技能页卡顿专项：取消自动全量渲染，改为按需增量）

### 目录树

```text
Matcha-claw/
├── src/
│   └── pages/
│       ├── Tasks/index.tsx
│       └── Skills/index.tsx
└── src/i18n/locales/
    ├── zh/{tasks,skills}.json
    ├── en/{tasks,skills}.json
    └── ja/{tasks,skills}.json
```

### 文件职责

- `src/pages/Tasks/index.tsx`：任务列表由“空闲自动追加到全量”改为“滚动触发 + 手动加载更多”，并将源数据计算改为 `useDeferredValue(tasks)`，降低切页瞬间的主线程压力。
- `src/pages/Skills/index.tsx`：技能列表由“空闲自动追加到全量”改为“手动加载更多”，避免进入页面后后台持续渲染全部卡片。
- `src/i18n/locales/*/{tasks,skills}.json`：新增分页文案（`pagination.showing/loadMore`）。

### 模块依赖与边界

- 不改变业务接口和数据语义，只调整页面渲染调度和列表展示策略。
- 增量渲染仅影响“首屏展示数量与追加时机”，不影响搜索、筛选、批量操作结果。

### 关键决策与原因

1. 自动追加会在页面进入后继续占用主线程，用户会感觉“刚点开先顺一点，随后又卡一下”。
2. 改为按需追加后，把无效渲染从“自动发生”改为“用户滚动/点击时发生”，显著降低首屏卡顿峰值。
3. 任务页使用 deferred tasks，避免高频任务更新与页面交互抢占同一帧。

### 本次变更

- Tasks：
  - 移除自动 idle 追加列表；
  - 新增滚动阈值触发追加；
  - 新增底部“已显示 x / y + 加载更多”交互；
  - 任务源数据改用 `useDeferredValue` 参与筛选链路。
- Skills：
  - 移除自动 idle 追加列表；
  - 新增底部“已显示 x / y + 加载更多”交互。
- i18n：
  - 中英日三语新增分页文案键。

## 本次变更日志（2026-03-15 高频事件降噪：Gateway 批处理 + Task 静默刷新）

### 目录树

```text
Matcha-claw/
└── src/
    └── stores/
        ├── gateway.ts
        ├── task-center-store.ts
        └── task-inbox-store.ts
```

### 文件职责

- `src/stores/gateway.ts`：将高频 `task_*` 通知改为短窗口批处理分发，并缓存动态模块加载 Promise，减少微任务风暴与重复 import 开销。
- `src/stores/task-center-store.ts`：轮询刷新改为静默刷新；增加“任务列表/阻塞队列等价性判断”，无变化时不触发 setState。
- `src/stores/task-inbox-store.ts`：轮询刷新改为静默刷新；增加“任务列表/工作区作用域等价性判断”，无变化时不触发 setState。

### 模块依赖与边界

- 不改业务协议，不改 Gateway API，仅优化 renderer 状态分发与 store 更新策略。
- `task_*` 事件仍完整处理；仅将处理时机从“每条立即分发”改为“短窗口批量分发”。

### 关键决策与原因

1. 高频通知下逐条 `setState` 会持续抢占主线程，直接影响页面切换体感。
2. 轮询每轮切 `loading` 会放大页面重渲染，即使数据没变化也会触发 UI 抖动。
3. 动态 import 虽有缓存，但每次都创建 Promise 链仍有调度开销，缓存模块 Promise 可进一步降噪。

### 本次变更

- `gateway.ts`
  - 新增 `task_*` 队列 + 48ms flush（批处理 + 进度/状态事件按 task 去重）。
  - `chat/task/channels` store 动态加载改为缓存 Promise 复用。
- `task-center-store.ts`
  - `refreshTasks` 去掉轮询阶段 `loading` 翻转。
  - 新增任务列表与阻塞队列等价判断，无变化返回原状态。
- `task-inbox-store.ts`
  - `refreshTasks` 去掉轮询阶段 `loading` 翻转。
  - 新增任务列表与工作区作用域等价判断，无变化返回原状态。

## 本次变更日志（2026-03-15 渲染线程减载第三轮：导航 transition + 列表分批 + DevTools 开关）

### 目录树

```text
Matcha-claw/
├── electron/
│   └── main/
│       └── index.ts
└── src/
    ├── components/layout/
    │   └── Sidebar.tsx
    └── pages/
        ├── Tasks/index.tsx
        └── Skills/index.tsx
```

### 文件职责

- `src/components/layout/Sidebar.tsx`：侧边栏导航点击改为 `startTransition`，把重路由切换标记为低优先级更新。
- `src/pages/Tasks/index.tsx`：任务列表改为分批渲染（idle 追加），降低首次进入任务中心时同步渲染峰值。
- `src/pages/Skills/index.tsx`：技能筛选与排序基于 deferred 值计算，减少切页瞬间与输入瞬间的主线程抢占。
- `electron/main/index.ts`：开发环境默认不自动打开 DevTools，仅在 `MATCHACLAW_OPEN_DEVTOOLS=1` 时打开。

### 模块依赖与边界

- 未改变数据协议和接口语义，仅调整渲染调度策略与开发期运行开销。
- `DevTools` 策略仅影响开发模式，不影响生产包行为。

### 关键决策与原因

1. 切页“卡一下”多发生在同一事件循环内同步渲染，导航 transition 可以降低交互阻塞感。
2. 任务中心列表可能较大，分批渲染比一次性全量渲染更稳定。
3. Skills 的筛选排序在大列表下会占用主线程，deferred 可把计算延后到非紧急阶段。
4. 开发时自动打开 DevTools 会显著放大渲染开销，默认关闭更接近真实体感。

### 本次变更

- Sidebar 导航项点击改为 transition 导航，同时保留 hover/focus/mousedown 预热。
- Tasks 列表新增 `INITIAL_TASK_LIST_BATCH/TASK_LIST_BATCH_SIZE` 分批机制。
- Skills 新增 `useDeferredValue` 以延后筛选排序计算。
- Dev 环境仅在 `MATCHACLAW_OPEN_DEVTOOLS=1` 时自动打开 DevTools。

## 本次变更日志（2026-03-15 渲染模式修正：GPU 默认 Auto）

### 目录树

```text
Matcha-claw/
└── electron/
    └── main/
        └── index.ts
```

### 文件职责

- `electron/main/index.ts`：主进程启动阶段 GPU 策略决策，从“全局强制软件渲染”改为“默认 Auto”。

### 模块依赖与边界

- 不改任何业务路由与 store 逻辑，仅调整 Electron 渲染加速策略。
- 保留 CLI 覆盖能力，不破坏已有运维排障方式。

### 关键决策与原因

1. 全局关闭 GPU 会显著影响页面切换与合成流畅度，和“点击瞬开体感”目标冲突。
2. 默认 Auto 让 Chromium 自适应硬件；异常机器仍可通过 CLI 强制关闭 GPU。

### 本次变更

- 默认不再调用 `app.disableHardwareAcceleration()`。
- 新增 CLI 开关策略：
  - `--disable-gpu` / `--disable-hardware-acceleration`：强制软件渲染。
  - `--enable-gpu`：显式保留 GPU 路径（优先于 disable 标记）。

## 本次变更日志（2026-03-15 点击体感二次优化：交互前预热、重渲染降载、模板秒开反馈）

### 目录树

```text
Matcha-claw/
├── src/
│   ├── App.tsx
│   ├── lib/
│   │   └── route-prewarm.ts
│   ├── components/layout/
│   │   └── Sidebar.tsx
│   ├── pages/
│   │   ├── Dashboard/index.tsx
│   │   ├── Skills/index.tsx
│   │   ├── Tasks/index.tsx
│   │   └── SubAgents/
│   │       ├── index.tsx
│   │       └── components/SubagentTemplateLoadDialog.tsx
│   └── services/openclaw/
│       └── subagent-template-catalog.ts
```

### 文件职责

- `src/lib/route-prewarm.ts`：统一管理重页面 chunk 预热，提供去重与串行预热能力，避免重复下载/解析。
- `src/App.tsx`：接入共享路由预热器，保持启动后空闲串行预热。
- `src/components/layout/Sidebar.tsx`：导航交互前（hover/focus/mousedown）预热目标页面与关键数据；阻塞卡片聚合改为 deferred + 限量扫描，降低高频更新时主线程占用。
- `src/services/openclaw/subagent-template-catalog.ts`：模板目录与模板详情增加 in-memory cache + in-flight 合并 + 预取方法。
- `src/pages/SubAgents/index.tsx`：模板列表空闲预取前几个模板详情；点击模板立即弹出“加载中”对话框，详情到达后无缝切换。
- `src/pages/SubAgents/components/SubagentTemplateLoadDialog.tsx`：新增 loading 态渲染，支持“先反馈再加载”。
- `src/pages/Dashboard/index.tsx`：重统计区（token history）延后挂载，统计计算改为 memo，减少首次切页和秒级 uptime 更新带来的重算抖动。
- `src/pages/Skills/index.tsx`：移除 `framer-motion` 交互包装，减少首屏解析体积；初始渲染批次从 24 调整到 12，降低首帧压力。
- `src/pages/Tasks/index.tsx`：任务清单 Markdown 解析延后到 idle 执行；状态计数合并为单次 reduce，减少切页同步计算峰值。

### 模块依赖与边界

- 未引入新进程、新服务，优化均发生在现有 Renderer + Zustand + React Router 体系内。
- 路由与模板预热仅改变“何时加载/解析”，不改变业务数据语义与接口协议。
- 模板缓存范围限定在前端内存生命周期（应用进程级），不落盘、不改变模板源。

### 关键决策与原因

1. 仅做“懒加载”仍会在首次点击时触发重解析，必须叠加“交互前预热”才能逼近瞬时切页体感。
2. 全局卡顿不只来自路由，还来自高频状态导致的重计算，因此对 Sidebar 阻塞聚合做 deferred + 限流扫描。
3. 模板点击体验问题本质是“用户反馈滞后”，通过“立刻弹窗 + 异步填充详情”先给即时反馈，再完成数据到位。
4. Skills 页面动画包装收益低、解析成本高，优先移除重动画依赖以换取真实响应速度。

### 本次变更

- 新增路由预热工具并在 App/Sidebar 双点接入：启动空闲预热 + 导航交互前预热。
- Sidebar 阻塞卡片计算改为 deferred 数据源与限量扫描（team/task/chat 均做上限）。
- SubAgents 模板目录与详情新增缓存、并发去重和预取；点击模板支持即时 loading 弹窗。
- Dashboard token history 区延后挂载，并将重统计逻辑 memo 化。
- Skills 移除 framer-motion 动画包裹，降低首屏运行成本；初始渲染批次减半。
- Tasks 将 checklist 解析移入 idle 阶段，并合并多次筛选计数遍历。

## 本次变更日志（2026-03-15 启动交互性能优化：懒加载、后台预热、降订阅、动态降频）

### 目录树

```text
Matcha-claw/
├── src/
│   ├── App.tsx
│   ├── components/layout/
│   │   └── Sidebar.tsx
│   ├── features/teams/runtime/
│   │   └── orchestrator.ts
│   ├── pages/Chat/components/
│   │   └── TaskInboxPanel.tsx
│   └── stores/
│       ├── teams.ts
│       ├── task-center-store.ts
│       └── task-inbox-store.ts
```

### 文件职责

- `src/App.tsx`：重页面路由改为懒加载，并在空闲阶段串行后台预热页面代码 chunk。
- `src/components/layout/Sidebar.tsx`：将待处理阻塞信息聚合从主导航壳体拆分为独立子组件，降低主 Sidebar 订阅与重渲染压力。
- `src/features/teams/runtime/orchestrator.ts`：团队守护循环改为动态 tick 与动态快照刷新频率（活跃/空闲/后台）。
- `src/pages/Chat/components/TaskInboxPanel.tsx`：任务收件箱轮询改为动态频率（活跃快、空闲慢、后台更慢）。
- `src/stores/teams.ts`：`refreshSnapshot/pullMailbox` 新增并发合并与最小间隔去重，避免重复拉取。
- `src/stores/task-center-store.ts`：任务中心刷新新增并发合并与最小间隔去重。
- `src/stores/task-inbox-store.ts`：任务收件箱刷新新增并发合并与最小间隔去重。

### 模块依赖与边界

- 未引入新进程或新服务；性能优化全部在现有 Renderer + Zustand 架构内完成。
- 路由懒加载与后台预热仅影响页面代码加载时机，不改变业务接口协议。
- Teams/Task 的降频与去重只影响“拉取频率与并发行为”，不改变任务状态机语义。

### 关键决策与原因

1. 采用“懒加载 + 空闲预热”组合：兼顾启动轻量与页面瞬切体感。
2. 将 Sidebar 重订阅聚合拆出主壳体：隔离高频状态更新对导航交互的干扰。
3. 采用动态频率与去重：减少后台重复 IO 和无效 store 广播，稳定主线程负载。

### 本次变更

- 重页面（Tasks/Skills/SubAgents/Settings/Dashboard）支持懒加载并加入空闲串行预热。
- Sidebar 的阻塞卡片改为独立 memo 子组件订阅与渲染。
- Teams 守护循环从固定频率升级为活跃/空闲/后台动态频率。
- Task 相关轮询改为动态频率，并在 store 层增加刷新去重（in-flight merge + 最小间隔）。

## 本次变更日志（2026-03-15 Guardian 策略语义补齐：preset/白名单/不可变红线）

### 目录树

```text
Matcha-claw/
├── electron/
│   ├── api/routes/
│   │   └── settings.ts
│   └── utils/
│       ├── store.ts
│       └── guardian-policy.ts
├── packages/
│   └── openclaw-task-manager-plugin/
│       ├── policy/
│       │   ├── default.json
│       │   └── presets/
│       │       ├── strict.json
│       │       ├── balanced.json
│       │       └── relaxed.json
│       └── src/
│           └── guardian.ts
├── src/
│   ├── pages/Security/
│   │   └── index.tsx
│   └── i18n/locales/
│       ├── zh/security.json
│       ├── en/security.json
│       └── ja/security.json
└── tests/
    └── unit/
        └── guardian-plugin.test.ts
```

### 文件职责

- `packages/openclaw-task-manager-plugin/policy/*`：定义插件内默认策略与预设档位（strict/balanced/relaxed）。
- `packages/openclaw-task-manager-plugin/src/guardian.ts`：实现不可变红线、风险判定增强、目录/域名/能力令牌约束、确认策略与审计扩展。
- `electron/utils/store.ts`：扩展安全策略配置结构（preset、路径/域名白名单、命令/安装开关、confirmStrategy、capabilities）。
- `electron/utils/guardian-policy.ts`：将策略同步到 `openclaw.json`，并额外写出 `~/.openclaw/policies/guardian.policy.json`。
- `src/pages/Security/index.tsx`：新增安全页细粒度配置项与预设选择。
- `tests/unit/guardian-plugin.test.ts`：补充 immutable 规则与 confirmStrategy 行为测试。

### 模块依赖与边界

- 策略仍在主进程受控存储中维护，通过 settings 路由同步到网关，不引入独立后端或独立进程。
- Guardian 规则执行仍在插件 Hook 层（`before_tool_call/after_tool_call`），不修改 OpenClaw 内核源码。
- 预设策略文件仅作为“默认与模板源”，用户覆盖策略写入受控配置区。

### 关键决策与原因

1. 增加 `strict/balanced/relaxed` 预设，降低用户首次配置成本，同时保留按 Agent 细粒度覆盖。
2. 将“禁用守卫、提示词注入、敏感外发”提升为不可变红线，避免被普通策略覆盖。
3. 审计记录附带 `policyVersion/policyPreset/ruleId/requiredCapabilities`，提升可追溯性与运营诊断能力。

### 本次变更

- Guardian 策略引擎新增：
  - 预设档位；
  - 路径白名单、域名白名单；
  - 命令执行与依赖安装开关；
  - 能力令牌（CAP_*）缺失拦截；
  - 每次确认/会话确认策略。
- 新增策略文件落点：
  - `packages/openclaw-task-manager-plugin/policy/default.json`
  - `packages/openclaw-task-manager-plugin/policy/presets/{strict,balanced,relaxed}.json`
- 策略同步新增用户可编辑落点：
  - `~/.openclaw/policies/guardian.policy.json`
- 安全页面新增细粒度配置项并接入保存链路。
- 安全页面新增“策略优先级可视化”与“最近命中审计”面板，可直接查看命中来源（immutable/user/preset/default）。
- 修复策略来源判定：改为按字段 patch 存储与加载压缩，避免“仅改一个字段却全部显示用户覆盖”。
- 单测新增并通过：immutable 拦截 + confirmStrategy 不缓存。

## 本次变更日志（2026-03-15 Security 页面策略接入 Guardian 执行链路）

### 目录树

```text
Matcha-claw/
├── electron/
│   ├── api/routes/
│   │   └── settings.ts
│   └── utils/
│       └── guardian-policy.ts
├── packages/
│   └── openclaw-task-manager-plugin/
│       └── src/
│           ├── guardian.ts
│           └── index.ts
└── tests/
    └── unit/
        └── guardian-plugin.test.ts
```

### 文件职责

- `electron/utils/guardian-policy.ts`：将应用受控设置中的安全策略规范化并同步到 `~/.openclaw/openclaw.json`（`plugins.entries.task-manager.guardian`）。
- `electron/api/routes/settings.ts`：在设置写入时触发 Guardian 策略同步，并在网关运行中调用 `guardian.policy.sync` 热更新。
- `packages/openclaw-task-manager-plugin/src/guardian.ts`：支持按 `agentId` 覆盖策略（`defaultAction` + tool lists），并支持运行时同步。
- `packages/openclaw-task-manager-plugin/src/index.ts`：新增 `guardian.policy.sync` 网关方法。
- `tests/unit/guardian-plugin.test.ts`：新增“按 agent 覆盖策略即时生效”测试用例。

### 模块依赖与边界

- 页面配置仍写入主进程受控 settings（`electron-store`），不允许前端直写 OpenClaw 配置文件。
- Guardian 执行层仍位于 task-manager 插件 Hook（`before_tool_call/after_tool_call`），不改 OpenClaw 内核源码。
- 热更新通过网关方法下发，不引入独立服务或独立进程。

### 关键决策与原因

1. 使用“设置持久化 + openclaw.json 镜像 + 运行时热同步”三段式，兼顾重启后可恢复与运行中即时生效。
2. 按 `agentId` 覆盖策略，仅覆盖声明字段，未声明字段继承全局 Guardian 基线，减少配置冗余。
3. 按 `agentId` 做增量覆盖（仅覆盖声明字段），未声明字段继承全局 Guardian 基线，保证默认行为稳定。

### 本次变更

- 新增 Guardian 策略同步工具并接入 settings 路由。
- 保存 `securityPolicyVersion/securityPolicyByAgent` 后自动：
  - 写入 `openclaw.json` 的 task-manager guardian 配置；
  - 在网关运行时调用 `guardian.policy.sync` 热更新。
- Guardian 新增按 agent 覆盖策略解析与运行时 `syncPolicy`。
- 新增 `guardian.policy.sync` gateway method。
- 单测新增并通过：按 agent 覆盖可即时生效。

## 本次变更日志（2026-03-15 新增 Security 菜单页与按 Agent 策略配置）

### 目录树

```text
Matcha-claw/
├── src/
│   ├── pages/
│   │   └── Security/
│   │       └── index.tsx
│   ├── components/layout/
│   │   └── Sidebar.tsx
│   ├── i18n/
│   │   ├── index.ts
│   │   └── locales/
│   │       ├── zh/security.json
│   │       ├── en/security.json
│   │       ├── ja/security.json
│   │       └── */common.json
│   └── App.tsx
└── electron/
    └── utils/
        └── store.ts
```

### 文件职责

- `src/pages/Security/index.tsx`：提供独立“安全”页面，支持按 Agent 编辑 `defaultAction/allowTools/confirmTools/denyTools`。
- `src/components/layout/Sidebar.tsx`：新增 `Security` 菜单项，并放在 `Settings` 上方。
- `src/App.tsx`：新增 `/security` 路由入口。
- `src/i18n/locales/*/security.json` 与 `src/i18n/index.ts`：新增安全页三语文案与命名空间注册。
- `electron/utils/store.ts`：新增安全策略持久化字段（`securityPolicyVersion/securityPolicyByAgent`）。

### 模块依赖与边界

- 安全页通过既有 `hostApiFetch('/api/settings')` 与主进程受控存储交互，不新增独立服务/进程。
- 策略编辑作用域为“每个 Agent 一份配置”，页面不直接修改 OpenClaw 内核。

### 关键决策与原因

1. 将安全能力做成独立菜单页，避免塞入 Settings，符合“上方独立入口”的产品要求。
2. 策略结构先落地为受控持久化字段，保证后续 Guardian 执行层可直接读取并演进。
3. 使用三语 i18n 资源，避免新增页面回退为硬编码文案。

### 本次变更

- 新增 Security 页面并支持按 Agent 保存策略。
- 侧边栏新增 Security 菜单，位置在 Settings 上方。
- 新增 `/security` 路由。
- settings 持久化结构新增安全策略字段。
- 新增 `security` i18n namespace（zh/en/ja）。

## 本次变更日志（2026-03-15 审批同 Run 续跑 + chat.send 等待态 + Guardian 审计）

### 目录树

```text
Matcha-claw/
├── packages/
│   └── openclaw-task-manager-plugin/
│       └── src/
│           ├── guardian.ts
│           └── index.ts
├── src/
│   ├── pages/Chat/index.tsx
│   └── i18n/locales/
│       ├── zh/chat.json
│       ├── en/chat.json
│       └── ja/chat.json
└── tests/
    └── unit/
        └── guardian-plugin.test.ts
```

### 文件职责

- `packages/openclaw-task-manager-plugin/src/guardian.ts`：实现 Tool Guard 策略判定、`before_tool_call` 审批等待、`after_tool_call` 审计落库与脱敏查询。
- `packages/openclaw-task-manager-plugin/src/index.ts`：接入 Guardian 控制器，绑定网关上下文并新增 `guardian.audit.query` 网关方法。
- `src/pages/Chat/index.tsx`：在“等待审批”态展示审批卡片，提供 `allow-once / allow-always / deny` 操作。
- `src/i18n/locales/*/chat.json`：补齐审批操作面板文案。
- `tests/unit/guardian-plugin.test.ts`：覆盖同 Run 审批续跑、拒绝阻断与审计脱敏查询。

### 模块依赖与边界

- 审批等待逻辑落在 OpenClaw 插件 Hook 层，不改 OpenClaw 内核源码。
- 聊天前端继续通过 `gateway:notification` 消费 `exec.approval.requested/resolved`，不新增前端协议。
- 审计存储采用主进程内同进程 SQLite（`node:sqlite`），不引入独立后端服务/独立进程。

### 关键决策与原因

1. `before_tool_call` 内阻塞等待审批结果，确保被拦工具调用在同一 `runId` 内续跑，不走 follow-up run。
2. 审计只记录参数脱敏摘要与哈希，不落敏感明文，满足“可追溯 + 最小泄露面”。
3. 前端在等待审批时提供会话内就地审批动作，减少“切会话后无反馈”的误解成本。

### 本次变更

- 新增 Guardian 控制器并接入插件 Hook：
  - `confirm` 路径：`request -> waitDecision -> allow/deny` 同步等待；
  - `deny` 路径：即时阻断并落审计；
  - `after_tool_call`：记录 `tool/risk/action/decision/duration/result`。
- 新增 `guardian.audit.query` 网关查询（分页 + agent/run/session/risk/action/time 过滤）。
- Chat 页面新增审批操作卡（同意一次/始终同意/拒绝）。
- 补齐中英日审批文案。
- 验证通过：
  - `pnpm test -- tests/unit/guardian-plugin.test.ts tests/unit/chat-approval-flow.test.ts tests/unit/gateway-events.test.ts tests/unit/sidebar.chat-nav.test.tsx`
  - `pnpm run typecheck`

## 本次变更日志（2026-03-15 Subagent 模板内置化 + 一键加载）

### 目录树

```text
Matcha-claw/
├── src/
│   ├── features/
│   │   └── subagents/
│   │       └── templates/
│   │           └── <144 template workspaces>/
│   │               ├── AGENTS.md
│   │               ├── SOUL.md
│   │               ├── TOOLS.md
│   │               ├── IDENTITY.md
│   │               └── USER.md
│   ├── pages/SubAgents/
│   │   ├── index.tsx
│   │   └── components/SubagentTemplateLoadDialog.tsx
│   ├── services/openclaw/subagent-template-catalog.ts
│   └── types/subagent.ts
├── electron/
│   ├── adapters/platform/ipc/openclaw-ipc.ts
│   └── preload/index.ts
```

### 文件职责

- `src/features/subagents/templates/*`：项目内置 subagent 模板库（打包资源源目录）。
- `electron/adapters/platform/ipc/openclaw-ipc.ts`：模板目录扫描、模板目录/模板详情 IPC 提供。
- `electron/preload/index.ts`：暴露模板目录相关安全 IPC 白名单。
- `src/services/openclaw/subagent-template-catalog.ts`：renderer 模板目录/详情读取服务。
- `src/pages/SubAgents/index.tsx`：模板展示与“加载模板”交互编排。
- `src/pages/SubAgents/components/SubagentTemplateLoadDialog.tsx`：仅模型选择的模板加载弹窗。
- `src/types/subagent.ts`：模板目录/模板详情类型定义。
- `electron-builder.yml`：将 `src/features/subagents/templates` 打包到 `resources/subagent-templates`。

### 模块依赖与边界

- 模板读取仍走 `renderer -> preload -> main ipc`，保持主进程文件系统访问边界。
- 业务编排保持在 `src/stores/subagents.ts`：创建 agent 后按模板拷贝 5 个 md 文件。
- 主进程仅提供模板元数据与文件内容，不做业务态创建决策。

### 关键决策与原因

1. 模板目录迁入 Matcha-claw 仓库，避免运行时依赖外部 `agency-agents` 邻仓存在。
2. 打包使用 `extraResources` 固化模板资源，保证安装包离线可用。
3. “加载模板”流程只要求选择模型，名称和 emoji 继承模板，满足快速创建诉求。

### 本次变更

- 将 `agency-agents/integrations/openclaw` 全量同步到 `Matcha-claw/src/features/subagents/templates`（144 模板）。
- 新增 `openclaw:getSubagentTemplateCatalog` 与 `openclaw:getSubagentTemplate` IPC。
- SubAgents 页面新增模板卡片与“加载模板”入口。
- 新增模板加载弹窗：只选择模型，创建后自动拷贝模板 md 文件。
- 验证通过：`pnpm run typecheck`、`pnpm test -- tests/unit/subagents.page.test.tsx tests/unit/subagents.store.test.ts`。

## 本次变更日志（2026-03-15 目录分层重构：services/features + team-runtime 迁移）

### 目录树

```text
electron/
├── adapters/
│   └── platform/
│       └── team-runtime/
│           ├── claim-lock.ts
│           ├── mailbox-store.ts
│           ├── runtime-store.ts
│           ├── schema.ts
│           ├── task-store.ts
│           └── types.ts
├── core/
│   └── application/
│       └── team-runtime-service.ts
└── main/
    └── team-ipc-handlers.ts

src/
├── features/
│   ├── subagents/
│   │   └── domain/
│   │       ├── prompt.ts
│   │       └── workspace.ts
│   └── teams/
│       ├── api/
│       │   └── runtime-client.ts
│       ├── domain/
│       │   └── runner-automation.ts
│       └── runtime/
│           └── orchestrator.ts
├── lib/
│   └── sections.ts
└── services/
    └── openclaw/
        ├── agent-runtime.ts
        ├── session-runtime.ts
        ├── task-manager-client.ts
        └── types.ts
```

### 文件职责

- `electron/adapters/platform/team-runtime/*`：团队运行时的文件存储、任务状态机、claim lock、邮箱与事件落盘实现（adapter 侧）。
- `electron/core/application/team-runtime-service.ts`：团队运行时 application service，统一编排 team IPC 的业务流程。
- `electron/main/team-ipc-handlers.ts`：仅做参数校验与 application service 调用，不再直接拼业务流程。
- `src/services/openclaw/*`：OpenClaw/Gateway 客户端能力，归并为基础设施服务层。
- `src/features/subagents/domain/*`：Subagent 领域规则（workspace/prompt）。
- `src/features/teams/api/runtime-client.ts`：Teams 运行时 IPC 客户端访问层。
- `src/features/teams/domain/runner-automation.ts`：Teams 自动仲裁与指令解析领域规则。
- `src/features/teams/runtime/orchestrator.ts`：Teams 运行时编排器，归并到 teams feature 域。
- `src/lib/sections.ts`：通用设置分区链接与解析函数（移除 `src/lib/settings` 目录层）。

### 模块依赖与边界

- `main -> core/application -> adapters` 方向收敛，主进程 team IPC 去业务化。
- `services/openclaw` 独立承载外部运行时访问能力，避免与 feature/domain 混杂。
- `features/subagents/domain` 与 `features/teams/runtime` 承载业务域规则与编排。

### 关键决策与原因

1. 将 `team-runtime` 从 `electron/main` 迁出，消除 host-shell 层业务实现堆积。
2. 用 `TeamRuntimeApplicationService` 承接 team 业务流程，确保 IPC handler 只承担输入边界职责。
3. 将 `src/lib/openclaw` 与 `src/lib/subagent` 拆分到 `services` 与 `features/*/domain`，按变化源分层。

### 本次变更

- 完成 `electron/main/team-runtime/* -> electron/adapters/platform/team-runtime/*` 迁移。
- 新增 `electron/core/application/team-runtime-service.ts` 并导出到 application 入口。
- 重构 `electron/main/team-ipc-handlers.ts` 为“参数校验 + 调用 application service”模式。
- 完成 `src/lib/openclaw/* -> src/services/openclaw/*` 迁移并全量改引用。
- 完成 `src/lib/subagent/* -> src/features/subagents/domain/*` 迁移并全量改引用。
- 完成 `src/lib/team/* -> src/features/teams/*` 全量迁移（`runtime-client`、`runner-automation`、`background-orchestrator`）并清理 `src/lib/team`。
- 完成 `src/lib/settings/sections.ts -> src/lib/sections.ts` 迁移并清理 `src/lib/settings`。
- 验证通过：`pnpm run typecheck`、`pnpm run check:trait-boundary`、相关 unit tests（24 tests）。

## 本次变更日志（2026-03-14 Agent 平台化收口：C 阶段主进程瘦身）

### 目录树

```text
electron/
├── adapters/
│   └── platform/
│       └── ipc/
│           ├── cron-ipc.ts
│           ├── gateway-ipc.ts
│           ├── openclaw-ipc.ts
│           ├── provider-ipc.ts
│           └── skill-config-ipc.ts
└── main/
    └── ipc-handlers.ts

docs/
└── plans/
    └── 2026-03-14-agent-platform-cutover-checklist.md
```

### 文件职责

- `electron/adapters/platform/ipc/*.ts`：承接原主进程中的平台业务 IPC 处理逻辑，按能力域拆分（gateway/openclaw/cron/provider/skill-config）。
- `electron/main/ipc-handlers.ts`：收敛为注册与宿主壳层编排入口，减少平台业务细节内嵌。
- `docs/plans/2026-03-14-agent-platform-cutover-checklist.md`：同步 A/B/C 切流完成态与回滚策略。

### 模块依赖与边界

- 维持单向依赖：`core/contracts -> core/application -> adapters -> host-shell`。
- `main/ipc-handlers.ts` 仅依赖 adapter 注册函数，不再维护大段平台业务实现。
- 平台业务入口统一经 `platform-composition-root` / `platform-ipc-facade` 连接 application 层。

### 关键决策与原因

1. C 阶段优先做“主进程去业务化”，避免继续在宿主层堆叠平台语义。
2. 保留兼容链路（如 unified request）以降低切流回归风险。
3. 将 cutover checklist 与代码同步，避免迁移状态口径漂移。

### 本次变更

- 新增 `electron/adapters/platform/ipc/*` 五个模块并接入 `registerIpcHandlers`。
- 清理 `gateway-ipc.ts` 抽取残留与 `cron-ipc.ts` 导出边界问题。
- `ipc-handlers.ts` 迁出 gateway/openclaw/cron/provider/skill-config 业务大段逻辑。
- 同步更新 `2026-03-14-agent-platform-cutover-checklist.md`。
- 验证通过：`check:trait-boundary`、平台相关 unit/integration/contract、`pnpm test`、`pnpm run lint`。

## 本次变更日志（2026-03-14 Agent 平台 Trait 驱动 implementation plan）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-implementation-plan.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-implementation-plan.md`：基于 Trait 驱动架构设计的实施主计划，按任务给出分层落地路径、测试策略、迁移阶段与提交粒度。

### 模块依赖与边界

- 实施目标边界固定为：`core/contracts -> core/application -> adapters/*`，`host-shell` 只保留宿主职责。
- 计划要求 `application` 仅依赖契约，不得引用具体 OpenClaw/Platform 适配实现。
- 迁移按 A/B/C 分阶段推进（双写验证 -> 主链路切换 -> 冗余剥离），并要求三账本一致性验证。

### 关键决策与原因

1. 采用与现有 `implementation-plan` 一致的 TDD 任务模板，保障计划可执行、可审计。
2. 将 Trait 合规门禁与 contract tests 直接纳入实施计划，避免“先改造后补治理”的回归风险。
3. 将主进程迁移与回滚路径写入同一计划，确保架构迁移具备可控切换窗口。

### 本次变更

- 新增 `2026-03-14-agent-platform-implementation-plan.md`。
- 固化 9 个实施任务（contracts/application/adapters/host-shell/门禁/文档收口）。
- 明确最终 DoD：分层依赖、三账本调和、合规门禁、跨层测试与文档同步。

## 本次变更日志（2026-03-14 Agent 平台化实施计划逐文件映射）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-implementation.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-implementation.md`：平台化改造实施主计划，包含现有代码目录逐文件迁移映射、分阶段任务、验收标准与回滚策略。

### 模块依赖与边界

- 明确目标分层：`contracts -> application -> adapters/*`，`host-shell` 仅保留宿主能力。
- 明确 Electron 主进程迁移边界：迁移平台业务逻辑，保留窗口/托盘/系统集成逻辑。
- 明确三账本模型（`GatewayPluginState`/`LocalPluginState`/`ToolRegistry`）与调和路径。

### 关键决策与原因

1. 需求明确要求“按现有代码目录逐文件映射”，因此实施文档采用文件级矩阵而非抽象任务描述。
2. 现有仓库仍是 Electron 生产架构，先做分层收敛和职责拆分，再进行后续运行时演进，降低一次性重构风险。
3. 保留 `gateway-client` 并行客户端为可选路径，不作为主链路，避免与主进程治理路径混淆。

### 本次变更

- 新增 `2026-03-14-agent-platform-implementation.md`。
- 固化 6 组目录（`electron/main`、`electron/main/team-runtime`、`electron/gateway`、`electron/api`、`electron/services/*`、`src/lib/*`）逐文件映射。
- 提供 7 个可执行任务（含测试与提交粒度）和统一 DoD/回滚策略。

## 本次变更日志（2026-03-14 Cron 手动/定时双配置执行）

### 目录树

```text
electron/
├── utils/
│   └── cron-manual-trigger.ts
├── main/
│   └── ipc-handlers.ts
└── api/
    └── routes/
        └── cron.ts

tests/
└── unit/
    └── cron-manual-trigger.test.ts
```

### 文件职责

- `electron/utils/cron-manual-trigger.ts`：封装“手动执行临时切换配置 -> 触发 -> 后台恢复原配置”的统一流程。
- `electron/api/routes/cron.ts`：将 `/api/cron/trigger` 改为使用统一手动触发流程。
- `tests/unit/cron-manual-trigger.test.ts`：覆盖手动切换条件与 patch 生成逻辑。

### 模块依赖与边界

- 渲染层不直接改动，仍通过 `IPC/Host API -> Gateway RPC`。
- Cron 触发行为统一收口到 `electron/utils/cron-manual-trigger.ts`，避免路由与 IPC 双实现漂移。
- 仅改“手动触发路径”，定时调度创建/执行路径保持不变。

### 关键决策与原因

1. 当前 OpenClaw 手动 `cron.run` 对 `isolated + agentTurn` 存在执行路径问题，导致手动触发不稳定。
2. 采用“双配置策略”：定时保留 `isolated + agentTurn`，手动临时切 `main + systemEvent` 后执行。
3. 为避免污染定时配置，手动执行完成后后台自动恢复原始字段。

### 本次变更

- 新增 Cron 手动触发统一工具，提供切换与恢复机制。
- `/api/cron/trigger` 改为复用该工具。
- 补充单测并通过（含既有 cron 会话回填用例回归）。

## 本次变更日志（2026-03-14 Trait 驱动架构强化 v2）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：严格 Trait 驱动版架构文档，新增契约层、依赖方向、合规门禁与测试基线。

### 模块依赖与边界

- 架构分层明确为 `core/contracts -> core/application -> adapters/*`，并隔离 `host-shell`。
- 核心边界由组件描述升级为 Trait 契约清单（不再只保留 RuntimeDriver 单点抽象）。
- 统一三账本模型与 `ReconcilerPort` 调和机制。

### 关键决策与原因

1. 修复“半 Trait 化”问题，避免应用层感知具体运行时实现。
2. 通过依赖方向禁令与 PR 合规门禁，避免后续架构回退。
3. 将主进程迁移策略与契约测试策略固化为可执行工程规则。

### 本次变更

- 全量重写架构文档为 Trait 驱动 v2。
- 新增核心 Trait：`ToolRegistryPort`、`ContextAssemblerPort`、`ToolExecutorPort`、`RuntimeManagerPort`、`PolicyEnginePort`、`AuditSinkPort`、`EventBusPort`、`ReconcilerPort`。
- 新增“Trait 驱动合规门禁”和“测试策略（Contract/Adapter/Migration）”章节。

## 本次变更日志（2026-03-14 架构最终定稿 + 主进程迁移矩阵）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：平台架构最终定稿，明确“统一控制面 + 被纳管运行时”模型，并加入 Electron 主进程逻辑迁移策略。

### 模块依赖与边界

- 新增 `AgentRuntimeDriver` 契约中心化表达，统一 Runtime 接入与工具纳管。
- 以三账本（`GatewayPluginState` / `LocalPluginState` / `ToolRegistry`）定义状态一致性边界。
- 明确主进程分层：平台业务逻辑迁入 Core，OS 集成能力保留在 Host Shell。

### 关键决策与原因

1. 采用“控制面/资源门户”定位，避免平台与 OpenClaw 职责重叠。
2. 将“Electron 主进程是否迁移”从口头结论固化为迁移矩阵与阶段顺序。
3. 用 Driver + Reconciler 约束上游变动风险和状态漂移风险。

### 本次变更

- 按最终定稿结构重写架构文档（原则、概念、分层、流程、状态同步、迁移、风险、冻结）。
- 新增第 6 章《Electron 主进程逻辑迁移策略（必答）》。
- 收敛并统一 OpenClaw 接入边界与工具治理口径。

## 本次变更日志（2026-03-14 架构文档重整）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：平台架构主文档（重整版），统一为“最小内核 + 平台能力插件域 + OpenClaw 接入契约”结构。

### 模块依赖与边界

- 内核边界与插件域边界分离，避免把具体业务语义放入内核。
- 明确 OpenClaw 原生插件/skill（上游）能力归属，平台只做接入、映射、治理。
- 将状态权威源、热插拔分级、迁移路线、冻结清单统一到同一结构中。

### 关键决策与原因

1. 原文档章节层次过深、重复描述较多，阅读路径不直观。
2. 通过“先总纲、再边界、再接入、再治理、再迁移”重排，降低认知跳转成本。
3. 统一术语后，避免将 `OpenClawPluginBridge` 误解为“实现 skill 能力”的组件。

### 本次变更

- 全量重写 `2026-03-14-agent-platform-full-architecture-design.md` 为简洁结构版。
- 统一 `OpenClaw 原生插件/skill（上游）` 口径。
- 收敛章节为：定位、架构、边界、接入、状态、治理、安全、版本、迁移、风险、冻结、准入。
- 补回 `AgentRuntimeProvider` 契约定义，并明确 `OpenClawCapabilityAdapter` 是当前默认 provider 实现。
- 将状态模型改为分账：`GatewayPluginState` / `LocalPluginState` / `ToolRegistry`（派生视图）。

## 本次变更日志（2026-03-14 OpenClaw 接口语义澄清）

### 目录树

```text
docs/
└── plans/
    └── 2026-03-14-agent-platform-full-architecture-design.md
```

### 文件职责

- `docs/plans/2026-03-14-agent-platform-full-architecture-design.md`：平台化架构设计主文档，明确“最小内核 + 能力插件域”边界与 OpenClaw 接入语义。

### 模块依赖与边界

- OpenClaw 能力来源明确为：Gateway RPC、Gateway 事件流、OpenClaw 插件 Hook 运行时。
- `OpenClawPluginBridge` 边界明确为：接口调用、状态同步、语义映射、审计纳管；不实现 skill 本体逻辑、不承载 Hook 执行器。
- 平台内核仅负责治理与基础设施，不在内核中二次实现 OpenClaw 原生机制。

### 关键决策与原因

1. 消除“Bridge 赋能 skill”语义歧义，避免错误实现方向（误把平台写成 OpenClaw 替代层）。
2. 把 OpenClaw 对外能力事实锚定到三份基线文档，确保后续开发有可核对依据。
3. 在插件纳管规则中显式写入 Hook 归属，防止团队重复造 Hook 执行框架。

### 本次变更

- 在架构文档新增“OpenClaw 对外接口事实”章节，引用 RPC/Event/Hook 基线。
- 将 `OpenClawPluginBridge` 相关描述统一为“接入/映射/治理”语义。
- 在 OpenClaw 插件纳管规则补充“Hook 归属”约束。

## 本次变更日志（2026-03-11 团队执行器闭环补齐）

### 目录树

```text
src/
├── components/runtime/
│   └── TeamsRuntimeDaemon.tsx
├── lib/team/
│   ├── background-orchestrator.ts
│   └── runner-automation.ts
├── stores/
│   └── teams-runner.ts
└── pages/Teams/
    ├── TeamChat.tsx
    └── useTeamAutoRunner.ts (已删除)

electron/main/team-runtime/
└── schema.ts

tests/unit/
├── team-runner-automation.test.ts
├── team-runtime-schema.test.ts
└── team-runtime-task-store.test.ts

docs/plans/
└── 2026-03-09-teams-minimal-pull-mailbox-design.md
```

### 文件职责

- `TeamsRuntimeDaemon.tsx`：应用级后台守护组件，负责启动/停止团队执行编排器。
- `background-orchestrator.ts`：后台常驻调度（自动认领、执行、阻塞决策、自动规划）。
- `runner-automation.ts`：阻塞决策解析、自动仲裁、proposal 标题提取等纯逻辑。
- `teams-runner.ts`：后台执行状态存储（开关、活跃成员、活跃任务、错误）。
- `TeamChat.tsx`：团队页展示与手动操作入口，消费全局 runner 状态，不再承载执行循环。
- `schema.ts`：任务状态机约束，新增 `blocked -> todo` 以支持重试回队列。

### 模块依赖与边界

- 执行循环从页面侧迁移到全局后台 daemon，UI 与执行编排解耦。
- 渲染层继续通过 `teams store -> runtime-client -> IPC(team:*)` 访问运行时。
- 阻塞决策/自动规划仅操作 `team:*` 契约，不新增旁路状态源。

### 关键决策与原因

1. 用全局 daemon 替代页面挂载执行，解决“切页即停工”的架构问题。
2. 阻塞流程改为 mailbox 决策闭环，避免失败后任务无人处理。
3. lead 自动处理 proposal 与超时仲裁，补齐最小自治协作能力。
4. 将“完成判定”收紧为“run 完成且产生新的 assistant 回复”，避免旧消息误判完成。

### 本次变更

- 新增后台常驻执行器、全局 runner store、自动决策工具模块。
- 删除旧 `useTeamAutoRunner.ts` 页面内执行器。
- 补齐 `blocked -> todo` 状态迁移与对应单测。
- 更新团队方案文档，补齐并发/接管/回归测试矩阵与验证命令。

## 本次变更日志（2026-03-11 团队自动执行首版）

- 新增 `src/pages/Teams/useTeamAutoRunner.ts`：团队成员自动执行循环（claim -> running -> chat.send -> done/failed -> release）。
- `src/pages/Teams/TeamChat.tsx` 接入自动执行开关与运行状态展示，支持一键暂停/恢复。
- 新增团队自动执行错误提示与活跃成员计数，便于观察任务分配与执行进度。
- 更新 `src/i18n/locales/{zh,en,ja}/teams.json`，补齐自动执行相关文案。

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

---

## 目录树（本次任务可见性修复）

```text
electron/
├── main/
│   └── ipc-handlers.ts (任务 workspace scope 解析改造)
└── utils/
    └── task-workspace-scope.ts (新增：主工作区/任务 scope 统一解析)

src/stores/
├── task-inbox-store.ts (兼容 task_created/task_create 等 task_* 事件兜底入列)
└── task-center-store.ts (兼容 task_created/task_create 等 task_* 事件兜底入列)

tests/unit/
├── task-workspace-scope.test.ts (新增：scope 回退与合并规则)
├── task-inbox-store.test.ts (新增 task_created 入列用例)
└── task-center-store.test.ts (新增 task_created 入列用例)
```

## 文件职责（关键模块）

- `electron/utils/task-workspace-scope.ts`：统一解析主工作区与任务读取 scope；配置缺失时回退到 `<openclawConfigDir>/workspace`。
- `electron/main/ipc-handlers.ts`：`openclaw:getWorkspaceDir` 与 `openclaw:getTaskWorkspaceDirs` 改为复用统一解析器，避免主工作区漏读。
- `src/stores/task-inbox-store.ts`：在保留既有事件分支的同时，对携带 `params.task` 的 `task_*` 通知做兜底 upsert。
- `src/stores/task-center-store.ts`：同上，补齐任务页对新增任务事件的实时入列能力。

## 模块依赖与边界

- 仅调整 Main 的任务 scope 计算与 Renderer 任务 store 事件消费，不改变 `host-api/api-client` 通信边界。
- 不改 Task Manager 插件协议与任务持久化格式；仍沿用 `task_list/task_get/task_resume`。
- UI 侧继续通过 store 拉取与订阅，不引入页面级临时协议分支。

## 关键决策与原因

1. 任务创建成功但 UI 不显示的主因是 scope 漏读主工作区：当 `agents.defaults.workspace`/`main.workspace` 缺失时，原实现无法覆盖 `~/.openclaw/workspace`。
2. 任务实时事件存在名称漂移风险（如 `task_created`），仅匹配少数固定方法会导致“创建后不立即出现”。
3. 采用“主因修复 + 事件兜底”组合方案，既保证读取范围正确，也保证新任务实时可见。

## 本次变更日志

- 日期：2026-03-11
- 变更主题：`fix(tasks): 修复任务创建后在收件箱与任务页不可见`
- 主要结果：
  - 任务 workspace scope 统一解析：主工作区缺失配置时回退到 `<openclawConfigDir>/workspace`
  - `openclaw:getTaskWorkspaceDirs` 始终包含主工作区，并合并子代理 workspace
  - 任务收件箱与任务页 store 兼容 `task_created/task_create` 等 `task_*` 新增事件入列
  - 补齐 scope 解析与事件入列单测，防止回归

---

## 目录树（本次 guardian -> shield+secureclaw 融合替换）

```text
packages/openclaw-task-manager-plugin/
├── openclaw.plugin.json (扩展 security schema：guardian.shield / guardian.secureclaw)
└── src/
    ├── guardian.ts (内部实现替换为 shield + secureclaw 融合引擎)
    └── index.ts (接入 security_shield_gate、tool_result_persist、message_received)

tests/unit/
└── guardian-plugin.test.ts (新增 kill switch / destructive / output redaction 用例)
```

## 文件职责（关键模块）

- `packages/openclaw-task-manager-plugin/src/guardian.ts`：统一承载策略决策、审批、审计，并新增 Shield 层（Prompt Guard / Tool Blocker / Output Scanner / Input Audit / Gate）与 SecureClaw 层（Kill Switch / 行为基线）。
- `packages/openclaw-task-manager-plugin/src/index.ts`：插件入口，负责注册新安全 gate 工具与相关 hook，同时保持 `guardian.*` RPC 兼容。
- `packages/openclaw-task-manager-plugin/openclaw.plugin.json`：声明新的安全配置结构，避免运行时隐式字段漂移。
- `tests/unit/guardian-plugin.test.ts`：验证融合替换后的关键安全行为与回归边界。

## 模块依赖与边界

- 仅替换 Task Manager 插件内部 guardian 执行层，不改 Electron Host API 协议与 Security 页路由。
- 保留 `guardian.policy.sync` / `guardian.audit.query` 对外契约；新增 `security.policy.sync` / `security.audit.query` 作为新别名能力。
- Shield/secureclaw 能力全部内聚于插件内部，不要求主工程新增外部 npm 依赖。

## 关键决策与原因

1. 以“外部接口兼容 + 内部执行替换”方式落地，避免一次性改 UI/路由造成连锁回归。
2. 将 `openclaw-shield` 的运行时拦截能力优先接入 Hook 链路（`before_agent_start`、`before_tool_call`、`tool_result_persist`、`message_received`），保证安全动作与工具调用同链执行。
3. 将 `secureclaw` 的 kill switch 与行为基线并入 `before_tool_call` 主路径，形成硬阻断兜底，而非仅做旁路告警。

## 本次变更日志

- 日期：2026-03-17
- 变更主题：`refactor(security): use secureclaw + openclaw-shield to replace guardian runtime`
- 主要结果：
  - 新增 `security_shield_gate` 工具，覆盖命令/敏感文件门控。
  - `before_tool_call` 新增 SecureClaw kill switch 阻断与行为基线日志。
  - `tool_result_persist` 新增 secrets/PII 输出脱敏（支持 enforce/audit 模式）。
  - 新增 `message_received` 输入审计与 `before_agent_start` 安全策略注入。
  - 保持 guardian 既有策略同步与审计查询 RPC 兼容，并增加 security 别名 RPC。

---

## 目录树（本次拆分：Task Manager 纯化 + 独立 Security 插件）

```text
packages/
├── openclaw-task-manager-plugin/
│   ├── openclaw.plugin.json (移除 guardian/security schema)
│   └── src/
│       └── index.ts (移除所有 guardian/security 逻辑，仅保留任务管理能力)
└── openclaw-security-plugin/ (新增)
    ├── package.json
    ├── openclaw.plugin.json
    └── src/
        └── index.ts (独立承接 guardian/security 网关方法骨架)

scripts/
├── bundle-openclaw-plugins.mjs (新增 security-core 本地插件打包入口)
└── after-pack.cjs (新增 security-core 打包产物拷贝入口)
```

## 文件职责（关键模块）

- `packages/openclaw-task-manager-plugin/src/index.ts`：回归纯任务编排插件，不再承担任何安全策略执行职责。
- `packages/openclaw-security-plugin/src/index.ts`：独立安全插件骨架，单独注册 `guardian.*`/`security.*` 网关方法，作为后续 secureclaw 裁剪落地承载点。
- `scripts/bundle-openclaw-plugins.mjs` 与 `scripts/after-pack.cjs`：确保新安全插件可进入构建与打包分发链路。

## 模块依赖与边界

- Task 管理域与安全域彻底解耦：Task 插件不再依赖安全规则、审计存储、审批策略。
- 前端安全页代码暂时保持不变，通过独立 security 插件兼容网关方法。
- 后续 secureclaw 能力接入仅改 `openclaw-security-plugin`，不再侵入 task-manager。

## 关键决策与原因

1. 将安全逻辑继续留在 task-manager 会导致职责混叠与维护边界失真，先做架构分层比继续补丁更稳定。
2. 先提供独立 security 插件骨架，再按能力清单逐步迁移 secureclaw，能降低一次性替换风险。
3. 保留 `guardian.*`/`security.*` 方法名兼容层，可避免前端立即联动改造。

## 本次变更日志

- 日期：2026-03-17
- 变更主题：`refactor(plugin-boundary): make task-manager pure and split security into standalone plugin`
- 主要结果：
  - 删除 task-manager 内所有 guardian/security 执行逻辑与相关代码文件。
  - 新增独立 `openclaw-security-plugin`，承接安全网关方法骨架。
  - 从 `secureclaw` 过滤拷贝核心检测能力到 `openclaw-security-plugin/src/vendor/secureclaw-lite.ts`，并接入 `before_tool_call` 的 P0 阻断链（kill switch / destructive / secret）。
  - 构建/打包脚本接入独立安全插件产物。

---

## 目录树（本次聊天滚动增量展开节流）

```text
src/pages/Chat/
└── index.tsx（消息列表向上增量展开：滚动事件加 rAF 节流）
```

## 文件职责（关键模块）

- `src/pages/Chat/index.tsx`：负责聊天消息滚动行为；本次将“顶部触发历史增量展开”从每次滚动直接 `setState` 改为每帧最多一次，降低滚动链路抖动。

## 模块依赖与边界

- 仅修改 Renderer 聊天页滚动监听逻辑。
- 不改 `stores/chat` 的数据协议与加载语义。
- 不改 `host-api/api-client` 边界与 Main 进程行为。

## 关键决策与原因

1. 顶部阈值命中时，滚动事件可能在一帧内触发多次，直接 `setState` 会产生连续调度与卡顿放大。
2. 采用 `requestAnimationFrame` 作为门控，保证同一帧只展开一次，同时保持现有“高度差补偿”不变，风险最小。

## 本次变更日志

- 日期：2026-03-23
- 变更主题：`perf(chat): 向上增量展开加帧节流，避免滚动时连续 setState`
- 主要结果：
  - 新增 `scheduleGrowOlderMessages`（rAF 节流）；
  - 顶部阈值命中后由“直接 setState”改为“每帧最多一次 setState”；
  - effect cleanup 增加未执行 rAF 取消，避免遗留调度。

---

## 目录树（本次切页热点治理：路由预热 + 导航调度简化）

```text
src/
├── lib/
│   └── route-preload.ts（新增：懒加载路由预热注册与路径映射）
├── App.tsx（改：接入预热组件并在空闲时预热关键懒加载路由）
└── components/layout/
    └── Sidebar.tsx（改：侧栏预取联动路由预热，页面跳转改为同步 navigate）
```

## 文件职责（关键模块）

- `src/lib/route-preload.ts`：统一定义 `Setup/Skills/Security/Settings` 的 `lazy + preload` 能力，提供按路径预热和关键路由批量预热入口。
- `src/App.tsx`：在应用稳定后（`settingsInitialized + setupComplete`）于空闲时预热关键懒加载页面 chunk，降低首切页解析/提交成本。
- `src/components/layout/Sidebar.tsx`：将导航预取从“仅数据预取”扩展为“数据 + 路由模块预热”，并移除页面跳转的 `startTransition`，避免切页链路落入 `Timer fired -> commitRootWhenReady` 延迟提交路径。

## 模块依赖与边界

- 仅改 Renderer 侧路由加载与侧栏导航调度。
- 不改 `stores/*` 数据协议，不改 `host-api/api-client` 与 Main 进程边界。
- 懒加载页面仍保持 `React.lazy + Suspense`，只是增加预热入口，不改变路由结构。

## 关键决策与原因

1. 现有热点主要表现为 React 并发调度链路（`Timer fired -> commitRootWhenReady`），优先去掉切页路径上的 `startTransition` 延迟因素。
2. 对懒加载页面做空闲预热，避免首切页时把 chunk 加载/解析成本叠加到点击链路。
3. 预热能力集中到 `route-preload.ts`，避免在各页面分散写 `import()`，保持边界清晰可维护。

## 本次变更日志

- 日期：2026-03-24
- 变更主题：`perf(route): 预热懒加载页面并简化侧栏切页调度`
- 主要结果：
  - 新增 `route-preload` 模块，支持按路径和批量预热；
  - `App` 增加空闲预热关键懒加载路由；
  - `Sidebar` 预取联动路由模块预热；
  - `Sidebar` 页面跳转移除 `startTransition`，改同步 `navigate`。

---

## 目录树（本次模板库卡顿治理：真虚拟化替换增量追加）

```text
src/pages/SubAgents/
└── index.tsx（模板库列表从“visibleCount 增量追加”改为“按行虚拟化渲染”）
```

## 文件职责（关键模块）

- `src/pages/SubAgents/index.tsx`：模板库筛选与卡片渲染主入口；本次新增网格行虚拟化与 `memo` 卡片，避免滚动时连续补批次触发的长任务与掉帧。

## 模块依赖与边界

- 使用既有 `@tanstack/react-virtual`（已在项目中引入）实现列表虚拟化。
- 仅改 Renderer 的模板库 UI 渲染路径，不改模板获取协议、不改 stores、不改主进程 IPC。

## 关键决策与原因

1. 旧实现基于 `visibleTemplateCount` 的“边滚边追加”模型，会在滚动事件链路触发频繁 `setState`，形成明显卡顿与“补一批卡片再停顿”的体感。
2. 新实现改为“完整高度占位 + 可视区渲染”，滚动时 DOM 数量稳定，主线程负载更平滑。
3. 将模板卡片拆为 `TemplateCatalogCard (memo)`，降低父组件状态变化时的卡片重复渲染成本。

## 本次变更日志

- 日期：2026-03-24
- 变更主题：`perf(subagents): 模板库切换为真虚拟化并减少滚动重渲染`
- 主要结果：
  - 删除模板库 `visibleCount` 增量追加逻辑与滚动阈值补批次链路；
  - 新增按断点列数（1/2/3 列）分行的网格虚拟化渲染；
  - 新增 `ResizeObserver` + rAF 宽度更新，保证列数变化时虚拟行测量正确；
  - 新增模板本地化文案缓存 `Map`，并引入 `TemplateCatalogCard (memo)`；
  - 保留 hover/focus 预取，移除点击按下阶段预取，减少交互帧竞争。

---

## 目录树（本次 Skills 首击优化：按需挂载 + 空闲补批）

```text
src/pages/Skills/
└── index.tsx（改：Tabs 按需挂载、技能列表补批次改为空闲调度）
```

## 文件职责（关键模块）

- `src/pages/Skills/index.tsx`：技能页渲染入口；本次聚焦“点击进入时的首帧主线程压力”，将非激活 tab 从“隐藏挂载”改为“按需挂载”，并将列表自动补批次改到 idle 阶段执行。

## 模块依赖与边界

- 仅改 Skills 页面渲染节奏，不改 `stores/skills.ts` 接口和主进程调用协议。
- 复用已有 `scheduleIdleReady` 调度工具，不引入新依赖。

## 关键决策与原因

1. 首击热点显示 `beginWork -> Skills -> SkillGridCard`，说明主要成本来自首帧挂载量，而不是业务请求。
2. 非激活 tab 继续挂载会放大 `createTask`，改为按需挂载可直接减少一次点击帧中的 React 工作量。
3. 自动补批次若同步执行，会把“补卡片渲染”叠到点击帧；改为空闲调度可以把重活后移，优先保证点击反馈。

## 本次变更日志

- 日期：2026-03-24
- 变更主题：`perf(skills): 降低首击渲染任务，延后补批次到空闲帧`
- 主要结果：
  - `TabsContent` 改为仅在激活 tab 时挂载，避免非激活面板参与首帧渲染；
  - 技能列表自动补批次从同步触发改为 `scheduleIdleReady` 调度；
  - 补批次步长从 `24` 下调为 `12`，降低单次批量渲染峰值；
  - `skillsHeavyContentReady` 取消“有数据立即重内容”同步路径，避免切页瞬间回到重渲染链路。

---

## 目录树（本次首击进一步压缩：卡片 props 提纯 + store 去重短路）

```text
src/
├── pages/Skills/
│   └── index.tsx（改：SkillGridCard 纯 props，父层预计算文案，虚拟窗口阈值收紧）
└── stores/
    └── subagents.ts（改：loadAgents 增加 in-flight 去重与无变化短路）
```

## 文件职责（关键模块）

- `src/pages/Skills/index.tsx`：将卡片渲染改为“视图模型下发”，减少卡片内部重复计算与引用抖动。
- `src/stores/subagents.ts`：将 `loadAgents` 从“每次调用都发请求并 set”改为“同一时刻单请求 + 数据等价时不 set”。

## 模块依赖与边界

- 未改 `host-api/api-client` 边界，仍走既有 RPC 调用链。
- 未引入新依赖；仅复用现有 `scheduleIdleReady`，并在 store 内做纯状态层去重。

## 关键决策与原因

1. `Skills` 热点在 `createTask / beginWork / SkillGridCard`，优先减少卡片层级的计算与挂载负担。
2. `loadAgents` 在多个入口被调用，先做低风险基础版去重短路，避免重复请求与重复提交。
3. 暂不引入 TTL 与强一致策略分支，先保证行为稳定与可回归。

## 本次变更日志

- 日期：2026-03-24
- 变更主题：`perf(skills+subagents): 压缩首击渲染并降低重复 agents 刷新`
- 主要结果：
  - `SkillGridCard` 改为纯 props 输入，不再在卡片内做 `useTranslation` 与可用性文案拼装；
  - 卡片可用性标签与缺失依赖文案上提到父层 `useMemo` 统一计算；
  - 技能列表虚拟化阈值由 `60` 收紧为 `24`，`overscan` 由 `2` 收紧为 `1`；
  - `loadAgents` 增加 `inflightLoadAgentsTask` 去重，避免并发重复拉取；
  - `loadAgents` 增加 agents 等价比较，无变化时跳过主列表 `set`。
