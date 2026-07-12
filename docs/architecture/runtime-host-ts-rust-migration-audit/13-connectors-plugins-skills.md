# 13 — Connectors、Plugins、Skills 与 Toolchain 文件级迁移审计

> 状态：静态审计完成。本文记录旧 TypeScript 行为和迁移证据，不构成 Rust 实施批准；未运行测试、未修改生产源、测试、配置或锁文件。

## 范围、方法与覆盖

- **路径权威：**`00-inventory.md` 第 13 分片。Python 递归枚举 `runtime-host/application/external-connectors/**`、`plugins/**`、`skills/**`、`toolchain/**` 当前 `.ts`，inventory **28**、实际 **28**，双向差集为空；`runtime-host/plugins`、`runtime-host/skills`、`runtime-host/toolchain` 不存在，实际范围是 inventory 所列 `application/*` 路径。
- **方法：**先以 CodeGraph 追踪 connector desired store → OpenClaw MCP projection / downstream status / job，以及 plugin install/discovery/config、skill/toolchain source/projection 与 composition job handler；再以 Python UTF-8 `read_text()` 完整读取 28 个文件。范围外只读的证据包括 composition modules、OpenClaw MCP/plugin/skill projections、workflows、capability routes 与测试索引；未执行测试或运行时 I/O。
- **关键边界：**External Connector、Plugin catalog、Skill config 是 Matcha 领域事实/desired state，不能移交给 OpenClaw；OpenClaw plugin/MCP/skill/config 仅是 Runtime Integration / Native Runtime Edge 的 applied projection。`memory-lancedb-pro` 是 OpenClaw managed plugin，不是 Matcha first-party module；system-runtime MCP 是 Matcha 自有 connector，经 OpenClaw MCP config 投影启动但其 session status 仍由 runtime adapter 观察。密钥只允许 private reference / private projection，不能进入公开 config、catalog、日志或状态投影。
- **Defect 纪律：**本轮没有同时具备代码、调用链和测试闭环的 Defect 结论；风险均标为待验证。下述 Rust 改进均须保留观察语义并做差分、fault 和（若声称优化）benchmark oracle。

## 已读文件（28）

1. `runtime-host/application/external-connectors/external-connector-capability.ts`
2. `runtime-host/application/external-connectors/external-connector-connection-status.ts`
3. `runtime-host/application/external-connectors/external-connector-downstream-status.ts`
4. `runtime-host/application/external-connectors/external-connector-json-store.ts`
5. `runtime-host/application/external-connectors/external-connector-model.ts`
6. `runtime-host/application/external-connectors/external-connector-service.ts`
7. `runtime-host/application/external-connectors/external-connector-store.ts`
8. `runtime-host/application/external-connectors/external-mcp-server-program-catalog.ts`
9. `runtime-host/application/plugins/catalog.ts`
10. `runtime-host/application/plugins/managed-plugin-catalog.ts`
11. `runtime-host/application/plugins/plugin-companion-skill-service.ts`
12. `runtime-host/application/plugins/plugin-groups.ts`
13. `runtime-host/application/plugins/plugin-lifecycle-registry.ts`
14. `runtime-host/application/plugins/plugin-lifecycle-types.ts`
15. `runtime-host/application/plugins/plugin-lifecycles/memory-lancedb-pro-lifecycle.ts`
16. `runtime-host/application/plugins/plugin-runtime-jobs.ts`
17. `runtime-host/application/plugins/plugin-runtime-service.ts`
18. `runtime-host/application/plugins/runtime-plugin-registry.ts`
19. `runtime-host/application/plugins/runtime-plugin-service.ts`
20. `runtime-host/application/skills/clawhub-cli.ts`
21. `runtime-host/application/skills/clawhub-jobs.ts`
22. `runtime-host/application/skills/clawhub-registry-client.ts`
23. `runtime-host/application/skills/clawhub.ts`
24. `runtime-host/application/skills/service.ts`
25. `runtime-host/application/skills/skills-jobs.ts`
26. `runtime-host/application/skills/store.ts`
27. `runtime-host/application/toolchain/toolchain-jobs.ts`
28. `runtime-host/application/toolchain/uv-service.ts`

---

## External Connectors

### runtime-host/application/external-connectors/external-connector-capability.ts

- **当前 owner：**Matcha Environment / Extension Domain 的 capability route declaration；不拥有 connector 状态或 OpenClaw 协议。
- **职责与关键 symbols：**`EXTERNAL_CONNECTOR_CAPABILITY_ID`、四个 `externalConnectors.*` descriptor、`createExternalConnectorCapabilityOperationRoutes`。
- **旧语义与策略：**声明 list/get/upsert/remove 均以 `runtime-endpoint` 为 target；无本地验证，原样把 `context.domainInput` 委派 service。
- **状态、存储与副作用：**纯 route 构建；下游 service 才读写 desired store、触发 projection。
- **并发与性能特征：**常数路由数组；无队列、锁或 I/O。
- **调用/依赖边界：**composition external-connectors module 注入 capability registry；OpenClaw runtime adapter 消费 capability 声明，不代表 OpenClaw 拥有 connector。
- **故障、恢复与安全：**授权/输入拒绝由 capability router 与 service；无 secret。
- **迁移分类：**Preserve：operation id、target kind 和 domain-input forwarding。待验证：是否应公开 connection/status operations。无 Defect 结论。
- **未来 Rust owner：**Matcha Platform Core（capability grammar / route registration）；Environment / Extension Domain 提供 handler。
- **Rust 重写与性能判断：**静态 typed route table；没有旧性能成本，不应以迁移为由优化。
- **验证 oracle：**capability registry route/id fixture；证据为 external-connectors composition module、`capability-registry.test.ts`。
- **证据：**source `createExternalConnectorCapabilityOperationRoutes`；external-connectors composition module 注册；报告引用 `capability-registry.test.ts`（未执行）。

### runtime-host/application/external-connectors/external-connector-connection-status.ts

- **当前 owner：**Environment / Extension Domain 的安全 connector connectivity probe policy。
- **职责与关键 symbols：**`ExternalConnectorConnectionProbeService`、status union、5 秒默认超时、MCP initialize JSON-RPC probe。
- **旧语义与策略：**disabled 直接 `disabled`；system-runtime MCP 直接 `unsupported`（只能经 downstream session 观察）；仅 `mcp-http` 发 initialize，`sse` 使用 GET、其他用 POST，使用 connector timeout 或 5 秒；HTTP/JSON-RPC/网络错误映射 disconnected，CLI/SDK/HTTP 等未主动执行的类型为 unsupported/unknown；全结果带 safeProbe 表示是否实际安全探测。
- **状态、存储与副作用：**无持久状态；HTTP 请求、AbortController 和 timer；clock 生成检查时刻/延迟。
- **并发与性能特征：**每 connector 一个独立 request，service `Promise.all` 并行探测；没有全局限流，成本为 O(connectors) 网络请求。
- **调用/依赖边界：**`ExternalConnectorService.listConnectionStatuses`/`probeConnectionStatus` 调用；其后不等于 OpenClaw session 状态。
- **故障、恢复与安全：**timeout finally 清 timer；不执行 stdio command，避免副作用；错误 reason 可能含远端文本，公开前需边界审查；无 secret header 注入。
- **迁移分类：**Preserve：只 probe mcp-http、system-runtime 排除、transport/timeout/JSON-RPC 判定和错误折叠。Intentional Improvement：可加有界并发，但须保持每项完成/错误结果与无重试语义。待验证：GET SSE initialize 与服务端兼容性、无全局限流是否造成启动突刺。
- **未来 Rust owner：**Environment / Extension Domain；HTTP transport 原语可用 Foundation，但 probe policy 不可下沉。
- **Rust 重写与性能判断：**typed `ProbeOutcome` + cancellable HTTP request；若加 semaphore，消除旧 O(n) 瞬时连接成本，保持并行结果及 timeout，量度并发连接数、probe p95、超时率，以 TS fake HTTP differential + timeout fault + 规模 benchmark 为 oracle。
- **验证 oracle：**mock HTTP vectors：disabled/system-runtime、SSE/streamable request、非 2xx、malformed JSON-RPC、abort/throw、clock latency。
- **证据：**source `ExternalConnectorConnectionProbeService`；`ExternalConnectorService.listConnectionStatuses`/`probeConnectionStatus` 调用；HTTP mock vectors 待补。

