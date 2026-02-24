---
title: Gateway 事件协议（开发参考）
summary: OpenClaw Gateway WebSocket 事件全集、payload 结构、drop 策略与 node 事件入口。
sidebarTitle: Gateway Events API
---

# Gateway 事件协议（开发参考）

## 1. 文档定位

- 用途: 作为后续开发中“流式事件兼容/订阅/兜底”实现的单一参考。
- 范围:
  - Gateway -> WebSocket 客户端事件（`features.events` 宣告）。
  - `agent` 事件的 `stream` 子类型。
  - Node 侧通过 `node.event` 上报给 Gateway 的事件名。
- 不包含:
  - 插件私有事件（如果插件自行扩展，需以插件源码为准）。

## 2. 完整性口径（源码真相源）

- 事件总表: `openclaw/src/gateway/server-methods-list.ts` 中 `GATEWAY_EVENTS`。
- 广播行为与慢连接策略: `openclaw/src/gateway/server-broadcast.ts`。
- 各事件 payload 来源:
  - `chat`: `openclaw/src/gateway/protocol/schema/logs-chat.ts` + `openclaw/src/gateway/server-chat.ts` + `openclaw/src/gateway/server-methods/chat.ts` + `openclaw/src/gateway/chat-abort.ts`
  - `agent`: `openclaw/src/gateway/protocol/schema/agent.ts` + `openclaw/src/infra/agent-events.ts` + `openclaw/src/agents/pi-embedded-subscribe*.ts`
  - 其他系统事件: `openclaw/src/gateway/server-maintenance.ts` `openclaw/src/gateway/server-close.ts` `openclaw/src/gateway/server.impl.ts` 等

## 3. Gateway -> WebSocket 事件全集

| 事件名 | 方向 | payload 要点 | `dropIfSlow` |
| --- | --- | --- | --- |
| `connect.challenge` | Gateway -> 新连接（握手前） | `{ nonce, ts }` | 不走广播器 |
| `agent` | Gateway -> WS 客户端 | `{ runId, seq, stream, ts, data, sessionKey? }` | 默认 `false` |
| `chat` | Gateway -> WS 客户端 | `{ runId, sessionKey, seq, state, message?, errorMessage?, usage?, stopReason? }` | `delta=true`，其余状态默认 `false` |
| `presence` | Gateway -> WS 客户端 | `{ presence: SystemPresence[] }` | `true` |
| `tick` | Gateway -> WS 客户端 | `{ ts }` | `true` |
| `talk.mode` | Gateway -> WS 客户端 | `{ enabled, phase, ts }` | `true` |
| `shutdown` | Gateway -> WS 客户端 | `{ reason, restartExpectedMs? }` | 默认 `false` |
| `health` | Gateway -> WS 客户端 | `HealthSummary` | 默认 `false` |
| `heartbeat` | Gateway -> WS 客户端 | `HeartbeatEventPayload` | `true` |
| `cron` | Gateway -> WS 客户端 | `CronEvent` | `true` |
| `node.pair.requested` | Gateway -> WS 客户端 | `NodePairingPendingRequest` | `true` |
| `node.pair.resolved` | Gateway -> WS 客户端 | `{ requestId, nodeId, decision, ts }` | `true` |
| `node.invoke.request` | Gateway -> Node 角色连接（定向） | `{ id, nodeId, command, paramsJSON?, timeoutMs?, idempotencyKey? }` | 不走广播器 |
| `device.pair.requested` | Gateway -> WS 客户端 | `DevicePairingPendingRequest` | `true` |
| `device.pair.resolved` | Gateway -> WS 客户端 | `{ requestId, deviceId, decision, ts }` | `true` |
| `voicewake.changed` | Gateway -> WS 客户端 | `{ triggers: string[] }` | `true` |
| `exec.approval.requested` | Gateway -> WS 客户端 | `{ id, request, createdAtMs, expiresAtMs }` | `true` |
| `exec.approval.resolved` | Gateway -> WS 客户端 | `{ id, decision, resolvedBy, ts }` | `true` |
| `update.available` | Gateway -> WS 客户端 | `{ updateAvailable: { currentVersion, latestVersion, channel } \| null }` | `true` |

