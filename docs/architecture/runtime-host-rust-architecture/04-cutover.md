# 04. Owner cutover 顺序

本顺序是依赖顺序，不是“当前已完成”清单。每个 block 都必须在不改 Renderer/Electron public API 的前提下闭合；未闭合时保持旧 owner 或明确不可用，不增加双写/fallback。

## Block 0：架构与契约冻结

输入：

- [contract baseline](../../runtime-host-contract-v1/README.md)；
- [owner/state model](../../runtime-host-owner-model/README.md)；
- 本目标架构及分解文档。

输出：

- route ownership matrix；
- operation → owner → state source → projection matrix；
- DirectRuntimeHost private control、signed loopback product routes 与已删除 root compatibility 的替代关系；
- 每个 owner 的旧 writer 删除条件。

此 block 完成前不再扩展 Rust 业务目录。

## Block 1：Rust child Delivery final form

Rust child 的 active delivery 面直落为：

```text
DirectRuntimeHost bootstrap/private control
signed loopback product routes
Electron-owned child stop/restart
parent callbacks
```

旧 root `/health`、`/dispatch`、`/lifecycle/restart`、`/lifecycle/stop` compatibility island 已删除，不再作为迁移目标。

必须验证：

- bootstrap frame、private control ready、unknown command rejection；
- `host.health` / `host.runtime.snapshot` redaction；
- signed route decision binding、expiry、replay/mismatch rejection；
- product route 30s/default deadline 或 route-local deadline；
- parent token/version/content-type；
- event best-effort 与 owner/facade typed query recovery；
- Electron main-owned route、CLI、webhook、Fleet ingress、terminal WS 不串 owner。

这一步不删除 Electron 的 Rust child process manager；Electron 仍负责该 child 的桌面 lifecycle。

## Block 2：Foundation + peer lifecycle composition

实现 Foundation process mechanism 和两个已有 peer Integration 的具体 policy：

```text
Foundation mechanism
  + OpenClaw lifecycle policy
  + matcha-agent lifecycle policy
  + Host start dependency / shutdown order
```

必须证明：authority、readiness、graceful stop、crash/restart、late result、epoch、shutdown/join 和日志/secret redaction。三平台机制只能以实际支持矩阵结算，不以当前宿主的 unit test 代替。

## Block 3：Host health、events、diagnostics projection

先闭合 Rust Host 的最小安全 projection：

- Host private health 与 application health 分层；
- Host admission 与 peer health 分层；
- safe events、parent callback、host:event；
- diagnostics archive/receipt/download；
- 不泄漏 PID、argv、path、secret、raw native payload。

Rust `HostState.ok` 只能表示 Host admission 语义，不能表示 peer running 或 Gateway connected。

## Block 4：Matcha session read/hydration projection

优先迁移只读 session/hydration 链路：

```text
Renderer session/history request
  -> Rust compatibility transport
  -> Matcha Integration protocol client
  -> native transcript/snapshot/replay
  -> SessionProjection
  -> old response/event shape
```

必须先闭合：

- legacy JSONL 与 app-server events 的双源模型；
- endpoint + agentId + sessionKey；
- endpointSessionId binding；
- run/message/seq crosswalk；
- hydration/window/large transcript limit；
- event gap/overflow/closed recovery；
- current Renderer `session:update`、snapshot/state consumer；
- Rust 当前 `run_id/sequence` 为空的问题。

不得迁移 transcript writer，也不得以 Rust projection 替换 peer native history owner。

## Block 5：OpenClaw native operations

按 native owner 迁移，而不是按 route 文件迁移：

1. config/private projection 与 readback；
2. Gateway health/connection/lifecycle；
3. channel config/live/login/pairing；
4. cron definitions/run/receipt/history；
5. skills/plugins/provider/toolchain 等各自 operation owner；Toolchain prepare 走 dedicated owner path：Renderer `hostToolchainPrepare()` → Electron `/api/toolchain/uv/prepare` → `toolchainTransport.prepare()` → modules/toolchain owner loopback → `runtime-host/modules/toolchain::NativeToolchain`，并等待真实结果。

每个 operation 必须拆开 config write、apply、ready、observed 和 terminal outcome；不能由 Host 或已删除的 Host-wide generic operation queue 代管。

## Block 6：独立产品 owner modules

以下能力由已有 `modules/` owner 分别闭合，不设 Environment 聚合 owner：

- `modules/connectors`：desired/persisted/applied/global probe/session status；
- `modules/provider`：account/model/routing/private auth；
- `modules/settings`：desired/private OpenClaw projection/Gateway apply；
- `modules/security`：policy/plugin apply/audit/enforcement；
- license 产品面已退休，不再迁移；
- `modules/toolchain`：verify/prepare result。

各 owner 处理自己的 schema migration、secret boundary、Unknown/readback 和 typed operation projection。Toolchain prepare 等需要真实业务结果的调用必须等待 native terminal result；只有 accepted-only operation 才返回 owner-local operationId，并由具体 owner/facade typed operation query/event 恢复。不能把它们合并为一个 `EnvironmentState`。无消费者的旧 `domains/environment` crate 与聚合 revision/grant/reconciliation 模型退役，不建立 `modules/environment`；这不等于本 block 的功能或 cutover 验证完成。OpenClaw `crate::environment` 安装检查与 Fleet environment 生命周期保留。

## Block 7：Fleet

先闭合已证明的 topology、endpoint identity、capacity lease、durable command/reconcile。然后分别证明：

- remote terminal WebSocket；
- runtime-agent ingress/auth/heartbeat；
- webhook/remote worker；
- command replay/audit/outcome unknown；
- artifact/credential/secret boundary。

没有相应 producer/consumer/oracle 就不把 remote executor 或 artifact producer写成已完成 owner。

## Block 8：Organization / TeamRun

Organization 独占 Team/TeamRun：

- graph；
- attempt；
- delivery；
- approval；
- evidence；
- trigger；
- role-session delivery；
- webhook/materialization lifecycle；
- native terminal receipt 与 outcome unknown。

OpenClaw/Matcha 只实现 typed effect port；Host actor 不拥有 TeamRun ledger。

## Block 9：删除旧 owner并完成 package cutover

只有满足以下条件，才能删除对应 TS owner：

1. unchanged Renderer/Electron trace 已通过；
2. Rust active path 唯一可达；
3. durable/native source 只有一个 writer；
4. old route、error、timeout、event、typed operation projection 已覆盖；
5. restart/crash/timeout/Unknown/recovery 已覆盖；
6. package artifact、启动、停止、权限和 secret negative evidence 已通过；
7. old TS import/registration/fallback/dual write residual scan 为空；
8. 对应 technical-gate attestation 和 migration ledger 已记录。

## 禁止的“迁移完成”替代品

- Rust crate 能编译；
- Rust transport 能启动；
- 一个 Windows unit test 通过；
- Electron 加一个 fallback；
- TS/Rust 双写；
- event 发出但没有 query recovery；
- config 写成功就宣称 runtime ready；
- typed operation accepted 就宣称 native operation succeeded。
