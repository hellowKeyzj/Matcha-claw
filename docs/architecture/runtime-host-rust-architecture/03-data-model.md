# 03. 数据结构与状态模型

## 1. 不建立单一 `RuntimeHostState`

Rust runtime-host 的顶层状态不是一个大 struct，而是多个 owner-local state 加少量 Host projection：

```text
Address / Identity
  + owner-local desired/persisted/applied/observed
  + CommandReceipt / Outcome
  + peer lifecycle observation
  + event cursor / validated projection
  + SessionProjection
  + JobCompatibilityProjection
```

`HostSnapshot` 最多是 admission、peer snapshot、safe health 和 projection metadata 的组合；它不能成为所有领域事实的总表。

## 2. Identity model

### 2.1 Endpoint

```text
EndpointRef
  = NativeRuntime { adapter_id, instance_id }
  | ProtocolEndpoint { protocol_id, connector_id, endpoint_id }
```

Endpoint 是 routing/isolation namespace。不能只用名称或 port 作为 endpoint identity。

### 2.2 Session

```text
SessionIdentity {
  endpoint: EndpointRef,
  agent_id: AgentId,
  session_key: SessionKey,
}

NativeSessionBinding {
  endpoint_session_id: NativeSessionId,
  protocol: ProtocolId,
}
```

`SessionIdentity` 是 Host 路由与隔离主键；`endpoint_session_id` 是 peer-native durable id。二者不能合并。

### 2.3 Run、message、event、command

| 类型 | 语义 | 不能替代 |
| --- | --- | --- |
| `RunId` | 一次 execution/run ownership | session identity、message identity |
| `MessageId` | 一条消息身份 | seq、event id |
| `EventId` | 一条事件身份 | message id、command id |
| `Sequence` | 单一 peer/session stream 的 ordering | global seq、transcript index |
| `CommandId` | 一次命令/attempt 身份 | run id |
| `CorrelationId` | 跨边界请求关联/幂等键 | terminal outcome |
| `Revision` | desired/apply 的版本 fence | event sequence |
| `Epoch` | peer/process/connection generation | revision |

所有 composite key 必须结构化校验、长度有界、脱敏。不同 seq 系统不建立假设性的 crosswalk；只能由具体 adapter 明确映射。

## 3. 四个状态平面

这四个平面是 owner 内的独立证据，不是全局枚举：

```text
desired
  -> persisted
  -> applied
  -> observed
```

### 3.1 概念形状

```text
Desired<T> {
  revision,
  value,
  requested_at,
}

Persisted<T> {
  revision,
  status: Pending | Confirmed | Rejected | Failed | Unknown,
  value_or_evidence,
}

Applied<T> {
  revision,
  downstream_epoch,
  status: Pending | Confirmed | Failed | Unknown,
  evidence,
}

Observed<T> {
  source,
  observed_at,
  freshness: Fresh | Stale | Unavailable | Unknown,
  value_or_evidence,
}
```

这只是共享术语和类型约束；Domain 不能把所有 owner 的值塞进 Platform 的统一 `StatePlanes` store。

### 3.2 转换规则

```text
requested
  -> persisted confirmed / rejected / failed / unknown
  -> applied confirmed / failed / unknown
  -> observed fresh / stale / unavailable / unknown
```

严格禁止：

```text
persisted => applied
applied => runtime ready
runtime ready => connected
connected => operation succeeded
callback accepted => business succeeded
```

新的 desired revision 会使旧 revision 的 apply/readback settle 失效；旧结果不能覆盖新 desired。

### 3.3 领域适用范围

| owner | 主模型 |
| --- | --- |
| settings/security/license/connector | 通常四态，带 private projection/readback |
| OpenClaw config/channel/cron | native desired/persisted/applied/observed |
| Fleet | desired target、persisted command、applied attempt、observed endpoint/lease |
| Organization/TeamRun | durable graph/attempt/delivery/approval/evidence；effect receipt 独立 |
| Matcha session/run | peer lifecycle + event/projection；不套 generic config 四态 |
| transcript/usage | native/read-only observed source + bounded projection |
| process/Host admission | lifecycle/readiness observation，不建 desired/persisted |

## 4. CommandReceipt 与 Outcome

```text
CommandReceipt {
  command_id,
  correlation_id,
  owner_subject,
  target_identity,
  requested_revision?,
  expected_epoch?,
  accepted_stage,
  per_plane_outcome,
  attempt,
  evidence_ref?,
  recovery_query?,
  requested_at,
  terminal_at?,
}
```

内部 outcome：

```text
Confirmed  = 当前 owner oracle 确认了承诺阶段
Rejected   = 本地/授权/前置条件/native 明确拒绝
Failed     = 明确失败，且 owner 能确认失败事实
Unknown    = 请求可能已到达或副作用可能已发生，但当前无法确认
```

`Unknown` 必须保留 correlation、revision/epoch 和 query/reconcile 路径；不能自动盲重试，不能伪造 succeeded。

