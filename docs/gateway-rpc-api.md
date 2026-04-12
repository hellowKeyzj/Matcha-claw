# Gateway RPC 协议（开发基线）

## 1. 文档定位

- 用途：作为 `Matcha-claw` 对接 `openclaw Gateway` 的 RPC 协议单一参考。
- 目标读者：`src/lib/host-api.ts`、`src/lib/api-client.ts`、页面数据层开发者。
- 同步基线：`openclaw@2026.4.1`（npm 包内 `dist` 产物）。
- 本文更新时间：2026-04-10。

当前文档的“事实来源”：

- 握手宣告方法与事件：
  - `node_modules/.pnpm/openclaw@2026.4.1_*/node_modules/openclaw/dist/gateway-cli-6Ksv5U_O.js`
  - 关键常量：`BASE_METHODS`、`GATEWAY_EVENTS`
- 权限映射：
  - `node_modules/.pnpm/openclaw@2026.4.1_*/node_modules/openclaw/dist/method-scopes-DOxx6FV1.js`
  - 关键常量：`METHOD_SCOPE_GROUPS`、`NODE_ROLE_METHODS`
- 握手与帧语义：
  - `node_modules/.pnpm/openclaw@2026.4.1_*/node_modules/openclaw/docs/gateway/protocol.md`

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

握手流程（2026.4.1）：

1. WebSocket 建连后，Gateway 先推 `connect.challenge` 事件（包含 `nonce`）。
2. 客户端第一帧必须发送 `connect` 请求（首包约束）。
3. Gateway 返回 `hello-ok`（`connect` 的 `payload.type === "hello-ok"`）。

## 3. 方法清单来源（非常重要）

`openclaw` 里有两层“方法集合”：

1. 握手宣告方法（当前 111 个）
   - 来源：`BASE_METHODS`
   - 用途：`connect` 成功后在握手信息中对外声明“标准可用方法”。
2. 实现层可处理但未进握手宣告的方法（当前 13 个）
   - 来源：`METHOD_SCOPE_GROUPS` 差集 + `config.openFile` 实现处理器。
   - 用途：兼容或控制平面辅助能力，默认不建议新功能优先依赖。

另外：

- 运行时插件会动态扩展方法集合（`pluginRegistry.gatewayHandlers`）。
- 所以最终可调用方法 = `BASE_METHODS` + 插件注册方法（去重）。
- 例如：`browser.request` 不在 4.1 的 `BASE_METHODS`，但浏览器扩展启用后会注册此方法。

对 `Matcha-claw` 的约束：

- 新功能默认优先使用“握手宣告方法”。
- 使用“实现层额外方法”前，先在本项目文档和调用层显式标注（防后续版本变动）。
- 使用“插件动态方法”前，必须先确认插件加载策略与禁用场景。

## 4. 握手宣告方法（111）

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
plugin.approval.request
plugin.approval.waitDecision
plugin.approval.resolve
wizard.start
wizard.next
wizard.cancel
wizard.status
talk.config
talk.speak
talk.mode
models.list
tools.catalog
tools.effective
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
sessions.subscribe
sessions.unsubscribe
sessions.messages.subscribe
sessions.messages.unsubscribe
sessions.preview
sessions.create
sessions.send
sessions.abort
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
chat.history
chat.abort
chat.send
```

## 5. 实现层额外可处理方法（13）

以下方法在实现层可处理，但不在当前握手 `methods` 列表中：

```text
chat.inject
config.openFile
connect
poll
push.test
sessions.get
sessions.resolve
sessions.steer
sessions.usage
sessions.usage.logs
sessions.usage.timeseries
web.login.start
web.login.wait
```

## 6. Gateway 事件清单（23）

```text
connect.challenge
agent
chat
session.message
session.tool
sessions.changed
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
plugin.approval.requested
plugin.approval.resolved
```

## 7. 2026.3.13 → 2026.4.1 差异

握手宣告方法：

- 数量：`100 -> 111`
- 新增（12）：
  - `plugin.approval.request`
  - `plugin.approval.waitDecision`
  - `plugin.approval.resolve`
  - `talk.speak`
  - `tools.effective`
  - `sessions.subscribe`
  - `sessions.unsubscribe`
  - `sessions.messages.subscribe`
  - `sessions.messages.unsubscribe`
  - `sessions.create`
  - `sessions.send`
  - `sessions.abort`
- 移除（1）：
  - `browser.request`（转为插件动态注册能力）

实现层额外方法：

- 数量：`12 -> 13`
- 新增：
  - `sessions.steer`

事件：

- 数量：`19 -> 23`
- 新增（5）：
  - `session.message`
  - `session.tool`
  - `sessions.changed`
  - `plugin.approval.requested`
  - `plugin.approval.resolved`
- 移除（1）：
  - `update.available`

## 8. 权限模型（operator 角色）

来源：`method-scopes-DOxx6FV1.js`。

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
  - `node.canvas.capability.refresh`
  - `node.pending.pull`
  - `node.pending.ack`
  - `skills.bins`

## 9. 在 Matcha-claw 的落地红线

- Renderer 禁止直接 `ipcRenderer.invoke('gateway:rpc', ...)`。
- Renderer 禁止直接调用 Gateway HTTP/WS 地址。
- 所有 RPC 统一走：
  - `src/lib/host-api.ts`
  - `src/lib/api-client.ts`
- 新增 RPC 方法时，必须同步：
  1. 本文“方法清单/权限”。
  2. `api-client` 参数与错误映射。
  3. 页面层调用点和异常提示。

## 10. 升级核对清单（每次同步 openclaw 必做）

1. 对比 `gateway-cli-*.js` 的 `BASE_METHODS`（握手宣告方法）。
2. 对比 `gateway-cli-*.js` 的 `GATEWAY_EVENTS`（事件）。
3. 对比 `method-scopes-*.js` 的 `METHOD_SCOPE_GROUPS` 与 `NODE_ROLE_METHODS`（权限/角色边界）。
4. 额外 grep 关键实现方法（例如 `config.openFile`、`sessions.steer`、`chat.inject`），确认“实现层额外方法”是否变化。
5. 检查插件动态方法（`pluginRegistry.gatewayHandlers`）是否新增了被 UI 依赖的方法。
6. 回归测试：`Matcha-claw` 的核心页面加载、刷新、错误提示与超时链路。
