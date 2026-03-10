# Gateway 事件协议（开发参考）

## 1. 文档定位

- 用途：作为本项目接入 OpenClaw Gateway 事件流时的开发参考
- 范围：
- Gateway -> WebSocket 客户端事件（`features.events` 宣告）
- `agent` 事件的 `stream` 子类型
- Node 侧通过 `node.event` 上报给 Gateway 的事件名
- 不包含：
- 插件私有事件（以插件源码为准）

## 2. 真相源（Source of Truth）

- 事件总表：`openclaw/src/gateway/server-methods-list.ts` 的 `GATEWAY_EVENTS`
- 广播策略：`openclaw/src/gateway/server-broadcast.ts`
- 本文基线版本：`openclaw 2026.3.1`

## 3. Gateway -> WS 事件总览

| 事件名 | 方向 | payload 关键字段 | `dropIfSlow` |
| --- | --- | --- | --- |
| `connect.challenge` | Gateway -> 新连接 | `{ nonce, ts }` | 不走广播器 |
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
| `node.invoke.request` | Gateway -> Node 角色连接 | `{ id, nodeId, command, paramsJSON?, timeoutMs?, idempotencyKey? }` | 不走广播器 |
| `device.pair.requested` | Gateway -> WS 客户端 | `DevicePairingPendingRequest` | `true` |
| `device.pair.resolved` | Gateway -> WS 客户端 | `{ requestId, deviceId, decision, ts }` | `true` |
| `voicewake.changed` | Gateway -> WS 客户端 | `{ triggers: string[] }` | `true` |
| `exec.approval.requested` | Gateway -> WS 客户端 | `{ id, request, createdAtMs, expiresAtMs }` | `true` |
| `exec.approval.resolved` | Gateway -> WS 客户端 | `{ id, decision, resolvedBy, ts }` | `true` |
| `update.available` | Gateway -> WS 客户端 | `{ updateAvailable: { currentVersion, latestVersion, channel } \| null }` | `true` |

补充说明：

- `hello-ok` 不是 `event` 帧，而是 `connect` 请求的 `res` payload
- `stateVersion` 只在部分事件上出现（例如 `presence`、`health`）

## 4. `agent` 事件 `stream` 子类型

`agent` 基本结构：

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

子类型要点：

- `lifecycle`：`phase=start|end|error`，含开始/结束/错误信息
- `assistant`：`text`（完整文本）、`delta`（增量）、`mediaUrls?`
- `tool`：`phase=start|update|result`，含 `name/toolCallId/args/result/isError`
- `thinking`：`text` + `delta`
- `compaction`：`phase=start|end`，可含 `willRetry`
- `error`：Gateway 合成事件（例如 `seq gap`）

## 5. `chat` 状态机（关键）

`chat.state` 固定枚举：

- `delta`
- `final`
- `aborted`
- `error`

策略：

- `delta` 高频，`dropIfSlow: true`
- `final/error/aborted` 为关键帧，默认不丢弃，慢连接会被关闭

## 6. 慢连接策略

- 判定：`socket.bufferedAmount > MAX_BUFFERED_BYTES`
- 阈值：`50MB`
- 行为：
- `dropIfSlow: true`：跳过该事件，不补发
- 默认：关闭连接（`1008 slow consumer`）

## 7. 事件权限过滤（广播层）

- `exec.approval.*`：需 `operator.approvals`（`operator.admin` 可覆盖）
- `device.pair.*`：需 `operator.pairing`（`operator.admin` 可覆盖）
- `node.pair.*`：需 `operator.pairing`（`operator.admin` 可覆盖）

## 8. Node -> Gateway（`node.event`）常见事件名

- `voice.transcript`
- `agent.request`
- `notifications.changed`
- `chat.subscribe`
- `chat.unsubscribe`
- `exec.started`
- `exec.finished`
- `exec.denied`
- `push.apns.register`

注：以 `openclaw/src/gateway/server-node-events.ts` 的实现为准

## 9. 升级核对清单

每次升级 OpenClaw 后至少核对：

- `server-methods-list.ts`（`GATEWAY_EVENTS` 是否新增/变更）
- `server-broadcast.ts`（`dropIfSlow` 和慢连接策略）
- `agent-events` 与订阅桥接实现（`agent.stream` 子类型）
- `server-node-events.ts`（node 上报事件是否变化）

