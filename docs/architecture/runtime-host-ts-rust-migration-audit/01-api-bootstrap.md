# API / Bootstrap 分片：TS → Rust 文件级审计

> 审计日期：2026-07-11。此分片只记录当前工作树中 `runtime-host/api/**`、`runtime-host/bootstrap/**` 与 `runtime-host/main.ts` 的事实；未修改任何源代码或测试。这里的 HTTP/RPC、路由表、JSON 包装和进程入口都是 **Delivery / transport**，不是 Matcha Platform Core 的业务事实源。Capability/Scope/Execution 语法的实际领域归属可在其下游为 Platform Core；Session、Fleet、TeamRun 等业务事实仍归各自 Domain Module；对 OpenClaw 等的具体实现归 Runtime Integration 或 Native Runtime Edge。

## 已读文件（当前存在，Python 枚举；37 个）

```text
runtime-host/api/common/http.ts
runtime-host/api/dispatch/dispatch-envelope.ts
runtime-host/api/dispatch/dispatch-route-handler.ts
runtime-host/api/dispatch/runtime-route-dispatcher-types.ts
runtime-host/api/dispatch/runtime-route-dispatcher.ts
runtime-host/api/dispatch/runtime-route-index.ts
runtime-host/api/routes/capability-routes.ts
runtime-host/api/routes/capability-routing-routes.ts
runtime-host/api/routes/channel-routes.ts
runtime-host/api/routes/clawhub-routes.ts
runtime-host/api/routes/cron-routes.ts
runtime-host/api/routes/external-connector-routes.ts
runtime-host/api/routes/file-routes.ts
runtime-host/api/routes/gateway-routes.ts
runtime-host/api/routes/license-routes.ts
runtime-host/api/routes/openclaw-routes.ts
runtime-host/api/routes/platform-routes.ts
runtime-host/api/routes/plugin-runtime-routes.ts
runtime-host/api/routes/provider-models-routes.ts
runtime-host/api/routes/provider-routes.ts
runtime-host/api/routes/remote-fleet-routes.ts
runtime-host/api/routes/remote-fleet-runtime-agent-ingress-route.ts
runtime-host/api/routes/route-utils.ts
runtime-host/api/routes/runtime-host-routes.ts
runtime-host/api/routes/runtime-topology-routes.ts
runtime-host/api/routes/security-routes.ts
runtime-host/api/routes/session-routes.ts
runtime-host/api/routes/settings-routes.ts
runtime-host/api/routes/skills-routes.ts
runtime-host/api/routes/subagent-routes.ts
runtime-host/api/routes/team-runtime-webhook-routes.ts
runtime-host/api/routes/toolchain-uv-routes.ts
runtime-host/api/routes/workbench-routes.ts
runtime-host/bootstrap/runtime-config.ts
runtime-host/main.ts
runtime-host/main-cli.ts
runtime-host/host-process.cjs
```

## 调用链与明确排除项

- **已用 CodeGraph 定位的链：** `runtime-host/main.ts` → `createRuntimeHostProcess`（composition root）→ route registry 的 `dispatcher` → `createRuntimeRouteDispatcher`；HTTP server 将 `/dispatch` 交给 `handleDispatchRoute`，将 TeamRun webhook 与 remote-fleet agent ingress 交给两个专门 handler。`runtime-host/composition/runtime-host-server.ts`、`runtime-host/composition/runtime-host-composition.ts`、`runtime-host/composition/route-registry.ts` 仅作为调用链证据读取，不属于本分片逐文件审计范围。
- **明确排除：** `runtime-host/application/**`、`runtime-host/composition/**`、`runtime-host/shared/**`、`runtime-host/infrastructure/**` 及其测试，均在用户划定范围外；它们不是遗漏。`api/` 和 `bootstrap/` 下没有当前存在的非 `.ts`/`.cjs` 文件；根目录的 `host-process.cjs` 是 Node loader，已纳入本分片。构建产物、依赖目录、测试输出和生成文件亦不在生产源审计范围内。
- **测试证据范围：** 本分片没有读取测试源；CodeGraph 指出 `tests/unit/runtime-host-process-dispatch-envelope.test.ts` 覆盖 envelope、`tests/unit/runtime-host-process-dispatch-route-handler.test.ts` 覆盖 dispatch handler、`tests/unit/team-trigger-webhook-route.test.ts` 覆盖 TeamRun webhook，route registry 有 framework / implementation-boundary 测试。未由该证据确认的结论标为“待补 oracle”，不将其视作已闭环。
- **通用 C/Q/Event 语义：** `GET` 路由为 Query 的 HTTP 投影；`POST`/`PUT` 路由为 Command 或兼容入口，不能从方法名推断业务 owner；webhook/agent ingress 是 Event ingress。除 webhook 的 `team.webhookTriggerFire` 明确接收 `idempotencyKey` 与 body hash 外，本分片没有实现通用幂等、队列、取消、重试或业务状态机。`routeResponder` 将成功包装为 `ApplicationResponse`，但不存储业务事实。

---

### runtime-host/api/common/http.ts

- **当前 owner：** Delivery 的无状态 HTTP 序列化/URL 规范化 helper；不拥有 Platform Core、路由或业务状态。
- **职责与关键 symbols：** `sendJson` 设状态和 JSON UTF-8 header 后 `end`；`normalizeRoutePath` 去 query；`parseRouteUrl` 把非 `/` 前缀输入补成绝对 URL 所需路径。
- **旧语义与策略：** `sendJson` 使用原生 `JSON.stringify`（`undefined` 会传给 `end`，非 JSON 特殊值遵 Node/JSON 行为）；route 为 falsy 时变空串；`normalizeRoutePath` 只按第一个 `?` 截断，不解码、不校验；`parseRouteUrl` 固定虚拟 origin `runtime-host.local`，保留 query 供 Query handler 使用。
- **状态、存储与副作用：** 无持久/内存状态；唯一副作用为写 HTTP response。
- **并发与性能特征：** 每请求 O(n) 字符串分割/URL 解析及一次 JSON 序列化；无锁、无队列、无背压。
- **调用/依赖边界：** dispatch、专用 ingress、composition HTTP server 使用；是 transport helper，不调用 application service。
- **故障、恢复与安全：** 不捕获 `JSON.stringify`（循环对象会向上抛）；不自行 redaction 或 content negotiation，调用者须先投影 secret。
- **迁移分类：** **Preserve：** `application/json; charset=utf-8`、query/path 处理及写出顺序。**待验证：** 是否依赖 `undefined`/非 JSON 值的 Node 响应语义；不应无证据改变。
- **未来 Rust owner：** **Delivery**（HTTP response/URL adapter）。
- **Rust 重写与性能判断：** 使用框架 JSON responder 与 URL parser，避免手拼响应；保留 JSON 表示和固定 path 语义。无重复扫描以外的已证实成本，不主张“极致优化”；量测序列化延迟、分配和错误响应一致性。
- **验证 oracle：** HTTP fixture：query route、空/非 `/` route、JSON header、循环值失败路径；与现有 dispatch/webhook 响应差分。
- **证据：** 本文件 `sendJson`/`normalizeRoutePath`/`parseRouteUrl`；`dispatch-route-handler.ts`、两个 ingress route 的调用。

### runtime-host/api/dispatch/dispatch-envelope.ts

- **当前 owner：** Delivery 的内部 RPC `/dispatch` envelope validator；不拥有下游 Command 的领域输入。
- **职责与关键 symbols：** 以 `DISPATCH_ENVELOPE_MAX_BODY_BYTES = 1_000_000` 限制 UTF-8 raw body，解析 `version/method/route/payload`，产出带 HTTP 400/413 的判别结果。
- **旧语义与策略：** 空 body 先变 `{}`；严格等于 `TRANSPORT_VERSION`；method 必须为 `REQUEST_METHODS` 成员；route 必须是以 `/` 开头的 string；`payload` 可为任何 JSON 值或缺失。body 限制按 UTF-8 byte 而非字符数；JSON grammar 本身委托 `JSON.parse`。
- **状态、存储与副作用：** 纯函数，无副作用；raw JSON 只转换为 `unknown` payload。
- **并发与性能特征：** 单次 `Buffer.byteLength` O(n) 加一次 JSON parse O(n)，无共享可变状态。
- **调用/依赖边界：** `/dispatch` handler 在已收集 raw body 后调用；常量来自 shared transport contract；成功值进入 route dispatcher。
- **故障、恢复与安全：** 过大返回 413；版本/method/path 不合规返回 400；畸形 JSON 抛 `SyntaxError` 由 handler 映射 400。**缺陷：** 合法 JSON `null` 使 `parsed.version` 解引用 `null`、抛 TypeError，handler 目前映射为 500 而非输入 400；代码可直接证明此路径，Rust 应用 object guard 后以 400 `BAD_REQUEST` 替代，兼容影响是修正错误分类。无 token/secret 使用。
- **迁移分类：** **Preserve：** 1,000,000-byte 限制、version/method/`/` route 拒绝、payload 原样转交。**Intentional Improvement：** `null`、array/primitive 统一先判断 JSON object，避免内部错误泄露为 500。**Defect：** `null` 的 500 映射。
- **未来 Rust owner：** **Delivery**（私有 HTTP/RPC transport schema）；Capability 的后续 grammar 不由该文件拥有。
- **Rust 重写与性能判断：** 流读取层先 byte-limit，随后反序列化到 envelope DTO（`payload: serde_json::Value`）；保留 raw JSON 语义。可消除 TS 当前“流层累计一次 + 本函数再 `byteLength` 一次”的重复 O(n) 计数；量测 p95 parse 延迟、峰值内存、413/400 差分 oracle。
- **验证 oracle：** CodeGraph 指向 `tests/unit/runtime-host-process-dispatch-envelope.test.ts`；补充空、畸形、`null`、超限 UTF-8、多字节、非法版本/method/route 的 table test。
- **证据：** 本文件 3–79 行；`dispatch-route-handler.ts` 91–103、160–176。

### runtime-host/api/dispatch/dispatch-route-handler.ts

