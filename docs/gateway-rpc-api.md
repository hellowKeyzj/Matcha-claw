# Gateway RPC 协议（开发基线）

## 1. 文档定位

- 用途：作为 `Matcha-claw` 对接 `openclaw Gateway` 的 RPC 协议单一参考。
- 目标读者：`src/lib/host-api.ts`、`src/lib/api-client.ts`、页面数据层开发者。
- 同步基线：`openclaw@2026.3.13`（commit `8023f4c70`，2026-03-13）。
- 本文更新时间：2026-03-13。

## 2. 帧结构与握手

请求帧：

```json
{
  "type": "req",
  "id": "request-id",
  "method": "chat.send",
  "params": {}
}
```

响应帧（成功）：

```json
{
  "type": "res",
  "id": "request-id",
  "ok": true,
  "payload": {}
}
```

响应帧（失败）：

```json
{
  "type": "res",
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "..."
  }
}
```

握手流程：

1. WebSocket 建连后，Gateway 先推 `connect.challenge` 事件。
2. 客户端必须发送 `connect` 请求（首包）。
3. Gateway 返回 `hello-ok`（作为 `connect` 的 `payload`）。

## 3. 方法清单来源（非常重要）

`openclaw` 里有两层“方法集合”：

1. **握手宣告方法（100 个）**
   - 来源：`openclaw/src/gateway/server-methods-list.ts` 的 `BASE_METHODS`。
   - 用途：在握手中告诉客户端“标准可用方法”。
2. **实现层可处理方法（112 个核心静态方法）**
   - 来源：`openclaw/src/gateway/server-methods.ts` + `src/gateway/server-methods/*.ts` + `server.impl.ts` 注入的额外 handlers。
   - 说明：其中有少量方法当前不在握手 `methods` 字段里，但实现仍可处理。

对 `Matcha-claw` 的约束：

- 新功能默认优先使用“握手宣告方法”。
- 使用“实现层额外方法”前，先在本项目文档和调用层显式标注（防后续版本变动）。

## 4. 握手宣告方法（100）

```text
health
doctor.memory.status
logs.tail
channels.status
channels.logout
status
usage.status
usage.cost
tts.status
tts.providers
tts.enable
tts.disable
tts.convert
tts.setProvider
config.get
config.set
config.apply
config.patch
config.schema
config.schema.lookup
exec.approvals.get
exec.approvals.set
exec.approvals.node.get
exec.approvals.node.set
exec.approval.request
exec.approval.waitDecision
exec.approval.resolve
wizard.start
wizard.next
wizard.cancel
wizard.status
talk.config
talk.mode
models.list
tools.catalog
agents.list
agents.create
agents.update
agents.delete
agents.files.list
agents.files.get
agents.files.set
skills.status
skills.bins
skills.install
skills.update
update.run
voicewake.get
voicewake.set
secrets.reload
secrets.resolve
sessions.list
sessions.preview
sessions.patch
sessions.reset
sessions.delete
sessions.compact
last-heartbeat
set-heartbeats
wake
node.pair.request
node.pair.list
node.pair.approve
node.pair.reject
node.pair.verify
device.pair.list
device.pair.approve
device.pair.reject
device.pair.remove
device.token.rotate
device.token.revoke
node.rename
node.list
node.describe
node.pending.drain
node.pending.enqueue
node.invoke
node.pending.pull
node.pending.ack
node.invoke.result
node.event
node.canvas.capability.refresh
cron.list
cron.status
cron.add
cron.update
cron.remove
cron.run
cron.runs
gateway.identity.get
system-presence
system-event
send
agent
agent.identity.get
agent.wait
browser.request
chat.history
chat.abort
chat.send
```

## 5. 实现层额外可处理方法（当前 12 个）

以下方法在实现层可处理，但不在当前握手 `methods` 列表中：

```text
chat.inject
config.openFile
connect
poll
push.test
sessions.get
sessions.resolve
sessions.usage
sessions.usage.logs
sessions.usage.timeseries
web.login.start
web.login.wait
```

## 6. Gateway 事件清单（19）

来源：`openclaw/src/gateway/server-methods-list.ts` + `src/gateway/events.ts`。

```text
connect.challenge
agent
chat
presence
tick
talk.mode
shutdown
health
heartbeat
cron
node.pair.requested
node.pair.resolved
node.invoke.request
device.pair.requested
device.pair.resolved
voicewake.changed
exec.approval.requested
exec.approval.resolved
update.available
```

## 7. 权限模型（operator 角色）

来源：`openclaw/src/gateway/method-scopes.ts`。

- Scope 常量：
  - `operator.read`
  - `operator.write`
  - `operator.admin`
  - `operator.approvals`
  - `operator.pairing`
- 规则：
  - `operator.admin` 放行全部方法。
  - `operator.read` 可读方法；`operator.write` 也可访问读方法。
  - 审批流方法要求 `operator.approvals`。
  - 配对/设备令牌方法要求 `operator.pairing`。
  - 未分类方法默认按 `admin` 处理（最小权限策略必须显式补齐）。
- Node 角色专属方法：
  - `node.invoke.result`
  - `node.event`
  - `node.pending.drain`
  - `node.pending.pull`
  - `node.pending.ack`
  - `node.canvas.capability.refresh`
  - `skills.bins`

## 8. 在 Matcha-claw 的落地红线

- Renderer 禁止直接 `ipcRenderer.invoke('gateway:rpc', ...)`。
- Renderer 禁止直接调用 Gateway HTTP/WS 地址。
- 所有 RPC 统一走：
  - `src/lib/host-api.ts`
  - `src/lib/api-client.ts`
- 新增 RPC 方法时，必须同步：
  1. 本文“方法清单/权限”
  2. `api-client` 参数与错误映射
  3. 页面层调用点和兜底提示

## 9. 升级核对清单（每次同步 openclaw 必做）

1. 对比 `openclaw/src/gateway/server-methods-list.ts`（握手宣告）。
2. 对比 `openclaw/src/gateway/server-methods.ts` 与 `src/gateway/server-methods/*.ts`（实现能力）。
3. 对比 `openclaw/src/gateway/method-scopes.ts`（权限变化）。
4. 对比 `openclaw/src/gateway/events.ts` 与 `server-methods-list.ts`（事件变化）。
5. 回归测试：`Matcha-claw` 的核心页面加载、刷新、错误提示与超时重试。