### runtime-host/application/external-connectors/external-connector-downstream-status.ts

- **当前 owner：**Environment / Extension Domain 的 connector-to-session downstream status contract 与输入 decoder。
- **职责与关键 symbols：**status/details/context/provider interfaces、`readSessionIdentityPayload`。
- **旧语义与策略：**从 `payload.sessionIdentity ?? payload` 宽容读取；要求 agentId、sessionKey、endpoint runtimeAdapterId/runtimeInstanceId/protocolId/connectorId/endpointId 为 trim 后非空，任何缺失返回 null；provider 接收 connector specs 与可选 endpointSessionId。
- **状态、存储与副作用：**纯类型/解码，无 I/O。
- **并发与性能特征：**O(字段数)，无可变状态。
- **调用/依赖边界：**service 按注册 provider 顺序聚合 status；OpenClaw MCP status provider 是下游 observation adapter，Session context resolver 只补 endpoint session id。
- **故障、恢复与安全：**不可信 payload fail-closed 为 bad request；不处理 secret。
- **迁移分类：**Preserve：identity 完整性、trim 和 null 拒绝。待验证：多个 provider 返回同一 connector 的去重/优先级需求。无 Defect 结论。
- **未来 Rust owner：**Environment / Extension Domain；session identity grammar引用 Matcha Platform Core，不反向拥有。
- **Rust 重写与性能判断：**typed extractor；无旧性能成本和优化主张。
- **验证 oracle：**identity table：嵌套/直传、空白、array、各缺字段；证据为 connector service、OpenClaw downstream provider。
- **证据：**source `readSessionIdentityPayload`；connector service 聚合 OpenClaw downstream provider；identity table fixture 待补。

### runtime-host/application/external-connectors/external-connector-json-store.ts

- **当前 owner：**Environment / Extension Domain 的 connector desired-state JSON persistence adapter。
- **职责与关键 symbols：**`ExternalConnectorRuntimeDataPort`、`ExternalConnectorJsonStore.readConnectors/writeConnectors`。
- **旧语义与策略：**固定 `external-connectors.json`；缺文件返回空；读 JSON 后只取 `connectors` array 并逐项 `assertExternalConnectorSpec`；写 `{version:1,connectors}`、pretty JSON 加尾换行，并在写前 ensure runtime data directory。
- **状态、存储与副作用：**文件读/parse/目录创建/写；该文件是用户 connector desired source，而不是 OpenClaw applied config。
- **并发与性能特征：**全量读取/全量重写，O(n + JSON bytes)；无锁、原子 replace、版本迁移或 cache。
- **调用/依赖边界：**`ExternalConnectorRepository` 每操作 load 后回写；composition 注入 runtime-data/filesystem。OpenClaw MCP projection 只读 service snapshot。
- **故障、恢复与安全：**缺文件容忍；parse/validation/write 错误传播；文件可包含 `secretEnv`/`secretHeaders` references，不能允许真实 secret 落入其中。并发读改写丢失更新风险待验证。
- **迁移分类：**Preserve：path、missing→[]、strict per-entry validation、版本 1 JSON 形状。Intentional Improvement：Foundation storage 可提供 atomic write/lock；要明确 crash/并发可观察变化。无 Defect 结论。
- **未来 Rust owner：**Environment / Extension Domain（schema/path/desired facts）；Foundation Kernel（generic atomic storage/lock、secret redaction primitive）。
- **Rust 重写与性能判断：**先以 transactional read-modify-write 或 single domain writer 消除全量写并发覆盖/partial-write 成本；保持 byte-level schema、missing语义与失败传播；量度 bytes written、p95 mutation、crash recovery、lost-update 数；以 old/new file fixtures differential、write-fault/crash injection、并发 benchmark 为 oracle。
- **验证 oracle：**temp-dir fixtures：missing、bad JSON、invalid entry、directory create、serialized version/format、write fail、parallel mutation。
- **证据：**source `ExternalConnectorJsonStore.readConnectors`/`writeConnectors`；`ExternalConnectorRepository` 调用、composition 注入 runtime-data/filesystem；temp-dir fixture 待补。

### runtime-host/application/external-connectors/external-connector-model.ts

- **当前 owner：**Environment / Extension Domain 的 connector desired-spec、secret separation 和 compatibility validation owner。
- **职责与关键 symbols：**five kind variants、MCP program reference、secret ref、`validateExternalConnectorSpec`/`assertExternalConnectorSpec`。
- **旧语义与策略：**ID 1–128 字符 pattern；kind-specific command/url/provider required；optional display/description/tags/timeout/transport/maps 校验；MCP program source allowlist；public `env`/`headers` 和 SDK config 检查 secret-like key，process env 拒绝受控 Node/Electron env key；真实 secret 只允许 `{secretRef}` maps；有效输入 structuredClone 返回。
- **状态、存储与副作用：**纯验证/clone；不解析 secret value、不访问网络。
- **并发与性能特征：**线性遍历 maps/嵌套 config；无 I/O。
- **调用/依赖边界：**repository 再验证 persisted data，service 验证 ingress；OpenClaw MCP projection 以 `secretEnv/secretHeaders` 非空拒绝公开投影，要求独立 private projection。
- **故障、恢复与安全：**核心安全边界：未知/inline secret key 拒绝，不能把 heuristic 当作完整 secret scanner；引用值仍属 Foundation secret store/Environment policy。验证错误必须不回显 secret。
- **迁移分类：**Preserve：discriminated kind schema、all reject/default rules、public/private map 分离与 clone isolation。待验证：secret-key regex 覆盖率、secretRef name/权限校验、old persisted invalid data 的迁移策略。无 Defect 结论。
- **未来 Rust owner：**Environment / Extension Domain（connector policy/schema）；Foundation Kernel（secret handle、redaction、encrypted persistence机制）。
- **Rust 重写与性能判断：**serde tagged enum + explicit validation returning sanitized error; 不得因 Rust type system 放松 runtime untrusted JSON validation。无优化结论；若做 streaming parser，必须列旧 JSON clone 成本、保持错误顺序、量度 CPU/allocation，并以 validation corpus differential oracle 回归。
- **验证 oracle：**per-kind valid/invalid corpus、reserved env、secret-like public key/nested config、secret ref map、URL/timeout/transport、clone mutation isolation。
- **证据：**source `validateExternalConnectorSpec`/`assertExternalConnectorSpec`；repository/service ingress 与 OpenClaw MCP projection 使用；validation corpus 待补。

### runtime-host/application/external-connectors/external-connector-service.ts