- **当前 owner：** Delivery 的 `/dispatch` streaming body 接收、RPC 包装、transport metrics/logging owner；不拥有被调路由的业务副作用。
- **职责与关键 symbols：** `readRequestBody` 有界聚合 raw bytes；`handleDispatchRoute` 验 envelope、调用 injected dispatcher、统一包 `{version,success,status,data|error}`；trace 与 5s/10s pending warning；`TransportStats` 五个累计计数。
- **旧语义与策略：** 流 chunk 非 Buffer 时 `String` 再转 Buffer；超 1 MB 立即清 chunks/reject，之后 data 忽略；成功 body `.trim()` 后 parse。每已读完整/合法或不合法 envelope 都增加 total；handler 有 response 则成功，`null` 为 404。只在路由执行期间安装两个 unref timer，`finally` 必清。raw/JSON 层不检验 `Content-Type`，仅依 envelope JSON。无 retry/cancel/timeout，挂起只记录警告。
- **状态、存储与副作用：** 每请求 chunks/timers/trace；全局注入 metrics 原地递增；写 response、输出日志；无文件/数据库。
- **并发与性能特征：** 请求间并发，Node event loop 上各自缓冲最多 1 MB；`Buffer.concat` 与 JSON parse 线性；metrics 是单线程进程内计数，不跨进程原子/持久。timer `unref` 不阻止退出。
- **调用/依赖边界：** composition server `/dispatch` 调用；依赖 envelope 和 injected `dispatchRuntimeRoute`，下游为 `createRuntimeRouteDispatcher`→registry/服务。
- **故障、恢复与安全：** SyntaxError→400/BAD_REQUEST、超限→413/PAYLOAD_TOO_LARGE、其余读取/路由/序列化故障→500/INTERNAL_ERROR；`String(error)` 原样返回，可能泄露下游错误信息；无 token 检查，安全边界应由 loopback/deployment 与各 capability authorization 证明，当前本文件未证明。try/finally 防止 pending timer 泄漏。
- **迁移分类：** **Preserve：** body 限制、404 null-dispatch、metrics、5s/10s observability 和 timer cleanup、响应 envelope。**Intentional Improvement：** 在 Rust transport 中将内部 error 映射为稳定公开消息、完整错误仅日志；兼容影响为减少公开细节。**Defect：** 延续 envelope 的 JSON `null` 误报 500，见上条。
- **未来 Rust owner：** **Delivery**；metrics 的长期监测机制可由 **Foundation Kernel** 提供，但此路由的计数投影不是 Kernel 业务 owner。
- **Rust 重写与性能判断：** 使用受限 body extractor/stream，直接累计字节并反序列化，维持 1 MB、无重试和 pending alarm；可去除拼接后 `byteLength` 的重复扫描。测 body-size 拒绝前读取量、并发请求内存、p95/99、timer 清理和 metrics 增量。
- **验证 oracle：** CodeGraph 指向 `tests/unit/runtime-host-process-dispatch-route-handler.test.ts`；补 fault injection（stream error、下游 throw、null JSON）和 5/10 秒 fake clock/log oracle。
- **证据：** 本文件 33–195；CodeGraph `runtime-host/composition/runtime-host-server.ts` 135–141。

### runtime-host/api/dispatch/runtime-route-dispatcher-types.ts

- **当前 owner：** Delivery 的路由调度类型契约（纯 type owner）。
- **职责与关键 symbols：** `RuntimeRouteRequest` 携带原 method/raw route/payload、pathname 与 URL；handler 可同步/异步并以 `null` 表示不处理；matcher 为 exact/prefix/RegExp pattern；entry 有 key/method/matcher/handle。
- **旧语义与策略：** `null` 是 fallback/404 控制流，不是成功空数据；path 与 routeUrl 同时保留，query 只在 URL；类型不约束 HTTP method、matcher 合法性或 payload schema。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 类型层无运行成本；其 `null` short-circuit 使 dispatcher 可串行尝试候选。
- **调用/依赖边界：** dispatcher/index 与 composition route registry 的公共内部契约；response alias 到 application `ApplicationResponse`，但不拥有其语义。
- **故障、恢复与安全：** 无运行时输入验证、secret、恢复或并发控制；这些必须在 transport/parser/route 服务完成。
- **迁移分类：** **Preserve：** exact/prefix/pattern 和 `null` fallback 语义。**待验证：** 外部是否把 handler key 当稳定诊断标识；不能擅自公开。
- **未来 Rust owner：** **Delivery**（内部 router contract）。
- **Rust 重写与性能判断：** enum matcher、request context 与 `Option<Response>`；不需要 actor/storage。应测路由选择和 fallback 顺序，而非声称性能提升。
- **验证 oracle：** registry fixture：exact success/null、prefix/pattern fallback、query context；CodeGraph route-registry test 线索待读取闭环。
- **证据：** 本文件 1–29；`runtime-route-dispatcher.ts`、`route-utils.ts`。

### runtime-host/api/dispatch/runtime-route-dispatcher.ts

- **当前 owner：** Delivery 的 index-to-handler dispatch orchestration；无业务 owner。
- **职责与关键 symbols：** `createRuntimeRouteDispatcher` 接受 entry array 或预建 `RuntimeRouteIndex`，parse URL，构建 request，优先 exact，随后依 index 顺序尝试 fallback，全部 `null` 时返回 `null`。
- **旧语义与策略：** array 时只在创建 dispatcher 时构建 index；exact handler 即便返回 null 也会继续 fallback；fallback 按 index 提供的 declaration order 串行 `await`，第一个非 null 胜出；handler throw 不吞没，交给 dispatch handler→500。
- **状态、存储与副作用：** closure 持有只读 route index；每请求创建 URL/context；无 I/O。
- **并发与性能特征：** 并发请求共享只读 Map；exact 近 O(1)，fallback 由 index filter/sort 决定；同请求候选串行，故有 side effect 的 fallback 不可并行化。
- **调用/依赖边界：** CodeGraph 链为 composition process→registry dispatcher→本函数；下游 entry handler 通常是 `route-utils` definition adapter。
- **故障、恢复与安全：** URL 构造异常、handler 异常向上传播；没有 auth/redaction，因为它只是 transport routing；没有 retry/cancel。
- **迁移分类：** **Preserve：** exact-before-fallback、exact-null 后继续、串行 declaration order、null 代表未处理。**待验证：** 是否有 handler 有意 exact-null 后由 pattern 接手；必须以 registry fixture 覆盖。
- **未来 Rust owner：** **Delivery**。
- **Rust 重写与性能判断：** immutable router table + `Option<Response>`；保持候选逐个 await，不能为“性能”并行而改变副作用顺序。测 exact、prefix、pattern 各路由吞吐与 handler execution order。
- **验证 oracle：** index/dispatcher table test 与完整 `/dispatch` fixture；CodeGraph 的 composition/route registry 调用链。
- **证据：** 本文件 17–42；`runtime-route-index.ts` 42–97。

### runtime-host/api/dispatch/runtime-route-index.ts

- **当前 owner：** Delivery 的只读 route index 与冲突检测 owner。
- **职责与关键 symbols：** per-method Map：exact path Map、按首 path segment 的 prefix bucket Map、pattern list；`from` 在启动构建；`fallbackCandidates` 返回匹配 prefix 与 pattern 的 registration order。
- **旧语义与策略：** duplicate **exact** path 同 method 在启动抛错（带两个 key）；prefix 不去重；空首 segment bucket 始终加，当前首段 bucket 再加；候选只接受 `startsWith(prefix)`；pattern 每次 reset `lastIndex=0` 防 global/sticky RegExp 漂移；混合候选按最初 order sort。prefix 不按最长优先。
- **状态、存储与副作用：** 构建后 Map/array 只读；启动阶段可能 throw，运行时无 I/O。
- **并发与性能特征：** 构建 O(H)（排序发生于每次 fallback）；exact O(1)；fallback 对两个 buckets 加全部 patterns filter 后 O(P + C log C)，而非全 handler 扫描。无锁，安全前提是 immutable。
- **调用/依赖边界：** dispatcher 接受 index；composition registry 从 route definitions 建 entry；是 API transport，不拥有 route 所代表领域。
- **故障、恢复与安全：** 只防 exact collision；pattern/prefix overlap 是有意按 order 解析。无 input/secret/retry。
- **迁移分类：** **Preserve：** duplicate exact fail-fast、空 bucket、prefix/pattern registration-order、RegExp reset 等微观选择。**待验证：** prefix overlap 是否应改最长匹配；当前无证据，不可改。
- **未来 Rust owner：** **Delivery**。
- **Rust 重写与性能判断：** `HashMap<Method, MethodIndex>`，exact HashMap、首段 prefix buckets、ordered pattern vec；避免每请求排序可在构建期预排序/稳定 merge，但必须保持跨 prefix/pattern 原始 order。旧成本为每次 fallback sort；测注册表规模下 p95、候选数和内存，差分比较顺序。
- **验证 oracle：** duplicate exact startup test、global regex 重复请求、empty-prefix、prefix/pattern cross-order、exact-null fallback；CodeGraph 未发现本类直接覆盖，需补。
- **证据：** 本文件 14–97；`runtime-route-dispatcher.ts` 17–41。

### runtime-host/api/routes/capability-routes.ts

- **当前 owner：** Delivery 的 capability HTTP/RPC adapter；不拥有 capability state。其 `id/scope/target/operationId` grammar 的实际语义属于 **Matcha Platform Core**，执行和业务事实仍在下游 capability/domain/runtime service。
- **职责与关键 symbols：** list/describe/execute 三路；`readCapabilityScopeRequest`、`readCapabilityExecuteRequest` 对 payload object 取值并调用 `validateRuntimeScope`/`validateCapabilityTarget`。
- **旧语义与策略：** list 是 Query；describe/execute 为 POST Command；id 和 operationId 必须非空 trim（但返回原未 trim 字符串）；scope 必验证；明确拒绝 caller supplied `runtimeAddress`，target 缺省为 null，`input` 可以任意/缺失。service 异常经 `routeResponder` 成 500；execute 直接保留下游 `ApplicationResponse`（包括其状态/data）。
- **状态、存储与副作用：** route 无状态；execute 可能触发下游命令，adapter 本身不写状态。
- **并发与性能特征：** O(1) shallow record/read validation；并发、幂等、取消、排队由下游 capability execution owner 决定，当前未提供。
- **调用/依赖边界：** `CapabilityRouteService` 为 injected port；依赖 runtime-address validators 和 route responder；由 registry 注册后经 `/dispatch` 进入。
- **故障、恢复与安全：** object 以外 payload 变 `{}`，得到 400 required error；禁止 runtimeAddress 防调用方越过 server-side addressing；不暴露 provider/token；没有权限校验或 idempotency key，是否由下游执行层落实待验证。
- **迁移分类：** **Preserve：** 输入 reject、target null、`runtimeAddress` 禁令、list/describe Query 与 execute Command 投影。**Intentional Improvement：** Rust DTO 可 trim-normalize id/operationId，但须先确认下游是否把空白当身份；当前只能待验证。
- **未来 Rust owner：** HTTP endpoint 为 **Delivery**；Capability/Scope/Execution contract 为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** typed request enum/serde `Value` input，保留 unknown payload；无需持久/actor。优化只应消除重复 record casts；测 validation/error JSON 和 execute receipt/status 差分。
- **验证 oracle：** table：non-object、空 id/op、bad scope/target、runtimeAddress、null target；capability service spy 验证没有在 400 情况调用。
- **证据：** 本文件 17–91；`route-utils.ts` 87–180。

