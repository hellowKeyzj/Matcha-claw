# runtime-host TS → Rust ownership migration：Rust 实施质量标准与技术门禁

> **用途**：本标准只约束 runtime-host 的 TypeScript 功能块在旧 owner 已重新走读、行为约束已冻结之后，Rust 如何可靠地接管其被分配的语义。它不规定 Matcha 的全部 Rust 开发，也不充当第二份迁移命令。

---

## 0. 规范边界与权威分工

迁移命令已经决定语义由谁接管、哪些行为必须保持或有意改变；本标准只要求 Rust 实现以可复现的技术证据证明：它能在真实部署、故障、升级和跨边界交互中可靠地承担被分配的职责。

| 问题 | 唯一权威来源 |
|---|---|
| 旧 owner 闭环、行为宇宙、行为分类、semantic-owner 表、TS active-path 退出和迁移完成 | [`runtime-host-ts-rust-migrate`](.claude/commands/runtime-host-ts-rust-migrate.md) |
| Matcha 分层、canonical facts、Electron 物理进程所有权、peer Runtime 边界 | [`layered-architecture.md`](docs/architecture/layered-architecture.md) |
| final-form、最小必要改动、禁止的过渡形态 | [`CODING_CONSTITUTION.md`](CODING_CONSTITUTION.md) 的「Final-form 最小改动」 |
| 任务路由、并发、通用 reviewer pass | [`/code`](.claude/commands/code.md) |
| **Rust 实现质量、Rust toolchain/CI、技术证据与技术 reviewer** | **本标准** |

本标准不：

- 把旧 R0–R6 目录翻译为 Rust crate 图，或复制 ZeroClaw 的产品结构；
- 要求一个功能块只落在一个 Rust crate、一个进程或一个终态 owner；
- 把 Electron desktop shell、Delivery 的安全 transport/展示职责，或 peer Runtime 的 LLM loop、tool harness、sandbox、native approval 上收给 Rust；受管 Runtime lifecycle 的 spawn/attach、readiness、restart/backoff、log、shutdown、process-tree cleanup 与 PID/provenance 则按迁移命令的 owner 表迁至 Rust Local Process Host，不得以当前 Electron 的物理 child handle 作为永久 retained-owner 结论；
- 把 config、raw transcript、transactional state、artifact 和 secret 统一塞入 SQLite；
- 以“Rust 更快”“零成本抽象”“无锁”或其他项目的 release profile 作为性能结论。

---

## 1. 质量模型：Gate、Standard、Evidence

本标准采用 ZeroClaw FND-006 的核心判断：

- **Gate** 是二元的：有可复现通过证据，或不通过。它决定 Rust 是否满足 actual cutover 的技术前置条件；迁移命令只在 semantic owner、行为覆盖、active-path 退出与技术 attestation 都闭合后作出最终 cutover 结论。
- **Standard** 是 reviewer 的工程判断：编译、Clippy 和测试全绿之后，代码是否仍然正确、可恢复、可诊断、可维护。
- **Evidence** 把二者连接起来：测试/fixture、fault 结果、升级样本、打包产物、profile、CI 日志与独立技术 review。没有实际结果的未来检查不能被写成“已通过”。

`cargo fmt`、Clippy、测试和依赖审查是质量地板；它们不能自动证明旧语义已正确分类、Rust 未制造第二事实源、升级能读取已发布状态，或 Electron 安装包实际运行了新 owner。

---

## 2. Rust owner 与保留边界的技术约束

迁移命令定义 semantic owner；Rust 实现必须尊重其结论，而不是借语言迁移改变本不属于自己的边界。

### 2.1 薄的 TS ↔ Rust 边界是允许的

长期 IPC、FFI、HTTP 或 Rust sidecar 并非天然非法 bridge。当前 Electron Main / `LocalProcessRuntime` 是受管 Runtime lifecycle 的 external old owner：它当前对直接启动的 `node-child` / `spawn` / `utility` plan 持有 PID/child handle，并实现 `external` attach 的 PID provenance、physical stop/terminate、readiness、crash restart/backoff、force-kill 与桌面 shutdown。这些可观察语义是 Rust Matcha Runtime / Local Process Host 的迁移输入；actual cutover 后 Rust 必须是 desired lifecycle、spawn/attach、readiness、restart/backoff、log、shutdown、process-tree cleanup 与 PID/provenance 的唯一 active semantic owner。Electron 长期只保留 desktop Delivery/client transport，不能继续保存第二份事实、重新解释 Rust 状态或编排这些 lifecycle 语义；它只可转发、编解码和投影，也不得决定迁移功能块的 retry、恢复、持久化重放或状态机。

跨边界 contract 必须按消息类别声明最小字段，而不是对所有消息机械套同一字段：

| contract 类别 | 最低要求 |
|---|---|
| request / response | 版本、调用身份或 correlation、稳定错误形状；若该请求支持取消，再声明 deadline/cancel 语义 |
| ordered event / stream | producer 与 stream/session identity、sequence/order 语义、版本、redaction |
| config / static snapshot | 版本、来源、完整性；deadline/correlation 只有协议确实需要时才出现 |

wire DTO 与内部领域类型分离。外部 bytes/JSON/env/IPC payload 在 boundary 校验后才转换为内部类型。

### 2.2 identity 与 projection 不得被重新发明