- **当前 owner：**Environment / Extension Domain 的 connector desired-state application service；不是 OpenClaw config source。
- **职责与关键 symbols：**`ExternalConnectorService`、projection/provider ports、system-runtime virtual connector、CRUD、connection/downstream status、`syncDownstreamProjections`。
- **旧语义与策略：**每次 list 从 repository 读取并 append/sort immutable `matcha` system-runtime connector；禁止 get/upsert/remove 将其当用户项。upsert 先 validate、持久化再串行 sync 所有 projections，单 projection 失败折叠为 `failed` 结果而不回滚 desired write；remove 同理。connection probe 并行；downstream providers 串行追加 status。payload connectorId 支持 `connectorId` 后备 `id`。
- **状态、存储与副作用：**自身内存 registries 保存按注册顺序的 projection/provider；repository 文件写和 projections（OpenClaw config）是副作用。desired/applied 没有显式 durable version/receipt。
- **并发与性能特征：**list 全量 store 读；status probes `Promise.all`；projection/provider 顺序串行；无 mutation serialization，repository 的每次 load/write 可竞态。
- **调用/依赖边界：**API/capability route 上游；`connectOpenClawApplicationServices` 注册 `ExternalConnectorOpenClawMcpProjectionService` 和 downstream status provider。OpenClaw projection 会 patch `mcp.servers`、清旧 Matcha-managed id、标 `commands.restart`；它不投影含 secret refs 的 connector。其 MCP status job 是 observed state refresh，不反写 desired。
- **故障、恢复与安全：**service response 折叠 mutation/each projection失败；projection错误不影响后续 projection；system connector immutable。对 absent private secret projection 的 connector，OpenClaw projection明确 skip，防止秘密进入 public config；但 desired 写后 applied 不一致只能由返回值/重试 reconciliation 发现。
- **迁移分类：**Preserve：system connector virtual/immutable、desired first、projection顺序与单项失败保留、无回滚、status两类区别。Intentional Improvement：为 desired/applied/observed 引入 versioned reconciliation receipt 与 durable retry，而不能把失败伪装成功。待验证：sync 是否在所有启动/secret变更后运行、并发 CRUD 的线性化语义。无 Defect 结论。
- **未来 Rust owner：**Environment / Extension Domain（desired facts、reconcile policy）；Runtime Integration（OpenClaw MCP applied projection/status）；Foundation Kernel（durable job/retry/receipt/secret mechanism）。
- **Rust 重写与性能判断：**per-environment single writer actor 或 optimistic revision store；旧成本是全量 reload/write 和 mutation竞态，保持 desired-first/nonrollback、provider order、partial result；指标 mutation p95、lost updates、projection lag、reconcile convergence；TS/Rust CRUD+projection differential、config-write/secret-resolution fault、parallel mutation benchmark oracle。
- **验证 oracle：**existing `external-connector-service.test.ts` 加 virtual system connector, invalid/missing, partial projection failure, remove, status/provider order；mock OpenClaw config differential。
- **证据：**source `ExternalConnectorService.syncDownstreamProjections`；`connectOpenClawApplicationServices` 注册 MCP projection/provider；报告引用 `external-connector-service.test.ts`（未执行）。

### runtime-host/application/external-connectors/external-connector-store.ts

- **当前 owner：**Environment / Extension Domain 的 in-memory desired registry 与 persistence repository。
- **职责与关键 symbols：**`ExternalConnectorStorePort`、`ExternalConnectorRegistry`、`ExternalConnectorRepository`、upsert result union。
- **旧语义与策略：**registry `Map` 按 insertion order list，constructor/each upsert 重新验证，读写边界 structuredClone；repository 每个 operation 从 store fresh-load，upsert then full write，remove only writes when found。
- **状态、存储与副作用：**registry 短暂内存；store port 决定文件 I/O；不保留 cache/revision。
- **并发与性能特征：**load O(n)、full rewrite O(n)，Map lookup O(1)；并发 read-modify-write 无隔离。
- **调用/依赖边界：**service 使用 Pick CRUD；json store实现 port，Memory store可测试。list sort 不是这里做，而是在 service append system connector 后做。
- **故障、恢复与安全：**invalid persisted entry 阻断 load；write errors传播；clone防调用者篡改内存；不拥有 secret material。
- **迁移分类：**Preserve：clone isolation、create/update classification、missing remove 无写、fresh-load semantics。Intentional Improvement：revision/CAS 或 actor serialization；待验证：持久文件 insertion order是否对用户可见。无 Defect 结论。
- **未来 Rust owner：**Environment / Extension Domain；Foundation Kernel仅提供 transactional KV/file primitive。
- **Rust 重写与性能判断：**domain repository atop revisioned storage；消除全量 reconstruction和 lost update，保留 validation及 result type；量度 allocation、write amplification、conflict/lost update；file-fixture differential、concurrent writers fault/benchmark oracle。
- **验证 oracle：**registry clone/insertion/update/remove cases，repository write/no-write/error/invalid persisted fixture。
- **证据：**source `ExternalConnectorRegistry`/`ExternalConnectorRepository`；service 经 JSON store port 调用；registry/repository fixture 待补。

### runtime-host/application/external-connectors/external-mcp-server-program-catalog.ts

- **当前 owner：**Environment / Extension Domain 的 install-layout discovery 到 connector-program catalog projection；不是 connector desired store。
- **职责与关键 symbols：**program descriptor/snapshot/issue、system IDs、`ExternalMcpServerProgramCatalog.snapshot`。
- **旧语义与策略：**catalog永远先含 Matcha system-runtime program；聚合 configured/bundled plugin、MCP app roots，resolve+source/layout 去重；根目录列举或 manifest read/parse errors记录 issue 并继续。`.mcp.json` 的 `mcpServers` 逐项生成 stdio/http descriptor，优先 command，其次 url，展开 `${__dirname}`；MCP app 使用 `cli.cjs`。输出按 id sort。
- **状态、存储与副作用：**只读文件系统、环境 resources/config paths；无写、缓存或执行。
- **并发与性能特征：**roots/entries/manifest顺序扫描，O(roots+entries+manifest bytes)，无并发和 cache。
- **调用/依赖边界：**service listMcpServerPrograms 暴露 catalog；输入来自 Native Runtime Edge install layout。用户可据 descriptor 创建 desired connector，OpenClaw MCP projection随后只消费 connector spec。
- **故障、恢复与安全：**untrusted manifest仅作为 metadata，未执行；issue公开时不得泄绝对敏感路径；无 path containment/signature/trust policy。重复 ID/manifest malformed的保留规则是排序/issue策略，待补测试。
- **迁移分类：**Preserve：built-in first inclusion、root dedupe、continue-with-issue、manifest command/url precedence、token expansion、sorted snapshot。Intentional Improvement：受限并发/mtime cache必须维持 deterministic output及所有 issue。无 Defect 结论。
- **未来 Rust owner：**Environment / Extension Domain（catalog policy）与 Native Runtime Edge（OpenClaw/bundle layout adapter）；Foundation仅可提供 safe filesystem primitive。
- **Rust 重写与性能判断：**stable ordered collector；若缓存，消除重复全目录/JSON扫描，保持 snapshot/issue语义，量度 catalog startup、stat/read count、stale detection，以 fake FS differential + malformed/missing fault + cold/warm benchmark oracle。
- **验证 oracle：**roots duplicate/missing、`.mcp.json` variants、MCP app、`${__dirname}`、bad JSON/permission、duplicate descriptor stable order。
- **证据：**source `ExternalMcpServerProgramCatalog.snapshot`；service `listMcpServerPrograms` 暴露；fake-FS catalog fixture 待补。

---

## Plugins

### runtime-host/application/plugins/catalog.ts

- **当前 owner：**Extension Domain 的 runtime plugin catalog merge/read repository。
- **职责与关键 symbols：**`mergePluginCatalogSnapshots`、`PluginCatalogRepository.discover`。
- **旧语义与策略：**先以 discovered 建 Map，再覆盖 injected 同 id；按 `group`、再 `name`/`id` English locale stable comparison 排序。repository只委派 discovery。
- **状态、存储与副作用：**纯 merge；discover 下游为 filesystem plugin discovery。
- **并发与性能特征：**Map O(n)、sort O(n log n)，无 I/O自身。
- **调用/依赖边界：**registry refresh 将 discovered + injected catalog 合并；injected 是 Matcha composition input，discovered 是 Native Edge filesystem projection。
- **故障、恢复与安全：**无 schema validation，输入信任上游 loader；无 secret。
- **迁移分类：**Preserve：injected-over-discovered collision及排序。待验证：同 id metadata owner/override是否产品意图。无 Defect。
- **未来 Rust owner：**Extension Domain（catalog policy）；Native Runtime Edge提供发现。
- **Rust 重写与性能判断：**ordered map/vector；无必要优化。
- **验证 oracle：**duplicate/id/group/name sort table；证据为 registry refresh、plugin discovery workflow。
- **证据：**source `mergePluginCatalogSnapshots`；registry refresh 合并 discovery workflow 输出；排序 collision table 待补。

