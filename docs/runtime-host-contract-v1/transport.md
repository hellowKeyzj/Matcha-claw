# Electron ↔ child transport

## 1. child root endpoints

| Method | Path | 状态 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | `CONFIRMED` | child readiness / root health；不是 dispatch success envelope。 |
| `POST` | `/dispatch` | `CONFIRMED` | Electron、CLI 和测试进入 child business route 的统一入口。 |
| `POST` | `/lifecycle/restart` | `CONFIRMED` | 重启 child 内部 lifecycle/background service；不重新 fork child。 |
| `POST` | `/lifecycle/stop` | `CONFIRMED` | 返回后异步 shutdown child。 |

来源：[runtime-host-server.ts](../../runtime-host/composition/runtime-host-server.ts#L95-L152)。Team webhook、remote-agent ingress 和 terminal WebSocket 另见 [scope.md](scope.md)。

## 2. `/dispatch` request envelope

Electron 永远向 child 发送 `POST /dispatch`，body 是：

```json
{
  "version": 1,
  "method": "POST",
  "route": "/api/capabilities/execute",
  "payload": {}
}
```

| 字段 | 规则 |
| --- | --- |
| `version` | 必须为 `1`。 |
| `method` | 仅 `GET`、`POST`、`PUT`、`DELETE`。 |
| `route` | 必须是以 `/` 开头的字符串；保留 query string。 |
| `payload` | 可省略；具体 schema 由目标 route/capability 决定。 |

Electron client 组装位置：[runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L137-L162)。child parser：[dispatch-envelope.ts](../../runtime-host/api/dispatch/dispatch-envelope.ts#L29-L79)。

## 3. `/dispatch` response envelope

### 成功

```json
{
  "version": 1,
  "success": true,
  "status": 200,
  "data": {}
}
```

### 失败

```json
{
  "version": 1,
  "success": false,
  "status": 400,
  "error": {
    "code": "BAD_REQUEST",
    "message": "..."
  }
}
```

Electron 对 response 有严格结构校验：object、`version === 1`、boolean `success`、numeric `status`；失败体还必须有 string `error.code` 与 `error.message`。不满足时 Electron 自己生成 `502 / INVALID_TRANSPORT_PAYLOAD`。来源：[runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L53-L91)。

## 4. 已观察到的 child error matrix

| 条件 | HTTP / outer status | code | 证据 |
| --- | --- | --- | --- |
| transport version 不为 `1` | `400` | `BAD_REQUEST` | [dispatch-envelope.ts](../../runtime-host/api/dispatch/dispatch-envelope.ts#L41-L49) |
| method 不在 allowlist | `400` | `BAD_REQUEST` | [dispatch-envelope.ts](../../runtime-host/api/dispatch/dispatch-envelope.ts#L51-L59) |
| route 缺少 `/` | `400` | `BAD_REQUEST` | [dispatch-envelope.ts](../../runtime-host/api/dispatch/dispatch-envelope.ts#L61-L69) |
| body 超过 `1_000_000` bytes | `413` | `PAYLOAD_TOO_LARGE` | [dispatch-envelope.ts](../../runtime-host/api/dispatch/dispatch-envelope.ts#L3-L38) |
| route 未注册 | `404` | `NOT_FOUND` | [dispatch-route-handler.ts](../../runtime-host/api/dispatch/dispatch-route-handler.ts) |
| JSON syntax / request failure | `400` | `BAD_REQUEST` | [dispatch-route-handler.ts](../../runtime-host/api/dispatch/dispatch-route-handler.ts) |
| 未处理异常 | `500` | `INTERNAL_ERROR` | [dispatch-route-handler.ts](../../runtime-host/api/dispatch/dispatch-route-handler.ts) |
| network / fetch / parse failure（Electron client） | `503` | `UPSTREAM_UNAVAILABLE` | [runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L177-L185) |

`PAYLOAD_TOO_LARGE` 与 Electron 的 `INVALID_TRANSPORT_PAYLOAD` 尚未写入 shared error-code union，见 [open-items.md](open-items.md)。

## 5. root health 与 application health 必须区分

### `GET /health`：child process health

```json
{
  "version": 1,
  "ok": true,
  "lifecycle": "running",
  "pid": 12345,
  "uptimeSec": 12
}
```

- `ok` 当前等于 `lifecycle === 'running'`。
- `pid`、`uptimeSec` 由 child 进程产生。
- 用于 readiness；Electron `checkHealth()` 最多等待 3 秒。

来源：[runtime-state.ts](../../runtime-host/application/runtime-host/runtime-state.ts#L7-L20)、[runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L191-L217)。

### `GET /api/runtime-host/health`：application projection

该 route 通过 `/dispatch` 返回 application-level `state` / `health`，可含 active plugin count 与 degraded plugin 信息；不是 root `/health` 的同一个 payload。来源：[runtime-host-routes.ts](../../runtime-host/api/routes/runtime-host-routes.ts#L18-L37)、[runtime-state.ts](../../runtime-host/application/runtime-host/runtime-state.ts#L125-L131)。

## 6. Electron Host API 再包装

Renderer 不直接得到 child outer envelope。Electron Host API proxy：

1. 将 Renderer `hostapi:fetch` 转为 authenticated loopback Host API request；
2. Host API route 将 child `result.status` 与 `result.data` 回写；
3. Electron IPC 再包为 `{ ok: true, data: { status, ok, json|text } }` 或 `{ ok:false, error }`；
4. Renderer decoder 用 HTTP status / `ok` / response JSON 决定是否抛错。

来源：[hostapi-proxy-ipc.ts](../../electron/main/ipc/hostapi-proxy-ipc.ts#L55-L132)、[runtime-host-proxy.ts](../../electron/api/routes/runtime-host-proxy.ts#L25-L84)、[host-api-transport-contract.ts](../../src/lib/host-api-transport-contract.ts#L1-L128)。

## 7. timeout baseline

| 方向 | 当前实际值 | 说明 |
| --- | --- | --- |
| Renderer → Electron Host API proxy | 默认 `30s`，请求可覆盖 | [hostapi-proxy-ipc.ts](../../electron/main/ipc/hostapi-proxy-ipc.ts#L21-L22) |
| Electron → child `/dispatch` | 默认 `30s`，请求可覆盖 | [runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L12-L13) |
| Electron → child `/health` | `min(request timeout, 3s)` | [runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L191-L217) |
| child → Electron shell callback | `15s` | [parent-transport-client.ts](../../runtime-host/composition/parent-transport-client.ts) |
| child → Electron gateway/job event | `3s`，best effort | [parent-transport-client.ts](../../runtime-host/composition/parent-transport-client.ts) |

`docs/runtime-host-transport-v1.md` 仍写 main→child default dispatch timeout 为 `15s`，与当前 Electron client 不一致；本基线记录实际源码为 `30s`，正式治理决定见 [open-items.md](open-items.md)。