迁移记录为每个协议或持久化记录声明 identity namespace、生成者、唯一性范围、排序字段、与 run 的关联和可否重用。不能在不同协议间强加 `runId`、`seq`、`messageId` 必然一一对应或绝对互斥；只能遵守该 contract 已冻结的语义。

可写业务事实只能有一个 canonical owner。Rust cache/index/projection 仅能从 canonical facts 重建，并记录重建输入与失效条件。对跨请求、key-space 可增长或缓存外部可变结果的 cache，必须定义容量/失效/观测；request-scoped 或静态有界 memoization 只需证明作用域和有界性，不能为了满足条款伪造 TTL/指标。

---

## 3. T0：Rust delivery baseline（每次 actual cutover 的硬门禁）

Rust 实验、spike 或 wrapper 可以在此门禁前存在；**没有 T0，Rust 不得成为唯一 active semantic owner。**

独立 technical-gate attestation 必须提供：

1. 可解析的 Rust project root、提交并锁定的 `Cargo.lock`，以及固定 Rust toolchain 的版本、来源和 `rustc -Vv` 证据；
2. 版本控制的支持矩阵：`Rust target triple / ABI × feature bundle × package target × required CI job × evidence mode`。互斥 feature、明确不支持的组合和每格是交叉编译、模拟还是目标平台实际执行都必须写明；
3. 与该矩阵相符、以锁定依赖解析的 format、lint、test 命令；非宿主 target 的交叉编译不得表述为“测试已运行”；
4. 对影响 Rust source、Cargo manifest/lockfile、feature/target、delivery 或 actual-cutover path 的变更会运行的受保护 required PR CI job。该 job 必须显式安装/校验固定 toolchain，且 Rust/Cargo/delivery 相关路径不能被 workflow path filter 跳过；发布物或平台特定 target 还必须由相应 release/platform CI 覆盖；
5. 具体 CI job/run 链接、实际命令输出及适用 target/feature 结果，而不是计划中的命令名。纯文档或迁移证据变更可以引用仍适用的最近成功 run，但必须说明未重跑原因。

attestation 是这些技术事实、适用性与结论的唯一权威记录。迁移执行记录只能引用它的路径、不可变 revision、覆盖范围与结论，不得复制命令输出、矩阵、门禁判定或 reviewer 理由。

最低命令形态通常是：

```text
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked 或 cargo nextest run --locked（以项目真实 runner 为准）
```

所有会解析 Cargo 依赖的 T0 命令必须以提交的 lockfile 解析；若命令修改 lockfile 或无法在 locked 模式解析，T0 失败。不得盲目使用 `--all-features`：只有当 feature 组合可以共同构建，且确实代表支持矩阵时才适用。每个受支持组合必须按矩阵获得相应的 build/test 证据。

新增依赖后的 source/license/advisory policy 也必须在实际 CI 落地；`cargo deny` 的忽略项必须说明当前影响、理由和追踪，而不能让所有 advisory 变成永久噪声。

---

## 4. 条件技术门禁

T0 之外，下列门禁在触发条件成立时是 actual cutover 的必要技术条件。迁移命令拥有“哪些语义要迁移、是否可 cutover”的最终结论；本节定义独立 technical-gate attestation 对 Rust 技术证据的最低质量线。

| ID | 触发 | 必须证明 |
|---|---|---|
| **T1：boundary contract** | 新增或替换 TS↔Rust、Electron↔Rust、FFI、sidecar 或 peer Runtime contract | schema/version/reject 或协商政策；消息类别适用的 identity/order/correlation/cancel；unknown/malformed input、稳定错误和 redaction；对实际存在的 null/缺失/default、number/time/bytes/Unicode 等跨语言语义使用旧 TS active-path golden fixture 做 TS→Rust 与 Rust→TS 双向验证；真实 consumer contract test |
| **T2：durable upgrade** | Rust 读取或写入已存在的 JSON/TOML/YAML、JSONL/archive、SQLite/transactional state、artifact metadata | 已发布格式样本、版本边界、writer 排除和切换顺序；每个 store 的原子提交方式，或版本化恢复状态机、不变量和可见提交点；upgrade 重试、中断、restart/replay、磁盘满/权限失败；downgrade 或明确的 backup/restore 与不可降级策略 |
| **T3：delivery topology** | 改变 executable、sidecar、FFI、启动方式、打包位置或支持 target | 每个受支持 `OS × arch × package target` cell 都绑定 artifact 的 source revision/Cargo.lock、Rust target triple/ABI、feature bundle、二进制路径与 digest 或可观测 build/protocol version；package location、asar/codesign/notarization/permission 策略、实际 `LocalProcessLaunchPlan` kind/command/entry artifact、Electron 的 PID/terminate owner、secret 注入、readiness、exit/crash、graceful stop/force kill；解包发布物观测该身份的 smoke；产品支持安装内更新时，还需从前一发布版本升级的 smoke |
| **T4：performance claim** | 性能、内存、启动或吞吐是迁移动机，或作为 cutover 结论宣称 | 旧基线 commit、固定环境与 build flags、workload/fixture 版本、预先声明的样本/预热/比较统计量/噪声处理与阈值判定命令、资源预算、原始结果；只报告具有足够采样意义的 tail percentile；同时证明正确性/取消/恢复/诊断未退化 |
| **T5：trust / supply chain** | 新增或启用 dependency/feature、resolved Cargo graph、build script/proc macro、依赖来源、捆绑 native artifact、unsafe、外部输入、secret、FFI 或高风险 trust boundary | 最小 capability、input validation、redaction、解析图/feature diff、依赖维护/license/advisory/source 与 build-time/native capability 审查；unsafe/FFI safety proof 与适用的 ownership/ABI/Miri/sanitizer/fault evidence；跨边界 secret 的通道、读取者、生命周期、禁止落点与 sentinel secret 负向证据 |