对外旧 job projection 只有 `queued/running/succeeded/failed`，因此 `Unknown` 不能被通用地翻译成 succeeded。每个 owner 必须定义：等待 readback、保持 running，或按原 TS 行为以 failed + safe unknown error 结束。

## 5. Peer lifecycle model

不要有 universal `RuntimeLifecycle`。至少拆为：

```text
Peer declaration
Supervisor/process phase
Transport connectivity
Protocol readiness
Host admission
Operation outcome
```

每个观察记录绑定：

```text
endpoint + generation/epoch + observed_at + last_error + source
```

以下值必须分开：Electron parent child lifecycle、Rust Host admission、Matcha app-server health、OpenClaw port reachability、Gateway connected、operation terminal。

旧 epoch 的 event/readiness/receipt 不能污染新 epoch；连接断开或 terminal readback 丢失进入 Unknown/Unavailable。

## 6. SessionProjection

这是 Host 可重建的 client projection，不是 native history authority：

```text
SessionProjection {
  session_identity,
  native_binding?,
  catalog,
  hydration_status,
  event_cursor,
  recovery_status,
  runs,
  terminal_run_ids,
  messages,
  tools,
  approvals,
  bounded_timeline,
  renderer_window,
  last_issue?,
  updated_at,
}
```

事实来源严格区分：

```text
legacy transcript JSONL  -> conversation content/recovery
app-server events.jsonl  -> runtime/protocol event facts
snapshot/index            -> peer projections/catalog
SessionProjection         -> rebuildable Host/UI projection
```

Rust 不写 transcript，不写 app-server EventStore，不把 snapshot 当 transcript，不把 `activeSessionKey` pointer 当 session facts。

### Run 投影

```text
prompt accepted
  -> submitted/queued
  -> streaming
  -> waiting_tool / waiting_approval
  -> done | error | aborted | unknown
```

terminal run 进入 terminal set；晚到 event 不能 reopen。native message id 存在时沿用；不能从 seq 推导 message id。缺少 native identity 时只能生成显式 synthetic projection key。

## 7. EventEnvelope 与 cursor

```text
EventEnvelope {
  source,
  event_id,
  session_id,
  run_id?,
  worker_id?,
  seq,
  created_at,
  payload,
}
```

验证顺序：endpoint/session → sequence → run/worker → schema/bounds → redaction → neutral projection。

cursor 规则：

| 输入 | 结果 | cursor |
| --- | --- | --- |
| wrong session | OutOfSession | 不前进 |
| seq < cursor | Stale | 不前进 |
| seq == cursor | Duplicate | 不前进 |
| seq 跳跃 | Gap | 不前进，触发 replay/readback |
| next seq | Accepted | 前进 |
| 合法 seq 但 run/payload 不匹配 | OutOfRun/Malformed | 遵循 peer adapter 已证明的消费语义，不泄漏 raw |

overflow/closed/gap 都不能当作业务成功；必须进入 recovery 或 Unknown。

## 8. JobCompatibilityProjection

兼容 projection 最小字段：

```text
id, type, status,
queuedAt, startedAt?, finishedAt?,
attempts, maxAttempts,
progress?, result?, error?
```

实现原则：

```text
具体 owner operation/task/run
  -> owner-local terminal oracle
  -> owner-local job view
  -> Host lookup multiplexer（只路由，不存事实）
  -> runtimeHost.jobGet / runtime-job:done|progress
```

不保留 queue priority、generic retry、generic retention、generic cancellation 或 generic payload store。job id 是兼容键，不是领域主键。

## 9. Foundation execution 与业务后台 operation

`foundation::execution` 是可复用的底层生命周期机制：

```text
business owner
  -> OperationHandle<T> / ServiceHandle<T>
  -> cancellation + join
  -> owner-defined result / receipt / projection
```

它与兼容 Job projection 的关系是：

```text
Foundation execution
  != RuntimeJobQueue
  != persistent job registry
  != business terminal oracle
```

Foundation 只负责 task 的启动、取消和 join；业务 owner 负责：

- operation 是否 accepted、running、completed、failed 或 unknown；
- 是否需要 progress、dedupe、retry、retention 或 recovery；
- 如何把结果映射为自己的 receipt；
- 是否需要再投影为旧 `runtimeHost.jobGet` / `runtime-job:*` 形状。

`OperationHandle<T>` 的 `Drop`/cancel 不能被解释为业务成功、失败或已撤销；需要可观察结论时，owner 必须显式 `join` 并根据自己的 oracle 发布结果。不得因为删除 Host-wide generic RuntimeJob 而删除这套 Foundation execution mechanism。

## 10. Storage 分类

- human-editable config：原有 JSON/TOML/YAML/native config；
- transcript/raw runtime payload：native JSONL/archive；
- Domain transactional state：由具体 Domain 选择并拥有其 transactional store；
- artifact/archive：filesystem/blob owner；
- secret：private resolver/OS keychain；
- Host projection：可重建内存状态，不能变成第二 durable source。

不能为了 Rust 方便把 config、transcript、receipt、artifact、secret 统一塞进一个 SQLite 或 Host state file。
