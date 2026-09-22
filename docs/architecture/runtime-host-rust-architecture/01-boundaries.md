# 01. 边界与 Delivery

## 1. 四个 boundary

### A. Renderer ↔ Electron

保持现有 preload IPC、Host API path/method/body、response/error、timeout、abort、event name/payload 和 main-owned route ownership。Rust 设计不能要求 Renderer、page、store 或 Electron public API 变化。

### B. Electron ↔ Rust child

这是 runtime-host replacement 的 active delivery boundary：

```text
Electron Host API proxy
  -> RuntimeHostManager / Delivery adapter
  -> DirectRuntimeHost private control 或 signed loopback product route
  -> Rust installed module route / private-control command
  -> typed owner/facade command
```

必须保留：

| 类型 | contract |
| --- | --- |
| readiness | `DirectRuntimeHost` 等待 private control `ready`；Host private health 与 Electron manager lifecycle 分层 |
| Host-private control | `host.health`、`host.runtime.snapshot`；不承载业务 command enum |
| business ingress | Electron signed loopback product transports 调 installed module routes |
| child process control | Electron `RuntimeHostLifecycleOwner` / `DirectRuntimeHost` 负责 stdin EOF stop、forceKill、restart replacement |
| peer lifecycle | `/api/runtime-control/lifecycle/*` product routes；不等同 Rust child PID lifecycle |
| timeout | private control max 120s；product route 使用 route/transport deadline，Host router 默认 30s |
| parent callback | shell action 15s；gateway event 3s、best effort、不重试；owner operation typed event 由具体 facade 定义 |
| callback auth | parent base URL + `x-runtime-host-dispatch-token` + version/content-type validation |

旧 root `GET /health`、`POST /dispatch`、`POST /lifecycle/restart`、`POST /lifecycle/stop` compatibility island 已删除；内部 module HTTP DTO 不需要再包进 root dispatch envelope。

### C. Rust child ↔ native peer

Rust Host 对 OpenClaw、matcha-agent 等 peer 使用 Integration-specific protocol。Foundation 只提供 process authority/supervision mechanism；Integration 决定：

- executable/argv/environment private projection；
- readiness predicate；
- native handshake/health；
- graceful stop；
- recovery/restart policy；
- output/log redaction。

### D. Rust child ↔ Electron parent callbacks

三类 parent effect 必须独立建模：

```text
/internal/runtime-host/shell-actions
/internal/runtime-host/gateway-events
owner/facade typed operation events
```

shell 是 request/response effect；gateway 和 owner operation events 是 best-effort notification。callback accepted 不等于业务操作成功；业务成功必须由对应 owner 的 terminal oracle 或 readback 确认。

## 2. DirectRuntimeHost 与 signed transport 的定位

当前 active delivery 只有一套方向：

```text
Host-private path
  Electron DirectRuntimeHost
  -> private framed control
  -> installed private-control descriptor

Trusted product path
  Electron Delivery issuer
  -> Rust fixed product transport
  -> signed decision verifier
  -> installed module route
```

必须满足：

1. Renderer 仍看到同一 Host API；
2. 同一 public route 只有一个实际 owner；
3. signed transport 不绕过 main-owned route boundary；
4. private control 不承载业务命令；
5. error/status/timeout/event/owner-operation projection 由对应 owner/facade 保持一致；
6. 不保留 root compatibility semantic owner。

如果某个 direct transport 仅服务新的内部 consumer，应标为 private，不得写入 Renderer contract。

## 3. Route ownership 分类

每个 route 必须有一行 owner matrix：

```text
Renderer allowlisted -> Electron main-owned 或 signed loopback product route -> Rust owner
child-private        -> DirectRuntimeHost private control -> installed private-control descriptor
external ingress     -> Rust ingress owner / Domain owner
WebSocket            -> Electron upgrade/proxy -> Rust terminal module route
```

特别处理：

- gateway 同名 route 不能以 child registry 存在推断 public owner；
- retired root compatibility endpoint 不得重新注册；
- `/api/sessions/*` mutation 已 capability-first，不能把被拒绝 legacy product path重新设计成成功 API；
- Team webhook、Remote Fleet runtime-agent ingress 与 Renderer API 分开验证；
- terminal WebSocket 要单独验证 raw upgrade、auth、close、backpressure 和 reconnect。

## 4. Event boundary

```text
native event
  -> Integration schema/identity/sequence validation
  -> neutral validated event
  -> Host rebuildable projection
  -> parent callback / host:event
  -> Renderer store/page
```

`host:event` 无 ack、无 replay；不能在 bridge 层补事实。必须由 Integration/Host projection 保证：

- endpoint/session/run identity；
- sequence/gap/duplicate/stale；
- bounded IDs/text；
- secret/private payload 排除；
- terminal/unknown 语义。

## 5. Capability boundary

TS descriptor、Rust signed decision 和 product transport 是三个层次：

```text
Descriptor: Renderer 能发现什么
Decision:   Electron 是否授权这次调用
Transport:  Rust 如何验证并到达 owner
```

它们不能通过同名字段隐式合并。每个切换块必须提供 positive/negative fixture：scope 不匹配、target 不匹配、过期、重放、malformed body、unknown operation、main-owned overlap 和 upstream unavailable。