### runtime-host/api/routes/capability-routing-routes.ts

- **当前 owner：** Delivery 的单一 capability-routing Query 投影；不拥有 route policy/state。
- **职责与关键 symbols：** `GET /api/capability-routing`，通过 `routeResponder.value` await injected `read()`。
- **旧语义与策略：** 无 payload/query 输入解释；成功一律 `ok(data)`；服务 throw 映射 500。无 Command/Event、重试或缓存。
- **状态、存储与副作用：** 无状态；下游 read 的实际 I/O 不在本文件。
- **并发与性能特征：** 一请求一次 async read，无合并/缓存/锁。
- **调用/依赖边界：** route registry 注入 `capabilityRoutingService`；将下游的 routing view 变 HTTP JSON。
- **故障、恢复与安全：** 无边缘 input、secret redaction 或 authorization；下游 projection 必须承担敏感数据契约，当前待验证。
- **迁移分类：** **Preserve：** GET Query、异常→500 wrapper。**待验证：** routing view 是否公开/含 secret。
- **未来 Rust owner：** **Delivery**（endpoint）；被读 routing policy 依实际模型归 **Matcha Platform Core** 或 Domain Module，不能由此 API 归 Core。
- **Rust 重写与性能判断：** direct async Query handler，无特别数据结构；量测下游 read 和 JSON 序列化。
- **验证 oracle：** success/throw HTTP contract，service spy；对返回体 secret scan。
- **证据：** 本文件 6–20；`route-utils.ts` 150–180。

### runtime-host/api/routes/channel-routes.ts

- **当前 owner：** Delivery 的 channel Query/validation adapter；channel 配置/credential 事实属于相关 Domain Module/Native Runtime Edge，不属于本路由。
- **职责与关键 symbols：** snapshot、配置/凭证 validation、pairing query；旧 config read pattern 显式 400 disabled；`channelValidationError` 规定 validation 失败 data shape。
- **旧语义与策略：** validation service throw 也返回 HTTP 500 但 data 为 `{success:false,valid:false,errors:[message],warnings:[]}`；pairing path 以 `([^/]+)` 捕获并 `decodeURIComponent`，accountId query 空串变 undefined，结果经 read-only sanitizer；legacy config `/config/(.+)` 无条件拒绝。raw payload 未在本层 schema 验证，交服务。
- **状态、存储与副作用：** route 无状态；snapshot/read Query，validation 名义为 Command-like probe，具体副作用待下游证明。
- **并发与性能特征：** O(1) regex/URL lookup；sanitize 深度复制返回体 O(n)，没有缓存/锁。
- **调用/依赖边界：** injected channel service；依赖 route sanitizer/decode；注册为 dispatch handler。
- **故障、恢复与安全：** read-only pairing redacts通用 token/secret fields；validation output 未在此文件 redaction。**Defect：** malformed percent encoding 在 `decodeRouteParam` 抛出，经 responder 成 500 而非 400（共享 helper 证据见 `route-utils.ts`）；修复须统一改变。无 retry/idempotency。
- **迁移分类：** **Preserve：** validation error object、accountId 空值、legacy config 禁用、pairing redaction。**Intentional Improvement：** invalid percent path parameter→400，见共享 Defect。
- **未来 Rust owner：** **Delivery**；实际 channel state 为 **Domain Module**，runtime-specific channel adapter 为 **Native Runtime Edge/Runtime Integration**。
- **Rust 重写与性能判断：** framework path/query extractor 应 decode-fail 400；保留 sanitizer 深度行为。测 pairing response redaction、validation failure data、legacy rejection。
- **验证 oracle：** route table、invalid URI encoding、recursive secret fields、service throws；手工/fixture 不应出现 credential。
- **证据：** 本文件 22–62；`route-utils.ts` 98–131、139–177。

### runtime-host/api/routes/clawhub-routes.ts

- **当前 owner：** Delivery 的 ClawHub search Command/Query transport adapter（POST 是现有兼容形状）；搜索/目录事实不在本文件。
- **职责与关键 symbols：** `POST /api/clawhub/search`，以 `readRecord(payload)` 将 object 或 `{}` 交 `clawHubService.search`，成功回 `{success:true,results}`。
- **旧语义与策略：** 不验证具体 filter/query；非 object 被静默降为 `{}`；直接 `await` 写在 handler，服务 throw 向 dispatcher 冒泡，最终 `/dispatch` 500（不像 routeResponder 的局部映射）。
- **状态、存储与副作用：** route 无状态；下游 search 可能网络 I/O，未由本文件证明。
- **并发与性能特征：** O(1) shallow cast；无 timeout/cache/retry/limit。
- **调用/依赖边界：** injected ClawHub port；不经 `routeResponder`，仍以统一 dispatch transport envelope 包裹。
- **故障、恢复与安全：** 不处理 token/secret；raw body 已由 dispatch envelope parse。缺少输入 schema/limit是**待验证**是否由 service 承担，不能判 defect。
- **迁移分类：** **Preserve：** record-only projection、成功 data 结构、抛错到 transport 500。**待验证：** POST 是否是业务 Command 或 legacy search transport，不能换 GET。
- **未来 Rust owner：** **Delivery**；ClawHub integration 实际归 **Runtime Integration/Native Runtime Edge**（取决于下游实现）。
- **Rust 重写与性能判断：** `serde_json::Map`/空 object fallback；不引入 cache。测 malformed/non-object、service error、search result JSON。
- **验证 oracle：** service spy 的 `{}` fallback、HTTP result envelope；查询输入 schema 需从下游补。
- **证据：** 本文件 7–24；`route-utils.ts` 87–91。

### runtime-host/api/routes/cron-routes.ts

- **当前 owner：** Delivery 的 cron/usage Query adapter；任务调度状态、历史和作业 owner 不在 API。
- **职责与关键 symbols：** recent usage 传 payload 和 URL；jobs 无输入；session-history 直接保留 application response。
- **旧语义与策略：** 三者均 GET（甚至 usage 将 dispatch payload 传下游）；search params 完整保留给 service；`value` 将 raw value 包成 200，`result` 保留 status/data；无边缘 validation/分页限制。
- **状态、存储与副作用：** route 无状态；Query 应只读，实际下游 I/O/状态由 cron/session domain 负责。
- **并发与性能特征：** 一次 service 调用；无 lock/cache/backpressure。
- **调用/依赖边界：** injected `cronService`，由 route utils 统一错误→500；session-history response 的 error mapping 可跨过 `ok` 包装。
- **故障、恢复与安全：** 本层不 sanitize、无 token/secret policy；usage/jobs/history 的公开字段需下游 oracle。无 retry/cancel。
- **迁移分类：** **Preserve：** GET URL/query forwarding、`result` 对 application status 的保留。**待验证：** GET payload 的消费者与是否会泄露 session data。
- **未来 Rust owner：** **Delivery**；cron/job state 多为 **Domain Module**，调度原语可为 **Foundation Kernel**。
- **Rust 重写与性能判断：** direct Query adapters；不以 Rust 迁移引入 cache。测 URL/query、status passthrough 和 read-only behaviour。
- **验证 oracle：** job/history fixtures、service errors、secret scan；下游 cron tests 待读取。
- **证据：** 本文件 7–33；`route-utils.ts` 150–177。

### runtime-host/api/routes/external-connector-routes.ts

- **当前 owner：** Delivery 的 external-connector API facade；连接配置/状态的事实不由此拥有。
- **职责与关键 symbols：** list/programs/status Query 及 probe/session-status/get/upsert/remove POST，所有 service `ApplicationResponse` 经 `result`，并做 read-only sanitizer。
- **旧语义与策略：** 所有八路（包括 mutation-looking upsert/remove）都对 response 深递归 redaction；payload 原样下传，无 HTTP schema validation、idempotency 或 method-level authorization。`result` 保留 service status/data；throw→500。
- **状态、存储与副作用：** route 无状态；后三类可能 Command/写配置，实际副作用在 service。
- **并发与性能特征：** 每个 response sanitizer 全树 clone/filter O(n)，数组 map；无 serialization/lock，写竞争依服务。
- **调用/依赖边界：** injected connector service；共享 sanitizer 过滤 token/secret/log/output 等默认字段。
- **故障、恢复与安全：** read-only 名称不等于 Query：它只指 response redaction，不能误判 upsert/remove 无副作用。没有 request secret redaction（不得日志 payload 由 caller约束）；无 retry。
- **迁移分类：** **Preserve：** 全路由 response redaction 和 application-status passthrough。**待验证：** mutation route 是否应有 capability-only 改造；当前没有 legacy rejection 证据。
- **未来 Rust owner：** **Delivery**；connector domain facts为 **Domain Module**，具体外部 connector端口实现为 **Runtime Integration**。
- **Rust 重写与性能判断：** secure response DTO 优于通用递归 redact（只在契约确认后）；当前已证实成本是 full-tree clone，保留字段剔除行为并测大 status snapshot 的分配、泄露 scan、延迟。
- **验证 oracle：** nested forbidden-field fixture、upsert/remove service spy、status passthrough、cyclic response fault test。
- **证据：** 本文件 18–59；`route-utils.ts` 51–128。

### runtime-host/api/routes/file-routes.ts