### runtime-host/application/plugins/managed-plugin-catalog.ts

- **当前 owner：**Extension Domain 对受控 OpenClaw plugin 的声明 port，不拥有安装实现。
- **职责与关键 symbols：**managed plugin/companion skill definition、catalog/installer ports、managed snapshot type。
- **旧语义与策略：**仅类型契约：definition关联 plugin id、可选 companion skill和安装入口；无默认、验证、I/O或状态机。
- **状态、存储与副作用：**无。
- **并发与性能特征：**无。
- **调用/依赖边界：**`RuntimePluginRepository` 委派 OpenClaw managed plugin catalog/installer projection；具体 OpenClaw definitions属于 Native Runtime Edge。
- **故障、恢复与安全：**installer失败语义由实现；不携带 secret。
- **迁移分类：**Preserve：port隔离。待验证：definition是否应签名/版本锁定。无 Defect。
- **未来 Rust owner：**Extension Domain（Matcha managed intent port）；Native Runtime Edge（OpenClaw installer/catalog实现）。
- **Rust 重写与性能判断：**traits/typed IDs；无性能结论。
- **验证 oracle：**fake port compile/interaction tests；OpenClaw managed catalog fixtures。
- **证据：**source managed plugin/catalog/installer ports；`RuntimePluginRepository` 委派 Native Runtime Edge catalog/installer；fake-port fixture 待补。

### runtime-host/application/plugins/plugin-companion-skill-service.ts

- **当前 owner：**Extension Domain 的 plugin companion-skill orchestration façade。
- **职责与关键 symbols：**`PluginCompanionSkillService.ensureInstalled` 和 workspace port re-export。
- **旧语义与策略：**仅向 workflow 委派 pluginId；不存在本地幂等/验证/retry。
- **状态、存储与副作用：**无自身状态；workflow写 OpenClaw workspace skill assets。
- **并发与性能特征：**单 await；并发/文件冲突由 workflow处理。
- **调用/依赖边界：**plugin lifecycle / runtime module上游，plugin companion skill workflow下游；这是 Matcha针对 OpenClaw plugin 的投影辅助，不是 OpenClaw skill本身的 canonical catalog。
- **故障、恢复与安全：**错误直传；文件内容/路径安全属 workflow。无 secret。
- **迁移分类：**Preserve：thin delegation。待验证：重复ensure并发和 cleanup ownership。无 Defect。
- **未来 Rust owner：**Extension Domain orchestration；Runtime Integration / Native Runtime Edge实现 OpenClaw workspace materialization。
- **Rust 重写与性能判断：**一个 port call，不引入 actor；无性能主张。
- **验证 oracle：**fake workflow invokes once/error propagation；workflow temp-dir tests。
- **证据：**source `PluginCompanionSkillService.ensureInstalled`；plugin lifecycle/runtime module 调用 companion-skill workflow；workspace temp-dir fixture 待补。

### runtime-host/application/plugins/plugin-groups.ts

- **当前 owner：**Extension Domain 的 catalog group classification policy。
- **职责与关键 symbols：**`pickCatalogGroup`、channel category/id sets。
- **旧语义与策略：**category trim/lowercase；`controlMode=channel-config`、channel category或`voice-call`归 channel；model类线索归 model，否则 general。
- **状态、存储与副作用：**纯函数。
- **并发与性能特征：**O(1)。
- **调用/依赖边界：**catalog injected parser和merge/registry用于 UI/runtime projection；不决定 OpenClaw 实际 load。
- **故障、恢复与安全：**不验证 plugin metadata；无 secret。
- **迁移分类：**Preserve：precedence与normalization。待验证：hardcoded `voice-call`、模型线索集合完整性。无 Defect。
- **未来 Rust owner：**Extension Domain。
- **Rust 重写与性能判断：**enum classifier；无优化。
- **验证 oracle：**category/controlMode/id precedence matrix。
- **证据：**source `pickCatalogGroup`；injected catalog parser 与 merge/registry 使用；precedence matrix 待补。

### runtime-host/application/plugins/plugin-lifecycle-registry.ts

- **当前 owner：**Extension Domain 的 managed plugin transition/startup lifecycle dispatcher。
- **职责与关键 symbols：**registered lifecycle map、`RuntimePluginLifecycleRunner` four apply/run methods。
- **旧语义与策略：**仅对注册 plugin id 依次调用 optional config 和 side-effect hooks；transition context带 pluginId/enabled/config、workspace/installer/companion skill；startup按 enabled ids。缺 lifecycle/hook静默跳过，hook错误传播并中断后续调用。
- **状态、存储与副作用：**registry module-level immutable mapping；config hook 可变更 OpenClaw config object，side-effect可安装plugin/写workspace。
- **并发与性能特征：**for-of 串行，确保 lifecycle order；无 retry/cleanup/transaction。
- **调用/依赖边界：**runtime plugin lifecycle workflow使用；`memory-lancedb-pro`是当前唯一注册实现。上游 desired enabled IDs，downstream OpenClaw config/installer/workspace。
- **故障、恢复与安全：**失败直接传播，未补偿已执行 hook；不得将 config hook放进 public Matcha desired config。无 secret logic。
- **迁移分类：**Preserve：registered set、serial/order、missing no-op、failure propagation。Intentional Improvement：每 hook 生成 receipt、声明compensation再引入 retry。待验证：transition state重复提交的幂等性与启动/transition竞态。无 Defect。
- **未来 Rust owner：**Extension Domain（lifecycle policy）；Runtime Integration/Native Runtime Edge（OpenClaw config/install/workspace effects）。
- **Rust 重写与性能判断：**ordered lifecycle trait list；旧成本非性能而是无 durable receipt，保留顺序/short-circuit，量度 convergence/partial-effect cleanup，使用 scripted hook differential、throw fault、restart recovery oracle。
- **验证 oracle：**fake lifecycles order/missing/failure and config mutation fixtures；memory lifecycle config fixtures。
- **证据：**source `RuntimePluginLifecycleRunner`；plugin lifecycle workflow 调用、`memory-lancedb-pro` 为注册实现；scripted lifecycle fixture 待补。

### runtime-host/application/plugins/plugin-lifecycle-types.ts

- **当前 owner：**Extension Domain lifecycle hook contract。
- **职责与关键 symbols：**transition/startup config/side-effect contexts、`RuntimePluginLifecycle` optional hooks。
- **旧语义与策略：**类型只区分 config mutation 与 side effects、transition与startup；没有运行时校验或默认。
- **状态、存储与副作用：**无；ports中可能携带 config、workspace、installer。
- **并发与性能特征：**无。
- **调用/依赖边界：**runner和 lifecycle implementations；OpenClaw-specific types不该向 Matcha Platform Core 泄漏。
- **故障、恢复与安全：**secret/config安全全由具体 hook/projection。
- **迁移分类：**Preserve：四阶段边界。待验证：取消、deadline、compensation contract。无 Defect。
- **未来 Rust owner：**Extension Domain；OpenClaw edge effect traits在 Runtime Integration/Native Runtime Edge。
- **Rust 重写与性能判断：**async trait contexts with explicit effect receipt；无性能结论。
- **验证 oracle：**compile-time trait wiring + runner interaction tests。
- **证据：**source `RuntimePluginLifecycle` contexts；runner 与 lifecycle implementations 消费；trait wiring interaction test 待补。

### runtime-host/application/plugins/plugin-lifecycles/memory-lancedb-pro-lifecycle.ts