### 4.1 T2：durable upgrade 的具体判断

首次由 Rust 写入已发布数据并非普通 happy path，而是数据所有权切换。若旧 TS 与新 Rust 使用“相同 schema 名称”，仍必须验证 SQL affinity、约束、序列化、事务与崩溃恢复的实际兼容性。这里的 data recovery 仅指 durable format / transaction commit point 的恢复；它不得触发 Electron 或任何 launcher 根据领域错误改选旧 TS semantic owner。若部署回滚启动旧 owner，迁移状态必须降回「未切换」，不能作为已切换 Rust slice 的 recovery 证据。

“原子升级”不是跨 JSON/JSONL、SQLite、文件和 artifact 的空泛承诺。每个 durable store 要么使用它能提供的原子提交，要么声明版本化恢复状态机、不变量和可见提交点；每一个已持久化中断点在 restart 后必须收敛为旧版本或一致的新版本。若旧语义要求掉电后持久，对文件路径还要定义 write/sync/replace/目录同步边界。

不支持 downgrade 可以是合理产品决策，但必须显式记录版本边界、备份/恢复路径、用户影响与不可逆原因；不能让一次半转换静默成为唯一恢复方式。

### 4.2 T3：Electron/Rust lifecycle 的具体判断

当前 release matrix 以 [`electron-builder.yml`](electron-builder.yml) 为准：macOS `x64` / `arm64` 的 DMG、ZIP；Windows `x64` / `arm64` 的 NSIS；Linux `x64` / `arm64` 的 AppImage、deb，以及 Linux `x64` 的 rpm。任何新增、删除或实际不支持的 cell 都必须先同步该配置、支持矩阵和 attestation，不能以笼统的“所有平台”替代它。

每个 cell 的 attestation 至少记录：

1. OS、arch、package target、CI runner/架构、native 或 cross-build、release job/run；
2. Rust target triple、profile、feature bundle、artifact 相对路径/digest/版本身份，以及确认 smoke 使用的是解包发布物而非工作树；
3. 实际 `LocalProcessLaunchPlan`：`node-child` 经 CJS launcher、独立 Rust executable 的 `spawn`，或 FFI 三者择一；不得只写“使用 Rust binary”。记录 command、argv、entry artifact、stdio/IPC、环境 allowlist 和 wrapper/loader（若有）；
4. current Electron external old owner 与 Rust cutover 后的 lifecycle semantic owner、readiness 协议和 ready predicate；直接启动计划须分别记录 current process-handle/PID/process-tree owner 与 Rust cutover 后的 owner，`external` attach 则须记录 current adapter 的 PID provenance、stop authority、physical termination implementation，以及 Rust 对应的重建 owner。当前 runtime-host 基线是 `node-child` → `runtime-host/host-process.cjs`、loopback `GET /health`，由 `LocalProcessRuntime` 通过 IPC graceful shutdown 与 process-tree termination 管理；Rust cutover 不能只保留这条 Electron active path；
5. fresh-install cold start、restart、occupied port、entry missing、bad env、readiness timeout、startup/post-ready crash、graceful stop、force kill、port release 与 orphan descendant 的解包产物证据；
6. stdout/stderr capture 与 redaction、exit/signal 分类、auto-restart policy，以及 secret 不出现在 argv、日志、IPC 或诊断产物的 sentinel 负向证据。

通过源码工作树、Cargo target、交叉编译或一个平台的开发环境，不足以替代已声明支持发布 target 的解包产物验证。release workflow 只构建而没有针对某 cell 的解包 lifecycle smoke，不构成该 cell 的 T3 通过证据。

### 4.3 T4：性能协议

性能测量要回答一个可证伪的问题，而不是展示一个漂亮数字：

1. 消除了哪条已 profile/trace 证明的旧成本；
2. 哪组冻结行为不可退化；
3. 哪个代表性 workload 覆盖 cold start/ready、核心请求、并发、取消/shutdown/recovery、IPC/SQLite/artifact 中与功能块真正相关的路径；
4. 环境、CPU/OS、release flags、数据规模、预热、样本数、比较统计量、环境波动处理、阈值判定命令和原始结果在哪里；只报告与 workload 样本量和采样方法相称的 tail percentile、RSS、CPU 或 I/O；
5. 超过阈值时撤回什么结论或阻止什么 cutover。

microbenchmark 可以定位热点，不能替代端到端 workload。吞吐增加但已声明的 tail latency、峰值 RSS、数据完整性、取消安全、恢复或诊断性退化，不构成性能完成。pool、arena、SIMD、lock-free、allocator、LTO、`panic = "abort"` 与 unsafe 必须由本协议证明净收益，不能从其他项目复制。

### 4.4 Technical-gate attestation

