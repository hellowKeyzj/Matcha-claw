---
title: Gateway RPC 接口协议（开发参考）
summary: OpenClaw 网关 WebSocket RPC 的方法清单、入参、返回、权限和关键行为。
sidebarTitle: Gateway RPC API
---

# Gateway RPC 接口协议（开发参考）

## 1. 文档定位

- 用途: 作为后续开发和联调用的长期参考文档。
- 范围: `openclaw` 网关 WebSocket RPC（不是 HTTP REST）。
- 完整性边界:
  - 本文覆盖 `coreGatewayHandlers` 的内置 RPC（`src/gateway/server-methods.ts`）。
  - 不包含运行时插件动态注入的方法（`listChannelPlugins().flatMap(plugin.gatewayMethods)`）。
  - 不包含启动时通过 `extraHandlers` 注入的私有扩展方法。
- 依据源码:
  - `src/gateway/server-methods-list.ts`
  - `src/gateway/server-methods.ts`
  - `src/gateway/protocol/schema/*.ts`
  - `src/gateway/server-methods/*.ts`
- 协议版本: `PROTOCOL_VERSION = 3`（见 `src/gateway/protocol/schema/protocol-schemas.ts`）。

## 2. 通信模型

### 2.1 连接与握手

1. 客户端建立 WebSocket 后，服务端先发事件:
   - `event: "connect.challenge"`
   - `payload: { nonce: string, ts: number }`
2. 客户端发送 `connect` 请求帧。
3. 服务端返回 `hello-ok`，包含:
   - `protocol`
   - `features.methods` / `features.events`
   - `snapshot`
   - `policy.maxPayload / maxBufferedBytes / tickIntervalMs`

### 2.2 帧结构

请求帧:

```json
{ "type": "req", "id": "r1", "method": "agents.list", "params": {} }
```