- **当前 owner：**Native Runtime Edge 的 `memory-lancedb-pro` OpenClaw managed-plugin config compatibility policy。
- **职责与关键 symbols：**plugin/model constants、`ensureMemoryPluginConfigured`、`releaseMemorySlot`、`memoryLancedbProLifecycle`。
- **旧语义与策略：**enable时确保 plugin slot/entry/config，缺 embedding provider/model填 local-minilm/Xenova defaults，缺 extract/session-memory defaults填入；disable时仅移除该 slot而保留 entries/config；startup config同 enable；side-effect ensure managed install，enable再 ensure companion skill。已有用户值不覆盖。
- **状态、存储与副作用：**就地修改 OpenClaw config record；installer/companion workspace I/O由 port。
- **并发与性能特征：**record traversal常数深度；runner串行，no cache。
- **调用/依赖边界：**lifecycle registry→OpenClaw plugin config workflow/projection、managed installer、companion skill workflow。它配置第三方/OpenClaw plugin，绝非 Matcha first-party memory domain。
- **故障、恢复与安全：**install/skill ensure error传播；disable不清垃圾配置为保留策略；embedding/provider config可能含未来敏感字段，必须走 private config projection。待验证：slot移除而entry保留是否会导致再启用陈旧配置。
- **迁移分类：**Preserve：non-destructive defaults、disable仅slot、startup enable、effect顺序。Intentional Improvement：将每个改动建 typed OpenClaw config patch与 receipt，明确 rollback；无 Defect。
- **未来 Rust owner：**Native Runtime Edge（OpenClaw plugin semantics）；Runtime Integration实施 patch/installer；Environment/Extension Domain只持有“managed plugin enabled”意图。
- **Rust 重写与性能判断：**typed JSON patch，非性能迁移；若避免 repeated clone，旧成本是 nested-record clone/serialization，保持用户值/slot语义，量度 config patch bytes/latency，fixture differential + installer failure fault oracle。
- **验证 oracle：**enable absent/partial/user overrides、disable, startup, installer/companion call order/error fixtures。
- **证据：**source `ensureMemoryPluginConfigured`/`memoryLancedbProLifecycle`；lifecycle registry 经 OpenClaw config/install/workspace workflow 调用；config fixture 待补。

### runtime-host/application/plugins/plugin-runtime-jobs.ts

- **当前 owner：**Extension Domain 的 plugin mutation/catalog background-job submission policy。
- **职责与关键 symbols：**`SET_ENABLED_PLUGINS_JOB`、`REFRESH_PLUGIN_CATALOG_JOB`、dedupe key、job port factory。
- **旧语义与策略：**set-enabled key以 enabled state + distinct sorted ids，queue `critical`；refresh使用 global dedupe/cooldown并可查询 latest job。实际 retry/backoff/cancel/cleanup由 runtime long-task supervisor，不在本文件。
- **状态、存储与副作用：**纯 submission adapter，写入 supervisor队列。
- **并发与性能特征：**sort O(n log n)确保同集合去重；无本地 queue。
- **调用/依赖边界：**registry enqueue refresh；plugin runtime workflow提交 set；composition `plugin-runtime-module` handler调用 registry refresh/enable flow。
- **故障、恢复与安全：**payload不含 secret；dedupe不代表已成功或 applied，job failure由 supervisor exposed snapshot。待验证：set transitions key区分顺序但不含 environment/revision是否足够。
- **迁移分类：**Preserve：job names、critical/refresh policy、canonical dedupe key。待验证：retry/cleanup和 cancellation 的跨任务语义。无 Defect。
- **未来 Rust owner：**Extension Domain（job intent/dedupe）；Foundation Kernel（job store/retry/cancel/deadline/cleanup机制）。
- **Rust 重写与性能判断：**submit typed command to Foundation supervisor；无旧性能成本除排序。若替换排序为 set hash，必须保持 key等价并量度 submission allocation，以 canonical-key differential oracle。
- **验证 oracle：**identical reordered IDs dedupe、enable/disable separation、queue/lookup arguments、supervisor failure/retry tests。
- **证据：**source `createPluginRuntimeJobPort`；`plugin-runtime-module` handler 调用 registry refresh/enable flow；job submission fixture 待补。

### runtime-host/application/plugins/plugin-runtime-service.ts

- **当前 owner：**Extension Domain 的 runtime plugin application façade。
- **职责与关键 symbols：**`PluginRuntimeService`、`PluginRuntimeServiceDeps`。
- **旧语义与策略：**methods仅转发 registry snapshot、enqueue、set、execute set-enabled；无附加默认/validation/retry。
- **状态、存储与副作用：**无自身状态；registry可能写 config、restart gateway、submit refresh。
- **并发与性能特征：**O(1) delegation。
- **调用/依赖边界：**plugin capability/operation routes上游，registry下游；不直接拥有 OpenClaw installation/discovery。
- **故障、恢复与安全：**错误直传；无 secret。
- **迁移分类：**Preserve：façade public behavior。无 Defect；可在Rust直接由 domain service替代该单层。
- **未来 Rust owner：**Extension Domain。
- **Rust 重写与性能判断：**不需要一对一 façade；保持 API contract即可，无性能结论。
- **验证 oracle：**fake registry forwarding/method surface test。
- **证据：**source `PluginRuntimeService`；plugin capability/operation routes 转发至 registry；forwarding test 待补。

### runtime-host/application/plugins/runtime-plugin-registry.ts

- **当前 owner：**Extension Domain 的 in-memory plugin desired/applied view registry和 refresh orchestration。
- **职责与关键 symbols：**`RuntimePluginRegistry` snapshots、refresh/set/execute set、fallback/injected parsers。
- **旧语义与策略：**初始化 fallback enabled/injected catalog clones；refresh先读 enabled config，成功则 merge discovered+injected，否则降级只用 injected并仍使用 read出的 enabled/fallback且 warn；set写 config后 enqueue refresh；execute set后要求 gateway restart success，返回 payload+latest refresh job。两 env JSON parsers非法值→[]，injected需核心 fields且补 group/platform。
- **状态、存储与副作用：**mutable arrays；repository读 OpenClaw config/discovery/install records，jobs提交，gateway restart，logger。这里是 desired enabled view与 discovery applied/observed view混合，但没有显式版本。
- **并发与性能特征：**arrays clone，merge Map/sort；refresh/set无single-flight，可能交错覆盖内存 snapshot。
- **调用/依赖边界：**plugin runtime service/routes上游；repository跨 OpenClaw projection ports；runtime state builder构建 public payload。OpenClaw config仍applied，不应作为 Matcha managed intent的唯一 owner。
- **故障、恢复与安全：**discovery失败的降级可用、但 config read失败在try外直接失败；restart失败在config改变后抛，导致 desired/applied暂时不一致；logger error 不应含 config secrets。待验证：restart failure后的自动 reconcile和 refresh concurrency。
- **迁移分类：**Preserve：fallback/injected parsing、discovery-failure fallback、set→refresh→restart ordering与 failure exposure。Intentional Improvement：显式 desired/applied/observed revisions及 restart/reconcile receipt。无 Defect。
- **未来 Rust owner：**Extension Domain（desired/catalog view）；Runtime Integration（OpenClaw config/discovery/restart projection）；Foundation Kernel（job/retry receipt storage）。
- **Rust 重写与性能判断：**single domain actor/revisioned state；旧成本是 repeated clone/sort和 concurrent stale overwrite，保持 fallback/degrade ordering，量度 refresh latency/stale overwrites/restart convergence，以 mock ports differential、restart fail/retry fault、parallel refresh benchmark oracle。
- **验证 oracle：**invalid env, catalog collision/group/platform, discovery fail, config read fail, restart fail, interleaved refresh/set scenarios。
- **证据：**source `RuntimePluginRegistry`；plugin runtime service/routes 调用、repository 连接 OpenClaw projection ports；mock-port fixture 待补。