- **当前 owner：** Delivery 的遗留 file HTTP 入口拒绝表；不拥有文件系统能力或 workspace state。
- **职责与关键 symbols：** `rejectedFileRoute` 生成九个 POST definition，统一 `badRequest` 指向 `capabilities/execute` + workspace-file target。
- **旧语义与策略：** read/write/stage/thumbnail 均无条件拒绝，完全不读取 payload、不调用声明但未使用的 `fileService`；这是一条明确 capability migration boundary，不是缺失实现。
- **状态、存储与副作用：** 无；无文件读写。
- **并发与性能特征：** O(1) static route + response；无队列/锁/I/O。
- **调用/依赖边界：** 仅 route-utils；真实 file capability 在范围外下游。`FileRouteService` 是死接口式依赖，在此文件不实际调用。
- **故障、恢复与安全：** 400 保证遗留直接 path 不越过 workspace-file target 约束；无 token/secret/raw JSON处理。
- **迁移分类：** **Preserve：** 所有列出 path 及相同 rejection message。**Intentional Improvement：** 当前代码已完成的“direct file API → capability target”迁移，Rust 不得复活旧 endpoint。**待验证：** 未使用 interface 是否由 composition 类型统一需要，勿在本分片删除。
- **未来 Rust owner：** **Delivery**（拒绝 compatibility surface）；真实 filesystem capability 的 policy/receipts为 **Matcha Platform Core** + 相关 **Domain Module**。
- **Rust 重写与性能判断：** 静态 reject routes，无优化需要；测每条 route 均不调用 file port。
- **验证 oracle：** nine-path table，assert 400/message/zero service calls。
- **证据：** 本文件 6–38；`capability-routes.ts` 81–89。

### runtime-host/api/routes/gateway-routes.ts

- **当前 owner：** Delivery 的 gateway status/recover facade 和 legacy control rejector；不拥有 gateway lifecycle。
- **职责与关键 symbols：** GET status 经 sanitizer；POST recover 直接保留 service response；ready/auto-approve 统一拒绝并引导 gateway-control capability target。
- **旧语义与策略：** status 是 Query且 redacted；recover 是 Command，payload 原样、没有 idempotency/retry；两个 legacy control Command 不调用 service，恒 400。`ready` 接口存在但未被本表使用。
- **状态、存储与副作用：** route 无状态；recover 的 lifecycle side effect 下沉服务。
- **并发与性能特征：** O(n) status sanitize；recover concurrency 由 gateway service 串行化/恢复机制承担，当前未见。
- **调用/依赖边界：** injected gateway service，route-utils sanitizer；capability routing 是新 command boundary。
- **故障、恢复与安全：** status response redaction；recover payload/response没有额外 redaction，服务的 secret contract待验证；异常→500，未重试。
- **迁移分类：** **Preserve：** status sanitization、recover passthrough、两个 legacy rejection。**Intentional Improvement：** 保持 gateway control 只走 capability target，不能回退到 transport API。
- **未来 Rust owner：** **Delivery**；gateway具体控制为 **Runtime Integration/Native Runtime Edge**，capability grammar为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** read DTO/projection + command forwarding；测 recovery action 一次调用及 status redaction，不创建 HTTP-side retry。
- **验证 oracle：** status nested secret fixture、recover error/status fixture、legacy route no-call tests。
- **证据：** 本文件 3–21；`route-utils.ts` 98–177。

### runtime-host/api/routes/license-routes.ts

- **当前 owner：** Delivery 的 license Query projection；license/key 的存储和授权 policy 不由此 API 拥有。
- **职责与关键 symbols：** gate 与 stored-key 两个 GET；两者接受 application response 后 sanitizer，stored-key 加 `key` 显式禁止字段。
- **旧语义与策略：** 原 response status/data 经 `result` 保留；`storedKey` 即便服务返回 `key` 也会在 data 深处删除；gate 仅用默认 secret pattern。无参数、缓存或 token 校验。
- **状态、存储与副作用：** route 无状态、Query；实际 license store 读取在服务。
- **并发与性能特征：** 深度 sanitizer O(n)，无 cache/lock。
- **调用/依赖边界：** injected license service 与共享 sanitizer。
- **故障、恢复与安全：** `key` 是直接的 private projection 防线，另有 token/secret pattern；没有写入/恢复。本层不保证相近字段（如结构外编码 secret）被过滤，需 contract test。
- **迁移分类：** **Preserve：** HTTP GET、服务 status、`key`及默认敏感字段删除。**待验证：** `storedKey` 的允许安全投影字段。
- **未来 Rust owner：** **Delivery**；license policy/storage 依领域归 **Domain Module**，secret redaction primitive 可归 **Foundation Kernel**。
- **Rust 重写与性能判断：** 最佳是 service 只提供 public DTO，迁移期间保留递归 denylist oracle；旧成本是全树 clone，测泄露、分配和 response latency。
- **验证 oracle：** key/apiKey/token nested/array fixture；service error/status test。
- **证据：** 本文件 3–15；`route-utils.ts` 51–128。

### runtime-host/api/routes/openclaw-routes.ts

- **当前 owner：** Delivery 的 OpenClaw Query/permission-mode adapter；OpenClaw concrete runtime config/state 属于 **Native Runtime Edge/Runtime Integration**，绝非 platform API owner。
- **职责与关键 symbols：** 十个 GET directory/status/template/CLI/permission Query；PUT permission mode；`readPermissionMode` 只准 `default|fullAccess`；template id regex capture 后 decode。
- **旧语义与策略：** direct `ok` 用于同步 dir/config/skills，`value` 等 async；PUT invalid/missing/non-object payload 400，合法值下传；template accepts any non-empty regex suffix（decode 后可为空）；没有额外 sanitization，路径/CLI disclosure 是现有契约。无 token/secret endpoint。
- **状态、存储与副作用：** route 无状态；PUT 改 runtime permission mode，其他为 Query；service owns config/process effects。
- **并发与性能特征：** O(1) parsing；PUT 无 idempotency key/lock，重复设置的幂等性待 service 证明。
- **调用/依赖边界：** injected OpenClaw port，route-utils decode/responder；handlers从 registry 进入。
- **故障、恢复与安全：** permission enum 是最小 input guard；template invalid percent encoding会触发共享 decode→500 Defect；公开 absolute directories/CLI可能是 information boundary，需 security oracle；无 retry。
- **迁移分类：** **Preserve：** endpoint 集合、enum guard、PUT Command 与 GET Query。**Intentional Improvement：** decode failure→400。**待验证：** directory/CLI output是否需 public projection，不能静默删除。
- **未来 Rust owner：** endpoint为 **Delivery**；OpenClaw adapter/state为 **Native Runtime Edge** 或 **Runtime Integration**。
- **Rust 重写与性能判断：** typed enum extractor、percent decode error mapping；不创建 cache。测 mode set calls、template decoding、all GET response shape。
- **验证 oracle：** valid/invalid enum、malformed escape、permission mode repeat, public-path disclosure review。
- **证据：** 本文件 9–61；`route-utils.ts` 130–177。

### runtime-host/api/routes/platform-routes.ts

- **当前 owner：** 名称虽为 `platform`，当前文件仍只是 **Delivery** HTTP adapter，不能误归 Matcha Platform Core；下游 health/tools 的事实/grammar另行归属。
- **职责与关键 symbols：** runtime health、list tools（URL query）、query tools（payload）三个 route definition。
- **旧语义与策略：** 两个 GET Query，POST tools query 是现有 RPC Query projection；raw payload 原样；成功 `ok`、throw→500；没有边缘 schema、分页、缓存。
- **状态、存储与副作用：** route 无状态；理论均为 Query，是否 `queryTools` 有远程副作用待验证。
- **并发与性能特征：** 一请求一 service call；无索引/cache/lock。
- **调用/依赖边界：** injected platform service，route responder。名称仅 path namespace，不是 owner evidence。
- **故障、恢复与安全：** 无 sanitizer/token handling；工具 metadata 是否有 secret需下游 public projection oracle；无 retry/cancel。
- **迁移分类：** **Preserve：** URL/payload forwarding、GET/POST transport shape。**待验证：** tools query 的 command/query semantic及字段公开性。
- **未来 Rust owner：** **Delivery**；如工具 capability grammar为 **Matcha Platform Core**，但 HTTP adapter绝不移入 Core。
- **Rust 重写与性能判断：** direct handlers + typed query DTO only after schema evidence；测 tools URL filters、raw query payload、error wrapper。
- **验证 oracle：** health/list/query service spy，secret scan/tool list fixture。
- **证据：** 本文件 6–20；README 新 owner约束。

### runtime-host/api/routes/plugin-runtime-routes.ts

- **当前 owner：** Delivery 的 plugin runtime/catalog read projection；plugin catalog本体应归 **Native Runtime Edge**，不是 Core。
- **职责与关键 symbols：** GET `/api/plugins/runtime` 和 `/api/plugins/catalog`，同步 service `ApplicationResponse` 经 `routeResponder.result`。
- **旧语义与策略：** 只读 Query；response若已有 `{status,data}` 保持 status，否则包 200；没有 sanitizer、payload、分页或 exception special case。
- **状态、存储与副作用：** 无 route state/I/O；catalog runtime state在 service。
- **并发与性能特征：** O(1) adapter，无缓存/锁。
- **调用/依赖边界：** injected object仅有 `runtime/catalog`；依赖 application response shape。
- **故障、恢复与安全：** 无 token/redaction；plugin catalog需保证不泄露 source/secret，当前本层未证明。
- **迁移分类：** **Preserve：** two GET paths 和 ApplicationResponse status passthrough。**待验证：** catalog public field allowlist。
- **未来 Rust owner：** endpoint为 **Delivery**；plugin runtime/catalog为 **Native Runtime Edge**。
- **Rust 重写与性能判断：** direct read responders；无性能算法变更依据，测 status/data差分及 public DTO。
- **验证 oracle：** runtime/catalog success/error fixtures 与 sensitive-field scan。
- **证据：** 本文件 3–21；`bootstrap/runtime-config.ts` 提供相关 catalog type但不证明服务实现。

### runtime-host/api/routes/provider-models-routes.ts

- **当前 owner：** Delivery 的 provider model read facade/legacy detail rejector；provider model事实在 runtime integration/domain，不在 API。
- **职责与关键 symbols：** read all/selectable GET；detail pattern GET 固定 400并引导 provider capability target。
- **旧语义与策略：** 两个 list Query无参数/无 sanitizer；detail无论 id 合法与否都拒绝，既不 decode也不调用 service；使旧 detail access不能绕过 capability path。
- **状态、存储与副作用：** 无；完全 Query/reject。
- **并发与性能特征：** O(1) adapter，无 cache/scan。
- **调用/依赖边界：** injected models service及 route-utils；下游 provider capability不在本文件。
- **故障、恢复与安全：** 无 key/token route；list响应未 redact，public model projection需服务保证。错误→500。
- **迁移分类：** **Preserve：** list/read-selectable、detail 400/message。**Intentional Improvement：** 禁止 legacy detail 并使用 capability target；Rust 不重建。
- **未来 Rust owner：** **Delivery**；provider implementation为 **Runtime Integration/Native Runtime Edge**，capability address为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** static rejection + query forwarding；测 detail不调用 service与两 list JSON。
- **验证 oracle：** all/selectable service spies，any detail path no-call/400。
- **证据：** 本文件 8–34；`capability-routes.ts`。

