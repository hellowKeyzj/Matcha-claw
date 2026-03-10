# Gateway RPC 协议（开发参考）

## 1. 文档定位

- 用途：作为本项目调用 OpenClaw Gateway RPC 的快速参考
- 目标读者：维护 `api-client/host-api`、网关桥接、诊断链路的开发者
- 基线版本：`openclaw 2026.3.1`

## 2. 协议帧结构

请求帧：

```json
{
  "type": "req",
  "id": "request-id",
  "method": "chat.send",
  "params": {}
}
```

响应帧：

```json
{
  "type": "res",
  "id": "request-id",
  "ok": true,
  "payload": {}
}
```

错误帧：

```json
{
  "type": "res",
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "ERR_CODE",
    "message": "error message"
  }
}
```

## 3. 客户端握手（`connect`）

- 建连后先接收 `connect.challenge`
- 客户端使用 `connect` 请求回传认证信息与能力声明
- `hello-ok` 属于 `connect` 的响应 payload，不是事件帧

## 4. 常用方法分组

### 4.1 聊天与会话

- `chat.send`：发送消息
- `chat.history`：获取会话历史
- `chat.abort`：中止运行
- `sessions.list`：会话列表
- `sessions.delete`：删除会话

常见参数：

- `sessionKey`
- `message`
- `attachments`
- `timeoutMs`
- `idempotencyKey`

### 4.2 Agent 运行

- `agent`：创建一次运行
- `agent.wait`：等待运行状态推进
- `agent.stop`：停止运行

常见参数：

- `runId`
- `sessionKey`
- `timeoutMs`

### 4.3 配置与运行时

- `config.get`
- `config.set`
- `health.get`
- `cron.list/create/update/delete/trigger`

### 4.4 模型与技能

- `models.list`
- `tools.catalog`
- `skills.status`
- `skills.install`
- `skills.update`
- `skills.bins`（node-role）

### 4.5 渠道与投递

- `channels.status`
- `channels.logout`
- `message.send`
- `tts.convert`

## 5. 权限与角色（简版）

- 常见 scope：
- `read`
- `write`
- `admin`
- `operator.read`
- `operator.admin`

建议：

- 前端仅走 `host-api/api-client`
- 不在 renderer 直接访问 Gateway HTTP/WS 原始端点
- 权限分配和 transport 策略统一由主进程维护

## 6. 超时与重试建议

- 默认超时按方法粒度配置（短查询 < 15s，执行类 >= 30s）
- 长轮询（如 `agent.wait`）采用分片等待
- 客户端可做幂等重试，但必须带 `idempotencyKey`

## 7. 错误处理建议

- 优先读取 `error.code` + `error.message`
- 对 `TIMEOUT`、`RATE_LIMIT`、`PERMISSION` 做明确用户提示
- 对 Gateway 不可达场景统一映射为“网关不可用”

## 8. 与本项目的落地约束

- Renderer 统一入口：
- `src/lib/host-api.ts`
- `src/lib/api-client.ts`
- 禁止新增页面组件直接 `ipcRenderer.invoke('gateway:rpc', ...)`
- 禁止 renderer 直接 `fetch('http://127.0.0.1:18789/...')`

## 9. 升级核对清单

- `openclaw/src/gateway/server-methods-list.ts`：方法增删变更
- `protocol/schema/*.ts`：参数/返回结构变化
- `server-broadcast.ts`：事件配套行为变化
- 本项目 `api-client` 错误映射是否仍完整

