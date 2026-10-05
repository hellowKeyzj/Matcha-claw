# Debugging Case Archive

本文是 [debugging-playbook.md](./debugging-playbook.md) 的案例归档。它用于保存已经被 Diagnostic Pattern 覆盖、已经过期、或只在少数场景下有参考价值的定位案例。

默认定位类任务只需要读取 `docs/agents/debugging-playbook.md`。本文不是默认必读材料，只有在 playbook 明确指向、当前问题与某个归档案例高度相似，或需要追溯历史细节时才读取。

## 1. 使用规则

- `debugging-playbook.md` 保存默认定位原则、Diagnostic Patterns、少量 active Case Cards。
- 本文保存 `promoted` / `archived` Case Cards。
- 新案例不要直接写入本文；先进入 playbook，经过抽象或过期后再迁移到本文。
- 本文案例不应改变第一轮定位顺序；能改变第一轮定位顺序的内容必须回写到 playbook 的 Diagnostic Pattern。
- 本文不得保存聊天流水、完整命令输出或长篇事故报告。

## 2. 读取触发

只有满足至少一个条件时才读取本文：

1. `debugging-playbook.md` 的某个 pattern 或 active case 明确引用本文案例。
2. 当前问题与归档案例的 Source incident / Root cause boundary 高度相似，需要追溯细节。
3. 准备新增或合并 case，需要检查是否已有同类历史案例。
4. reviewer pass 要确认本次经验应进入 active playbook 还是 archive。

## 3. 归档状态

### promoted

案例已经抽象进 Diagnostic Pattern。本文只保留短卡片，用来说明 pattern 的来源和关键误判点。

### archived

案例已经过期、一次性太强，或不再适合作为默认定位依据。本文只保留可追溯摘要。

## 4. 迁移规则

从 `debugging-playbook.md` 迁移案例到本文时：

1. 保留 Case Card 固定字段。
2. 将 `Status` 改为 `promoted` 或 `archived`。
3. 压缩 `Wrong path taken`、`Correct first-round plan` 和 `Verification closure`，只保留未来仍有价值的信息。
4. 如果案例中的 Reusable rule 已进入 Diagnostic Pattern，写明对应 pattern id。
5. 删除所有一次性命令、日志片段、聊天上下文和与当前规则无关的实现细节。

如果迁移后发现某条信息仍会改变默认定位顺序，应先更新 `debugging-playbook.md` 的 Diagnostic Pattern，再归档案例。

## 5. 归档 Case Card 模板

```md
## Case: <short name>

### Status

promoted | archived

### Linked pattern

DP-xxx 或 `none`

### Source incident

### Symptom

### Surface path

### Real minimum loop

### Wrong path taken

### Missed first probe

### Root cause

### Root cause boundary

### Correct first-round plan

### Fix boundary

### Verification closure

### Reusable rule

### Applies to

### Does not apply to

### Archive note

为什么该案例进入 archive，而不是继续留在 playbook 主体。
```

## 6. 当前归档案例

## Case: OpenClaw MCP status timeout

### Status

promoted

### Linked pattern

DP-001 Integration status failure / unavailable result

### Source incident

Matcha system-runtime MCP 在当前会话连接器中显示等待/未知，`mcpServerStatus/list` 和 `/api/external-connectors/session-status` 超时。

### Symptom

外层看到 session connector status 请求超时，gateway RPC `mcpServerStatus/list` 超时，OpenClaw 报 MCP server connection timed out。

### Surface path

Renderer status component → external connector store → Electron host API → runtime-host route → downstream status provider → OpenClaw gateway RPC。

### Real minimum loop

OpenClaw MCP runtime 通过 stdio JSON-RPC 调用 Matcha `system-runtime mcp-stdio`，完成 `initialize` 和 `tools/list`，拿到 TeamRun command tools。

### Wrong path taken

先沿 UI/status/gateway RPC 表象逐层排查，并过早处理 timeout、cached catalog、stale runtime/config 等外围问题。

### Missed first probe