### runtime-host/application/plugins/runtime-plugin-service.ts

- **当前 owner：**Extension Domain repository facade over OpenClaw plugin config/catalog/install projections。
- **职责与关键 symbols：**four port interfaces、`RuntimePluginRepository`。
- **旧语义与策略：**每个 method直接委派：install managed、list catalog/enabled/configured, ensure configured installs, ensure enabled, set enabled, source/target signatures；force defaults false。
- **状态、存储与副作用：**自身无状态；delegate可能读写 OpenClaw config、filesystem、install records。
- **并发与性能特征：**O(1) delegation；no retry/serialization。
- **调用/依赖边界：**registry/lifecycle上游；OpenClaw plugin config/discovery/managed installer projections下游。ports防止 Extension Domain直接依赖具体 OpenClaw implementation。
- **故障、恢复与安全：**errors直传；config/signature metadata不得公开 secret。无 cleanup policy本身。
- **迁移分类：**Preserve：port separation、force default。待验证：source/target signature是否具备强一致性。无 Defect。
- **未来 Rust owner：**Extension Domain port/repository；Runtime Integration/Native Runtime Edge adapter。
- **Rust 重写与性能判断：**traits + typed result; 无优化理由。
- **验证 oracle：**fake-port delegation, default force and error propagation.
- **证据：**source `RuntimePluginRepository`；registry/lifecycle 调用并委派 OpenClaw config/discovery/installer projections；fake-port fixture 待补。

---

## Skills 与 Toolchain

### runtime-host/application/skills/clawhub-cli.ts

- **当前 owner：**Runtime Integration / Native Runtime Edge 的 ClawHub CLI process adapter。
- **职责与关键 symbols：**CLI runtime port、`ClawHubCliRunner.runWithRegistryFallback`/command execution。
- **旧语义与策略：**在 candidate entries中取第一个存在项，否则 throw；按 registry base顺序运行，成功立即返回，失败累积 messages，所有失败后 throw；以 `processInfo.execPath [entry,...args]` 执行，cwd是 runtime workdir，`MATCHACLAW_CLAWHUB_REGISTRY`注入环境；系统/exec error格式化 stderr/stdout/code。
- **状态、存储与副作用：**文件 exists、子进程、环境变量；无内存cache。
- **并发与性能特征：**registry fallback串行，最坏 O(registries × process startup)，无 timeout/cancel限制在本层。
- **调用/依赖边界：**ClawHub install workflow调用；registry client提供 same mirror/base policy。CLI安装的是第三方/OpenClaw workspace skill asset，不是 Matcha first-party module。
- **故障、恢复与安全：**aggregate error可能带 CLI output（可含路径/token），日志/API需 redaction；无 cleanup或 retry（fallback只对 registry）。待验证：child process deadline/cancel与 partial install cleanup。
- **迁移分类：**Preserve：candidate/base order、first success、env/cwd/aggregate failure。Intentional Improvement：supervised cancellable child process和 sanitized stderr；需明确输出兼容影响。无 Defect。
- **未来 Rust owner：**Native Runtime Edge（CLI invocation/layout）；Runtime Integration（workflow adapter）；Foundation Kernel只提供 process supervisor/redaction primitive。
- **Rust 重写与性能判断：**sequential `Command` supervisor；旧成本为每mirror cold process startup，保持 fallback顺序，指标 install wall time、exit/failure taxonomy、orphan process count；CLI fake differential、kill/timeout/partial-install fault、cold/warm benchmark oracle。
- **验证 oracle：**entry missing、first/second registry success、all failures/stderr/code、env/cwd fixtures。
- **证据：**source `ClawHubCliRunner.runWithRegistryFallback`；ClawHub install workflow 调用并与 registry client 共享策略；CLI fake fixture 待补。

### runtime-host/application/skills/clawhub-jobs.ts

- **当前 owner：**Skill Domain 的 ClawHub install/uninstall job intent policy。
- **职责与关键 symbols：**job constants/payloads/port、`createClawHubJobPort`。
- **旧语义与策略：**install/uninstall按 slug dedupe；install payload保留 version/force；handler在 openclaw application module委派 `ClawHubService.execute*`。无指定queue/retry/cleanup。
- **状态、存储与副作用：**只提交 long task，无自身I/O。
- **并发与性能特征：**O(1)；同 slug install/uninstall 是不同 job type，可并发，交互语义待验证。
- **调用/依赖边界：**ClawHub service ingress→job supervisor→composition handler→workflow/CLI。不是 OpenClaw managed plugin job。
- **故障、恢复与安全：**slug不含 secret；真实 retry/cancel/cleanup在 supervisor/workflow，未在本层定义。
- **迁移分类：**Preserve：job names、slug dedupe和payload。待验证：同slug相反操作的互斥与 retry idempotency。无 Defect。
- **未来 Rust owner：**Skill Domain（intent/dedupe）；Foundation Kernel（durable job mechanics）。
- **Rust 重写与性能判断：**keyed per-skill command stream可消除相反作业竞态，但会改变并发语义，先以 trace证明；指标交错作业收敛、queue time；job differential/fault oracle。
- **验证 oracle：**submission args、same-slug dedupe、install/uninstall interleave、supervisor retry/abort fixture。
- **证据：**source `createClawHubJobPort`；composition handler 委派 `ClawHubService.execute*`；install/uninstall job fixture 待补。

### runtime-host/application/skills/clawhub-registry-client.ts

- **当前 owner：**Runtime Integration 的 ClawHub mirror HTTP + private token reader。
- **职责与关键 symbols：**primary/backup mirror, `mapClawHubSearchResults`, `ClawHubRegistryClient.fetchJson/hasToken`。
- **旧语义与策略：**configured registry bases优先，去空/尾slash去重后追加 CN primary/backup；逐 base GET，Accept JSON，若 token存在用 `Bearer` Authorization，非 2xx/raw empty/bad JSON 各报错并尝试下一镜像，全部失败 aggregate；search rows过滤无 slug，normalize defaults/numbers，可按热度排序。token先 runtime `getAllSettings`，否则 settings file JSON；读取/parse错误在 fallback path可传播。
- **状态、存储与副作用：**HTTP、settings file read；token仅临时内存用于 request。
- **并发与性能特征：**mirror顺序网络 fallback；search mapping O(n log n) with hot sort；无 cache、timeout/cancel/HTTP concurrency控制本层。
- **调用/依赖边界：**ClawHub service search/login、CLI runner共享 registry policy。外部 registry为不可信数据，Skill Domain只消费归一化 catalog。
- **故障、恢复与安全：**token是 private secret，绝不可进入 aggregate error/log/result；HTTP response text仅用于 error message，可能含敏感远端内容；no token returns null/no auth。待验证：settings file权限、explicit config与mirror failover privacy policy。
- **迁移分类：**Preserve：base precedence/normalization/fallback、GET wire shape、token precedence、result mapping。Intentional Improvement：Foundation secret handle + redacted error classification；不可改变 token fallback 可用性。无 Defect。
- **未来 Rust owner：**Runtime Integration（registry protocol）；Foundation Kernel（secret storage/redaction）；Skill Domain（search result use）。
- **Rust 重写与性能判断：**typed HTTP client with secret non-Debug wrapper; sequential retry policy。旧成本为每请求无cache和mirror serial latency；若加 cache/hedging须保持 selected-base/error policy，量度 p95 search、request count、stale rate；HTTP wire differential、mirror/401/invalid JSON fault、benchmark oracle。
- **验证 oracle：**base matrix、configured/primary/backup success/fail, Authorization omitted/present（不记录值）、bad body/status, search normalization/sort fixtures。
- **证据：**source `ClawHubRegistryClient.fetchJson`/`mapClawHubSearchResults`；ClawHub service search/login 和 CLI runner 使用；HTTP mirror fixture 待补。