每次 actual cutover 必须有一份仓库内、独立、持久、Git tracked 且可按 immutable revision 引用的 technical-gate attestation。路径固定为 `docs/architecture/runtime-host-ts-rust-migrations/<slice-id>/technical-gate-attestation.md`，其中 `<slice-id>` 与迁移执行记录一致且唯一。它是 T0–T5 技术事实、触发判定、未触发依据、证据与技术结论的唯一权威记录，至少包含：

- attestation 的 Git commit SHA；该 committed revision 必须同时包含 attestation、对应 migration record、被审计的 TS/Rust source 与入口/registry/config/dynamic-binding snapshot 或 fingerprint；
- migration slice、覆盖的 Rust commit、implementer identity、attestation author identity 与独立 reviewer identity；reviewer 不得是该 slice implementer；
- 支持的 target / ABI、feature bundle、package target 与 artifact 范围；
- T0 结论，以及 T1–T5 的触发判定、未触发依据、证据链接和结论；
- 实际命令、CI job/run、artifact/fixture/fault/profile 的证据定位；
- 独立 Rust 技术 reviewer、审查时间与结论；
- 技术条件通过时，非 cutover 关键的条件、具名 owner、期限与不阻断 cutover 的理由；
- 对 semantic owner、行为覆盖、active path 或 TS 退出有影响的发现，供迁移执行记录链接和消费。

「技术条件通过」不表示任何 Gate 可以条件通过：T0 与每个触发的 T1–T5 都必须完整通过。条件只能记录与 Gate 无关、非 cutover 关键的技术 reviewer 债务；任一未关闭条件若涉及 Gate 触发、所需证据、数据、信任或交付风险，结论必须是「技术阻断」。

迁移执行记录只引用 attestation 的路径、revision、覆盖范围、结论及其迁移影响；不得复制 T0–T5 的技术判定、证据或 reviewer 理由。

---

## 5. Rust 实施标准：技术 reviewer 必须作出的判断

以下是标准而非关键词清单。它们不能被 lint 代替，也不以“禁止某个语法”取代工程判断。

### 5.1 类型、状态机与 API 是已冻结语义的载体

领域 identity、状态、范围、deadline 和错误分类应由 newtype/enum/判别结构表达，不能在领域核心长期以裸 `String`、`serde_json::Value`、多个 bool 或万能 `HashMap` 隐藏语义。非法 transition 必须由类型/transition 函数拒绝并测试。

新 `pub` 是未来调用方的承诺，而非逃避模块边界的快捷方式。它必须有当前 consumer；fallible public API 说明 `# Errors`，可 panic 的 API 说明 `# Panics`，unsafe API 说明 `# Safety`，并写出不显然的前提、并发和成本语义。

### 5.2 错误处理是设计，不是 `.unwrap()` 计数

- **programmer error**：局部且已证明不可能违反的不变量，可以使用 `assert!` 或带理由的 `expect`；理由指向建立该不变量的类型或函数。
- **operational error**：I/O、网络、协议、持久化、输入、并发、peer Runtime 失败，使用可判别 `Result`/错误类型并保留可恢复性与足够 context。
- **configuration error**：启动阶段 fail fast，但必须指向具体字段、期望和可行动修复。

入口可以汇总未知错误，但不可把稳定领域错误抹为不可分支的字符串，也不可把 SQL、绝对路径、provider body、secret、backtrace 或 `Debug` 透传给 renderer/parent transport。最坏故障时的 log/span 要回答：正在做什么、涉及哪个非敏感 identity/operation、发生了什么、系统决定如何处理。

### 5.3 并发、阻塞与 shutdown 必须按风险建模

对跨请求存活、持有资源或可能与 shutdown 并发的 task，必须有明确 owner、stop/join 路径和退出结果；对会积压或可重试的队列，必须有容量、满载策略和关闭语义。若某路径没有队列或不能积压，应以控制流/类型说明，而不是凭空补 token 与指标。

阻塞型 mutex guard 不得跨 `.await`。异步 guard 只有在等待有界、锁顺序、最大持锁时间与取消行为已被证明时才能跨 `.await`；`Arc<Mutex<_>>`、atomics 与 channel 是同步工具，不是状态 owner。取消通常是 future drop，因此 transaction、文件写、channel send/recv、external side effect 和 checkpoint 的 cancel safety 必须按行为 oracle 验证。

同步阻塞工作是否转移到 bounded blocking executor，取决于项目定义的 worker 阻塞预算、并发路径和实测成本；短小、已证明在预算内的本地工作不应为了教条增加 `spawn_blocking`、调度和取消复杂度。超过预算或占用并发 async worker 的 CPU/阻塞 I/O 才必须隔离并限制容量。

`Drop` 仅做无需报告结果的尽力清理；flush、commit、checkpoint、协议收尾、stop 都必须走可返回 `Result` 的显式路径。

### 5.4 存储、secret 与 unsafe 需要可证明的边界

遵守已冻结的数据分类：human-editable config 归文件格式，raw transcript/runtime payload 归 JSONL/archive，transaction/queue/lease/index 归 transactional store，artifact 归 filesystem/blob，secret 归 OS keychain/private resolver。Rust 不因实现方便而改变这一事实。

