# Gateway 事件 API（开发基线）

## 1. 文档定位

- 用途：作为 `Matcha-claw` 对接 `openclaw Gateway` 事件流的单一参考。
- 覆盖范围：
- Gateway -> WebSocket 客户端事件（`hello-ok.features.events`）。
- `agent` / `chat` 两类高频事件的关键语义。
- Node -> Gateway 的 `node.event`（上报事件名）。
- 不包含：插件私有事件（以插件源码为准）。

## 2. 真相源与基线

- 事件清单：`openclaw/src/gateway/server-methods-list.ts` 的 `GATEWAY_EVENTS`
- 广播与慢连接策略：`openclaw/src/gateway/server-broadcast.ts`
- Node 事件入口：`openclaw/src/gateway/server-node-events.ts`
- 协议帧结构：`openclaw/src/gateway/protocol/schema/frames.ts`
- 同步基线：`openclaw@2026.3.13`（commit `8023f4c70`）
- 本文更新时间：2026-03-13

## 3. 事件帧结构

Gateway 事件统一使用 `event` 帧：

```json
{
  "type": "event",
  "event": "chat",
  "payload": {},
  "seq": 123,
  "stateVersion": {
    "presence": 8,
    "health": 21
  }
}
```

说明：

- `seq` 仅对“全局广播事件”有意义，定向投递可能不带 `seq`。
- `stateVersion` 仅在部分状态型事件中出现（如 `presence`、`health`）。
- `hello-ok` 不是事件帧，而是 `connect` 的 `res.payload`。

## 4. Gateway -> WS 事件清单（19）

来源：`GATEWAY_EVENTS` + `events.ts` 常量。

| 事件名 | 方向 | dropIfSlow（典型） | 备注 |
| --- | --- | --- | --- |
| `connect.challenge` | Gateway -> 新连接 | 不走广播器 | 握手挑战帧 |
| `agent` | Gateway -> WS 客户端 | 默认 `false` | 运行流事件 |
| `chat` | Gateway -> WS 客户端 | `delta=true`，关键帧默认 `false` | 会话消息流 |
| `presence` | Gateway -> WS 客户端 | `true` | 系统存在态 |
| `tick` | Gateway -> WS 客户端 | `true` | 心跳时钟 |
| `talk.mode` | Gateway -> WS 客户端 | `true` | 对讲模式状态 |
| `shutdown` | Gateway -> WS 客户端 | 默认 `false` | 关机/重启通知 |
| `health` | Gateway -> WS 客户端 | 默认 `false` | 健康摘要 |
| `heartbeat` | Gateway -> WS 客户端 | `true` | 心跳事件 |
| `cron` | Gateway -> WS 客户端 | `true` | 定时任务事件 |
| `node.pair.requested` | Gateway -> WS 客户端 | `true` | 节点配对待处理 |
| `node.pair.resolved` | Gateway -> WS 客户端 | `true` | 节点配对已处理 |
| `node.invoke.request` | Gateway -> Node 角色连接 | 不走广播器 | 对节点的定向调用请求 |
| `device.pair.requested` | Gateway -> WS 客户端 | `true` | 设备配对待处理 |
| `device.pair.resolved` | Gateway -> WS 客户端 | `true` | 设备配对已处理 |
| `voicewake.changed` | Gateway -> WS 客户端 | `true` | 唤醒词变更 |
| `exec.approval.requested` | Gateway -> WS 客户端 | `true` | 执行审批待处理 |
| `exec.approval.resolved` | Gateway -> WS 客户端 | `true` | 执行审批已处理 |
| `update.available` | Gateway -> WS 客户端 | `true` | 启动更新检测结果 |

## 5. `agent` 与 `chat` 关键语义

`agent` 事件核心字段：

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

要点：

- `agent` 的 schema 基础字段为 `runId/seq/stream/ts/data`，`sessionKey` 来自网关桥接扩展。
- `tool` 流在部分订阅路径会做字段裁剪（如非 full verbose 时去掉 `result/partialResult`）。
- 出现 run 序列缺口时，网关会补发 `stream=error`（原因 `seq gap`）。

`chat` 事件状态机（`ChatEventSchema`）：

- `delta`
- `final`
- `aborted`
- `error`

策略：

- `delta` 高频，广播使用 `dropIfSlow: true`。
- `final/error/aborted` 为关键帧，默认不丢，慢连接将被关闭。

## 6. 慢连接与权限过滤

慢连接判定与处理（`server-broadcast.ts`）：

- 判定条件：`socket.bufferedAmount > MAX_BUFFERED_BYTES`
- 当前阈值：`50MB`（`server-constants.ts`）
- 行为：
- 若事件设置 `dropIfSlow: true`，本次事件直接丢弃（不补发）。
- 否则关闭连接：`1008 slow consumer`。

事件权限过滤（广播层）：

- `exec.approval.requested/resolved`：需要 `operator.approvals`（`operator.admin` 可覆盖）
- `device.pair.requested/resolved`：需要 `operator.pairing`（`operator.admin` 可覆盖）
- `node.pair.requested/resolved`：需要 `operator.pairing`（`operator.admin` 可覆盖）

## 7. Node -> Gateway（`node.event`）当前实现支持事件

来源：`server-node-events.ts` 的 `switch (evt.event)`。

- `voice.transcript`
- `agent.request`
- `notifications.changed`
- `chat.subscribe`
- `chat.unsubscribe`
- `exec.started`
- `exec.finished`
- `exec.denied`
- `push.apns.register`

注意：这里是 `node.event` 的 `params.event` 值，不是 `hello-ok.features.events` 广播事件名。

## 8. 与 `gateway-rpc-api.md` 的关系

- `gateway-rpc-api.md`：方法（`req/res`）主参考，并附事件总表索引。
- 本文：事件模型、事件语义、广播策略主参考。
- 变更策略：升级 openclaw 时两份文档必须同基线提交更新，避免一新一旧。

## 9. 升级核对清单

每次升级 openclaw 至少核对以下文件：

- `src/gateway/server-methods-list.ts`（`GATEWAY_EVENTS` 变更）
- `src/gateway/server-broadcast.ts`（`dropIfSlow` 与权限过滤）
- `src/gateway/server-chat.ts`（`agent/chat` 事件语义与桥接）
- `src/gateway/server-node-events.ts`（`node.event` 支持事件）
- `src/gateway/protocol/schema/frames.ts`（事件帧字段变化）