响应帧:

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { } }
```

事件帧:

```json
{ "type": "event", "event": "chat", "payload": { }, "seq": 12 }
```

### 2.3 错误模型

统一错误结构:

```json
{ "code": "INVALID_REQUEST|UNAVAILABLE|NOT_LINKED|NOT_PAIRED|AGENT_TIMEOUT", "message": "...", "details": {}, "retryable": true, "retryAfterMs": 1000 }
```

## 3. 权限模型

### 3.1 角色

- `operator`: 常规控制端角色。
- `node`: 节点角色。只能调用少量节点侧方法。

### 3.2 Scope

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

说明:

- `operator.admin` 包含全部 operator 权限。
- `operator.write` 可调用 read 类方法。
- `node.invoke.result`、`node.event`、`skills.bins` 为 node-role 方法。

## 4. 方法清单总览

## 4.1 BASE_METHODS（握手会广播给客户端）

- 连接/状态: `health` `status` `logs.tail`
- 渠道: `channels.status` `channels.logout`
- 用量: `usage.status` `usage.cost`
- TTS: `tts.status` `tts.providers` `tts.enable` `tts.disable` `tts.convert` `tts.setProvider`
- 配置: `config.get` `config.set` `config.apply` `config.patch` `config.schema`
- 审批: `exec.approvals.get` `exec.approvals.set` `exec.approvals.node.get` `exec.approvals.node.set` `exec.approval.request` `exec.approval.waitDecision` `exec.approval.resolve`
- 向导: `wizard.start` `wizard.next` `wizard.cancel` `wizard.status`
- Talk: `talk.config` `talk.mode`
- 模型/技能: `models.list` `skills.status` `skills.bins` `skills.install` `skills.update`
- Agent 管理: `agents.list` `agents.create` `agents.update` `agents.delete` `agents.files.list` `agents.files.get` `agents.files.set`
- 更新/唤醒: `update.run` `voicewake.get` `voicewake.set` `wake`
- 会话: `sessions.list` `sessions.preview` `sessions.patch` `sessions.reset` `sessions.delete` `sessions.compact`
- 心跳/系统: `last-heartbeat` `set-heartbeats` `system-presence` `system-event`
- 节点/设备: `node.pair.*` `device.pair.*` `device.token.*` `node.rename` `node.list` `node.describe` `node.invoke` `node.invoke.result` `node.event`
- 定时任务: `cron.list` `cron.status` `cron.add` `cron.update` `cron.remove` `cron.run` `cron.runs`
- 消息与对话: `send` `agent` `agent.identity.get` `agent.wait` `browser.request` `chat.history` `chat.abort` `chat.send`

### 4.2 已实现但不在 BASE_METHODS 广播列表

- `connect`
- `poll`
- `push.test`
- `sessions.resolve`
- `sessions.usage`
- `sessions.usage.timeseries`
- `sessions.usage.logs`
- `chat.inject`
- `web.login.start`
- `web.login.wait`

说明: 这些方法在 `coreGatewayHandlers` 里已注册，可调用；但 `hello-ok.features.methods` 默认不一定展示。

## 5. 重点接口详细定义

## 5.1 Agent 与 Chat（最常用）

### `agents.list` (`operator.read`)

- 入参: `{}`
- 返回:
  - `defaultId`: 默认 agent id
  - `mainKey`: 主会话 key
  - `scope`: `per-sender|global`
  - `agents[]`: `{ id, name?, identity? }`
- 说明:
  - `identity` 主要来自配置 `agents.list[].identity`。

### `agents.create` (`operator.admin`)

- 入参:
  - `name` string 必填
  - `workspace` string 必填
  - `emoji` string 可选
  - `avatar` string 可选
- 返回: `{ ok: true, agentId, name, workspace }`
- 关键行为:
  - `name` 会归一化为 `agentId`。
  - `agentId = "main"` 会被拒绝（保留）。
  - 会创建 workspace 和 transcript 目录。
  - 会向 `IDENTITY.md` 追加 Name/Emoji/Avatar 行。

### `agents.update` (`operator.admin`)

- 入参:
  - `agentId` string 必填
  - `name?` `workspace?` `model?` `avatar?`
- 返回: `{ ok: true, agentId }`
- 关键行为:
  - `avatar` 会追加写入 `IDENTITY.md`。

### `agents.delete` (`operator.admin`)

- 入参:
  - `agentId` string 必填
  - `deleteFiles` boolean 可选，默认 `true`
- 返回: `{ ok: true, agentId, removedBindings }`
- 关键行为:
  - `agentId = "main"` 不允许删除。
  - `deleteFiles=true` 时会尝试回收:
    - workspace 目录
    - agentDir 目录
    - transcripts 目录
  - 回收采用 best-effort（失败不会中断主流程）。

### `agents.files.list/get/set`

- `agents.files.list` 入参: `{ agentId }`
- `agents.files.get` 入参: `{ agentId, name }`
- `agents.files.set` 入参: `{ agentId, name, content }`
- `name` 只允许:
  - `AGENTS.md` `SOUL.md` `TOOLS.md` `IDENTITY.md` `USER.md` `HEARTBEAT.md` `BOOTSTRAP.md`
  - `MEMORY.md` / `MEMORIES.md`
- 统一返回包含:
  - `agentId` `workspace`
  - `file` 或 `files[]`（含 `name/path/missing/size/updatedAtMs/content?`）

### `agent` (`operator.write`)

- 入参（核心）:
  - `message` string 必填
  - `idempotencyKey` string 必填
  - `agentId?` `sessionKey?` `sessionId?`
  - `thinking?` `deliver?` `attachments?`
  - `channel/replyChannel/accountId/replyAccountId/threadId?`
  - `label?` `spawnedBy?` `timeout?` `lane?` `extraSystemPrompt?`
- 响应是“两段式”:
  1. 立即 ACK: `{ runId, status: "accepted", acceptedAt }`
  2. 结束后再返回一次同 id 响应:
     - 成功: `{ runId, status: "ok", summary, result }`
     - 失败: `{ runId, status: "error", summary }`
- 关键行为:
  - 做 idempotency 去重。
  - 处理 `/new` `/reset` 指令并调用 `sessions.reset`。
  - 可注册 tool 事件接收。

### `agent.identity.get` (`operator.read`)

- 入参: `{ agentId?, sessionKey? }`
- 返回: `{ agentId, name?, avatar?, emoji? }`
- 关键行为:
  - 会综合配置身份与工作区身份文件。

### `agent.wait` (`operator.write`)

- 入参: `{ runId, timeoutMs? }`
- 返回:
  - 超时: `{ runId, status: "timeout" }`
  - 命中: `{ runId, status, startedAt, endedAt, error? }`

### `chat.history` (`operator.read`)

- 入参: `{ sessionKey, limit? }`
- 返回: `{ sessionKey, sessionId?, messages[], thinkingLevel?, verboseLevel? }`
- 关键限制:
  - `limit` 最大 1000。
  - 总体 JSON 字节有硬上限（默认约 6MB）。
  - 单条消息硬上限约 128KB，超限会替换为占位符。

### `chat.send` (`operator.write`)

- 入参:
  - `sessionKey` `message` `idempotencyKey` 必填
  - `thinking?` `deliver?` `attachments?` `timeoutMs?`
- 返回:
  - 首包 ACK: `{ runId, status: "started" }`
  - 中间/最终内容走 `chat` 事件流（`delta/final/error/aborted`）
- 关键行为:
  - 同 idempotencyKey 会走 dedupe。
  - 收到 stop 命令会转 `chat.abort` 逻辑。

### `chat.abort` (`operator.write`)

- 入参: `{ sessionKey, runId? }`
- 返回: `{ ok: true, aborted: boolean, runIds: string[] }`

### `chat.inject` (`operator.admin`, 已实现未广播)

- 入参: `{ sessionKey, message, label? }`
- 返回: `{ ok: true, messageId }`
- 关键行为:
  - 直接写 transcript，并广播一次 `chat` final 事件。

## 5.2 Session 与 Usage

### `sessions.list` (`operator.read`)

- 入参: `limit? activeMinutes? includeGlobal? includeUnknown? includeDerivedTitles? includeLastMessage? label? spawnedBy? agentId? search?`
- 返回: `{ ts, path, count, defaults, sessions[] }`

### `sessions.preview` (`operator.read`)

- 入参: `{ keys: string[], limit?, maxChars? }`
- 返回: `{ ts, previews[] }`

### `sessions.resolve` (`operator.read`, 已实现未广播)

- 入参: `{ key?|sessionId?|label?|agentId?|spawnedBy?|includeGlobal?|includeUnknown? }`
- 返回: `{ ok: true, key }`

### `sessions.patch` (`operator.admin`)

- 入参: `{ key, ...patchFields }`
- 返回: `{ ok: true, path, key, entry, resolved? }`

### `sessions.reset` (`operator.admin`)

- 入参: `{ key, reason?: "new"|"reset" }`
- 返回: `{ ok: true, key, entry }`
- 关键行为:
  - 会归档旧 transcript。

### `sessions.delete` (`operator.admin`)

- 入参: `{ key, deleteTranscript? }`
- 返回: `{ ok: true, key, deleted, archived[] }`
- 关键行为:
  - main session 不可删除。

### `sessions.compact` (`operator.admin`)

- 入参: `{ key, maxLines? }`
- 返回: `{ ok: true, key, compacted, kept?, archived?, reason? }`

### `usage.status` / `usage.cost` (`operator.read`)

- `usage.status`: provider 用量摘要。
- `usage.cost`: 时间范围成本摘要（支持 `startDate/endDate/days`）。

### `sessions.usage*`（均 `operator.read`，已实现未广播）

- `sessions.usage` 入参: `{ key?, startDate?, endDate?, limit?, includeContextWeight? }`
- `sessions.usage.timeseries` 入参: `{ key }`
- `sessions.usage.logs` 入参: `{ key, limit? }`
- 返回: 会话维度 tokens/cost/messages/tools/latency 聚合数据。

## 5.3 配置与控制面

### `config.get` (`operator.read`)

- 入参: `{}`
- 返回: 配置快照（含 hash 与脱敏配置）。

### `config.schema` (`operator.admin`)

- 入参: `{}`
- 返回: `{ schema, uiHints, version, generatedAt }`

### `config.set` (`operator.admin`)

- 入参: `{ raw, baseHash? }`
- 返回: `{ ok: true, path, config }`
- 说明: 现存配置时建议强制携带 `baseHash`。

### `config.patch` (`operator.admin`)

- 入参: `{ raw, baseHash?, sessionKey?, note?, restartDelayMs? }`
- 返回: `{ ok, path, config, restart, sentinel }`
- 关键行为:
  - merge patch 已支持“数组按 id 合并”。
  - 会触发网关重启调度。

### `config.apply` (`operator.admin`)

- 入参: 与 `config.patch` 类似
- 返回: 与 `config.patch` 类似

### `update.run` (`operator.admin`)

- 入参: `{ sessionKey?, note?, restartDelayMs?, timeoutMs? }`
- 返回: `{ ok, result, restart, sentinel }`

### `wizard.start/next/cancel/status` (`operator.admin`)

- `wizard.start` 入参: `{ mode?, workspace? }`，返回 `{ sessionId, done, step?, status?, error? }`
- `wizard.next` 入参: `{ sessionId, answer? }`，返回 `{ done, step?, status?, error? }`
- `wizard.cancel` 入参: `{ sessionId }`，返回 `{ status, error? }`
- `wizard.status` 入参: `{ sessionId }`，返回 `{ status, error? }`

## 5.4 渠道、发送、媒体

### `channels.status` (`operator.read`)

- 入参: `{ probe?, timeoutMs? }`
- 返回: `ts/channelOrder/channelLabels/channels/channelAccounts/channelDefaultAccountId...`

### `channels.logout` (`operator.admin`)

- 入参: `{ channel, accountId? }`
- 返回: `{ channel, accountId, cleared, ...providerFields }`

### `web.login.start` / `web.login.wait` (`operator.admin`, 已实现未广播)

- 入参:
  - start: `{ force?, timeoutMs?, verbose?, accountId? }`
  - wait: `{ timeoutMs?, accountId? }`
- 返回: provider 网关定义的扫码登录结果。

### `send` (`operator.write`)

- 入参: `{ to, message?|mediaUrl?|mediaUrls?, gifPlayback?, channel?, accountId?, threadId?, sessionKey?, idempotencyKey }`
- 返回: `{ runId, messageId, channel, chatId?|channelId?|toJid?|conversationId? }`

### `poll` (`operator.write`, 已实现未广播)

- 入参: `to/question/options/idempotencyKey` + poll 扩展字段
- 返回: `{ runId, messageId, channel, pollId?, ... }`

### `tts.*`

- `tts.status` (`read`): 返回启用状态、provider、fallback、key 可用性等。
- `tts.providers` (`read`): 返回 provider 列表及 active provider。
- `tts.enable/disable` (`write`): 返回 `{ enabled: boolean }`
- `tts.setProvider` (`write`): 入参 `{ provider: openai|elevenlabs|edge }`
- `tts.convert` (`write`): 入参 `{ text, channel? }`，返回音频路径等。

### `voicewake.get/set`

- `voicewake.get` (`read`): `{ triggers: string[] }`
- `voicewake.set` (`write`): 入参 `{ triggers: string[] }`，返回同结构。

### `browser.request` (`operator.write`)

- 入参: `{ method: GET|POST|DELETE, path, query?, body?, timeoutMs? }`
- 返回: 浏览器代理结果（动态结构）。
- 关键行为:
  - 优先走 browser node 的 `browser.proxy`。
  - 无可用 node 时回落本地 browser control。

## 5.5 Node、Device、审批

### Node 配对与查询

- `node.pair.request/list/approve/reject/verify` (`operator.pairing`)
- `node.rename` (`operator.pairing`)
- `node.list` (`operator.read`)
- `node.describe` (`operator.read`)

返回重点:

- `node.list`: `{ ts, nodes[] }`
- `node.describe`: 单节点详情
- 配对 approve/reject 会广播 `node.pair.resolved` 事件

### `node.invoke` (`operator.write`)

- 入参: `{ nodeId, command, params?, timeoutMs?, idempotencyKey }`
- 返回: `{ ok: true, nodeId, command, payload, payloadJSON }`
- 关键行为:
  - 节点离线时会尝试 APNs 唤醒并重试等待。
  - 会校验命令白名单。

### `node.invoke.result` / `node.event`（node-role）

- `node.invoke.result` 入参: `{ id, nodeId, ok, payload?, payloadJSON?, error? }`，返回 `{ ok: true }` 或 `{ ok: true, ignored: true }`
- `node.event` 入参: `{ event, payload?, payloadJSON? }`，返回 `{ ok: true }`

### Device 配对

- `device.pair.list/approve/reject/remove` (`operator.pairing`)
- `device.token.rotate/revoke` (`operator.pairing`)

返回重点:

- `device.pair.list`: `{ pending, paired }`
- `device.token.rotate`: `{ deviceId, role, token, scopes, rotatedAtMs }`
- `device.token.revoke`: `{ deviceId, role, revokedAtMs }`

### Exec 审批

- 文件级:
  - `exec.approvals.get/set`
  - `exec.approvals.node.get/set`
- 会话级:
  - `exec.approval.request/waitDecision/resolve`

`exec.approval.request` 关键行为:

- 支持 `twoPhase=true`。
- twoPhase 时先返回 `accepted`，再返回最终 `decision`。

### `push.test` (`operator.write`, 已实现未广播)

- 入参: `{ nodeId, title?, body?, environment? }`
- 返回: APNs 发送结果。

## 5.6 Cron 与系统

### `wake` (`operator.write`)

- 入参: `{ mode: "now"|"next-heartbeat", text }`
- 返回: `context.cron.wake(...)` 的结果。

### `cron.*`

- `cron.list` (`read`): 入参 `{ includeDisabled? }`，返回 `{ jobs }`
- `cron.status` (`read`): 返回状态对象
- `cron.add` (`admin`): 返回创建后的 job
- `cron.update` (`admin`): 入参支持 `id` 或 `jobId` + `patch`
- `cron.remove` (`admin`): 返回 remove 结果
- `cron.run` (`admin`): 入参 `id|jobId` + `mode?`
- `cron.runs` (`read`): 返回 `{ entries }`

### 系统事件

- `last-heartbeat` (`read`): 返回最近心跳事件
- `set-heartbeats` (`admin`): 入参 `{ enabled }`，返回 `{ ok, enabled }`
- `system-presence` (`read`): 返回 presence 列表
- `system-event` (`admin`): 入参至少 `text`，返回 `{ ok: true }`

## 5.7 模型与技能

### `models.list` (`read`)

- 入参: `{}`
- 返回: `{ models: [{ id, name, provider, contextWindow?, reasoning? }] }`

### `skills.*`

- `skills.status` (`read`): 入参 `{ agentId? }`，返回 workspace 技能状态报告
- `skills.bins`（node-role）: 返回 `{ bins: string[] }`
- `skills.install` (`admin`): 入参 `{ name, installId, timeoutMs? }`，返回 install 结果
- `skills.update` (`admin`): 入参 `{ skillKey, enabled?, apiKey?, env? }`，返回 `{ ok, skillKey, config }`

## 6. 事件协议（重点）

- `connect.challenge`: `{ nonce, ts }`
- `agent`: `{ runId, seq, stream, ts, data }`
- `chat`: `{ runId, sessionKey, seq, state, message?, errorMessage?, usage?, stopReason? }`
- `presence`: 快照/状态变化
- `tick`: `{ ts }`
- `talk.mode`: `{ enabled, phase, ts }`
- `shutdown`: `{ reason, restartExpectedMs? }`
- `heartbeat`
- `cron`
- `node.pair.requested` / `node.pair.resolved`
- `device.pair.requested` / `device.pair.resolved`
- `exec.approval.requested` / `exec.approval.resolved`
- `node.invoke.request`
- `voicewake.changed`
- `update.available`

## 7. 开发注意事项（强相关）

- 去重键: `send/poll/agent/chat.send` 均依赖 `idempotencyKey`。
- 多响应语义:
  - `agent`、`exec.approval.request(twoPhase)` 可能对同一 req id 返回多次 `res`。
- 聊天结果主通道:
  - `chat.send` 的正文主要通过 `chat` 事件推送，不只看同步 `res`。
- 历史上限:
  - `chat.history` 有数量和字节硬上限，不能假设全量返回。
- 配置并发写:
  - `config.*`、`exec.approvals.*` 建议走 `baseHash` 防并发覆盖。
- 广播清单差异:
  - 某些方法已实现但不在 `features.methods`，客户端若做能力探测要额外兼容。

## 8. 参考源码路径（排障必看）

- 方法清单: `src/gateway/server-methods-list.ts`
- 权限映射: `src/gateway/method-scopes.ts`
- 总分发入口: `src/gateway/server-methods.ts`
- Schema: `src/gateway/protocol/schema/*.ts`
- 关键实现:
  - Agent/Chat: `src/gateway/server-methods/agent.ts` `src/gateway/server-methods/chat.ts`
  - Agent 管理: `src/gateway/server-methods/agents.ts`
  - 会话: `src/gateway/server-methods/sessions.ts`
  - 配置: `src/gateway/server-methods/config.ts`
  - 节点: `src/gateway/server-methods/nodes.ts`
  - 审批: `src/gateway/server-methods/exec-approvals.ts` `src/gateway/server-methods/exec-approval.ts`

## 9. 建议维护策略

- 每次升级 OpenClaw 后，优先核对以下文件是否有 break change:
  - `src/gateway/server-methods-list.ts`
  - `src/gateway/protocol/schema/*.ts`
  - `src/gateway/server-methods/*.ts`
- 若 UI/客户端依赖“方法广播列表”，同时检查“已实现但未广播”的差异是否变化。