SQLite 使用者需明确 writer/model、transaction 边界、busy/lock 处理、checkpoint 与损坏/磁盘满/权限失败的恢复；transaction 内不得等待网络、用户输入、无界工作或大文件 I/O，但允许完成该 transaction 所必需且有界的数据库 await，并证明锁持有与取消语义。文件替换/rename、archive append 和 artifact cleanup 同样必须由 fault/cancel oracle 覆盖。

secret 只在调用外部 SDK 的最小范围显露。每个跨边界 secret 必须声明传输通道、允许读取者、生命周期和禁止落点；不得进入 argv、非必要子进程环境、IPC payload、日志、错误、诊断包、升级备份、artifact metadata、fixture 或 benchmark。用 sentinel secret 的负向证据确认这些表面不含该值。unsafe 默认不用；确有必要时缩在最小 adapter 内，紧邻 `SAFETY:` 说明 layout、alias、lifetime、thread、allocation/free ownership，并有与风险相称的可执行证据。

### 5.5 测试是设计反馈

测试通过 public contract 和 observable outcome 证明行为，不应固化 Rust 私有字段或 mock 调用序列。若一条领域规则必须启动完整 runtime、mock 多层依赖才能测试，先审查其职责和依赖方向；不要用更多 mock 掩盖错误边界。

迁移命令拥有行为宇宙与 TS active-path 的最终证明。本标准要求其中涉及 Rust 的测试采用恰当层级：纯 transition/encoding 用 unit；storage/adapter 用 integration；跨边界用 contract；保留旧语义时用离线 differential；真实失败路径用 deterministic fault/replay。所有这些只可出现在测试/受控验证路径，绝不可演变为生产双写或 fallback。

### 5.6 Rust 命名、术语与模块拓扑

本节是 runtime-host TS → Rust 迁移中 Rust 命名、术语与模块拓扑的**唯一规范本体**。迁移命令在每个功能块只冻结本节的术语选择、预期 crate/module 边界、公开 API 与已证明例外，并将其纳入审查门禁；它只能引用本节，不得复制、裁剪或另行解释本节规则。字符数量不是门禁，也不设字符上限：先让调用点和状态可理解，再讨论简短。

这不是将旧 TypeScript 长名称机械改成 Rust 标识符的规则。命名应服务于最终 Rust owner，而不是保存迁移历史：**module 给上下文，type 表示身份或稳定角色，method 表示动作，局部变量表示当前角色。** 若一个 identifier 需要同时堆叠产品、运行形态、资源与设计模式，先重划 module、type 或 owner；不得继续拼接，也不得以缩写掩盖错误边界。这是「语义先于简短」「状态必须显式」「函数管规则，类管生命周期」和 Final-form 最小改动在 Rust 中的直接要求。

#### 5.6.1 Rust casing 与 initialism

| 符号 | 规范 | 示例 |
|---|---|---|
| Cargo package | lowercase kebab-case；其 Rust crate identifier 使用对应的 snake_case | `runtime-host-gateway` / `runtime_host_gateway` |
| crate、module、function、field | snake_case | `gateway_control`、`request_stop`、`restart_policy` |
| const、static | SCREAMING_SNAKE_CASE | `DEFAULT_CONTROL_TIMEOUT`、`MAX_RESTART_ATTEMPTS` |
| struct、enum、type alias、trait、enum variant | UpperCamelCase | `LaunchSpec`、`ControlReadiness`、`GatewayLauncher`、`ControlReady` |

initialism 在 Rust identifier 中按一个词处理：type/trait/variant 使用 `Http`、`Rpc`、`Pid`、`Utf8`、`Ipv4`，而不是 `HTTP`、`RPC`、`PID`、`UTF8`、`IPV4` 的连续大写；module/function/field 使用 `http`、`rpc`、`pid`、`utf8`、`ipv4`；const/static 因整体为大写而使用 `HTTP`、`RPC`、`PID`、`UTF8`、`IPV4`。外部协议、操作系统 API、持久化/wire field 或品牌已将非常规拼写冻结为稳定领域术语时，可以保留其必要拼写或在 boundary 做映射；例外必须说明该术语的权威来源、适用边界和为何普通 Rust casing 会损害 contract 可读性。它不是为旧 TS 习惯或视觉偏好开设的例外。

#### 5.6.2 crate 与 module 应表达语义边界

crate 是独立编译、依赖、feature、交付或 trust boundary，不是为缩短 import、隔离一个 type、或复刻旧目录而拆分。module 是同一上下文内的内聚语义边界：它应让调用方从路径理解资源、协议或业务上下文，并将实现细节留在该上下文内。crate/module 的拆分必须与本标准第 2 节的 retained boundary、已冻结的 semantic owner 和实际 consumer 一致。

禁止以 `utils`、`common`、`helpers`、`base` 或 `impl` 作为跨语义垃圾桶的 module 名；`impl` 在 Rust 语法中当然可正常使用，但不能成为文件或目录的职责说明。也不得默认“一种 type 一个文件”。仅当 type 的独立复杂度、公开边界、测试/feature 条件或真实变更节奏证明其需要独立 module 时才拆出；否则让同一生命周期、协议或状态机的 type、规则与测试邻近。

下列只是命名形状示例，不声明当前仓库的 crate 图：