### runtime-host/api/routes/provider-routes.ts

- **当前 owner：** Delivery 的 provider account list/has-key projection和 secret-route hard boundary；provider secrets不由 transport持有。
- **职责与关键 symbols：** list GET，has-api-key GET by account id；validate、api-key、detail legacy paths均 `badRequest`；interfaces保留但 validate/getApiKey/get未调用。
- **旧语义与策略：** account id pattern是非 `/`、经 decode；has-key只公开存在性；获取实际 api key、account detail和validation全部引导 capability provider target。list本层不 sanitize，依赖 service public projection。
- **状态、存储与副作用：** 无；没有读取或写出 provider secret。
- **并发与性能特征：** O(1)，无 retry/cache/lock。
- **调用/依赖边界：** injected provider account port；route-utils decode/responder；capability API为替代路径。
- **故障、恢复与安全：** 强制禁止 raw secret endpoint是关键 secret policy；malformed percent account id沿共享 Defect→500。has-key是 metadata disclosure，authorization交下游/host deployment，当前待验证。
- **迁移分类：** **Preserve：** secret/detail/validate拒绝、仅 `hasApiKey` 查询、list。**Intentional Improvement：** invalid decode→400。**待验证：** list是否已完全 private-projected。
- **未来 Rust owner：** **Delivery**；provider secret storage/redaction机制为 **Foundation Kernel**，provider concrete adapter为 **Runtime Integration/Native Runtime Edge**。
- **Rust 重写与性能判断：** 不把 key 放入 public DTO；typed account-id decode；无算法优化。测 secret payload never invoked/never emitted，has-key bool contract。
- **验证 oracle：** rejection/no service calls、nested provider list redaction contract、malformed encoding。
- **证据：** 本文件 8–40；`route-utils.ts` 130–177。

### runtime-host/api/routes/remote-fleet-routes.ts

- **当前 owner：** Delivery 的 remote-fleet operation table/transport facade；fleet topology、credentials、deployment和terminal state归 **Domain Module**（具体 remote implementation为 Runtime Integration）。
- **职责与关键 symbols：** `REMOTE_FLEET_ROUTE_OPERATIONS` 静态表将 21 路 GET/POST 映射到 typed `RemoteFleetOperationId`；map 生成 route；全部调用 `invoke(operationId,payload)`并 sanitize response，额外禁 `plaintext`。
- **旧语义与策略：** operation table是唯一 route ownership mapping；GET snapshot/metrics/list等是 Query，register/deploy/writeCredential/drain/terminal等为 Command；所有响应（包括 Command）做 read-only redaction，不表示无写入；payload无 schema和 idempotency HTTP header。operation id 静态 TypeScript satisfies检查。
- **状态、存储与副作用：** route table immutable；实际 remote network/credential/write/event effects在 service。route无队列/事务。
- **并发与性能特征：** build-time O(21) map；请求 O(n) recursive sanitizer；并发/endpoint serialization由 remote fleet service。无 HTTP retry/backoff。
- **调用/依赖边界：** injected `RemoteFleetPort.invoke`；terminal websocket另由 composition server upgrade分派，不在此 table。
- **故障、恢复与安全：** default sanitizer加 `plaintext` 删除，对 credential/terminal output/log等也用默认 denylist；请求 credential可能进入 service，transport不日志。writeCredential等 Command的 authorization/idempotency必须下游验证。
- **迁移分类：** **Preserve：** operation-to-path/method exact mapping、status passthrough、all response redaction及 `plaintext` extra field。**待验证：** 每个 operation 的 C/Q/Event receipt/idempotency contract；不可由 POST/GET猜测完整语义。
- **未来 Rust owner：** endpoint table为 **Delivery**；fleet facts为 **Domain Module**，remote protocol ports为 **Runtime Integration**。
- **Rust 重写与性能判断：** static typed route table，secure response DTO；旧确定成本是每个大 snapshot全树 clone。保留 key removal，测 per-operation mapping、redaction、terminal/fleet large snapshot延迟与分配。
- **验证 oracle：** 21-row route table test，operation spy，nested plaintext/token fixture，Command fault/retry（应证明未在 edge retry）。
- **证据：** 本文件 1–45；composition server CodeGraph evidence 155–170。

### runtime-host/api/routes/remote-fleet-runtime-agent-ingress-route.ts

- **当前 owner：** Delivery 的 remote runtime-agent **Event ingress**；agent enrollment/heartbeat business validation、credentials和fleet fact写入归 Domain Module/Runtime Integration。
- **职责与关键 symbols：** handler只接受 POST + `application/json`（参数可附 `;`）；64 KiB content-length预检与实际流累计；parse raw JSON；Bearer authorization credential；仅 `type==='runtime-agent.heartbeat'` 时额外取 enrollment header；错误使用 application rejected response。
- **旧语义与策略：** method错→405、content-type错/invalid JSON→400、过大→413、service invocation throw→503 runtime-unavailable；`content-length` 用 `parseInt`，不可信时仍实读限额；header数组取首值；raw parsed request原样交 service，非 heartbeat 不传 enrollment credential。无 idempotency/replay/dedup在 edge。
- **状态、存储与副作用：** request-local chunks至64 KiB；调用 `remoteFleetService.invoke('ingestRuntimeAgentIngress',...)` 可能写 fleet facts；每次获取 `nowIso`在进入时冻结 receivedAt。
- **并发与性能特征：** 请求并行、每请求 O(n) read + concat + parse，64 KiB内存上限；无队列、timeout、backpressure/retry（流自然背压仅由 Node iterator）。
- **调用/依赖边界：** composition server exact ingress path调用；application factory `createRuntimeAgentIngressRejectedResponse` 定义 Error/Event response；service为 RemoteFleetPort subset。
- **故障、恢复与安全：** transport验证 JSON/content type/大小；Bearer及enrollment credential只转交、未响应/日志；未见 timing-safe credential compare（须下游）；catch 故意压缩任意服务故障为503，避免内部错误泄漏。raw JSON不是 dispatch envelope，独立协议。
- **迁移分类：** **Preserve：** 64 KiB、HTTP status mapping、heartbeat-only enrollment header、receivedAt、503 compression。**待验证：** replay/idempotency和credential validation由 service的证据，不能在 Delivery 伪造。
- **未来 Rust owner：** ingress HTTP为 **Delivery**；fleet event/identity/credential policy为 **Domain Module** + **Runtime Integration**，跨 runtime receipt grammar可为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** bounded async body stream、serde_json `Value`、headers typed extractor；保留双重 size防线。测 overlarge Content-Length、chunk overflow、bad JSON、credential absent/present、service throw、64 KiB并发内存。
- **验证 oracle：** ingress fixture/fault tests（当前 CodeGraph未报告专门测试，待补）；application rejected-response differential。
- **证据：** 本文件 8–140；CodeGraph `runtime-host/composition/runtime-host-server.ts` 91–94、124–132。

### runtime-host/api/routes/route-utils.ts

- **当前 owner：** Delivery 的 route definition, response/error mapping, public read projection helper；并不拥有下游业务状态。默认 redaction policy是跨 endpoint transport projection，不等同 secret store owner。
- **职责与关键 symbols：** response type guard；`readRecord`；递归 `sanitizeReadOnlyRoutePayload/Response`；decode；error wrappers；`RuntimeRouteResponder`；definition matcher/match/context/invoke adapter。
- **旧语义与策略：** `readRecord` 对 null/array/primitive返回 `{}`；response只需 object含 numeric `status`和`data`；sanitizer递归数组/object，删除精确 denylist或 regex token/secret/password/private key字段，保留原型外转为 Object entries；extra fields每次递归新建 Set；`routeResponder.value` 总包 ok，`result`保留识别到的 app response。matcher优先 path→prefix→pattern；prefix是 startsWith；pattern `exec`不重置 `lastIndex`；无 matcher抛。`invokeRuntimeRouteDefinition` 不匹配返回 null。
- **状态、存储与副作用：** `routeResponder` 单例无可变状态；其余纯函数；无 I/O。
- **并发与性能特征：** sanitizer为 O(nodes) 时间/空间深复制，数组/object循环引用会无限递归/抛；每层重建 forbidden Set；pattern若 global/sticky可能有 lastIndex并发/跨请求状态风险。matcher本身 O(1)/regex cost。
- **调用/依赖边界：** 几乎所有 route file依赖；definition 最终转为 dispatch entry；ApplicationResponse来自 application common。
- **故障、恢复与安全：** `routeError` 将 `String(error)` 放入 500 data，可能对公开 route泄露内部细节；decodeURIComponent 对 malformed `%`抛，responder捕获为500。**Defect：** invalid percent-encoded path input被映射为500而非400，影响 channel/openclaw/provider/settings 等；代码路径直接可证。**待验证：** denylist/projection足够性与循环 response可达性；secret保护应以 DTO/allowlist 逐领域强化。
- **迁移分类：** **Preserve：** response pass-through/ok wrapping、默认禁止字段与 recursive scrub、path/prefix/pattern匹配。**Intentional Improvement：** fallible path decode→400稳定 code；公开 error使用稳定消息/日志保留详情；在不变允许字段 oracle下用 DTO/allowlist替代广泛 denylist。**Defect：** decode→500；potential error detail泄露为待验证（未见具体泄露 fixture）。
- **未来 Rust owner：** HTTP utilities为 **Delivery**；可复用 secret/redaction primitive为 **Foundation Kernel**，但业务字段 allowlist必须留在各 Domain Module/Runtime Integration owner。
- **Rust 重写与性能判断：** serde DTO优先；保留 dynamic unknown endpoints时使用 iterative/cycle-aware scrub，避免递归栈与每层 Set分配。旧成本：deep clone/重复 Set；测 nested/large body、cycle fault、安全字段差分、route match order。
- **验证 oracle：** forbidden exact/pattern field matrix、array/nested response、invalid escape→400、throw response、global regex repeated matching、cycle failure policy。
- **证据：** 本文件 43–241；全体 route引用；dispatch types/index。

### runtime-host/api/routes/runtime-host-routes.ts

