# Peer runtime 与 Host 边界

## 1. 四层责任

```text
Peer runtime
  native session/run/approval/transcript/tool/model/lifecycle facts

Runtime integration
  protocol、transport、event conversion、capability declaration、error mapping

Platform language
  Endpoint、Capability、Invocation outcome、listener identity 等中性 grammar

Rust Host facade
  composition、admission、command routing、stable public projection/selection、parent integration
```

Rust Host 不是 OpenClaw 或 Matcha 的业务替代品；它组合 peer，并把 native facts 投影到既有外部契约。

## 2. Matcha peer

`MatchaPeer` 的责任是：

- 管理 native app-server endpoint、认证 secret、证书指纹和 supervisor；
- 启停、health、restart、readiness；
- 通过 app-server protocol 读取 session、transcript、snapshot、event replay；
- 订阅带 cursor 的事件流；
- 校验 session/run/sequence，输出 bounded Renderer-safe activity；
- 把 connection loss、identity mismatch、malformed result 和未确认 terminal outcome 保持为 unavailable/unknown。

`MatchaPeer` 不拥有：

- global external connector JSON；
- OpenClaw config；
- Host-wide cron、usage、RuntimeJob；
- Renderer canonical session state；
- legacy transcript JSONL writer。

## 3. OpenClaw peer

OpenClaw/Gateway native subsystem 拥有：

- config channel identity；
- Gateway channel live status；
- cron definitions、runs、receipts；
- native session/runtime status；
- Gateway apply/readback；
- pairing/conversation runtime facts。

OpenClaw integration 负责：

- GatewayClient control exchange、RPC/WebSocket/CLI protocol adapter；
- private config projection；
- outcome mapping；
- native event 到 Host/Renderer projection；
- 不确定结果保留 `Unknown`。

当前 OpenClaw active path 的 session/task/team prompt 不保留独立 `SessionClient` 主链路；session mutation 复用 `GatewayClient` control exchange，`sessions.subscribe` 只保留 wire/protocol 能力，不参与 Host session 主链路。

## 4. Capability 与 authorization

当前 TS 与 Rust 不是同一套 capability model：

```text
TS:
  dynamic descriptor registry
  RuntimeScope / CapabilityTarget grammar
  operation route producer
  generic capability execute

Rust:
  signed decision verifier
  fixed transport admission
  typed commands
  safe event projection
  no generic CapabilityExecute command
```

因此不能把 Rust 当前 fixed descriptor directory 直接称为 TS capability router 的替代品。切换前必须明确：

- `/api/capabilities/list|describe|execute` 是否由 Rust 完整兼容；
- `policyScope`、`ownerModuleId`、`routeOwnerId` 与 signed decision scope 是否有正式映射；
- full descriptor、endpoint capability summary、Rust peer directory 的 authority 顺序；
- `bootstrap` scope 等当前 TS scope 是否需要保留。

## 5. Host 与 peer state 分层

以下状态不得合并：

```text
Electron process readiness
TS child health
Rust Host admission Ready
Matcha app-server /health
OpenClaw gateway port reachable
OpenClaw Gateway connected
operation terminal outcome
```

例如 Rust `HostState.ok` 是 Host admission projection，不表示 Matcha peer 已 Running；Gateway port reachable、Gateway health 和 OpenClaw control readiness 是不同 read projection，不表示 WebSocket connected、policy 已生效或 operation 可终局成功。

## 6. 事件投影

```text
peer/native event
  -> integration validation and cursor
  -> Host safe projection
  -> Electron parent callback / host:event
  -> Renderer store/page
```

Rust projection必须负责：

- identity、run、sequence、epoch 校验；
- duplicate/stale/gap 处理；
- bounded text/IDs；
- secret/private payload 排除；
- terminal/unknown 语义。

TypeScript `host-events` bridge 只分发 event，不负责 schema validation、sequence validation 或 secret redaction。因此上游 projection 才是安全边界。