```text
runtime_host_gateway/
  gateway/
    launch.rs       # LaunchSpec、启动动作和其输入校验
    readiness.rs    # PortReady/ControlReady 的判定
    supervisor.rs   # 持有运行资源及其 stop/join 生命周期
```

在这个形状中，`gateway::Supervisor` 已由 module 获得上下文，`Supervisor` 是稳定角色；把它命名为 `RuntimeHostGatewayProcessLifecycleManagerService` 既重复路径，也混合产品、资源和模式。若某个 type 会被 re-export 到失去该路径上下文的位置，应保留必要的领域限定，例如 `GatewaySupervisor`，或重设公开 module；不要用冗长前缀补偿错误的 export 边界。

#### 5.6.3 公开 API、内部实现与稳定角色

公开 API 是长期 contract，必须在其**预期 import 路径**上自解释，反映稳定的领域身份、能力或状态；它不得泄露 TS 旧 owner、临时迁移阶段、文件组织或不必要的实现模式。内部 private item 可以依赖已清晰的 module、type 和函数上下文而更短，例如 `probe`、`phase`、`deadline`、`pid`，但仍须说明其当前角色，不能退化为 `data`、`item`、`value`、`flag`、`handler` 或 `state` 一类万能名。

不要默认以 `Manager`、`Service`、`Helper`、`Processor`、`Controller` 或 `Handler` 充当 type 身份。先命名它实际稳定承担的角色，例如 `Supervisor`、`Catalog`、`Scheduler`、`Coordinator`、`Launcher`、`Store` 或 `Probe`，并由 module 提供领域上下文。泛化名称在产品领域、外部协议或平台 API 中确为已冻结的稳定术语时可以保留，例如公开 `WindowsService` 或由协议定义的 `HealthService`；此时功能块 glossary 必须证明其 authority、consumer 和术语来源，不能只因旧 TS 名称存在而沿用。

同一原则适用于 trait：trait 表达实现者提供的能力、端口或可替换角色，如 `GatewayLauncher`、`SessionCheckpointStore`，而不是 `GatewayServiceTrait` 或模糊的 `RuntimeHelper`。不要为单一实现预建 trait；只有已有真实 consumer、替换边界或测试所需的 dependency inversion 才公开该 contract。纯规则优先为 module-level function；只有持有连接、task、channel、timer、文件句柄、cache 或明确 `stop`/`join` 资源生命周期的 struct 才成为 owner。

#### 5.6.4 type、error、state 与 event 命名

type 以身份、值域、稳定角色或已冻结 contract 命名。对不能互换的 domain value，优先使用 `RunId`、`ProcessId`、`ControlEndpoint`、`ByteCount` 等 newtype，而不是让 `String`、`u16` 或 `u64` 在调用点猜测含义。error 应以失败的领域动作或边界命名，如 module 内的 `LaunchError`、跨 module 对外的 `GatewayLaunchError`；error variant 说明可判别原因，例如 `PortInUse`、`ControlRejected`，而不是 `Failed`、`Unknown` 或拼接底层错误文本。

复杂流程必须以 enum/判别结构表达可达 state 和 transition；不能以 `is_running`、`has_error`、`should_retry` 等 bool 堆叠决定下一步。state type 与 variant 应说明其属于哪种状态面，event 则说明已经发生的事实：

```rust
pub enum ControlReadiness {
    NotReady,
    PortReady,
    ControlReady,
}

pub enum GatewayEvent {
    ProcessExited { exit_code: Option<i32> },
    ControlBecameReady,
}
```

`ProcessExited`、`ControlBecameReady` 是过去时事实；`RestartRequested` 是请求/命令而不是已完成事件。若同一消息可同时表示命令、状态和事件，说明 contract 尚未分清，应先重划 type 或 message channel。

#### 5.6.5 生命周期歧义术语必须在功能块 glossary 冻结

每个迁移功能块在实现前必须从下表选择术语、记录其定义和适用边界，并在 Rust API、wire contract、日志、fixture 与测试中一致使用。相近词不能在同一功能块内互作未定义同义词；确有两个概念时，必须同时保留其区分和转换关系。

| 术语 | 本标准规定的可选定含义与禁止混用 |
|---|---|
| `Phase` / `Lifecycle` | `Phase` 是一个 operation 或状态机当前互斥、可转移的步骤；`Lifecycle` 是某个长期资源从创建/attach 到 shutdown/drop 的 owner、资源与合法 transition 的整体模型。需要 enum 表示当前步骤时用 `*Phase`；不能把同一 enum 一会儿叫 phase、一会儿叫 lifecycle。 |
| `Status` | 面向调用方、UI、诊断或 API 的当前观察/projection；它不因名称而成为 transition 的事实源，也不替代 lifecycle/phase。 |
| `Readiness` | 对“当前是否可接受某类工作”的具名 predicate/result，独立于“进程是否存在”或一般 status。必须说明接受的工作和验证方式。 |
| `PortReady` / `ControlReady` | `PortReady` 仅表示所需 port 已 bind/listen 或可连接；`ControlReady` 表示预期 control contract 已以所需版本/认证/响应条件可用。不得把 port connect 成功称为 control ready。若功能块只关心后者，则公开 `ControlReadiness` 而非含混的 `Ready`。 |
| `stop` / `kill` | `stop` 是请求 graceful protocol/lifecycle 收尾并等待可报告结果的动作；`kill` 是强制 physical termination（含必要的 process-tree 处理）。不能将 timeout 后的 kill 伪称为 stop 成功。 |
| `attach` / `adopt` | `attach` 是连接既有 external subject 而不取得其物理生命周期 authority；`adopt` 是经验证后接管明确管理职责，并记录 provenance、stop authority 和失败处理。不能以 attach/adopt 互换掩盖 PID 或 termination owner。 |
| `LaunchSpec` / `RestartPolicy` / `Provenance` | `LaunchSpec` 是一次启动所需的不可变输入；`RestartPolicy` 是何时、是否、以何种 backoff/预算重启的决策规则；`Provenance` 是资源身份、来源和 authority 的事实记录。三者不得互塞 command、重启决定或 PID 来源。 |