- **当前 owner：** Delivery 的 runtime-host diagnostics/bootstrap/jobs Query facade；不拥有 lifecycle、provider environment、webhook auth secret或job事实。
- **职责与关键 symbols：** health、transport stats、provider env map、host bootstrap settings、gateway plan、TeamRun webhook auth public projection、jobs(type query)。
- **旧语义与策略：** health/stats直接 ok；env/settings/plan/jobs均sanitize；webhook route仅在 optional service存在时调用 `getPublicAuthProjection`，缺失故意 throw→500；jobs仅将 `type` null变 undefined；所有均 GET Query。
- **状态、存储与副作用：** 无 route state；transport stats本身在 dispatch handler变动但这里仅读；无 Command/Event。
- **并发与性能特征：** Query一调用；sanitized views O(n)，stats O(1)，无缓存/lock。
- **调用/依赖边界：** injected runtime host services以及 optional TeamRun auth port；route responder/sanitizer。
- **故障、恢复与安全：** public auth endpoint明确依下游 public projection，不能返回 token；optional service缺失目前是500不是404/feature-unavailable，可能是 composition invariant，**待验证**而非 defect；provider env map也redact。
- **迁移分类：** **Preserve：** all GET、sanitized diagnostic projections、missing webhook-auth error behavior待兼容确认。**Intentional Improvement：** 如 composition允许缺服务，可改稳定 503/404，但缺业务契约证据，暂不实施。
- **未来 Rust owner：** HTTP routes为 **Delivery**；stats/lifecycle primitives为 **Foundation Kernel**，TeamRun auth实际为 **Domain Module**，但不因 path而归 Platform Core。
- **Rust 重写与性能判断：** public projection DTO、read-only endpoints；测 optional absence、secret redaction、jobs type forwarding、stats monotonic snapshots。
- **验证 oracle：** health/stats deterministic fixture、webhook auth with/without service、providerEnv secret scan。
- **证据：** 本文件 3–37；dispatch handler stats；Team webhook route。

### runtime-host/api/routes/runtime-topology-routes.ts

- **当前 owner：** Delivery 的 runtime topology Query facade及遗留 connector Command rejector；topology snapshot实际为 Platform Core/Runtime Integration 的下游事实，不由 API拥有。
- **职责与关键 symbols：** adapters/instances/connectors/endpoints list 从一次 `snapshotRuntimeTopology()` 选择字段；connect/disconnect 直接 400 disabled。
- **旧语义与策略：** list无 payload且每请求分别调用 snapshot（非共享 transactional snapshot）；value handler为 list wrapper；已禁两 lifecycle commands并引导 capability runtime-endpoint target，声明但未调用 connect/disconnect service methods。
- **状态、存储与副作用：** API无状态；Query只读；legacy Commands无副作用。
- **并发与性能特征：** 一次 snapshot + shallow object创建；无 cache/lock；snapshot构造成本在下游。
- **调用/依赖边界：** injected topology service与 runtime topology type；capability API是替代控制边界。
- **故障、恢复与安全：** 无 sanitizer/token；topology的 runtime IDs/metadata公开性待下游确认；service throw→500。
- **迁移分类：** **Preserve：** four list selections、two disabled routes/messages。**Intentional Improvement：** connector lifecycle only through capability target，Rust不恢复 HTTP control。
- **未来 Rust owner：** endpoint为 **Delivery**；shared identity/topology protocol可属 **Matcha Platform Core**，runtime adapter facts为 **Runtime Integration**。
- **Rust 重写与性能判断：** snapshot projection无额外 index；若同一请求需多组件不能改变目前一次endpoint一次snapshot行为。测 each field selection、rejection no-call、snapshot error。
- **验证 oracle：** topology fixture、disabled connect/disconnect paths、public-field review。
- **证据：** 本文件 4–51；`capability-routes.ts`。

### runtime-host/api/routes/security-routes.ts

- **当前 owner：** Delivery 的 security policy/catalog/audit Query projection；policy和audit事实在 security Domain Module，不在 HTTP adapter。
- **职责与关键 symbols：** GET policy、destructive rule catalog（optional `platform` query）、audit（完整 URL）。
- **旧语义与策略：** policy/audit async value→ok；catalog sync ok；query `platform` absence为 null，audit自行解释完整 query；没有 pagination/schema/redaction/authorization逻辑。
- **状态、存储与副作用：** route无状态、都是 Query；audit storage由 service。
- **并发与性能特征：** 每请求一调用；无 streaming/paging/cache，审计结果尺寸控制待下游验证。
- **调用/依赖边界：** injected security service、route responder。
- **故障、恢复与安全：** security path本身不等于 authorization enforcement；此文件没有 token check、audit redaction或 error masking，服务/host必须承担。throw→500（可能含 error message，见 shared pending issue）。
- **迁移分类：** **Preserve：** GET and query forwarding。**待验证：** audit pagination, secret redaction, caller authorization；缺证据不能上升为 Defect。
- **未来 Rust owner：** endpoint为 **Delivery**；policy/audit为 **Domain Module**，通用 audit append/cursor机制可为 **Foundation Kernel**。
- **Rust 重写与性能判断：** read handlers，无无界 scan优化证据；先量测 audit response size、latency、cursor/limit contract后决定分页。
- **验证 oracle：** platform null/value、audit URL forwarding、unauthorized/redacted audit fixture（待补）。
- **证据：** 本文件 6–20；`route-utils.ts`。

### runtime-host/api/routes/session-routes.ts

- **当前 owner：** Delivery 的 session legacy boundary；Session timeline/identity/approval state属于 **Domain Module**，不是 API。
- **职责与关键 symbols：** allowlist四种 legacy read-only paths；仅 list/approvals真正 read service，window/state因可能 hydrate而拒绝；大量 mutation/hydration/prompt/approval routes全拒绝；`validateLegacyReadOnlySessionPayload`调用 application session request parsers。
- **旧语义与策略：** POST即使是 Query；list必须 endpoint；window/state/approvals要求不同 SessionIdentity/sessionKey，window older/newer必须 offset；但 window/state永不服务调用，验证函数对其目前不可达（只在 read routes调用）。allowed list/approvals都sanitize response且 onError data `{success:false,error}`；allowlist guard若新增错误 path则启动/构建 throw。C/Q：list/approvals是只读 Query；所有原 Command（create/prompt/rename/delete/abort/resolve）明确禁止，不能复活；没有 Event ingress。
- **状态、存储与副作用：** 无路由状态；list/approval仅下游读取；disabled endpoints零副作用。
- **并发与性能特征：** O(1) validation + possible O(n) response sanitize；无 session lock、queue、cancel、recovery，均由 session domain。
- **调用/依赖边界：** application session request parser是输入 grammar source；route-utils是 response projection；capability execute为新入口。
- **故障、恢复与安全：** identity validation防无定位读；sanitize防 session outputs含 token/log等；hydrate rejection防旧 read endpoint隐式改变 state。**待验证：** window/state validation dead paths是否应删除，因无行为影响不判 defect。
- **迁移分类：** **Preserve：** path allowlist、specific validation messages、window/state hydration rejection、all command rejection及 sanitizer。**Intentional Improvement：** Sessions只走 capability target（旧直接 routes保持拒绝）。
- **未来 Rust owner：** HTTP compatibility routes为 **Delivery**；session state/turn/approval/recovery为 **Domain Module**，execution receipt grammar可为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** typed session identity DTO，保留 per-path validation；不得以并行ization改变 session order。测 17 endpoints、zero service calls for reject/hydrate, input matrix and secret projection.
- **验证 oracle：** parser fixture、route table/no-call test、older/newer offset cases、sanitized nested session data；session domain recovery test待范围外读取。
- **证据：** 本文件 1–144；`route-utils.ts` 98–177。

### runtime-host/api/routes/settings-routes.ts

- **当前 owner：** Delivery 的 settings Query adapter；settings persistence/config ownership不在 API。
- **职责与关键 symbols：** GET all；pattern GET key，decode 后非空才 getValue，否则 400。
- **旧语义与策略：** `/api/settings` exact优先；`(.+)` 至少一个字符，再 decode；encoded empty `%`? decode结果为空则400；key不 trim；service values原样返回，无 sanitizer；all返回 declared `Record<string,unknown>`。
- **状态、存储与副作用：** 无状态、Query；store read在 service。
- **并发与性能特征：** O(1) regex/decode/service call，无 cache/lock。
- **调用/依赖边界：** injected settings service；route responder/decode helper；route index exact-first保证 all不落 pattern。
- **故障、恢复与安全：** malformed percent escape共享 Defect→500；无 secret redaction，settings service必须仅给 public values，当前缺证据；service throw→500。
- **迁移分类：** **Preserve：** exact/pattern shape、empty decoded key 400、raw key forwarding。**Intentional Improvement：** malformed decode 400。**待验证：** settings secret policy。
- **未来 Rust owner：** endpoint为 **Delivery**；settings business/config state为相应 **Domain Module** 或 **Native Runtime Edge**，secret mechanism为 **Foundation Kernel**。
- **Rust 重写与性能判断：** fallible path extractor + public DTO; no cache before invalidation model exists. Measure value response latency and malformed-path error contract.
- **验证 oracle：** all/key/encoded key/empty/malformed paths，settings secret fixture。
- **证据：** 本文件 8–33；`route-utils.ts` 130–177、dispatcher exact priority。

### runtime-host/api/routes/skills-routes.ts

- **当前 owner：** Delivery 的 skills status/effective/readme-preview facade；skill catalog/content实际归 Domain Module或 Native Runtime Edge。
- **职责与关键 symbols：** GET status/effective、POST readme；status可同步，effective async，preview保留 application response。
- **旧语义与策略：** POST raw payload无 edge validation；readme preview是 Query-like read despite POST（不应靠 HTTP verb重定 owner）；`result`保留下游 status，其他 `value`包200；无 pagination/cache。
- **状态、存储与副作用：** API无状态；readme preview可能文件 I/O但服务拥有。
- **并发与性能特征：** 一调用；content size、filesystem concurrency未限制于本层。
- **调用/依赖边界：** injected skills service，route responder。
- **故障、恢复与安全：** 未 sanitize README/result，可能含 source paths/content；是否公开/含 secret待 service contract；异常映射500，无 retry。
- **迁移分类：** **Preserve：** current HTTP forms/status passthrough。**待验证：** preview payload schema、read-only guarantee及大小限制。
- **未来 Rust owner：** endpoint为 **Delivery**；skill facts为 **Domain Module** 或 **Native Runtime Edge**。
- **Rust 重写与性能判断：** body DTO/size limit只能在下游契约明确后；先测 preview body/response sizes和 read latency。
- **验证 oracle：** status/effective/preview success/error, large README and secret-content projection tests待补。
- **证据：** 本文件 3–18；`route-utils.ts` 150–177。