没有第一时间用 OpenClaw `createSessionMcpRuntime(...).getCatalog()` 直接验证真实 MCP runtime 闭环；手写 probe 只测了 Content-Length，没有模拟 OpenClaw SDK 的 newline-delimited JSON-RPC framing。

### Root cause

OpenClaw 使用的 MCP SDK stdio transport 发送 newline-delimited JSON-RPC；Matcha MCP server 当时只支持 Content-Length framing。

### Root cause boundary

runtime-host R4 MCP stdio protocol boundary。

### Correct first-round plan

1. 直接跑 OpenClaw runtime `getCatalog()`。
2. 用同一 command/env 拉起 `system-runtime mcp-stdio`。
3. 分别 probe Content-Length 和 newline-delimited JSON-RPC framing。
4. 读取 OpenClaw MCP SDK stdio serialize 实现。
5. 只修 MCP stdio parser/response framing。

### Fix boundary

修 `runtime-host/application/runtime-cli/mcp-stdio-json-rpc.ts`；不要修 Renderer、generic route、TeamRun core 或 OpenClaw business projection。

### Verification closure

OpenClaw runtime `getCatalog()` 返回 `team_node_event` 和 `team_graph_patch`；system-runtime MCP framing 单测同时覆盖 Content-Length 和 newline-delimited JSON-RPC。

### Reusable rule

集成类状态失败先验证真实协议闭环；手写 probe 必须模拟真实调用方 SDK，而不是只测我方已知 happy path。

### Applies to

MCP、stdio JSON-RPC、gateway runtime、子进程工具服务、provider SDK transport、跨进程协议适配。

### Does not apply to

纯 UI 展示错误、纯 DTO 文案映射错误、已经由单元测试直接复现的业务纯函数错误。

### Archive note

该案例已经被 DP-001 覆盖。默认定位顺序应由 DP-001 承载，完整案例只作为追溯材料保留。

## Case: Matcha-agent app-server completed but UI pending

### Status

promoted

### Linked pattern

DP-001 Integration status failure / unavailable result

### Source incident

Matcha-agent app-server 接入 runtime-host 后，用户在 Matcha Agent 会话发“你好”，app-server 已完成 run，但 UI 持续显示“正在思考”。

### Symptom

Renderer 中 assistant pending 卡片一直存在；用户可见状态没有结束。后端 app-server session 事件实际已经包含 `run.completed`，snapshot 中 run 状态也是 `completed`。

### Surface path

Renderer chat pending state → runtime-host session update projection → session gateway ingress → matcha-agent event bridge → app-server event store。

### Real minimum loop

Renderer 发起 chat turn，经 runtime-host 调用 matcha-agent app-server；app-server worker 产出 SDK message 和 `run.completed`；runtime-host ingress 接收 app-server envelope，adapter 投影成 canonical lifecycle `final/done`；renderer 收到 terminal update 后清除 pending 并展示 assistant result。

### Wrong path taken

先把成功标准停在 worker 初始化和 app-server `run.completed`，没有一开始要求 renderer terminal state 作为闭环完成证据。

### Missed first probe

没有第一轮冻结并验证跨进程字段映射：app-server envelope 顶层 `sessionId` → runtime-host `endpointSessionId` → canonical `sessionKey` → renderer `sessionKey`。

### Root cause

app-server event envelope 使用顶层 `sessionId`；runtime-host session gateway ingress 只读取 `sessionKey` / `event.sessionKey` / `params.sessionKey`。结果 `run.completed` envelope 在 ingress 被丢弃，没有进入 matcha-agent protocol adapter，也没有投影成 renderer 的 `final/done`。

### Root cause boundary

runtime-host session gateway ingress 的 endpoint session identity 提取边界。不是 worker、app-server、SDK、renderer pending 组件或 UI timeout 问题。

### Correct first-round plan

1. 定义最终成功状态：renderer pending cleared、assistant item visible、runtime `activeRunId=null`、`runPhase=done`。
2. 沿真实 envelope 链路核对每一跳：app-server event store → event bridge → gateway ingress → protocol adapter → canonical reducer → renderer store。
3. 冻结字段映射：外部 `sessionId` 作为 endpointSessionId，进入 registry 后映射为 canonical sessionKey。
4. 用真实 app-server envelope 验证 `run.started` / `sdk.message` / `run.completed` 能投影成 streaming 和 final/done。