功能块 glossary 是术语选择与例外的冻结面，不是第二份命名规范。它至少应列出选定词、边界定义、相邻易混词、对外 spelling 和证明例外；详细 casing、模块和 API 规则始终只引用本节。

#### 5.6.6 method 与 function 的动作语义

构造和转换遵守 Rust 调用方的预期：`new` 只用于无需外部失败、已具备完整 identity 的构造；`try_new` 明确进行可失败校验、解析或资源取得；`from`/`From` 表示来源明确的转换，`into`/`Into` 消耗 self 转换，`as_*` 提供不取得所有权的 view 或转换。不要把启动、I/O、网络、持久化或隐式全局查找藏进这些名称。

predicate 使用 `is_*`、`has_*`、`can_*`、`should_*`，分别表达状态、拥有/存在、能力和依据规则的建议；它们应无副作用。直接 accessor 优先使用领域名，如 `endpoint()`、`restart_policy()`，不要机械写 `get_endpoint()`；`get_*` 只在确为 lookup/fetch 且 Rust 调用约定已清楚其语义时使用。所有真实副作用使用可审查的动作动词，例如 `launch`、`request_stop`、`kill`、`attach`、`adopt`、`persist`、`publish`、`join`，并以 `Result`、返回值或 event 说明成功、失败和剩余生命周期。`handle`、`process`、`execute`、`run` 只有在其对象和可观察动作已经由 contract 精确限定时才足够具体。

#### 5.6.7 field 与局部变量必须携带单位、可空性与角色

时间以 `Duration`、时间点以适当 time type、字节量以 `ByteCount` 或明确 byte type 表示；不要在领域 API 以 `timeout_ms`、`retry_delay_secs`、`payload_size` 等裸数字和单位后缀维持约定。端口、PID、URL/endpoint、identity、sequence 等不能互换的值应有 newtype 或已证明的强类型边界。无法立即引入 newtype 时，命名必须暴露单位和角色，并将其限制在 boundary 的最小范围。

`Option<T>` 表示 absence 本身是合法且可观察的 domain state；`Result<T, E>` 表示动作或解析失败。二者不能互相代替，也不能用空字符串、`0`、magic enum variant 或 `bool + Option` 藏起缺失/失败分支。bool field/variable 使用正向、可读的条件，如 `is_control_ready`、`has_pending_restart`、`restart_requested`；如果多个 bool 才能说明当前 state，应改为 enum 或判别结构。

局部变量可以使用在小作用域内已成为 Rust 惯例的 `pid`、`cfg`、`spec`、`tx`、`rx`，前提是其 type、函数和相邻代码让角色唯一；它们不自动适合 public API、跨 module field 或长期日志字段。在这些位置优先写 `process_id`、`config`、`launch_spec`、`event_sender`、`event_receiver`。除这类已建立的局部惯例外，禁止 `mgr`、`svc`、`ctx`、`req`、`res`、`proc` 等无意义压缩；若全称仍然难以读懂，应调整 owner 或模块上下文，而不是发明更短缩写。

#### 5.6.8 迁移前后审查规则与最小示例

迁移前，功能块必须在冻结术语时完成以下检查：

1. 从旧 TS symbol 的真实职责反推 Rust 的 module context、type identity/role、纯规则 function 与资源 lifecycle owner；不得按旧名称逐词翻译；
2. 列出本功能块的 `Phase`/`Lifecycle`、`Status`、`Readiness`、`PortReady`/`ControlReady`、`stop`/`kill`、`attach`/`adopt`、`LaunchSpec`/`RestartPolicy`/`Provenance` 的选定项、非适用依据或明确区分；
3. 审查预期 public import path、wire spelling、持久化字段和日志字段，确认 module 已提供的上下文不会在 re-export 后丢失；
4. 对 generic stable-term、外部 spelling 或非常规 initialism 的每个例外，留下可核验的产品/协议/platform consumer 证明。

实现后、actual cutover 前，技术 reviewer 必须从 public API 和实际调用点反向检查：module/crate 是否仍表示真实 owner 而非历史 TS 文件；type 是否是身份/稳定角色、method 是否是动作、局部变量是否只承载当前角色；公开与跨边界 spelling 是否一致；state/event/error 是否可判别；以及是否出现 `utils`/`common`/`helpers`/`base`/`impl` 垃圾桶、type-per-file 机械拆分、默认 `Manager`/`Service`、无意义缩写、布尔 state 堆叠、误称 readiness 或隐藏 kill/attach/adopt authority。审查不得以字符长度、批量 rename 或 lint 通过替代上述语义判断。