### runtime-host/api/routes/subagent-routes.ts

- **当前 owner：** Delivery 的遗留 subagent endpoint reject table；agent/subagent事实不由此拥有。
- **职责与关键 symbols：** `rejectedSubagentRoute` 静态创建 list/config/files get/list 四个 POST 400，按 read/file类别分别说明新 capability target。
- **旧语义与策略：** 所有 path无条件拒绝、不读 payload、不用 optional `subagentService`；list被归“read route”但仍拒绝，防止旧投影绕过 agent/subagent target。
- **状态、存储与副作用：** 无；没有 filesystem/agent读取。
- **并发与性能特征：** O(1) static rejection，无 I/O/lock。
- **调用/依赖边界：** route-utils及未来 capability endpoint；optional dependency是未使用兼容类型表面。
- **故障、恢复与安全：** file routes禁用直接防越权文件访问；无token/secret/raw JSON处理。
- **迁移分类：** **Preserve：** four paths、分组错误消息、zero service call。**Intentional Improvement：** existing capability-only boundary，Rust不得实现旧读取。
- **未来 Rust owner：** **Delivery**；agent/subagent facts为 **Domain Module**，native agent bridge为 **Native Runtime Edge/Runtime Integration**。
- **Rust 重写与性能判断：** static route match，无优化；验证 no-call。
- **验证 oracle：** four-path table and absent service fixture。
- **证据：** 本文件 3–24；`capability-routes.ts`。

### runtime-host/api/routes/team-runtime-webhook-routes.ts

- **当前 owner：** Delivery 的 TeamRun webhook **Event ingress**；webhook trigger/event fact、idempotency judgement和TeamRun state属于 **Domain Module**，token secret owner不在 API。
- **职责与关键 symbols：** fixed prefix detection；async token resolve；POST/auth/path/body control；sanitized header/body projection；SHA-256 deterministic hash；invoke `team.webhookTriggerFire` with runtime-instance target；200升级为202。
- **旧语义与策略：** 空 configured token伪装404；method→405，missing/bad token→401；Bearer优先于 custom header（Bearer存在但空/错误时不会回退 custom）；safe URL/decode缺失/坏值→404；64 KiB preflight和stream cap；idempotency header trim/truncate200，否则 UUID；只白名单四 headers且截500。body一律可带 redacted text，JSON content-type才另带 redacted bodyJson；hash在读取原始 bytes时计算。Event语义：下游的200接收改成202，其他 status原样。
- **状态、存储与副作用：** request chunks≤64KiB/hash/id；调用 TeamRuntime Command/Event fire可追加业务事件；无 route persistence/queue/retry。token可每请求动态读取。
- **并发与性能特征：** 每请求 streaming O(n) + hash + concat；并发无锁，幂等只传 key/hash不在 edge 去重；`createWebhookRequestId`是 UUID。hash/constant-time compare由 composition 注入（CodeGraph server 使用 SHA-256 + `timingSafeEqual`）。
- **调用/依赖边界：** composition server prefix优先分派且有 catch→generic 500；TeamRuntimePort为下游；shared `sendJson`写 raw JSON而非 dispatch envelope。
- **故障、恢复与安全：** token从不回显；authorization compare依注入，生产 composition使用 timing-safe hash compare；body/header secret redact正则/递归 key，非 JSON raw body仍text redact；服务 throw交 server generic500。redactor是 best effort，payload仍交 trusted TeamRuntime。无 Content-Type强制，允许任何 webhook payload。
- **迁移分类：** **Preserve：** prefix, auth/status concealment, limits, header allowlist/caps, key/hash, 200→202 Event acknowledgment, redaction projections。**待验证：** duplicate delivery/replay和 TeamRuntime receipt behavior；不得在 Delivery自行声明 exactly-once。
- **未来 Rust owner：** HTTP ingress为 **Delivery**；TeamRun trigger/idempotency state为 **Domain Module**；secret comparison/redaction primitive可为 **Foundation Kernel**；execution/correlation grammar可为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** bounded async stream，同时 digest与收集；constant-time token verify；serde JSON conditional projection。保留 64KiB and caps；旧成本为 text+JSON双投影/深复制，测 webhook p95、allocation、secret scan、duplicate idempotency behavior and 202 mapping。
- **验证 oracle：** CodeGraph 指向 `tests/unit/team-trigger-webhook-route.test.ts`；补 bearer/custom precedence、empty token 404、bad UTF-8/large chunk、nested secret/body hash、idempotency truncation、service status matrix。
- **证据：** 本文件 4–221；CodeGraph `runtime-host/composition/runtime-host-server.ts` 64–90、116–121。

### runtime-host/api/routes/toolchain-uv-routes.ts

- **当前 owner：** Delivery 的 toolchain availability Query adapter；toolchain detection/installation policy不在 route。
- **职责与关键 symbols：** GET `/api/toolchain/uv/check`，await `checkInstalled()`，包装 bool。
- **旧语义与策略：** 无 payload/query/cache；服务异常→500；Query不触发 install。
- **状态、存储与副作用：** 无状态；service可能检查 filesystem/process，但不由本文件证实。
- **并发与性能特征：** 一请求一 probe，无 memoization，潜在重复 process/filesystem成本待量测。
- **调用/依赖边界：** injected toolchain UV port、routeResponder。
- **故障、恢复与安全：** 无 token/redaction/validation/retry；安装路径或环境详情不在返回 type（仅 boolean）。
- **迁移分类：** **Preserve：** GET boolean Query/error wrapper。**待验证：** repeated probe是否需 cache，不能无效缓存改变安装后可见性。
- **未来 Rust owner：** endpoint为 **Delivery**；toolchain runtime integration为 **Runtime Integration/Native Runtime Edge**。
- **Rust 重写与性能判断：** simple async probe; benchmark filesystem/process cost before adding cache; oracle is freshness after uv changes.
- **验证 oracle：** installed/not installed/throw fixtures，repeat check freshness test。
- **证据：** 本文件 3–18；`route-utils.ts`。

### runtime-host/api/routes/workbench-routes.ts

- **当前 owner：** Delivery 的 Workbench bootstrap Query projection；workbench state/payload model不由 API拥有。
- **职责与关键 symbols：** GET `/api/workbench/bootstrap`，同步 `bootstrap()` 直接 `ok`。
- **旧语义与策略：** 无 input、没有 async/exception wrapper（若 bootstrap throw，会由外层 dispatch转500）；GET represents Query/bootstrap view，非 process bootstrap Command。
- **状态、存储与副作用：** 无；service可能读取 runtime state/clock，CodeGraph定位的 WorkbenchService只是下游构造 payload。
- **并发与性能特征：** O(1) adapter，无cache/lock；payload复杂度在 service。
- **调用/依赖边界：** injected workbench service，routeResponder；composition registry为上游。
- **故障、恢复与安全：** 本层无 sanitizer/token；workbench payload secret policy待验证；exception由 `/dispatch` catch处理。
- **迁移分类：** **Preserve：** GET/`ok` wrapper和同步错误传播。**待验证：** bootstrap payload public field contract。
- **未来 Rust owner：** endpoint为 **Delivery**；workbench domain view为 **Domain Module**。
- **Rust 重写与性能判断：** direct Query handler；无优化依据，测 payload serialization/security and throw mapping。
- **验证 oracle：** bootstrap fixture、throw transport response、secret scan。
- **证据：** 本文件 6–20；CodeGraph `runtime-host/application/workbench/service.ts` evidence。

### runtime-host/bootstrap/runtime-config.ts

- **当前 owner：** runtime-host 的 plugin catalog/bootstrap configuration value normalization；不是 HTTP/Platform Core owner。当前更接近 **Native Runtime Edge** 的静态 runtime catalog定义。
- **职责与关键 symbols：** empty default enabled plugin ids；catalog plugin/group/state TS contracts；`normalizePluginIds` trim、删空、Set stable dedupe。
- **旧语义与策略：** 输入 readonly array，输出新 mutable array；first occurrence wins、保留首次出现的顺序/大小写；只检查 trimmed emptiness但返回的是 **原始 id**，所以 `' a '` 与 `'a'` 不会去重且空白不会被写回 trimmed value。这是需忠实保留的微观语义。
- **状态、存储与副作用：** 不存储、不读环境、不 I/O；常量 array可被类型层readonly保护。
- **并发与性能特征：** `map/filter/Set/Array.from` O(n) 时间和空间；纯函数，线程安全。
- **调用/依赖边界：** 由 runtime composition/plugin catalog消费者使用（具体调用方不在本审计文件中）；接口描述 plugin metadata，不等于 plugin runtime state。
- **故障、恢复与安全：** 不校验 ID grammar/version/source，不处理 secret；没有恢复/error。
- **迁移分类：** **Preserve：** default空集、first-seen order以及“trim only for emptiness、不规范化 output”的行为。**待验证：** 这是否是无意的 whitespace quirk；无调用/fixture证据前不能标 defect或改成输出 trim。
- **未来 Rust owner：** **Native Runtime Edge**（runtime plugin catalog configuration）；若成为跨 runtime schema再由 **Matcha Platform Core** 定义 grammar，但本函数不构成该证据。
- **Rust 重写与性能判断：** `IndexSet`/HashSet+Vec保留 insertion order，或单 pass Vec+HashSet；旧成本是三次遍历和中间 array，只有 large plugin lists benchmark证明时才优化。测 whitespace/order/duplicates exactly。
- **验证 oracle：** table：empty、space-only、duplicate、`' a '`/`'a'`、case difference、order；catalog serialization fixture。
- **证据：** 本文件 1–29。

### runtime-host/main-cli.ts