### Fix boundary

修 runtime-host ingress 对 app-server envelope 的 endpoint session id 读取；不要在 renderer 增加超时清 pending，也不要把 app-server `run.completed` 当成可绕过 runtime-host 的 UI 直连信号。

### Verification closure

回归测试必须证明 app-server envelope 经 runtime-host 后产生：`session_item_chunk` streaming、`session_info_update phase=final`、snapshot runtime `activeRunId=null`、`runPhase=done`、`pendingTurnKey=null`。真实运行还需重启 app 后用 UI 发消息确认 pending 消失。

### Reusable rule

新 runtime / app-server / event adapter 接入，不能以中间层 completed 作为完成证据；必须验证 terminal event 被 downstream ingestion 接收并投影到最终产品状态。跨进程 session 字段必须先作为 contract 冻结，不能把 `sessionId`、`endpointSessionId`、`sessionKey` 当成同义词。

### Applies to

runtime-host session ingress、event bridge、protocol adapter、canonical session lifecycle、renderer pending state、worker/app-server/gateway 到 UI 的多进程 chat turn。

### Does not apply to

纯 renderer 样式、纯文案、单进程内纯函数错误、已经由局部单元测试直接复现的非集成 bug。

### Archive note

该案例补强 DP-001 的 verification closure 和 field mapping 要求。默认定位顺序仍由 DP-001 承载；本文只保留本次 app-server 接入事故的追溯摘要。

## Case: Gateway retry re-entered prepare

### Status

archived

### Linked pattern

none

### Source incident

将 OpenClaw Gateway 的物理进程 ownership 迁移到 Electron main `LocalProcessRuntime` 后，一次 startup 在 port ready 之后等待 control ready 超时，`keep-current` retry 却重新进入 prepare、prelaunch 和 spawn。

### Symptom

control-ready timeout 后，config sync、prelaunch 和 fork 全部重复，owned Gateway 被 stop 后换成新 PID；本应只消费 startup outer retry budget 的暂态等待变成了重复拉起进程。

### Surface path

Electron main Gateway startup → `LocalProcessRuntime` owned process → OpenClaw Gateway adapter/supervisor readiness → recovery decision → startup outer retry。

### Real minimum loop

同一 logical start 仅按 `prepareLaunch → launch → readiness` 执行一次准备和启动。port ready 后继续等待 control ready；若 control-ready timeout 返回 `{ action: retry, cleanup: keep-current }` 且当前 plan/child 有效，则保留同一进程，等待 1 秒后只重执行 readiness。整个 startup 使用 3 次 outer budget，`still-starting` 在单轮内按内层 backoff 等待。`stop-current` 停止后，下一轮才正常 prepare/spawn；active start/restart 的 readiness 期间 child 退出时，立即中断并以真实 child-exit failure 结束本次 start。

### Wrong path taken

迁移后的 recovery 让 `keep-current` retry 重新进入 prepare，因此再次执行 prelaunch、listener 查找/attach/orphan cleanup、config/env sync 和 fork；这破坏了同一 logical start 保留 current plan/child 时只重试 readiness 的语义。

### Missed first probe

没有先断言 control-ready timeout 前后 PID、fork 次数与 prepare 次数，也没有在 ownership migration 开始时逐项冻结 startup retry、readiness、attach/orphan、crash backoff、stop/quit cleanup 等旧行为约束。

### Root cause

ownership migration 只迁移了可启动、可停止、可通过 readiness 的 happy path，没有明确 `keep-current` 重试复用 current plan/child 而不重入 prepare 的边界；generic retry loop 因而把 Gateway 专属 prepare 策略错误应用到同一 logical start 的后续 readiness attempt。

### Root cause boundary

问题位于 Electron main 的 owner seam：OpenClaw Gateway adapter/supervisor/recovery 拥有 Gateway 专属 prepare、readiness、attach/orphan 与恢复决策，`LocalProcessRuntime` 拥有 config 驱动的物理进程和 quit termination 机制。它不在 Renderer UI 或 runtime-host bridge/workflow。

