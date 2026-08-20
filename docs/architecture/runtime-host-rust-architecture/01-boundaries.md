# 01. 边界与 Delivery

## 1. 四个 boundary

### A. Renderer ↔ Electron

保持现有 preload IPC、Host API path/method/body、response/error、timeout、abort、event name/payload 和 main-owned route ownership。Rust 设计不能要求 Renderer、page、store 或 Electron public API 变化。

### B. Electron ↔ Rust child

这是 runtime-host replacement 的 compatibility boundary：

```text
Electron Host API proxy
  -> RuntimeHostManager / Delivery adapter
  -> Rust child /dispatch
  -> Rust compatibility decoder
  -> internal owner command
```

必须保留：

| 类型 | contract |
| --- | --- |
| readiness | `GET /health`；child lifecycle 与 Electron manager lifecycle 分层 |
| business ingress | `POST /dispatch`；`version/method/route/payload` v1 envelope |
| child control | `/lifecycle/restart`、`/lifecycle/stop` |
| failure | `BAD_REQUEST`、`PAYLOAD_TOO_LARGE`、`NOT_FOUND`、`INTERNAL_ERROR`、`UPSTREAM_UNAVAILABLE` 等稳定映射 |
| timeout | dispatch 30s；health ≤3s |
| parent callback | shell action 15s；gateway/runtime-job event 3s、best effort、不重试 |
| callback auth | parent base URL + `x-runtime-host-dispatch-token` + version/content-type validation |

`/dispatch` 是外部 child ingress；内部可以按 owner 分发到 Rust modules，但不能让内部 module 的 HTTP DTO直接取代它。

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
/internal/runtime-host/runtime-jobs
```

shell 是 request/response effect；gateway/job 是 best-effort notification。callback accepted 不等于业务操作成功；业务成功必须由对应 owner 的 terminal oracle 或 readback 确认。

## 2. DirectRuntimeHost 与 signed transport 的定位

当前代码中存在 DirectRuntimeHost、bootstrap frame、issuer、verification key 和多个专用 signed loopback transport。这些是**实现证据**，不是自动完成了外部契约替换。

最终允许两种内部路径：

```text
Compatibility path
  old Electron Host API / child /dispatch
  -> Rust compatibility ingress

Trusted product path
  Electron Delivery issuer
  -> Rust fixed product transport
  -> signed decision verifier
```

它们可以并存，但必须满足：

1. Renderer 仍看到同一 Host API；
2. 同一 public route 只有一个实际 owner；
3. direct transport 不绕过 main-owned route boundary；
4. `/dispatch` 与 direct transport 的同一 operation 有明确映射；
5. error/status/timeout/event/job projection 一致；
6. cutover 后不保留 dual semantic owner。

如果某个 direct transport 仅服务新的内部 consumer，应标为 private，不得写入 Renderer contract。

## 3. Route ownership 分类

每个 route 必须有一行 owner matrix：

```text
Renderer allowlisted -> Electron main-owned -> child compatibility -> Rust owner
child direct only    -> Rust compatibility/direct adapter
external ingress     -> Rust ingress owner / Domain owner
WebSocket            -> Electron upgrade/proxy -> Rust terminal transport
```

特别处理：

- gateway 同名 route 不能以 child registry 存在推断 public owner；
- legacy-rejected route 必须继续返回旧拒绝语义；
- `/api/sessions/*` mutation 已 capability-first，不能把被拒绝 legacy path重新设计成成功 API；
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
