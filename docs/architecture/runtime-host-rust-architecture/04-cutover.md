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
- DirectRuntimeHost/direct transport 与 `/dispatch` 的替代关系；
- 每个 owner 的旧 writer 删除条件。

此 block 完成前不再扩展 Rust 业务目录。

## Block 1：Rust child Delivery compatibility

Rust 先成为一个可被 Electron 以既有方式调用的 child，不先迁移业务：

```text
/health
/dispatch
/lifecycle/restart
/lifecycle/stop
parent callbacks
```

必须验证：

- v1 envelope success/failure；
- 1 MB body / 413；
- 30s/3s/15s/3s timeout；
- malformed response、404、500、503；
- parent token/version/content-type；
- event best-effort 与 owner/facade typed query recovery；
- Electron main-owned route、CLI、webhook、Fleet ingress、terminal WS 不串 owner。

这一步不删除 Electron 的 Rust child process manager；它只替换 child server/owner 的实现。Electron 仍负责该 child 的桌面 lifecycle。

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

- child `/health` 与 application health 分层；
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
5. skills/plugins/provider/toolchain 等各自 operation owner；Toolchain prepare 走 dedicated Host path：Renderer `hostToolchainPrepare()` → Electron `/api/toolchain/uv/prepare` → Rust private `host.toolchain.prepare` → `runtime-host/external/toolchain::NativeToolchain`，并等待真实结果。

每个 operation 必须拆开 config write、apply、ready、observed 和 terminal outcome；不能由 Host 或已删除的 Host-wide generic operation queue 代管。

## Block 6：Environment 子 owner

Environment 不是 generic config owner。以下 owner 分别闭合：

- connector desired/persisted/applied/global probe/session status；
- provider account/model/routing/private auth；
- settings desired/private OpenClaw projection/Gateway apply；
- security policy/plugin apply/audit/enforcement；
- license 产品面已退休，不再作为 Environment owner 迁移；
- toolchain verify/prepare result。

各 owner 处理自己的 schema migration、secret boundary、Unknown/readback 和 typed operation projection。Toolchain prepare 等需要真实业务结果的调用必须等待 native terminal result；只有 accepted-only operation 才返回 owner-local operationId，并由具体 owner/facade typed operation query/event 恢复。不能把它们合并为一个 `EnvironmentState`。

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