### Correct first-round plan

1. 先把旧语义写成迁移约束表，并逐项指定新 owner 与验证断言。
2. 用同一 PID、一次 fork、一次 prepare 复现 port-ready/control-not-ready 场景，先确认 `keep-current` 只重试 readiness，再看 outer retry。
3. 分开验证 startup outer budget/inner backoff、首次 logical start 或显式 restart 的 listener attach/orphan cleanup、crash reconnect backoff 与 stop/quit cleanup，不能只测 happy path readiness。
4. 保持 `electron/gateway/**` 退出，不用复活旧实现修补迁移语义。

### Fix boundary

修复只落在 OpenClaw Gateway adapter/supervisor/recovery 与 `LocalProcessRuntime` 的 config/quit owner 边界：`keep-current` 且 current plan/child 有效时，通用 owner 只重执行 readiness；`stop-current` 后才由下一轮正常 prepare/spawn。Gateway 的 listener attach 或 orphan cleanup 仍只在首次 logical start 或显式 restart 的 prepare 阶段决策，config/env 只在真实 spawn 前同步。不要在 UI 或 runtime-host 增加 retry/timeout 补丁。

### Verification closure

回归闭环必须断言：

- control-ready timeout 后仍是同一 owned PID，且整个 startup 只有一次 prepare、一次 fork、一次真实 spawn 前 config/env 同步；
- `{ action: retry, cleanup: keep-current }` 只重执行 readiness，不执行 prelaunch、listener 查找/attach/orphan cleanup、config/env sync 或 spawn/fork；`stop-current` 后下一轮正常 prepare/spawn；
- active start/restart 的 readiness 期间 child 退出会立即中断，并以真实 child-exit failure 结束本次 start；
- startup 最多 3 次 outer attempt、轮次间 1 秒 delay，`still-starting` 使用单轮内层 backoff；
- listener attach 与非 owned listener 的 orphan cleanup 只发生在首次 logical start 或显式 restart 的 prepare 阶段；
- Gateway crash reconnect 最多 10 次，从 1 秒指数退避到 30 秒封顶，readiness 成功后归零；
- stop/quit 执行 5 秒 cleanup，quit timeout 时触发 emergency force termination；
- stderr classify/dedup 与 public status 在 retry、prepare 和 crash recovery 中保持既有语义。

### Reusable rule

架构 ownership migration 不能以 happy path 可用作为完成证据；必须用 `旧语义/策略 → 旧 owner 位置 → 新 owner 落点 → 验证方式 → 完成状态` 约束表逐项迁移和验收。

### Applies to

runtime/process owner migration、daemon/framework replacement、跨层 lifecycle owner 转移，以及带 prepare/readiness/recovery/attach/quit 策略的子进程迁移。

### Does not apply to

纯 UI 文案或样式、无 owner 转移的小型重构、单个纯函数 bugfix。

### Archive note

该经验已经由 `.claude/commands/code.md` 的 architecture-migration 行为约束表规则覆盖，因此不新增同义规则；本文只保留 Gateway control-ready retry 事故的可追溯案例。

## Case: TeamDesign final-form 结构收口

### Status

archived

### Linked pattern

DP-001；既有 P3/P4/P6/P7、`CODING_CONSTITUTION.md` §26 与 code reviewer 已覆盖，不新增同义规则。

### Source incident

2026-10-08，ExistingTeam 工作流设计实现后，用户质疑补丁式方案，授权有界 final-form 收口；随后核对设计 API 前三操作 input.teamId 遗漏。

### Symptom

源码确认四项结构缺陷：TeamChat 完整图缺失时 fallback 到 active-team graph/roles/gate，UI 自选新旧 patch；两页各持 local 设计写 pending；request hash 被塞为未实际 apply 的 SetMetadata audit 操作，operation_count 虚增；design store 与 facts 重复 apply/validate。后续确认 Start/Continue/Snapshot 的 wrapper 与 validator 都未要求 input.teamId，与 Rust exact decode 不匹配；文档前三表同样遗漏。同范围 response 核对发现 dependencyPlan 旧 TS 平铺类型与 Rust status/plan envelope 不符，页面直接 items.filter；Canvas replace helper 又丢 Work.groupId、Join.config.join、edge.dependency，使 domain 回默认值。未证明 durable ledger 损坏或实机故障。