```rust
// `gateway` 提供产品上下文；type 是稳定角色；动作、状态和输入各自可辨。
pub struct Supervisor {
    control_timeout: Duration,
}

pub struct LaunchSpec {
    pub control_endpoint: ControlEndpoint,
}

impl Supervisor {
    pub fn try_new(control_timeout: Duration) -> Result<Self, ConfigError> { /* ... */ }

    pub fn is_control_ready(&self, readiness: ControlReadiness) -> bool { /* ... */ }

    pub async fn request_stop(&mut self) -> Result<StopOutcome, StopError> { /* ... */ }
}
```

这里不应因旧路径、类型名或短期实现细节改成 `GatewayRuntimeProcessLifecycleManagerService`、`getReady`、`stopOrKill`、`timeout_ms: u64`、`cfg: String` 或 `ok: bool`。如果 `Supervisor` 无法完整说明其 authority，应先改为更准确的稳定角色（如 `Launcher` 或 `Coordinator`）或重划 module；如果某个泛化名称确为冻结领域术语，则按本节的证明例外保留。

---

## 6. 门禁落地顺序与真实状态

当前仓库尚没有可被视为事实的 runtime-host Rust workspace、Rust CI 或迁移 fixture harness。因此以下是实施顺序，而不是已通过的检查：

1. **首个 Rust ownership cutover 前**：落实 T0，包括固定 toolchain、lockfile、支持矩阵、locked format/lint/test 的实际命令、具体 required CI job/run 与路径触发覆盖；
2. **首个跨边界 Rust slice 前**：落实 contract fixture runner（T1）；
3. **首个 durable writer cutover 前**：落实 versioned legacy fixture、upgrade/replay/fault runner（T2）；
4. **首个 Rust binary/sidecar/FFI delivery cutover 前**：落实 target-specific package smoke（T3）；
5. **任何性能主张前**：落实固定环境 benchmark/profile runner 与 regression threshold（T4）；
6. **新增依赖/unsafe/secret-boundary 前**：落实 dependency/security policy 与证据模板（T5）。

没有某个 runner 不代表对应风险消失；它意味着该风险路径还不能 cut over。环境不足时可以显式标记验证未运行和原因，不能悄悄跳过或把未来 CI 当作已通过。

---

## 7. 独立 Rust 技术 reviewer pass

实际 cutover 前，未参与该 slice 实现的 reviewer 必须单独审查 Rust 技术风险；迁移命令的独立 reviewer 仍拥有 semantic owner、行为表、active path 与 TS 退出的最终结论。

Rust 技术 review 至少回答：

1. T0 是否真实通过：workspace、提交 lockfile、固定 toolchain、支持矩阵与具体 required CI job/run 是否覆盖发布会使用的组合；
2. 触发的 T1–T5 是否有可复现证据，未触发项是否确有不适用依据；
3. Rust 是否遵守第 2 节的边界，而没有把 Electron/Delivery/peer Runtime 变成影子 semantic owner；
4. 类型/transition、错误、public API、async/cancel、storage/secret/unsafe 是否符合第 5 节；
5. 性能优化是否有量化成本和净收益，而没有把代价转移到已声明的 tail latency、内存、恢复或诊断；
6. 技术发现、T0–T5 判定与 reviewer 理由是否首先回写 technical-gate attestation；仅当它改变旧语义分类、semantic owner、active path、TS 退出范围或 cutover 状态时，才将该影响及 attestation 引用回写迁移执行记录与文件级审计库。

结论仅可为：**技术通过**、**技术阻断**，或 **技术条件通过**。技术条件通过只允许 Gate 之外的低风险、非 cutover 关键债务，并必须有具名 owner 与期限；T0 与每个触发的 T1–T5 仍须完整通过。任何条件涉及 Gate 触发、所需证据、数据、信任或交付风险时，必须技术阻断。

---

## 8. 设计依据与取舍

本标准吸收的是成熟工程的可迁移方法，而不是复制任何项目的产品：

- [ZeroClaw FND-006](https://github.com/zeroclaw-labs/zeroclaw/blob/main/docs/book/src/foundations/fnd-006-zero-compromise-in-practice.md)：gate/standard 分层、错误分类、行为测试、trust boundary 与可诊断性；
- [ZeroClaw AGENTS.md](https://github.com/zeroclaw-labs/zeroclaw/blob/main/AGENTS.md)：canonical source 优先与新增状态先声明真源；
- [ZeroClaw quality gate](https://github.com/zeroclaw-labs/zeroclaw/blob/main/scripts/ci/rust_quality_gate.sh) 与 [`cargo-deny` policy](https://github.com/zeroclaw-labs/zeroclaw/blob/main/deny.toml)：仓库特有约束应成为可执行、可解释的门禁；
- 成熟 Rust 系统的一致模式：验证真实 consumer/交付物，将性能置于受控环境，且让仓库特有架构约束可执行。

明确不照搬 ZeroClaw 的 microkernel crate 图、runtime/plugin/tool/security 模型、feature 名、worker 数量、release profile、`panic = "abort"`、SQLite/crypto crate 或配置兼容策略。Matcha 的竞争力来自其自身 owner 边界、Electron/Runtime 关系、真实升级路径与真实用户工作负载的证据。