- **当前 owner：** CLI Delivery entrypoint；只解析顶层命令、动态装载 CLI command implementation、映射进程 exit code，不拥有 runtime-host capability 的业务状态或策略。
- **职责与关键 symbols：** `runMatchaCli`、`stripOptionalExecutablePrefix`、`formatMatchaCliUsage`。
- **旧语义与策略：** 无命令或 `--help/-h` 输出 usage 并返回 0；`runtime` 动态导入 `runMatchaRuntimeCommand`，`system-runtime` 动态导入 `runSystemRuntimeMcpServerCommand`；未知命令写 stderr 并返回 2；顶层启动失败写 `[matcha-cli] failed to start: <detail>` 并设 exit code 1。可选 `matcha` executable 前缀会被剥离。
- **状态、存储与副作用：** 无内存业务状态与存储；写 stdout/stderr、延迟 import 下游 command、设置 `process.exitCode`。不直接启动 daemon、写业务数据或处理 secret。
- **并发与性能特征：** 单次命令串行；dynamic import 仅装载被选命令，避免无关 CLI 依赖进入 help/另一命令的启动路径。
- **调用/依赖边界：** 下游 runtime/system-runtime command 是 CLI Delivery adapter；业务执行必须由 runtime-host capability 背书，正如 usage 文案所明确。它不是 Platform Core 或 Runtime Integration 的事实源。
- **故障、恢复与安全：** 动态 import/command rejection 统一只暴露 `Error.message` 或字符串到 stderr；没有 retry、恢复或 token 输出逻辑。
- **迁移分类：** **Preserve：** command token、0/1/2 exit code 语义、按命令 lazy import、未知命令文案结构。**Intentional Improvement：** Rust CLI 可使用 typed subcommand parser，但不可改变 `runtime` 与 `system-runtime mcp-stdio` 的 public invocation contract。**Defect：** 未证实。**待验证：** stderr 是否需要进一步 redaction。
- **未来 Rust owner：** Delivery。
- **Rust 重写与性能判断：** 不存在可证明的热路径；保留 lazy command loading 或以编译链接替换时应测量冷启动与 help latency，而非假定 Rust 自动更快。
- **验证 oracle：** argv matrix（empty/help/prefixed runtime/system-runtime/unknown）、exit code、stdout/stderr golden；下游 load failure 的 redaction fixture。
- **证据：** `runtime-host/main-cli.ts:3-55`。

### runtime-host/host-process.cjs

- **当前 owner：** Node CommonJS process loader；只将运行控制交给构建后的 `build/main.js`，不拥有 application state、IPC policy、child process 或 lifecycle 策略。
- **职责与关键 symbols：** `require('./build/main.js')`。
- **旧语义与策略：** 无参数解析、异常转换、重试、shutdown hook 或输出策略；模块加载成功与否完全继承 build entrypoint。
- **状态、存储与副作用：** 仅 CommonJS module-load 副作用。
- **并发与性能特征：** 一次 require；无可审计队列、锁或 I/O。
- **调用/依赖边界：** 属于 Delivery/process packaging edge；构建输出不是真实迁移 source，实际 owner 应追到 `main.ts` 与 composition root。
- **故障、恢复与安全：** build entry 缺失或初始化抛错直接由 Node module loader 传播；没有本地 secret、logging 或 recovery。
- **迁移分类：** **Preserve：** packaging entrypoint 能启动实际 host。**Intentional Improvement：** Rust binary 可直接替代 loader，不应保留 CJS bridge。**Defect：** 未证实。
- **未来 Rust owner：** Delivery。
- **Rust 重写与性能判断：** 去除 loader 是部署形态收敛，不是可单独宣称的 runtime performance win。
- **验证 oracle：** packaged/unpacked launch smoke test；构建 entry 缺失时 exit/error contract。
- **证据：** `runtime-host/host-process.cjs:1-2`。

### runtime-host/main.ts

- **当前 owner：** runtime-host process entrypoint / Delivery-adjacent bootstrap glue；业务/HTTP route state不在此文件。进程 supervision、shutdown/cancellation primitives的未来基本 owner为 Foundation Kernel，不是 Platform Core。
- **职责与关键 symbols：** module load创建 composition `runtimeHostProcess`；监听 IPC `message`；仅 object且含 `type==='matchaclaw:shutdown'` 时 fire-and-forget `shutdown(0)`；调用 `start()`，失败写 stderr并 `process.exit(1)`。
- **旧语义与策略：** 创建失败在 import/composition阶段不会被 start catch覆盖；IPC message只浅检查，不验证 sender/capability/nonce；重复 shutdown message可重复调用（幂等性由 process服务决定）；`void shutdown`不 await，message handler不设 catch；start failure总硬退出 1；正常启动不显式 ready event。本入口不解析 HTTP/JSON token/secret。
- **状态、存储与副作用：** module singleton持有 runtime process；注册 Node IPC listener；启动/停止进程、stderr、exit。无业务存储。
- **并发与性能特征：** Node event-loop；start调用一次，IPC可并发触发 shutdown；无队列、锁、deadline、backoff。进程 exit时未在此层等待 shutdown。
- **调用/依赖边界：** entry→`createRuntimeHostProcess`（composition外部范围）；CodeGraph链进一步到 route registry dispatcher和 HTTP server；父进程是 shutdown IPC上游。
- **故障、恢复与安全：** `start().catch`记录完整 error后退出；shutdown rejection可能成为 unhandled rejection，**待验证**是否 `shutdown`永不拒绝/内部已处理。IPC信任边界取决于 child-process parent关系，当前文件无 authentication；不能把它当网络 auth。无 restart/retry/recovery实现。
- **迁移分类：** **Preserve：** message type、start failure exit code/log、composition root的单实例启动。**Intentional Improvement：** Rust supervisor应在收到 shutdown时 await/记录失败并定义重复请求幂等 response，但需保持不阻塞 parent lifecycle；当前无 evidence可将其定为 Defect。
- **未来 Rust owner：** **Foundation Kernel**（process lifecycle/supervision/IPC mechanism）与 **Runtime Integration** composition；HTTP delivery本身仍在 Delivery。
- **Rust 重写与性能判断：** async main+supervisor cancellation token、single shutdown task/join；消除的是当前 fire-and-forget cleanup可观测性，不是性能宣称。量测 stop latency、forced exit率、shutdown error记录与重复 shutdown语义。
- **验证 oracle：** child-process integration：normal start、startup reject→stderr/1、valid/invalid IPC message、duplicate shutdown、shutdown reject；CodeGraph composition chain regression。
- **证据：** 本文件 1–19；CodeGraph `createRuntimeHostProcess`→dispatcher→`createRuntimeRouteDispatcher` flow。

## 分片反向核验

- **Inventory：** Python 从当前工作树递归枚举到 37 个 `.ts`/`.cjs` 文件；本文件含 37 条同路径记录，数量一一对应。`api/`、`bootstrap/` 内当前无非源文件；`main.ts`、`main-cli.ts` 与 `host-process.cjs` 均已读。
- **入口/transport：** `main.ts` → composition process → registry dispatcher → `createRuntimeRouteDispatcher`；server 的 `/dispatch` → envelope → handler；webhook 与 agent ingress 是独立 raw JSON/HTTP Event ingress，不走 dispatch envelope。
- **raw/JSON、验证与错误证据：** dispatch raw body有1 MB UTF-8上限、version/method/route校验、400/413/404/500 wrapper；remote agent 与 TeamRun分别64 KiB、独立 content-type/auth/JSON规则；共享 route `readRecord`、capability/session/mode validators、legacy reject tables覆盖输入边界。已确认 `JSON.parse('null')`→500及 malformed percent decode→500 两项 Defect；其余无充分证据者保留“待验证”。
- **token/secret：** provider key direct routes拒绝；license key、fleet plaintext及通用 token/secret字段的 read projection删除；webhook使用 bearer/custom token、动态 token、composition timing-safe compare、body/header redaction；agent bearer/enrollment credential只交下游。没有在本分片发现把 token 持久化的 API owner。
- **C/Q/Event：** HTTP adapter均是 Delivery；GET主要为 Query，POST/PUT只为既有 transport form；明确 Command 的 capability execute、gateway recover、fleet mutations、OpenClaw permission mode；TeamRun webhook和remote agent ingress为 Event ingress。API/Delivery 不应被迁移为 Matcha Platform Core。
- **无源代码修改确认：** 本分片只创建本报告；未修改 `runtime-host` 源文件、测试、共享 README 或其他 agent 文档。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **残留 TypeScript Delivery / Bootstrap；Rust cutover 未证实。** 本次 status 未显示 `runtime-host` Rust production owner；不可将任何 TS relocation 记为 Rust 交割。
- **生产 active path：** `electron/main/index.ts` → `createRuntimeHostManager` → `electron/main/runtime-host-manager.ts` → 新 `electron/main/process-runtime/runtime-host-process-manager.ts` / `adapters/runtime-host-process-adapter.ts` → `runtime-host/host-process.cjs` → `runtime-host/main.ts` → `createRuntimeHostProcess` → `runtime-host/composition/runtime-host-composition.ts` → `createRuntimeHostHttpServer`。其 HTTP 面仍为 `/health`、`/lifecycle/{restart,stop}`、`POST /dispatch`、TeamRun webhook、remote-fleet runtime-agent ingress 和 terminal WebSocket upgrade；`/dispatch` 仍经 dispatcher 进入 TS route handlers。
- **外部旧 owner 与 current-vs-target 边界：** 删除的 `electron/main/runtime-host-process-manager.ts` 已由 `electron/main/process-runtime/**` 的 TS 实现替代；它们当前仍是 active physical lifecycle path，但其 runtime-host launch、readiness、restart/backoff、log、graceful shutdown、process-tree cleanup 与 PID/provenance 语义必须作为 Rust Local Process Host 的**外部旧 owner**纳入迁移闭环，不能因位于 Electron 而排除。Electron 最终只保留窗口、桌面集成及 Command/Query/Event 客户端；本分片的 `host-process.cjs` / `main.ts` 入口和 HTTP transport 则必须在同一功能块的 active-path matrix 中证明已切至 Rust。Peer Runtime 内部 worker/store 及 Session/Gateway/Fleet 领域事实不随此项迁移。
- **旧策略与 future owner：** Preserve 现有 Node child IPC、HTTP envelope、route/auth/error 形状，直到有可执行差分证据。终态由 Rust Matcha Runtime 的 Local Process Host 承接 runtime-host process lifecycle；HTTP/API adapter 仍是 Delivery，Session、Gateway、Fleet 领域事实分别留在其 Domain/Runtime Integration owner。当前 Rust 实现、cutover 与该 owner 转移均**未证明**。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/runtime-host-process-manager-compatibility.test.ts tests/unit/runtime-host-manager.request-transport.test.ts tests/unit/runtime-host-process-dispatch-route-handler.test.ts tests/unit/runtime-host-process-runtime-route-dispatcher.test.ts tests/unit/runtime-host-server-runtime-agent-ingress.test.ts`；`pnpm run check:main-api-boundary`；`pnpm run build:runtime-host-process`。本次均**未运行**。