### Surface path

TeamChat / Chat 页面里的 TeamLeader 会话运行面 → Teams store → Organization design transaction → draft.resolve → facts / event ledger。

### Real minimum loop

同 exact team/run 请求经 wrapper → Electron validator → Rust decode/owner → 原 store mutation 与 facts 单次 apply/validate/accept → 同 run snapshot 回读；dependencyPlan 返回原 status/plan union，页面先判 status 再展示 plan。

### Wrong path taken

以局部检查通过和旧 review pass 收口，保留了第二展示来源、页面级写互斥及假 audit 操作；又过度用既有 Data 74 绿替代新增三操作的请求 producer/consumer 核对。已有 P4/P7、DP-001、宪法 §26 和 code reviewer 规则明确；这是代理执行失败，不是规则缺失。

### Missed first probe

未核单一消费者实际读哪个 graph/roles/gate、写 flight 的跨页面 owner，以及 audit operations 是否与真实 apply 操作逐项一致；未逐项比对前三 wrapper serialize、Electron exact validator 与 Rust design decode 的 teamId。

### Root cause

新增设计分支没有收束到既有图消费与 mutation 边界；请求身份被编码成领域操作，验证工作又在两个 store 层重复。后续请求缺陷是前三仅在 target 放 teamId，而后端要求 input 同样携带；response 缺陷是 client 错报 dependencyPlan 为平铺 plan，consumer 未先判 status/取 .plan。不能放宽 Rust decode、从 target 隐式补值或为 client 改服务协议。

### Root cause boundary

仅 UI/store 投影与写入控制、Organization patch command identity / apply，以及 Team API wrapper/validator/response consumer 边界；不是 native runtime、Goal owner 或用户数据损坏。

### Correct first-round plan

先沿同 exact-run 消费链核单源与写 owner，再比对 command operations 与真实 apply，选择 typed fingerprint 和 facts 单次验证；新增 operation 逐项核 wrapper → validator → Rust decode → response consumer，不靠 fallback 或旧绿测试补齐证据。

### Fix boundary

TeamChat 只读 exact 完整 snapshot；两页共享原 store flight/mutationPending，图提交由 store 单入口选择，canvas pending 不清 draft。event GraphPatch 显式 content_fingerprint 由 draft.resolve 统一生成，codec 新 tag 4、旧 tag 0 保留原历史解释；删除假 metadata 与 design 层重复 apply/validate，facts 保留 layout/noop 设计校验。普通 session 无 Team 设计入口/协议，成员不获 leader control；Goal 独立链未重裁。[VERIFY: src/pages/Teams/TeamChat.tsx:88-94] [VERIFY: src/pages/Chat/index.tsx:681-694] [VERIFY: src/stores/teams.ts:267-322] [VERIFY: src/stores/teams.ts:1066-1099] [VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:100-139] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:1193-1213] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:2904-2919] [VERIFY: runtime-host/modules/organization/src/store/design.rs:29-79] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:2880-2921]

前三请求修复遵循原 Rust decode：Start `{teamId,runId,idempotencyKey}`、Continue `{teamId,runId,proposalId,idempotencyKey}`、Snapshot `{teamId,runId}`，匹配 exact team target；只修 wrapper/validator，Patch、响应及 owner/facts 不变。[VERIFY: runtime-host/modules/organization/src/application/design.rs:58-117] [VERIFY: src/services/openclaw/team-runtime-client.ts:956-999] [VERIFY: electron/api/routes/team-runtime-capability.ts:111-127] dependencyPlan client 改 typed status/plan union，页面两 consumer 先判 status/取 `.plan`，非 available 沿原 createError；不改服务器 source 或协议。[VERIFY: runtime-host/modules/organization/src/application/team_runtime_control.rs:696-745] [VERIFY: src/pages/Teams/index.tsx:314-348] Canvas replace 保留原 Work.groupId、Join.config.join、edge.dependency，shared DTO 对齐原 nullable 字段，不加 UI 或修改 Rust 合同。[VERIFY: src/pages/Teams/TeamRunGraphCanvas.tsx:535-560] [VERIFY: src/types/team-design.ts:16-56] MCP schema 仅对齐原 decoder 的结构、条件必填、grammar 与整数范围，不改执行语义。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:42-104] [VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:163-190]