说明:
- `hello-ok` 不是 `event` 帧，而是 `connect` 请求的 `res` payload，里面会带 `features.events`。
- `stateVersion` 仅在部分事件帧上携带（例如 `presence`、`health`）。

## 4. `agent` 事件 `stream` 子类型（完整）

`agent` 事件本体固定为:

```json
{
  "runId": "string",
  "seq": 1,
  "stream": "lifecycle|assistant|tool|thinking|compaction|error",
  "ts": 1730000000000,
  "data": {},
  "sessionKey": "optional"
}
```

`stream` 子类型与典型 `data`:

- `lifecycle`
  - `phase: "start" | "end" | "error"`
  - `startedAt` / `endedAt` / `error`
- `assistant`
  - `text`（当前完整文本）
  - `delta`（增量）
  - `mediaUrls?`
- `tool`
  - `phase: "start" | "update" | "result"`
  - `name` `toolCallId` `args?` `partialResult?` `result?` `isError?`
- `thinking`
  - `text`（当前完整推理文本）
  - `delta`（增量）
- `compaction`
  - `phase: "start" | "end"`
  - `willRetry?`
- `error`（Gateway 合成）
  - 用于 `seq gap` 检测，`data.reason = "seq gap"`，并带 `expected/received`

## 5. `chat` 事件状态机（关键）

`chat.state` 固定枚举:
- `delta`
- `final`
- `aborted`
- `error`

来源与策略:
- `delta`: 主要由 `agent assistant` 流映射而来，高频，`dropIfSlow: true`。
- `final/error`: 由 run 收尾逻辑发射，关键帧，不设置 `dropIfSlow`（慢连接会触发关闭而不是静默跳过）。
- `aborted`: 由 `chat.abort`/超时清理路径发射，不设置 `dropIfSlow`。

## 6. 慢连接策略（全局）

来源: `openclaw/src/gateway/server-broadcast.ts`

- 慢连接判定: `socket.bufferedAmount > MAX_BUFFERED_BYTES`
- 阈值: `MAX_BUFFERED_BYTES = 50 * 1024 * 1024`（50MB）
- 行为:
  - `dropIfSlow: true` -> 跳过该事件，不补发
  - 默认（`dropIfSlow` 未设置/`false`）-> 关闭连接（`1008 slow consumer`）

## 7. 事件权限过滤（广播层）

来源: `openclaw/src/gateway/server-broadcast.ts`

- `exec.approval.requested` / `exec.approval.resolved`
  - 需要 `operator.approvals`（`operator.admin` 可覆盖）
- `device.pair.requested` / `device.pair.resolved`
  - 需要 `operator.pairing`（`operator.admin` 可覆盖）
- `node.pair.requested` / `node.pair.resolved`
  - 需要 `operator.pairing`（`operator.admin` 可覆盖）

## 8. Node -> Gateway（`node.event`）支持的事件名

这是 node 通过 RPC `node.event` 上报给 Gateway 的事件名（非 `features.events`）:

- `voice.transcript`
- `agent.request`
- `chat.subscribe`
- `chat.unsubscribe`
- `exec.started`
- `exec.finished`
- `exec.denied`
- `push.apns.register`

来源: `openclaw/src/gateway/server-node-events.ts` 的 `switch(evt.event)`。

## 9. 升级后核对清单

每次升级 OpenClaw 后建议至少核对:

- `openclaw/src/gateway/server-methods-list.ts`（`GATEWAY_EVENTS` 是否变更）
- `openclaw/src/gateway/server-broadcast.ts`（慢连接策略是否变更）
- `openclaw/src/infra/agent-events.ts` + `openclaw/src/agents/pi-embedded-subscribe*.ts`（`agent.stream` 是否新增）
- `openclaw/src/gateway/server-node-events.ts`（node 上报事件是否新增）