### runtime-host/application/skills/clawhub.ts

- **当前 owner：**Skill Domain 的 ClawHub search/install/installed inventory/open-path application service。
- **职责与关键 symbols：**`ClawHubSkillInventory.listInstalled`、`ClawHubService` search/login/install/uninstall/openReadme/openPath。
- **旧语义与策略：**inventory列 skills root directories，读取 `SKILL.md`/package JSON，缺 manifest等以 installed metadata defaults容忍；search空 query limit默认25并 hot sort，非空默认50，limit clamp 1..200；login仅在已token时成功，否则明确拒绝 browser login。install/uninstall校验trim slug后仅提交 job，execute委派 workflow。路径解析先可信 preferred existing base，再 slug candidates，最后扫描 SKILL frontmatter name；open优先 parent-shell `shell_open_path`，失败时按 platform default app，二者均失败throw。
- **状态、存储与副作用：**filesystem list/read、registry HTTP、job submit、workflow I/O、parent shell request/child process；无本地 canonical skill store。
- **并发与性能特征：**manifest fallback可能串行全目录扫描 O(number skills × file reads)；open candidates顺序；无 install mutual exclusion。
- **调用/依赖边界：**skill management capability/routes和 composition job handlers上游；ClawHub workflow/registry/CLI/parent-shell下游。已安装 artifact是 OpenClaw/workspace consumable skill，不可与 Matcha first-party Skill Domain模块混同。
- **故障、恢复与安全：**required slug拒绝；open shell非2xx报 upstream error；`preferredBaseDir`只检查存在后直接使用，path containment/trust待验证；frontmatter read parse failure路径策略待补。token不经本 service serialize。
- **迁移分类：**Preserve：limits、login refusal、job-before-execute、lookup and open fallback order。Intentional Improvement：skill identity→path registry并加 safe containment，需证明不破坏现有任何路径入口。无 Defect。
- **未来 Rust owner：**Skill Domain（intent/inventory policy）；Runtime Integration/Native Runtime Edge（ClawHub/OpenClaw workspace/parent shell adapter）；Foundation（controlled filesystem/process/secret mechanisms）。
- **Rust 重写与性能判断：**persistent indexed inventory仅在有规模测量后采用；旧成本是 repeated directory/frontmatter scan，保持 candidate precedence/metadata defaults，指标 inventory latency/FS reads/stale correctness，FS fixtures differential、symlink/permission fault、cold/warm benchmark oracle。
- **验证 oracle：**search limits, installed variants, missing manifest/package, job payload, frontmatter name fallback, shell success/fail/default-app paths。
- **证据：**source `ClawHubSkillInventory.listInstalled`/`ClawHubService`；capability routes、composition job handlers 调用 workflows/registry/CLI；FS/shell fixture 待补。

### runtime-host/application/skills/service.ts

- **当前 owner：**Skill Domain 的 generic skill status/config/state/bundle façade。
- **职责与关键 symbols：**`SkillsService`、workspace port。
- **旧语义与策略：**status/refresh、gateway update、local import、bundle export/import、preinstalled ensure均委派 workflows；config/state/batch mutations委派 config repository；effective和readme preview分别读 repository。无额外校验/retry。
- **状态、存储与副作用：**无自身状态；workflows读写 OpenClaw workspace/config/bundles，repository patch config/files。
- **并发与性能特征：**O(1) delegate；job scheduling由 skills-jobs。
- **调用/依赖边界：**capability/routes、openclaw application module job handlers、Team runtime调用；下游 skills workflows、config store、preview workspace。它是 Matcha Skill Domain service，未把 OpenClaw artifact转为 core module。
- **故障、恢复与安全：**errors直传；config updates may contain apiKey/env，repository必须把它们作为 private projection处理。待验证：bundle import integrity/cleanup。
- **迁移分类：**Preserve：method/port separation和delegate failure。无 Defect；Rust可合并薄façade但保留 public command contract。
- **未来 Rust owner：**Skill Domain；Runtime Integration/Native Runtime Edge adapters；Foundation secret/storage mechanics。
- **Rust 重写与性能判断：**无需一一复制 façade；无性能理由。
- **验证 oracle：**fake workflow/repository forwarding and error cases；workflow integration fixtures。
- **证据：**source `SkillsService`；capability routes、openclaw application module handlers 与 Team runtime 调用；workflow/repository forwarding fixture 待补。

### runtime-host/application/skills/skills-jobs.ts

- **当前 owner：**Skill Domain background-job submission/dedupe policy。
- **职责与关键 symbols：**four job constants、`SkillsJobPort`、factory。
- **旧语义与策略：**refresh以 global dedupe+shared cooldown；gateway update以 skillKey dedupe；import local / ensure preinstalled进 critical queue，ensure还 dedupe。handlers分别调用 SkillsService gateway update/refresh/import/ensure。
- **状态、存储与副作用：**只写 task supervisor queue，无自身持久状态。
- **并发与性能特征：**O(1)；相同 key合并，其他 skill 可并行；队列/retry/cancel由 supervisor。
- **调用/依赖边界：**skill workflows/service上游，openclaw application composition注册 handlers。Gateway update是对 OpenClaw skill projection的 applied mutation，不是 desired config itself。
- **故障、恢复与安全：**payload updates可能含 private data，job persistence/logging必须 redacted；本文件没有 redaction。待验证：dedupe合并时 updates覆盖/丢失语义、critical job cleanup。
- **迁移分类：**Preserve：job names/keys/queues/cooldown。Intentional Improvement：private payload envelope以及 versioned update coalescing；须定义合并语义。无 Defect。
- **未来 Rust owner：**Skill Domain（job policy）；Foundation Kernel（private durable job payload/retry/cancel/cleanup）。
- **Rust 重写与性能判断：**typed encrypted job payload; 旧成本不是性能而是未明合并，保持 queue/dedupe until product decision；量度 dedupe ratio, queue latency, leaked-secret count=0，supervisor differential/fault oracle。
- **验证 oracle：**submission option fixture、same/different skill key、refresh cooldown、private update redaction inspection。
- **证据：**source `SkillsJobPort` factory；openclaw application composition 注册 handlers 调用 `SkillsService`；submission fixture 待补。

### runtime-host/application/skills/store.ts

- **当前 owner：**Skill Domain desired config/effective view/readme preview repository。
- **职责与关键 symbols：**`SkillsConfigRepository` (`getAllConfigs`, config/state mutations, `listEffective`)、`SkillReadmePreviewRepository.read`。
- **旧语义与策略：**config updates require nonblank key, patch `skills.entries`; special `apiKey` becomes env entry after trim; `env` accepts nonempty string pairs; set enabled and batch dedupe/trim keys; effective merges config and installed ClawHub inventory across union of keys, defaults enabled unless explicit false, and projects install metadata. README preview builds candidate from file/base, resolves allowed roots via realpath, confirms target inside root, rejects missing/non-file/outside roots, reads text.
- **状态、存储与副作用：**OpenClaw/skills config read/update; inventory filesystem read; preview filesystem realpath/read. Config is desired state, installed inventory observed state; no separate applied receipt.
- **并发与性能特征：**config patch cost depends config size; listEffective Map/Set O(config+installed), preview sequential root realpath O(roots); no mutation lock here (underlying config port decides).
- **调用/依赖边界：**SkillsService and workflows; OpenClaw skill config projection implements config port. `SkillReadmePreviewRepository` receives workspace allowed roots, distinct from ClawHub direct open path.
- **故障、恢复与安全：**`apiKey`/env are secrets: current config model stores them in a config env map, so Rust requires a private secret projection rather than serializing public effective/API models. Preview has realpath containment against symlink escape but allowed root resolution errors are filtered; file read errors propagate. No archive/bundle integrity in this file.
- **迁移分类：**Preserve：entry patch/default enabled/batch de-dupe、effective merge、preview realpath containment and rejection. Intentional Improvement：move apiKey/env to Foundation secret references and project only at runtime; define migration and redacted display. 待验证：whether current config backend encrypts secret env and concurrent update behavior. 无 Defect。
- **未来 Rust owner：**Skill Domain（desired config/effective policy）；Foundation Kernel（secret handle/encrypted storage/controlled FS）；Runtime Integration（OpenClaw private config projection）。
- **Rust 重写与性能判断：**revisioned skill config plus secret references; old costs are full config patch/scan and potential cleartext persistence, preserve public effective shape/enable defaults; metrics config mutation latency, FS reads, secret exposure=0, preview escape rejects; config differential, symlink/permission/secret-migration fault, inventory benchmark oracle。
- **验证 oracle：**config key/apiKey/env validation, enabled batch duplicates, effective union/defaults, preview direct/base/missing/outside/symlink roots fixtures。
- **证据：**source `SkillsConfigRepository`/`SkillReadmePreviewRepository.read`；SkillsService/workflows 经 OpenClaw config port 和 workspace roots 调用；config/FS fixture 待补。