### Verification closure

主代理结构收口后四包/MCP bin check exit 0、Org 459 passed / 0 failed；Data 74 既有 tests 两次通过，Renderer tsc/scoped lint 通过。canvas 18 passed / 1 failed，前轮 MCP 1 passed / 6 failed 及 interaction/events/dock/page 失败保留；未为旧 fixture 恢复第二 store。74 原 tests 未覆盖新增三操作的请求，不能证明本次契约缺陷已恢复；本次源码核验确认 wrapper/validator 已按原 decode 对齐；主代理报告独立内存真实 client→validator 四 design 正例/20 负例、dependency decoder 3 正例/10 负例通过，未落盘、并非原 74 tests 覆盖。本轮 Organization lib 459/0、Renderer 集成 tsc exit 0，Electron 63 diagnostics/exit 2（changed design scope 0）；Canvas 18/1、page 4/10、额外 API 62/1 失败保留。未构建替换新 runtime-host/MCP 生产二进制；`OPEN`：真实模型/native/UI live 未验收。详见 [Team 设计验证账](../architecture-knowledge/modules/team-task-organization/dev.md#existingteam-工作流设计本轮验证边界)。

2026-10-08，Chat 入口改为输入框上方文字按钮后，用户仍看不到入口。实际旧 `dist/assets/page-chat-ejVJ__RC.js` 不含 `input.teamDesignInProgress`；源码修改未同步构建产物，属于既有 P6 闭环验证未执行，不是规则缺失。重新运行 `pnpm run build:vite` exit 0，新 Chat chunk 已包含文字入口和设计中状态；没有放宽 Leader/run/startGate 条件。未直接观察当前窗口加载 URL 或会话 ownership，不能据截图判定普通会话，也不能把产物更新称为实机按钮验收。[VERIFY: src/pages/Chat/ChatInput.tsx:1386-1409] [VERIFY: src/pages/Chat/index.tsx:681-694] [VERIFY: src/pages/Chat/index.tsx:1608-1615] [VERIFY: electron/main/main-window.ts:119-130]

2026-10-08，同一 Leader 会话入口仍缺失。主代理只读实机观察当前 loadedSession：OpenClaw 完整 identity 在 Teams store roles 与 design snapshot roles 均精确匹配同一 leader/run，不是 Agent main，却收到 `ownership.kind=ordinary`；meta 的 native `endpointSessionId` 与 leader receipt 的 `endpointSessionId` 不同。修前源码根因是 Host ownership reader 以 receipt 派生 ID 匹配 native history UUID，成功批查未命中落入 ordinary，Chat 据此隐藏设计入口；修后 reader 按 peer 身份关联，原 ordinary 投影与 leader gate 保持不变。[VERIFY: runtime-host/host/src/composition/host/ports/organization.rs:46-79] [VERIFY: runtime-host/modules/sessions/src/owner/session_ownership.rs:72-81] [VERIFY: src/pages/Chat/index.tsx:681-683]

前轮已查到该归属缺陷，却仅改入口样式/构建，未修真实失败边界，也缺当前加载会话的状态观测；这是既有 P3/P4/P6/P7 与宪法 §26 执行失败，不是规则缺失。修复仅由 writer 独占 Host reader/composition，复用既有 resolver 从 receipt 生成 OpenClaw 完整 sessionKey，按 endpoint/agent/sessionKey 关联；Matcha 保持 native ID 关联并忽略 default agent。不改 public DTO、reducer 或前端 fallback。writer 两文件已落盘且文档代理已读取当前源码核实；Host bins 离线 cargo check exit0，Windows x64 MSVC Host/MCP locked offline release 构建 exit0。Host/MCP 均已替换，Host SHA256 与构建来源一致；主代理未终止或重启进程，已通知用户可自行启动。Host lib 最终 79 PASS /6 FAIL（85 项，exit101）：两项源码文本断言、一项 recovery 次数差异、三项 service 5 秒 timeout；失败不在 reader/constructor，但未复跑修改前基线，不能称与修复无关或全通过，未新增、修改测试。修后 live 待启动观察，仍 OPEN，不把源码修复、编译或替换成功写成验收。[VERIFY: runtime-host/host/src/composition/host/ports/organization.rs:20-79] [VERIFY: runtime-host/host/src/composition/host/owners/runtime.rs:381-392] [VERIFY: runtime-host/host/src/composition/runtime_ports.rs:286-295] 详见 [Session / Chat 验证账](../architecture-knowledge/modules/session-chat/dev.md#2026-10-08-teamleader-设计入口--归属根因已确认修复验证-open)。

### Reusable rule

执行已有 P3/P4/P6/P7、DP-001、宪法 §26 与 code reviewer：沿真实 producer/consumer 核身份字段与当前产品状态，在已证明的失败边界收束最终形态并验证原行为恢复；本案不增加规则、兼容层或新的审计流程。

### Applies to

多页面消费同一权威图、同 run 并发 mutation、API producer/consumer、replace 字段保真、内容幂等与 event operation 语义核查。

### Does not apply to

独立业务投影、Goal 原生事实、未经观察的 ledger 损坏或实机结果。

### Archive note

既有规则已明确，归档只承认本轮执行及旧 review 漏查边界，保存已证明事故与修复，不建立重复规则。

## Case: Goal 原生窗口 ID 被会话地址替代

### Status

archived

### Linked pattern

DP-001；既有 P4/P6/P7 与 `CODING_CONSTITUTION.md` §26 已覆盖，不新增同义规则。

### Source incident

2026-10-08，OpenClaw Goal 创建失败后，复查 create/catalog producer、typed error 与输入区；此前只编译收口，未验证原生业务闭环。

### Symptom

当前同一完整 identity 的 stored binding 与 native describe binding 不同，stored 等于 key suffix。旧 failedtrace 是不同会话，旧请求的精确 native 拒绝尚未确认；另有裸失败分类、输入区对齐及未证闪动问题。

### Surface path

Goal composer → Chat send/controller → Electron transport → Sessions → OpenClaw native；create/catalog → Session meta 提供 native binding。

### Real minimum loop

真实 create/catalog 返回原生窗口 ID → 同 identity meta 保留该 ID → Goal 请求/receipt 核原 native session → 权威回读到达当前 UI；失败仍保 typed 分类并本地化。

### Wrong path taken

把 `sessionKey` 地址 suffix 当 `endpointSessionId` 原生窗口 ID，漏核 create/catalog producer；又以编译通过代替 live 闭环。已有 §26 和 P4/P6/P7 明确覆盖，本案是代理执行未遵守，不是规则缺失。

### Missed first probe

未按同一完整 identity 对比 create/list/describe 的真实 ID 与最终 meta，未沿 typed outcome 核失败分类，也未取得修后 Goal/UI 现场证据。

### Root cause

OpenClaw create 投影使用 command 地址 ID、catalog 从 key 拆 suffix，真实 native ID 没有进入消费链；错误分类在前端链丢失。当前 identity mismatch 不能证明旧 failedtrace 的精确原生拒绝，也不能解释未经现场采样的闪动。

### Root cause boundary

OpenClaw create/catalog producer、Team 导航传参、现有 send error/controller 与 ChatInput 对齐；不是新 Goal owner、临时 describe 填充或通用 UI remount 机制。

### Correct first-round plan

先核同 identity 的 producer → meta → Goal binding 与 typed outcome，再修原责任边界；最后真实 Goal/UI 验收，不跨会话借证据或用编译代替 live。

### Fix boundary

create 用 result.native_session_id，catalog 从 sessionId 保存真实 ID、缺 ID 不产 mandatory public row；sessionKey 地址不变，不加 describe 填充。typed 失败保既有四类 outcome，有限 GoalError / 四语文案承接；成功合同不扩展。ChatInput 根部承担对齐。Team receipt 的历史 suffix 仍为地址，TeamChat/侧栏 role/run 三处导航已仅传完整 identity，不再覆盖 meta native ID；无 Team native effects 重构。[VERIFY: src/pages/Teams/TeamChat.tsx:175-184] [VERIFY: src/components/layout/AgentSessionsPane.tsx:1144-1164][VERIFY: runtime-host/integrations/openclaw/src/session/adapters/runtime.rs:490-498] [VERIFY: runtime-host/integrations/openclaw/src/session/adapters/runtime.rs:649-655] [VERIFY: src/stores/chat/send-handlers.ts:528-549] [VERIFY: src/pages/Chat/useChatGoals.ts:11-32] [VERIFY: src/pages/Chat/ChatInput.tsx:1367-1375]

### Verification closure

main 三 crate 生产 cargo check、Windows x64 Host/MCP build exit0，产物已更新；Renderer tsc/6文件 lint PASS，成功字段回收后 scoped lint 再 PASS；扩大8文件 lint 两项失败经 Team owner 内存逆替 baseline/current diagnostics deepEqual 确认为改前已有，未顺手修；该局部有 baseline，与无 baseline 的 tests 分开。Rust protocol lib tests exit101、152项编译错误未运行，含本轮4 literal 缺字段及7 deleted-field 引用，不统称旧错误。既有 send/create 7 suites 52 PASS /18 FAIL，layout 4 suites 4 PASS /29 FAIL，无完整改前 baseline，不统称旧失败；未新增或修改测试。CDP 观测/复查 ECONNREFUSED，DOM/mount/cap 样本0，闪动 OPEN。旧 Goal 未重发、未花费模型，未证明 App 重启或加载新产物；Goal 创建/管理/预算同步与 UI live 均 OPEN。最终 Renderer tsc/6 Goal 核心文件 lint/diffcheck、四语9个错误 keys 存在性检查 PASS，不代替 live；完整检查见 [Goal 验证账](../architecture-knowledge/modules/session-chat/dev.md#后续身份诊断与修复账--live-open)。

### Reusable rule

执行已有 §26 Final-form 与 P4/P6/P7：核真实 producer/consumer 身份和最终状态，修原边界并证明业务恢复；不新增规则。

### Applies to

跨 runtime 地址/原生 ID 投影、create/catalog/meta 契约、typed 失败交付与真实 UI 验收。

### Does not apply to

未经同会话证据确认的原生拒绝、无现场样本的闪动，或以构建成功推断应用已重启。

### Archive note

既有规则已覆盖，本卡仅保存执行遗漏和有界事实；最终进展复用模块验证账，不新增同义规则或长篇事故报告。后续 09:09:16Z 同次提交已确认 ID 正确而 native restart-safe admission 拒绝，具体资格子条件仍 OPEN；上轮分类日志误用未传播的 platform task-local 且 exact match 未考虑原生错误包装，已改回 OpenClaw 现有 Session trace 与 requestHash 关联，既有 describe 边界只采安全状态摘要，不重算准入或追加 RPC。后续 09:46:44Z request/rejected 同 requestHash 已证明新日志生效，完整日志的同会话 describe 可见字段未命中不合格项；继续核对已安装插件代码与同次 gateway 初始化日志，确认 memory-lancedb-pro 无条件注册的纯 debug `before_message_write` hook 构成原生 restart-unsafe 的确定充分阻断条件：权限不拦该 hook，原生只检查全局存在性。不是 session busy；未移除 hook、未关闭插件、未重发 Goal，剩余条件及业务恢复仍未验证。证据见模块验证账与 [插件 hook](../../packages/memory-lancedb-pro/index.ts#L2603)、[原生准入](../openclaw-source/src/gateway/server-methods/chat-restart-recovery.ts#L274)。编译与拒绝分类确认均不等于 Goal 创建成功。
