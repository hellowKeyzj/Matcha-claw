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