### runtime-host/application/toolchain/toolchain-jobs.ts

- **当前 owner：**Environment Toolchain Domain 的 uv install job intent。
- **职责与关键 symbols：**`TOOLCHAIN_UV_INSTALL_JOB`、job port/factory。
- **旧语义与策略：**submit install到 `low` queue，以全局 job type dedupe；handler在 operations module调用 service `executeInstall`。
- **状态、存储与副作用：**仅 long-task submission。
- **并发与性能特征：**O(1)，全局唯一 install admission；retry/cancel/cleanup由 supervisor。
- **调用/依赖边界：**platform runtime capability/operations routes→service→job; install workflow/runtime/command executor在范围外。
- **故障、恢复与安全：**no payload secret；partial install cleanup未定义于此。待验证：platform/version不同请求共用dedupe是否正确。
- **迁移分类：**Preserve：job name、low queue、global dedupe。无 Defect。
- **未来 Rust owner：**Environment / Extension Domain（toolchain intent）；Foundation Kernel（job supervisor）。
- **Rust 重写与性能判断：**typed idempotent install command; no optimization claim。
- **验证 oracle：**submission options and duplicate install job snapshot; workflow install fault tests。
- **证据：**source `TOOLCHAIN_UV_INSTALL_JOB`/job factory；platform capability/operations routes 经 composition handler 调用 `executeInstall`；submission fixture 待补。

### runtime-host/application/toolchain/uv-service.ts

- **当前 owner：**Environment Toolchain Domain thin uv install/check façade。
- **职责与关键 symbols：**runtime port、`ToolchainUvService.checkInstalled/install/executeInstall`。
- **旧语义与策略：**check和 execute委派 install workflow；public install只提交 low-priority deduped job，不同步执行。runtime port declares platform/bundled candidates但本 class不读取。
- **状态、存储与副作用：**自身无状态；workflow处理 filesystem/process，job port提交任务。
- **并发与性能特征：**O(1) delegation；global dedupe控制 install admission。
- **调用/依赖边界：**platform capability/routes和 composition job handler上游；UvPythonInstallWorkflow和 long-task port下游。
- **故障、恢复与安全：**workflow errors only occur in execute job path；no secret. retry/cleanup belongs outside class。
- **迁移分类：**Preserve：async job boundary、method split、failure propagation。无 Defect；可不保留单独 façade实现。
- **未来 Rust owner：**Environment / Extension Domain；Foundation Kernel（process/task mechanics）。
- **Rust 重写与性能判断：**direct domain command/query handlers；无性能结论。
- **验证 oracle：**fake workflow/jobs forwarding; submit vs execute ordering and failed install task fixture。
- **证据：**source `ToolchainUvService.checkInstalled`/`install`/`executeInstall`；platform capability/routes 与 composition job handler 调用 workflow/jobs；forwarding fixture 待补。

## 结论与静态审计结果

1. **source of truth：**connector JSON/repository、plugin enabled/catalog intent、skills config entry均是 Matcha领域 source/desired；OpenClaw MCP server、plugin config/discovery/install record、workspace skill文件分别只是 applied/observed projection，禁止反向以其覆盖 domain desired。
2. **desired / applied / observed：**现有实现多以回写 desired 后立即 patch applied，并以 status/discovery/inventory读取 observed；没有统一 durable revision、receipt、reconcile retry或cleanup state。因此 Rust 不应假定同步成功；需明确 per-domain receipt、job retry/cleanup 和启动恢复，且保留当前 partial failure 对调用者可见。
3. **secret/private：**connector `secretEnv`/`secretHeaders`被阻止进入 OpenClaw public MCP config；skill `apiKey`/env、ClawHub token、CLI/registry error output仍要求 Foundation secret handles/redaction和 private projections。不要把 secret放进 catalog/status/job dedupe/log/API response。
4. **I/O 与安装：**connector/skill/plugin discovery有全量文件扫描/JSON；ClawHub CLI和registry有串行 fallback；managed plugin lifecycle可产生 config/install/workspace side effects但无本地 compensation。保持顺序、fallback、partial-failure表面后，再由 job supervisor处理 retry/cancel/deadline/cleanup。
5. **严格区分：**OpenClaw Plugin/MCP/Skill是 Native Runtime Edge或Runtime Integration的具体实现/投影；Matcha Connector、Extension、Skill、Toolchain Domain才拥有产品事实与策略。任何通用 storage/secret/job机制可落 Foundation；不得把这些业务状态机泛化塞进 Foundation Kernel或 Matcha Platform Core。
6. **高置信静态风险（非 Defect）：**connector repository全量 reload/rewrite、plugin registry refresh和skill install/uninstall/job update均未在本范围证明并发线性化；projection/installer失败后缺 durable receipt/reconcile；ClawHub token和skill env的 private persistence/redaction由范围外 adapter决定；所有这些须以 fault/recovery tests验证，而不是臆定当前缺陷。

## 未读与明确排除

- **本分片未读：0 / 28。**
- **范围外仅作为证据的文件不计入本分片已读；**包括 OpenClaw projections/workflows、composition、runtime task supervisor、capability routes、plugin engine及测试。
- **明确排除：**`runtime-host/build/**` 编译产物，依赖/测试输出/临时目录，`package.json`/`tsconfig.json`；以及 `runtime-host/plugins/**`、`runtime-host/skills/**`、`runtime-host/toolchain/**`（当前不存在，inventory实际指向 `runtime-host/application/*`）。
- **未改源：**本次唯一写入为本报告；未修改 runtime-host 源、测试、README、00-inventory、其它报告、配置或锁文件。

## 当前 Git status 增量边界（2026-07-12）

- **直接增量：**本分片 inventory 内没有 status 生产实现改动。`application/workflows/skill-runtime/skill-runtime-workflow.ts` 是外部调用链证据：canonical skill identity 合并 configured key 与 installed inventory，故仅配置、尚未安装的 skill 也不能在迁移时从 identity 集合消失；workflow 的逐文件 owner 仍在 08。
- **外部 Delivery 与 lifecycle：** Electron parent-shell、process launch、Host API/IPC、renderer catalog/status/local cache、CI/package/test都不拥有 connector/plugin/skill desired facts。若一个迁移功能块需要受管 Runtime lifecycle，当前 Electron process-runtime 是 Rust Local Process Host 的外部旧 owner 定位来源；这不把它们或 OpenClaw CLI/workspace/internal layout提升为本分片 Domain owner。
- **终态边界：**Connector/Extension/Skill/Toolchain desired state仍分别归 Domain Module；OpenClaw config/layout、ClawHub/CLI是 Runtime Integration或Native Runtime Edge；通用 storage/job/secret/redaction是Foundation。Rust cutover、actual install/reconcile、CLI effect与secret-safe projection均未执行验证。
