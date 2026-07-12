# 14 Operational Domains：旧 runtime-host 文件级审计

> 审计结论仅描述当前工作树 TypeScript 的事实和未来 Rust 的迁移边界；不表示 Rust 实现、迁移或测试已经完成。`Preserve` 是可观察旧语义，`Intentional Improvement` 仅是需另行批准的目标，未有源码/调用链/测试闭环的判断均标为“待验证”。

## 完整清单与读取状态

- **范围：** inventory 第 14 分片规定的 55 个当前 `runtime-host` 生产源路径。
- **已读：55；未读：0；排除：0。** 没有以目录摘要、其他分片或代理摘要代替逐文件读取。
- **逐路径清单（均已读）：**
  - `runtime-host/application/channels/channel-activation-strategy.ts`
  - `runtime-host/application/channels/channel-jobs.ts`
  - `runtime-host/application/channels/channel-login-session-service.ts`
  - `runtime-host/application/channels/channel-pairing-service.ts`
  - `runtime-host/application/channels/channel-runtime.ts`
  - `runtime-host/application/channels/channel-snapshot-projection.ts`
  - `runtime-host/application/channels/service.ts`
  - `runtime-host/application/chat/send-media.ts`
  - `runtime-host/application/common/application-response.ts`
  - `runtime-host/application/common/runtime-contracts.ts`
  - `runtime-host/application/common/runtime-job-throttle.ts`
  - `runtime-host/application/common/runtime-ports.ts`
  - `runtime-host/application/cron/cron-jobs.ts`
  - `runtime-host/application/cron/cron-model.ts`
  - `runtime-host/application/cron/cron-session-history.ts`
  - `runtime-host/application/cron/service.ts`
  - `runtime-host/application/files/file-service.ts`
  - `runtime-host/application/license/license-rules.ts`
  - `runtime-host/application/license/service.ts`
  - `runtime-host/application/providers/account-runtime.ts`
  - `runtime-host/application/providers/accounts.ts`
  - `runtime-host/application/providers/capability-routing-service.ts`
  - `runtime-host/application/providers/capability-routing-store.ts`
  - `runtime-host/application/providers/custom-media-provider-contracts.ts`
  - `runtime-host/application/providers/custom-media-runtime-projection.ts`
  - `runtime-host/application/providers/oauth-runtime.ts`
  - `runtime-host/application/providers/provider-account-jobs.ts`
  - `runtime-host/application/providers/provider-accounts-projection-port.ts`
  - `runtime-host/application/providers/provider-model-capabilities.ts`
  - `runtime-host/application/providers/provider-models-service.ts`
  - `runtime-host/application/providers/provider-models-store.ts`
  - `runtime-host/application/providers/provider-oauth-account-service.ts`
  - `runtime-host/application/providers/provider-projection-sync-plan.ts`
  - `runtime-host/application/providers/provider-registry.ts`
  - `runtime-host/application/providers/provider-store-model.ts`
  - `runtime-host/application/providers/provider-store-repository.ts`
  - `runtime-host/application/providers/provider-types.ts`
  - `runtime-host/application/providers/provider-validation.ts`
  - `runtime-host/application/providers/store-sync.ts`
  - `runtime-host/application/security/security-emergency-policy.ts`
  - `runtime-host/application/security/security-jobs.ts`
  - `runtime-host/application/security/security-plugin-config-applier.ts`
  - `runtime-host/application/security/security-policy-normalizer.ts`
  - `runtime-host/application/security/security-policy-presets.ts`
  - `runtime-host/application/security/security-policy-store.ts`
  - `runtime-host/application/security/security-policy-types.ts`
  - `runtime-host/application/security/security-rule-catalog.ts`
  - `runtime-host/application/security/service.ts`
  - `runtime-host/application/settings/defaults.ts`
  - `runtime-host/application/settings/service.ts`
  - `runtime-host/application/settings/settings-jobs.ts`
  - `runtime-host/application/settings/store.ts`
  - `runtime-host/application/usage/token-usage-history-jobs.ts`
  - `runtime-host/application/usage/token-usage-history.ts`
  - `runtime-host/application/usage/token-usage-parser.ts`

### runtime-host/application/channels/channel-activation-strategy.ts

- **当前 owner：** 渠道激活模式选择这一纯策略 owner；不拥有渠道状态或副作用。
- **职责与关键 symbols：** `ChannelActivationStrategyPort`、`DIRECT_CHANNEL_ACTIVATION_STRATEGY` 与 `channelUsesLoginSession` 定义 `direct-config`/`login-session` 分支。
- **旧语义与策略：** 默认策略无条件选 `direct-config`；只有 port 返回精确字符串 `login-session` 才走登录会话。
- **状态、存储与副作用：** 无状态、无 I/O、无网络。
- **并发与性能特征：** 常数时间字符串比较；无同步原语。
- **调用/依赖边界：** 被渠道激活 workflow 的策略注入使用；只暴露 TypeScript port，不依赖 OpenClaw。
- **故障、恢复与安全：** 无错误映射；未知策略值会被当作非登录会话，调用方行为待验证。
- **迁移分类：** Preserve：两个模式与“仅 `login-session` 为真”的判定；Intentional Improvement：无已批准项；Defect：无源码/测试闭环证据；待验证：未知值是否应在边界拒绝。
- **未来 Rust owner：** Domain Module（Channel 激活领域策略）。
- **Rust 重写与性能判断：** 旧成本为一次常量比较；Rust 用封闭 enum 保持分支语义，指标为每次判定 CPU/分配均为常数，oracle 为模式矩阵与未知值兼容测试；无可证实性能瓶颈。
- **验证 oracle：** direct 与 login-session 输入的单元测试；由 `ChannelActivationWorkflow` 做端到端激活路由测试。
- **证据：** 本文件 `ChannelActivationStrategyPort`/`channelUsesLoginSession`；`runtime-host/application/workflows/channel-runtime/channel-activation-workflow.ts` 的注入边界。

### runtime-host/application/channels/channel-jobs.ts

- **当前 owner：** 将渠道异步意图投递给 runtime 长任务队列的 owner，而非队列执行或渠道配置事实 owner。
- **职责与关键 symbols：** job 常量、`ChannelJobPort`、`createChannelJobPort`；构造刷新、探测、直接激活、删除配置提交。
- **旧语义与策略：** 刷新/探测以相同 job 名为 `dedupeKey` 且采用 10 秒冷却；激活和删除直接提交，不在此处声明重试。
- **状态、存储与副作用：** 不持久化；对 `RuntimeLongTaskSubmissionPort.submit` 产生入队副作用。
- **并发与性能特征：** 两个轮询型 job 由共享冷却去重以避免 job map 无界增长；其他请求的队列/并发语义属于下游任务系统。
- **调用/依赖边界：** `ChannelService.deleteConfig/probe` 和 OpenClaw application composition 取得此 port；依赖 `runtime-task-ports` 与 `runtime-job-throttle`。
- **故障、恢复与安全：** 提交失败由下游 port 传播；此层无取消、恢复或 secret。
- **迁移分类：** Preserve：job 名、刷新/探测 dedupe key 与冷却；Intentional Improvement：无已批准项；Defect：无闭环证据；待验证：队列持久化/重启后去重范围。
- **未来 Rust owner：** Foundation Kernel（任务提交、去重冷却原语）与 Domain Module（Channel job 类型）分切片。
- **Rust 重写与性能判断：** 旧成本是高频轮询产生入队记录，冷却已降低该成本；Rust 保持“窗口内返回最近 job”行为，指标为单位轮询数的入队数、队列长度和冷却命中率，oracle 为任务队列契约测试；不宣称更强投递保证。
- **验证 oracle：** 连续 10 秒内刷新/探测只创建一次的测试；任务执行器的 job-id/状态 trace。
- **证据：** 本文件 `createChannelJobPort`；`runtime-host/application/common/runtime-job-throttle.ts`；`runtime-host/application/channels/service.ts`。

### runtime-host/application/channels/channel-login-session-service.ts

- **当前 owner：** 多实现渠道登录会话的顺序分派策略 owner。
- **职责与关键 symbols：** `ChannelLoginSessionHandlerPort`、`ChannelLoginSessionService.start/cancel`；`isUnsupportedChannelLoginSessionError` 识别可继续尝试的规范错误文本。
- **旧语义与策略：** 按 handlers 数组顺序调用；仅精确的 unsupported 错误被吞掉并尝试下一个，其他异常立即传播；全部不支持时抛出统一错误。
- **状态、存储与副作用：** 自身只保存 handlers 引用；副作用在 handler（当前 OpenClaw 微信实现）中。
- **并发与性能特征：** 每次最多串行遍历 N 个 handler；没有锁、缓存或超时。
- **调用/依赖边界：** 渠道激活 workflow 使用其 `start/cancel`；composition 注册 `OpenClawChannelLoginSessionService`，后者承担二维码、轮询、文件和 gateway 事件副作用。
- **故障、恢复与安全：** 以错误消息协议区分“不支持”，脆弱性是文本耦合但尚无测试/调用失败证据可定为缺陷；不将 runtime 内部权限/协议错误归因于 Platform。
- **迁移分类：** Preserve：有序 fallback 与非 unsupported 错误透传；Intentional Improvement：可在 port 上建模 typed unsupported（需兼容 oracle）；Defect：未证实；待验证：多个 handler 同时支持同一渠道时的优先级是否为公开契约。
- **未来 Rust owner：** Runtime Integration（各 Runtime 登录实现）与 Domain Module（Channel 分派策略）分切片。
- **Rust 重写与性能判断：** 旧成本为最坏 O(N) 串行异步尝试；Rust 保持优先顺序，指标为 handler 尝试次数和首个成功延迟，oracle 为 handler trace；不得并行化而改变副作用/优先级。
- **验证 oracle：** 现有 `tests/unit/channel-login-session-service.test.ts`；补充“unsupported 后成功”“非 unsupported 停止”“全部不支持”的 fake-handler 测试。
- **证据：** 本文件 `start/cancel`；CodeGraph 调用链至 `channel-activation-workflow.ts`、`openclaw-channel-login-session-service.ts` 与 OpenClaw application module。

### runtime-host/application/channels/channel-pairing-service.ts

- **当前 owner：** 对会话 runtime 配对 API 的懒加载集成 owner。
- **职责与关键 symbols：** `ChannelPairingService.listRequests/approveRequest`、`ChannelPairingRuntimeEnvironmentPort`；缓存一次 `dynamicImport`。
- **旧语义与策略：** 首次使用动态导入会话 runtime URL 并复用 Promise；账号 ID 去空白；空 code 返回 `{ approved: null }` 而不加载/调用 runtime。
- **状态、存储与副作用：** 仅内存 `runtimePromise`；运行时导入和 `list/approve` 是跨 runtime 副作用。
- **并发与性能特征：** 并发首次请求共享同一 import Promise，避免重复加载；后续常量级读取缓存。
- **调用/依赖边界：** `ChannelService` 负责 HTTP 级参数错误，服务调用会话 runtime 的配对契约；依赖环境提供 env 与模块 URL。
- **故障、恢复与安全：** import 或 runtime 调用异常直接传播；失败 Promise 被缓存，后续不自动重试，是否符合恢复预期未由测试证明；code/accountId 交给下游，未在此记录 secret。
- **迁移分类：** Preserve：惰性加载、空 code 的非批准结果与参数 trim；Intentional Improvement：显式恢复/重载策略须先证明兼容性；Defect：未证实；待验证：缓存失败后是否应重试。
- **未来 Rust owner：** Runtime Integration。
- **Rust 重写与性能判断：** 旧成本是一次动态模块加载及两次远程调用；Rust 保持单次连接/客户端初始化语义，指标为首次/后续调用延迟、失败后恢复时间，oracle 为 fake conversation runtime trace；无证据支持预取或无限重试。
- **验证 oracle：** 配对列表、成功审批、空 code、导入失败、并发首调只加载一次的 integration fake。
- **证据：** 本文件 `runtimePromise`/`listRequests`/`approveRequest`；`runtime-host/application/channels/service.ts` 配对路由服务边界。

### runtime-host/application/channels/channel-runtime.ts

- **当前 owner：** 渠道配置 workflow 的仓储式 facade；配置与插件协调的真实 owner 在 workflow。
- **职责与关键 symbols：** `ChannelConfigRepository`、`ChannelConfigPort`，转发已配置列表、插件 reconcile/prepare、保存/删除、表单值与两种验证。
- **旧语义与策略：** 不改变入参或响应；`reconcileConfiguredChannelPlugins` 默认 `{ forceInstall: false }`。
- **状态、存储与副作用：** 本文件无状态；下游 workflow 可读写 runtime 配置、安装/准备 plugin。
- **并发与性能特征：** 本层 O(1) 委托；插件 reconcile 的扫描/安装成本属于 workflow，当前文件未证明。
- **调用/依赖边界：** `ChannelService` 使用校验/表单端口，channel workflows 注入底层配置 projection、store 与 plugin provisioner port。
- **故障、恢复与安全：** 下游异常原样传播；本层不处理密钥，因此 secret 投影约束必须留在配置/projection 端。
- **迁移分类：** Preserve：每个 port 操作及 `forceInstall` 默认；Intentional Improvement：无已批准项；Defect：未证实；待验证：workflow 写入原子性与插件失败恢复。
- **未来 Rust owner：** Domain Module（Channel 配置意图）与 Runtime Integration（插件/Runtime 配置 projection）分切片。
- **Rust 重写与性能判断：** 旧成本为一次 façade 调用；Rust 保持方法粒度与异步错误边界，指标为配置 mutation 到 projection 的延迟和失败后的状态，oracle 为 workflow contract tests；没有本文件可优化的热点。
- **验证 oracle：** 对各 port 的 fake workflow 转发测试；配置保存、删除、插件 reconcile 的 integration trace。
- **证据：** 本文件 `ChannelConfigRepository`；`runtime-host/application/workflows/channel-runtime/channel-config-workflow.ts`；`runtime-host/application/channels/service.ts`。

### runtime-host/application/channels/channel-snapshot-projection.ts

- **当前 owner：** 渠道“配置事实优先、gateway 状态仅富化”的纯 projection owner。
- **职责与关键 symbols：** `projectChannelsSnapshot` 与 `ProjectedChannelsSnapshot`；处理 `channels`、`channelAccounts`、`channelDefaultAccountId`。
- **旧语义与策略：** 仅遍历 `configuredChannels`；为每个渠道强制 `configured: true`，缺失状态给空账户数组；过滤 gateway 缓存中已删除的渠道；保持输入配置顺序。
- **状态、存储与副作用：** 纯内存对象投影，不 I/O。
- **并发与性能特征：** O(C) 遍历配置渠道并复制外层状态对象；不扫描 raw 的无关渠道。
- **调用/依赖边界：** 被 Channel runtime workflow 的 snapshot 路径使用；输入跨越配置事实与 gateway `channels.status` 缓存。
- **故障、恢复与安全：** 非 record raw 段降级为空，避免坏 gateway snapshot 抛错；不含 secret。
- **迁移分类：** Preserve：配置为权威、删除渠道过滤、默认账户/账户数组规则与顺序；Intentional Improvement：无已批准项；Defect：无闭环证据；待验证：重复 configuredChannels 的可观察行为。
- **未来 Rust owner：** Domain Module（Channel 投影）。
- **Rust 重写与性能判断：** 旧成本是 O(C) 外层复制；Rust 保持仅投影配置集合，指标为 C 增长下的分配/延迟，oracle 为 raw snapshot 与配置集合的表驱动差分测试；不应改为全量 gateway 扫描。
- **验证 oracle：** 配置存在/缓存缺失、缓存残留、账户/defaultAccount 有效和无效、顺序保持的单元测试。
- **证据：** 本文件文件头策略注释及 `projectChannelsSnapshot`；渠道 runtime workflow 的 snapshot 输入边界。

### runtime-host/application/channels/service.ts

- **当前 owner：** Channel application command/query facade；拥有请求形状检查和 200/202/400 映射，不拥有配置、登录或 gateway 状态机。
- **职责与关键 symbols：** `ChannelService` 的激活、连接、二维码、校验、配对、删除和探测操作。
- **旧语义与策略：** 缺 `channelType`/配对 `code` 返回 400；connect/disconnect/requestQr 包装 200；删除与 probe 返回 202 job submission；直接操作同步委托 workflow。
- **状态、存储与副作用：** 无持久状态；通过 config、activation/runtime workflow、pairing 和 jobs 引发配置、gateway、配对或入队副作用。
- **并发与性能特征：** 本层不串行化；异步并发/去重只由下游 workflow/job port 定义。
- **调用/依赖边界：** API channel routes/capability routes 到此服务；下游为 channel workflows、`ChannelPairingService` 和 `ChannelJobPort`。
- **故障、恢复与安全：** 显式参数错误；其他异常原样越过服务；pairing 找不到或过期 code 被统一映射 400；凭据验证 payload 只接受 record。
- **迁移分类：** Preserve：HTTP 级状态、参数 trim/默认 accountId 与异步 accepted 边界；Intentional Improvement：可将 API transport 移至 Delivery 但须维持返回体；Defect：无测试/调用链闭环；待验证：同步直接激活和异步 job API 的客户端依赖。
- **未来 Rust owner：** Delivery（命令/query 映射）与 Domain Module（Channel 用例）分切片。
- **Rust 重写与性能判断：** 旧成本仅为小对象解析和委托；Rust 保持 status/body 与同步/202 区分，指标为路由 p95 与 job 入队延迟，oracle 为 route contract fixtures；没有可证明的算法优化。
- **验证 oracle：** `channelType`/code 缺失的 400、配对未批准 400、connect 200、delete/probe 202 的 API contract tests。
- **证据：** 本文件所有公开方法；`runtime-host/api/routes/channel-routes.ts`；`channel-jobs.ts` 与三类 channel workflow imports。

### runtime-host/application/chat/send-media.ts

- **当前 owner：** 发往 gateway 的媒体消息参数构建与尽力发送集成 owner。
- **职责与关键 symbols：** `normalizeSendWithMediaInput`、`buildSendWithMediaGatewayParams`、`sendWithMediaViaGateway`；`VISION_MIME_TYPES` 白名单。
- **旧语义与策略：** 输入必须有 sessionKey/message/idempotencyKey；所有媒体写入文本引用，只有允许图像 MIME 且文件存在才 base64 附件；单附件读失败忽略，gateway 整体失败返回 `{ success:false,error }`；默认 `deliver:false`。
- **状态、存储与副作用：** 读附件二进制文件；调用 `gateway.chatSend`；内存中构建 base64 与参数。
- **并发与性能特征：** 媒体按数组顺序串行 `exists/read`；图片内容完整 base64 驻留内存，成本为文件总大小加编码膨胀。
- **调用/依赖边界：** 使用 shared `buildGatewayChatSendParams` 和 `GatewayChatPort`；上游会话/聊天命令提供 idempotency key，但本文件不实现外部 exactly-once。
- **故障、恢复与安全：** 单附件最佳努力；整体 gateway 错误被字符串化；任意 file path 可被传入，路径授权由 workspace file/gateway 上层约束，当前文件未证明自身做授权；idempotency key 只转交。
- **迁移分类：** Preserve：MIME 白名单、文本引用、单附件不阻断与整体失败结构；Intentional Improvement：流式附件仅在保持 payload 与错误语义后讨论；Defect：未证实；待验证：调用者的路径授权及 gateway 对 idempotency key 的去重持久性。
- **未来 Rust owner：** Runtime Integration（gateway chat protocol）；Foundation Kernel（受控文件 I/O/背压）分切片。
- **Rust 重写与性能判断：** 已证实旧成本为串行全文件读取和 base64 内存复制；Rust 必须保持附件顺序、忽略单件失败和最终 payload，指标为峰值内存、媒体发送延迟、单附件失败成功率，oracle 为 fake filesystem/gateway payload trace；不得据此声称 external exactly-once。
- **验证 oracle：** 无媒体、非视觉媒体、缺文件、读失败、多个视觉文件、gateway throw 的表驱动测试。
- **证据：** 本文件 `VISION_MIME_TYPES`、`buildSendWithMediaGatewayParams`、`sendWithMediaViaGateway`；`runtime-host/shared/gateway-chat-send-params.ts`。

### runtime-host/application/common/application-response.ts

- **当前 owner：** application 到 Delivery 的纯 HTTP 风格 response envelope owner。
- **职责与关键 symbols：** `ok`、`accepted`、`badRequest`、`conflict`、`notFound`、`unavailable`、`serverError` 和泛型 response 类型。
- **旧语义与策略：** 固定把 success 数据置于 `data`；failure body 为 `{ success:false,error }`；`conflict` 接受文本或已有失败对象。
- **状态、存储与副作用：** 无状态、无 I/O。
- **并发与性能特征：** O(1) 小对象分配。
- **调用/依赖边界：** 被 Channel、Cron、License、Settings 及 routes/workflows 广泛引用，构成 API response 契约。
- **故障、恢复与安全：** 不捕获异常、不 redaction；调用者必须避免把 secret 放进 data/error。
- **迁移分类：** Preserve：status/data envelope 和各 status 映射；Intentional Improvement：无已批准项；Defect：未证实；待验证：所有 Delivery 客户端是否依赖 error 文本。
- **未来 Rust owner：** Delivery。
- **Rust 重写与性能判断：** 旧成本为常数对象构造；Rust 使用明确 response DTO 保持 JSON 形状，指标为序列化兼容性而非吞吐优化，oracle 为 route response fixtures。
- **验证 oracle：** 对每个 helper 的 JSON/status contract test，尤其 409 的两种 overload 输入。
- **证据：** 本文件；第 14 分片的 `ChannelService`、`CronSessionHistoryService`、`LicenseService`、`SettingsService` imports。

### runtime-host/application/common/runtime-contracts.ts

- **当前 owner：** runtime 生命周期和任务快照的跨应用契约 owner。
- **职责与关键 symbols：** lifecycle/job status、queue name、progress、result envelope、snapshot 与 enqueue options。
- **旧语义与策略：** job 只有 queued/running/succeeded/failed 四态；队列为 critical/default/low；dedupe、冷却、最大尝试、retry delay、结果保留均为可选声明。
- **状态、存储与副作用：** 类型声明，无实现状态。
- **并发与性能特征：** 不实现排队；定义下游调度器需要报告的计数和尝试元数据。
- **调用/依赖边界：** `runtime-task-ports`/任务服务实现这些 contract；Channel/Cron/Security/Settings/Usage job ports 以此定义异步语义。
- **故障、恢复与安全：** result/error 可为 unknown/string，无 secret redaction 保障；恢复、取消和 deadline 未在此契约建模。
- **迁移分类：** Preserve：现有状态/队列/时间字段和 option 含义；Intentional Improvement：Foundation Kernel 可增加 cancellation/deadline，但不得改写旧 API 结果；Defect：未证实；待验证：attempt/retry/result retention 的真实执行器语义。
- **未来 Rust owner：** Foundation Kernel。
- **Rust 重写与性能判断：** 无旧算法；Rust 的状态 enum/不可变快照需保持字段与状态转移可投影，指标为队列长度、启动/完成时间和重试次数，oracle 为 task executor trace/contract fixtures。
- **验证 oracle：** Job 提交、去重、重试、result retain/drop 的执行器级测试；现有 API jobs snapshot fixture。
- **证据：** 本文件；`runtime-host/application/runtime-host/runtime-task-ports.ts`、`channel-jobs.ts`、`cron-jobs.ts`、`security-jobs.ts`。

### runtime-host/application/common/runtime-job-throttle.ts

- **当前 owner：** 高频刷新 job 的公共冷却常量 owner。
- **职责与关键 symbols：** `RUNTIME_REFRESH_JOB_COOLDOWN_MS = 10_000` 及其行为性注释。
- **旧语义与策略：** 同一 dedupe key 在十秒窗口最多入队一次，命中时由任务层返回最近完成快照而非创建 record。
- **状态、存储与副作用：** 无状态；实际冷却状态在任务系统。
- **并发与性能特征：** 设计目的明确是抑制轮询导致的 jobs Map 无界增长；常量本身无成本。
- **调用/依赖边界：** Channel refresh/probe、Cron refresh 与 token usage refresh job ports 使用；依赖任务系统遵守 `dedupeCooldownMs`。
- **故障、恢复与安全：** 不处理失败或 clock drift；窗口跨重启范围待验证。
- **迁移分类：** Preserve：10 秒值及高频刷新去重策略；Intentional Improvement：可按实测调参但须记录兼容影响；Defect：无闭环证据；待验证：任务实现是否准确返回“最近完成”而非任意历史 job。
- **未来 Rust owner：** Foundation Kernel。
- **Rust 重写与性能判断：** 已证实旧成本是轮询下的记录增长；Rust 保持同 key 冷却，指标为每窗口入队数、队列/内存上界与 stale response 延迟，oracle 为模拟时钟 dedupe test。
- **验证 oracle：** 0、9,999、10,000 ms 边界的模拟时钟测试与高频轮询压力 trace。
- **证据：** 本文件注释；`channel-jobs.ts`、`cron-jobs.ts`、`token-usage-history-jobs.ts`。

### runtime-host/application/common/runtime-ports.ts

- **当前 owner：** runtime OS/文件/网络/时间/进程依赖的抽象边界 owner。
- **职责与关键 symbols：** `RuntimeFileSystemPort`、HTTP、命令、clock、scheduler、TCP probe、timer、environment/process ports 等。
- **旧语义与策略：** 提供 Promise 型 I/O，文件系统包含 exclusive write、rename、realPath/stat；scheduler 返回可 cancel task；信号仅 SIGINT/SIGTERM。
- **状态、存储与副作用：** 仅 interface；实现可访问 OS、文件、网络和进程。
- **并发与性能特征：** 不规定实现的锁、原子性或背压；exclusive write/rename 是仅有可表达的文件协调能力。
- **调用/依赖边界：** 被 files、cron history、provider HTTP validation、settings/security store、usage parser workflow 及 OpenClaw infrastructure adapters 注入。
- **故障、恢复与安全：** 接口不规定错误分类、路径授权、secret redaction；这些必须由实现/领域边界证明，不得自动归于 Platform。
- **迁移分类：** Preserve：现有 port 能力和异步失败边界；Intentional Improvement：Foundation Kernel 可提供 typed error/cancel/deadline 原语，需 API adapter 兼容；Defect：未证实；待验证：各 Node adapter 对 atomic write/rename 的实际保证。
- **未来 Rust owner：** Foundation Kernel。
- **Rust 重写与性能判断：** 旧成本由适配器决定而非接口；Rust traits 保持 I/O 边界，指标按端口测文件/HTTP 延迟、错误率、取消延迟，oracle 为 port conformance suite；无依据作抽象层性能宣称。
- **验证 oracle：** fake port contract tests，及 OS adapter 的文件读写、exclusive write、rename、HTTP failure/scheduler cancel integration tests。
- **证据：** 本文件；`file-service.ts`、`send-media.ts`、`cron-session-history.ts`、`provider-validation.ts` imports。

### runtime-host/application/cron/cron-jobs.ts

- **当前 owner：** Cron mutation/refresh 意图到 runtime 长任务的提交 owner。
- **职责与关键 symbols：** 七个 cron job 名、`CronRuntimeJobPort`、`createCronRuntimeJobPort`。
- **旧语义与策略：** refresh 有十秒冷却；按 job id 对 update/delete/toggle/trigger 去重；repair delivery 只按类型去重；create 无本层 dedupe。
- **状态、存储与副作用：** 不存储 cron；调用 tasks.submit 入队。
- **并发与性能特征：** 每 job-id 的 dedupe 防止并发相同 mutation；不同 id 可并发；refresh 受共享冷却。
- **调用/依赖边界：** Cron operations workflow 及 `CronService` 的异步 API 使用；底层任务系统决定重试与持久性。
- **故障、恢复与安全：** 无异常转换；相同 key 合并的是提交，不证明 gateway cron 或外部投递 exactly-once。
- **迁移分类：** Preserve：job 名、dedupe key 构成与 refresh 冷却；Intentional Improvement：无已批准项；Defect：未证实；待验证：删除与触发并发时最终状态和任务重启恢复。
- **未来 Rust owner：** Foundation Kernel（去重提交）与 Domain Module（Cron 命令类型）分切片。
- **Rust 重写与性能判断：** 旧成本为重复 mutation/refresh 入队；Rust 保持同 key 合并，指标为每 job-id 活跃任务数、队列长度、合并率，oracle 为模拟并发提交 trace；不由 dedupe 推导外部 exactly-once。
- **验证 oracle：** 对各 key 的重复提交测试，尤其 update/delete/toggle/trigger 与 refresh 冷却边界。
- **证据：** 本文件 `createCronRuntimeJobPort`；`runtime-job-throttle.ts`；`runtime-host/application/workflows/cron/cron-operations-workflow.ts`。

### runtime-host/application/cron/cron-model.ts

- **当前 owner：** Cron UI/API 模型的纯规范化、投递字段验证及 gateway job projection owner。
- **职责与关键 symbols：** delivery normalize/merge/validate、`asCronCreateInput`、`normalizeCronJob`、`parseGatewayCronJobs`。
- **旧语义与策略：** 非 `announce` 或无 channel 一律为 `{mode:'none'}`；需目标的 channel 缺 `to`/`accountId` 返回说明；agentId 必须非空；provider projection 可自定义渠道规范化/目标要求。
- **状态、存储与副作用：** 纯转换；clock 仅用于 timestamp ISO 投影。
- **并发与性能特征：** O(字段数) 解析/复制，gateway jobs 线性 filter。
- **调用/依赖边界：** Cron operations workflow 使用此模型对 gateway cron API 往返；渠道投影 port 提供 Runtime 特有 delivery 规则。
- **故障、恢复与安全：** 无抛出式 JSON 解析；无 provider secret；无效输入通常归一为 none/null。
- **迁移分类：** Preserve：delivery 降级规则、agentId 拒绝、timestamp/lastRun 投影和可插拔渠道规则；Intentional Improvement：无已批准项；Defect：未证实；待验证：客户端是否区分缺 delivery 与显式 none。
- **未来 Rust owner：** Domain Module（Cron 模型）与 Runtime Integration（渠道 delivery projection）分切片。
- **Rust 重写与性能判断：** 旧成本是 job 列表 O(N) filter/映射；Rust 保持输入容错和字段省略，指标为 N 下 parse/投影延迟，oracle 为 gateway job fixture differential tests。
- **验证 oracle：** announce/none、必需目标渠道、空 agentId、各种 state timestamps、坏 job entry 的表驱动测试。
- **证据：** 本文件公开函数；`cron-operations-workflow.ts`；`runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection.ts` 的渠道策略边界。

### runtime-host/application/cron/cron-session-history.ts

- **当前 owner：** Cron run JSONL 到会话 fallback 消息的读取/projection owner。
- **职责与关键 symbols：** `CronRunHistoryRepository.readJobRuns`、`CronSessionHistoryService.read`、session key 解析、时间/时长/消息构建。
- **旧语义与策略：** 接受 `agent:<agent>:cron:<job>` 或 `<agent>:cron:<job>` 及可选 `:run:<id>`；只保留同 job 的 `finished` 或无 action 行；坏行忽略；按时间升序、最后取 limit（1..200）；空结果生成系统占位消息。
- **状态、存储与副作用：** 从 `<runtime-data>/cron/runs/<job>.jsonl` 整体读入；不写入。
- **并发与性能特征：** 全量读取并 split JSONL，再排序 M 条，成本 O(file bytes + M log M)，limit 不减少读取成本。
- **调用/依赖边界：** `CronService.sessionHistory` 调用；依赖 runtime data root/file system/clock；日志生产者在 cron runtime/gateway 侧，当前分片未包含。
- **故障、恢复与安全：** 缺文件视为空；坏 JSON 忽略；非法 sessionKey 为 400；错误摘要可能被展示，来源 redaction 是否完成待验证。
- **迁移分类：** Preserve：sessionKey grammar、finished 过滤、容错读取、排序/尾部 limit 与占位文本；Intentional Improvement：可尾读/索引以降成本，须保持相同筛选顺序；Defect：未证实；待验证：JSONL 与写入端并发时的行完整性、错误摘要的敏感信息处理。
- **未来 Rust owner：** Domain Module（Cron 历史投影）与 Foundation Kernel（append/cursor 文件机制）分切片。
- **Rust 重写与性能判断：** 可证实旧成本为全文件读、JSON parse、全量排序；Rust 若做尾读/索引必须保持最后 limit 的时间排序、坏行跳过和缺文件空结果，指标为大日志 I/O、峰值内存和 query p95，oracle 为同一 JSONL 的差分 fixture（含乱序/坏行）。
- **验证 oracle：** sessionKey 变体、秒/毫秒/ISO 时间、run-session 过滤、200 clamp、坏行和空日志 fixtures。
- **证据：** 本文件 `parseCronSessionKey`、`readJobRuns`、`buildFallbackMessages`；`cron/service.ts`。

### runtime-host/application/cron/service.ts

- **当前 owner：** Cron 应用 facade；持有 operations workflow 与 session history 的公共用例边界。
- **职责与关键 symbols：** `CronService` 逐一暴露 usage、列表、刷新、repair、history 与 create/update/delete/toggle/trigger 的 queued/execute 对。
- **旧语义与策略：** 除 `toggleJob`/`trigger` 的直接 job submission 委托外，其余 await workflow；不改写 payload、job id 或 response。
- **状态、存储与副作用：** 无本地状态；下游 gateway cron API、JSONL history 与 task queue 产生副作用。
- **并发与性能特征：** 本层无锁/批处理；排队和 gateway 并发由 workflow/task executor 所有。
- **调用/依赖边界：** Cron routes 到服务，服务到 `CronOperationsWorkflow` 和 `CronSessionHistoryService`。
- **故障、恢复与安全：** 下游错误保持其 response/throw；本层不补偿 cron mutation。
- **迁移分类：** Preserve：公开操作集合和 queued versus execute 分界；Intentional Improvement：无已批准项；Defect：未证实；待验证：调用者是否可直接抵达 execute 变体。
- **未来 Rust owner：** Delivery（命令/query facade）与 Domain Module（Cron 用例）分切片。
- **Rust 重写与性能判断：** 旧成本只是委托；Rust 保持每个方法的异步边界，指标为 route-to-workflow 延迟及 response shape，oracle 为 Cron route fixtures；无热点结论。
- **验证 oracle：** 每一公开方法的 mock-workflow forwarding test，并覆盖 toggle/trigger 返回 submission 的同步性。
- **证据：** 本文件；`runtime-host/application/workflows/cron/cron-operations-workflow.ts`；`cron-session-history.ts`。

### runtime-host/application/files/file-service.ts

- **当前 owner：** Workspace 文件操作 application facade；真正路径/权限/缩略图策略 owner 是 workspace-file workflow。
- **职责与关键 symbols：** `FileService` 转发 text/binary read/write、stat、list、stagePaths/stageBuffer、thumbnail(s)。
- **旧语义与策略：** 逐方法原样委托 payload；不在 facade 改写结果、错误或路径。
- **状态、存储与副作用：** 无本地状态；下游 workflow 访问文件系统并可能 staging/生成缩略图。
- **并发与性能特征：** 本层常数委托；文件大小、目录扫描、缩略图成本不在本文件可证实。
- **调用/依赖边界：** File routes/capability 使用此服务；下游为 `WorkspaceFileRuntimeWorkflow`。
- **故障、恢复与安全：** 无捕获，权限错误、路径约束和 cleanup 必须由 workflow 证明；不能将 Runtime 内部文件权限错误归 Platform。
- **迁移分类：** Preserve：操作集合与原始错误边界；Intentional Improvement：无已批准项；Defect：未证实；待验证：workspace workflow 的 canonical path、符号链接、staging cleanup 策略。
- **未来 Rust owner：** Domain Module（Environment/workspace 文件用例）与 Delivery（文件 API facade）分切片。
- **Rust 重写与性能判断：** 此文件没有已证实 I/O 成本；Rust 保持一次用例委托，指标由下游测文件读写吞吐/thumbnail 延迟/临时文件清理，oracle 为 workspace workflow conformance suite。
- **验证 oracle：** 文件 route 的 read/write/binary/stat/list/stage/thumbnail fixtures，以及拒绝越界路径的 workflow integration tests。
- **证据：** 本文件 `FileService`；`runtime-host/application/workflows/workspace-file/workspace-file-runtime-workflow.ts`；`runtime-host/api/routes/file-routes.ts`。

### runtime-host/application/license/license-rules.ts

- **当前 owner：** 本地许可证格式、allowlist 和 checksum 规则及公开结果脱敏 owner。
- **职责与关键 symbols：** `normalizeLicenseKey`、`buildLicenseKey`、`validateLicenseKeyLocally`、`sanitizeLicenseValidationResult`、`sanitizeLicenseGateSnapshot`、`LicenseRuntimePort` contracts。
- **旧语义与策略：** trim+uppercase；格式为 MATCHACLAW 四段；非空 allowlist 优先于 checksum；12 字符 seed 才能建 key；对外移除 `normalizedKey`，仅保留掩码/last4。
- **状态、存储与副作用：** 纯计算；runtime port 声明远程/缓存/存储操作但不实现。
- **并发与性能特征：** checksum 固定 4 字符、allowlist 每次 parse 为 Set，成本 O(allowlist 项数 + key 长度)。
- **调用/依赖边界：** `LicenseService` 使用 sanitizers；Node runtime 在 composition `license-node-runtime.ts` 实现 gate/storedKey/validate/revalidate/clear。
- **故障、恢复与安全：** 格式/allowlist/checksum 返回显式 code；关键安全边界是不把 normalized license key 发给 API；本地 checksum 不是服务器授权证明。
- **迁移分类：** Preserve：格式化、allowlist 优先、checksum 算法、结果 codes 与 secret redaction；Intentional Improvement：无已批准项；Defect：无证据；待验证：本地 checksum 是否仅开发/未配置服务 fallback 的产品契约。
- **未来 Rust owner：** Domain Module（License 规则）与 Foundation Kernel（secret/redaction primitive）分切片。
- **Rust 重写与性能判断：** 旧成本为短字符串线性处理；Rust 保持字节级 checksum 和掩码，指标为有效/无效 key differential rate，oracle 为 `tests/unit/license-validation.test.ts` 加固定 vector fixtures；无性能热点。
- **验证 oracle：** 规范化、12 字符 seed、format/allowlist/checksum、sanitizer 不泄露 normalized key 的表驱动测试。
- **证据：** 本文件；`runtime-host/application/license/service.ts`；CodeGraph 至 `runtime-host/composition/license-node-runtime.ts` 和 `tests/unit/license-validation.test.ts`。

### runtime-host/application/license/service.ts

- **当前 owner：** License runtime port 的 API-safe facade；拥有 key 输入提取与对外脱敏。
- **职责与关键 symbols：** `LicenseService.gate/storedKey/validate/revalidate/clear`、`LicenseRuntimePort`。
- **旧语义与策略：** 所有成功请求返回 status 200；validate 缺 key 传空串给 runtime；storedKey 从不回显原 key；gate 的 last validation 也经 sanitizer；clear await runtime 完成后返回 success。
- **状态、存储与副作用：** 无自身状态；Node license runtime 处理 encrypted key/cache/network/timer 等副作用。
- **并发与性能特征：** 本层串行一次 port 调用；无缓存。
- **调用/依赖边界：** license capability/routes、diagnostics 与 composition 的 Node runtime 到此服务；依赖 license-rules 的公开 sanitizer。
- **故障、恢复与安全：** runtime 异常向上传播；安全关键点是许可证密钥只在 runtime 内部使用，响应只含 masked/last4；不误把 Node runtime 内部错误归为 Platform。
- **迁移分类：** Preserve：200 wrapper、空 key 传递、clear 完成顺序、所有 public response 脱敏；Intentional Improvement：Delivery 可改 transport 但不得暴露 key；Defect：无闭环证据；待验证：外部 API 是否依赖所有 validation message 文本。
- **未来 Rust owner：** Delivery（license API）与 Domain Module（License 用例）分切片。
- **Rust 重写与性能判断：** 旧成本是一次 runtime 调用与对象 sanitizer；Rust 保持不泄密响应，指标为泄露扫描命中数、gate/validate 延迟，oracle 为 route fixtures 和 secret redaction tests。
- **验证 oracle：** gate/storedKey/validate/revalidate/clear fake-runtime tests；断言任何 response 不含 raw/normalized key。
- **证据：** 本文件 `LicenseService`；`license-rules.ts` sanitizers；CodeGraph callers `license-runtime-capability.ts`、operations module、`license-validation.test.ts`。

### runtime-host/application/providers/account-runtime.ts

- **当前 owner：** Provider account 本地规范化、状态掩码与 API-key 验证参数解析 owner。
- **职责与关键 symbols：** `normalizeProviderAccountLocal`、`accountToStatusLocal`、`sortProviderAccountsLocal`、`validateProviderApiKeyLocal`。
- **旧语义与策略：** account 必须 id/vendorId；custom media 必须有效 media protocol/contract；headers 仅保留非空字符串；保留创建时间、更新 now；API key 短于等于 8 字符全掩码；无 key 的 vendor 可本地 valid。
- **状态、存储与副作用：** clock 提供时间；验证时经 HTTP client 发网络请求；不持久化。
- **并发与性能特征：** status 排序 O(N log N)，列表密钥解析由上游 `Promise.all`；单 account normalize 为字段线性。
- **调用/依赖边界：** `ProviderAccountsService` 使用全部关键函数；依赖 registry、custom-media contracts、`provider-validation` 与 HTTP port。
- **故障、恢复与安全：** validation 对坏 payload/不支持 vendor/缺 key 返回结构化 invalid；headers 与 key 是敏感输入，status 仅输出掩码；网络错误由 validator 映射为无效结果。
- **迁移分类：** Preserve：providerKind/media contract 拒绝、headers 过滤、排序、密钥 mask 和验证 precheck；Intentional Improvement：无已批准项；Defect：未证实；待验证：metadata 是否允许包含需进一步 redaction 的字段。
- **未来 Rust owner：** Domain Module（Provider account 事实）与 Runtime Integration（HTTP provider validation）分切片。
- **Rust 重写与性能判断：** 已知成本为 N account 排序和每 account 的异步 key resolve；Rust 保持排序/timestamp/mask，指标为 list p95、HTTP probe 数和泄露扫描，oracle 为 account fixture differential tests；不并行化修改 account 语义。
- **验证 oracle：** custom chat/media、无效 protocol、headers、timestamp、短/长 key mask、vendor/key precheck、排序的表驱动测试。
- **证据：** 本文件；`providers/accounts.ts`；`custom-media-provider-contracts.ts`、`provider-validation.ts`。

### runtime-host/application/providers/accounts.ts

- **当前 owner：** Provider account 应用服务 owner：产品账户列表、异步 mutation、OAuth parent-shell 协调、密钥安全视图。
- **职责与关键 symbols：** `ProviderAccountsService.list/create/executeCreate/validate/startOAuth/cancelOAuth/submitOAuth/completeBrowser/completeDevice/getApiKey/hasApiKey/get/update/delete`。
- **旧语义与策略：** list 先规范化 store，若改变则写回，再按更新时间/ID 排序并并发解析 key；create/update/delete 先 202 入队，execute 变体直接 workflow；OAuth 输入严格限定 provider/token 形状并将 start/cancel/submit 代理给 parent shell；账户递归剔除 headers、token、secret、credential、password、apiKey/privateKey 字段。
- **状态、存储与副作用：** 读写 provider store；调用 projection key/secret resolver、HTTP validation、mutation workflow 和 parent shell OAuth IPC；没有本地 account cache。
- **并发与性能特征：** list 对所有账户 `Promise.all` key resolve；规范化可能 delete duplicate provider-key accounts 后写回；mutation 异步队列才是串行/重试 owner。
- **调用/依赖边界：** provider routes/capabilities 到此服务；下游为 store、provider account workflow、OAuth completion workflow、Runtime Integration projection 与 Electron parent shell。
- **故障、恢复与安全：** 参数错误 400；store/key/projection/parent shell 错误传播或由 shell mapResponse；原始 API key 只用于本地 resolver，API 仅暴露掩码/存在性；OAuth token 交给 completion port，服务不持久化 token。
- **迁移分类：** Preserve：先规范化再读视图、异步 mutation 202、OAuth 输入拒绝、递归账户脱敏；Intentional Improvement：Rust 必须显式 desired（账户事实）/applied（projection attempt）/observed（runtime receipt）三态，当前代码并无完整 observed receipt 证据；Defect：没有源码+调用链+测试闭环，不能定性 store 写回/重复删除为缺陷；待验证：并发 list/mutation 的 last-write 行为、OAuth flowId 重放与 parent-shell 恢复。
- **未来 Rust owner：** Domain Module（Provider account desired state）＋ Runtime Integration（OpenClaw/runtime secret/config projection）＋ Delivery（OAuth command API）分切片。
- **Rust 重写与性能判断：** 可证实成本为 N 个 key resolve、O(N log N) 排序和可能的 store rewrite；Rust 保持同一 winner 选择、公开脱敏和 202 分界，指标为 list p95/密钥解析调用数/投影收敛时间/secret leak 数，oracle 为 store fixtures、fake projection/shell trace；不得宣称投影为 external exactly-once。
- **验证 oracle：** 账户规范化/重复 provider key、API response secret scan、OAuth 参数拒绝与 parent-shell command fixtures、queued/execute mutation trace。
- **证据：** 本文件 `list`、OAuth 方法、`sanitizeProviderRecord`；`provider-store-model.ts`、`provider-account-jobs.ts`、provider-account mutation/OAuth workflows；CodeGraph `ProviderStoreRepository` callers。

### runtime-host/application/providers/capability-routing-service.ts

- **当前 owner：** Provider capability route 的 application facade，不拥有 routing 规则持久化或 runtime projection。
- **职责与关键 symbols：** `CapabilityRoutingApplicationService.read/write/syncRuntimeProjection/removeCredentialRoutes/pruneUnavailableModelRoutes` 与 projection port types。
- **旧语义与策略：** 所有业务语义直接委托 workflow；write 保留 workflow 的 `ApplicationResponse`；删除 credential 或不可用模型会触发 route 清理。
- **状态、存储与副作用：** 无自身状态；下游 workflow 可读写 routing store 并投影到 runtime。
- **并发与性能特征：** 常数委托；模型 pruning 的遍历成本在 workflow 未由本文件证明。
- **调用/依赖边界：** provider model/account mutation workflows 调此清理；runtime projection port 面向 Runtime Integration。
- **故障、恢复与安全：** 直接传播下游错误；routes 只引用 provider/model ID，不处理 secret。
- **迁移分类：** Preserve：读/写、显式 sync、凭据/模型清理 API；Intentional Improvement：在 Rust 将 desired routing、applied projection、observed runtime receipt 分离（旧文件未证明 observed）；Defect：未证实；待验证：清理和 runtime sync 之间的事务/重试边界。
- **未来 Rust owner：** Domain Module（capability routing desired state）与 Runtime Integration（runtime projection）分切片。
- **Rust 重写与性能判断：** 本文件无已证实热点；Rust 保持清理次序与 response，指标为 route prune 数、projection 收敛时间/失败率，oracle 为 workflow trace；不假设外部投影 exactly-once。
- **验证 oracle：** 写入、credential 删除、不可用模型 prune 后的 routing fixture 与 fake runtime projection test。
- **证据：** 本文件；`runtime-host/application/workflows/provider-capability-routing/provider-capability-routing-workflow.ts`；`provider-types.ts`。

### runtime-host/application/providers/capability-routing-store.ts

- **当前 owner：** schemaVersion 1 capability routing store 的 repository port/facade owner。
- **职责与关键 symbols：** `CapabilityRoutingStoreRecord`、storage/port contracts、`CapabilityRoutingStoreRepository.read/write`。
- **旧语义与策略：** repository 完全委托 persistence workflow；存储形状仅 `{schemaVersion:1,routing}`。
- **状态、存储与副作用：** 自身无状态；下游 workflow 读写配置路径并负责 JSON I/O。
- **并发与性能特征：** 一次 read/write 委托；锁/原子写不在本文件。
- **调用/依赖边界：** capability-routing persistence workflow 和 composition 创建 repository；上层 routing service/workflow 使用 port。
- **故障、恢复与安全：** I/O/JSON 错误由 persistence workflow 定义；不含密钥。
- **迁移分类：** Preserve：schemaVersion 与 read/write 边界；Intentional Improvement：持久化可在 Foundation Kernel 提供原子 journal，但需保持恢复结果；Defect：未证实；待验证：文件损坏和并发写恢复。
- **未来 Rust owner：** Domain Module（routing desired facts）与 Foundation Kernel（存储机制）分切片。
- **Rust 重写与性能判断：** 此文件无已证实 I/O 算法；Rust 保持 record shape，指标为 read/write 延迟、损坏恢复时间，oracle 为 persistence workflow fixture/conformance tests。
- **验证 oracle：** 空、有效、未知字段、损坏文件与并发写的 storage adapter tests。
- **证据：** 本文件；`runtime-host/application/workflows/provider-capability-routing-store/provider-capability-routing-store-persistence-workflow.ts`。

### runtime-host/application/providers/custom-media-provider-contracts.ts

- **当前 owner：** Custom media provider 的静态协议/能力/默认模型目录 owner。
- **职责与关键 symbols：** `CUSTOM_MEDIA_CONTRACTS`、`getCustomMediaContract`、`isCustomMediaCapability`、`isCustomMediaApiProtocol`。
- **旧语义与策略：** 只承认 openai/google/openrouter 三协议；每协议指定 runtime API、能力、默认 URL 和每能力默认模型；Map 按 id 查找。
- **状态、存储与副作用：** 进程内只读常量/Map，无 I/O。
- **并发与性能特征：** Map 查询 O(1)，能力判定为常数比较。
- **调用/依赖边界：** account normalize、model capability、projection workflow 使用；运行时 API 调用仍由 Runtime Integration 实现。
- **故障、恢复与安全：** 无效协议返回 undefined/false；不保存 API key。
- **迁移分类：** Preserve：三份 contract、默认 URL/model、能力枚举；Intentional Improvement：目录更新必须经产品/运行时兼容批准；Defect：未证实；待验证：默认 preview 模型的实际 runtime 可用性。
- **未来 Rust owner：** Domain Module（Provider catalog）。
- **Rust 重写与性能判断：** 旧成本是 O(1) catalog 查找；Rust 静态表保持相同投影，指标为 contract fixture equality，oracle 为所有 protocol/capability/default model 表驱动测试；无性能优化主张。
- **验证 oracle：** 每个 id 可取回、未知拒绝、合同字段及 `provider-model-capabilities` 一致性测试。
- **证据：** 本文件；`account-runtime.ts`、`provider-model-capabilities.ts`。

### runtime-host/application/providers/custom-media-runtime-projection.ts

- **当前 owner：** Matcha custom-media provider/model reference 字符串编码与解析 owner。
- **职责与关键 symbols：** provider/plugin ID 常量，`toMatchaClawMediaModelRef`、`toMatchaClawMediaRouteModelId`、`parseMatchaClawMediaRouteModelId`、`isCustomMediaCredential`。
- **旧语义与策略：** full ref 是 `matchaclaw-media/<providerKey>/<modelId>`；route ref 是首个 slash 分隔的二段；空任一段返回 null；凭据须 `vendorId=custom && providerKind=media`。
- **状态、存储与副作用：** 纯字符串转换。
- **并发与性能特征：** 线性扫描第一个 slash，常规短字符串成本。
- **调用/依赖边界：** provider model/routing projection 及 custom-media plugin runtime 依赖此命名契约。
- **故障、恢复与安全：** 输入 trim 后拒绝空段；不验证 provider/model 是否真实存在，交给 catalog/projection。
- **迁移分类：** Preserve：plugin ID 与 reference grammar；Intentional Improvement：无已批准项；Defect：未证实；待验证：modelId 内 slash 的故意保留是否所有下游都支持。
- **未来 Rust owner：** Runtime Integration（custom media plugin projection）。
- **Rust 重写与性能判断：** 旧成本为短字符串切分；Rust 保持编码/解析非对称细节，指标为 reference round-trip/invalid rejection，oracle 为 fixture differential tests；无热点。
- **验证 oracle：** valid/invalid provider/model 段、带额外 slash 的 modelId、credential kind 判定。
- **证据：** 本文件；`provider-models-projection-workflow.ts` 的 Runtime custom-media projection types；`account-runtime.ts`。

### runtime-host/application/providers/oauth-runtime.ts

- **当前 owner：** OAuth completion workflow 的窄 application port/facade owner。
- **职责与关键 symbols：** `ProviderOAuthCompletionPort`、`ProviderOAuthCompletionService.completeBrowser/completeDevice`，并 re-export token projection port。
- **旧语义与策略：** 两种 completion 原样 await 下游 workflow；不重写 token、错误或账户结果。
- **状态、存储与副作用：** 无自身状态；workflow 写 token projection 与 provider account store。
- **并发与性能特征：** 常数委托；OAuth token 更新并发由 workflow/store owner 决定。
- **调用/依赖边界：** `ProviderAccountsService.completeBrowser/completeDevice` 调用，依赖 provider-oauth completion workflow。
- **故障、恢复与安全：** 不 log/暴露 token；下游异常传播；flow correlation/replay 语义本文件没有实现证据。
- **迁移分类：** Preserve：browser/device completion 分界和 opaque input/result；Intentional Improvement：以 correlation/receipt 模型追踪 completion 需先保留旧 API；Defect：未证实；待验证：token refresh、重复 completion 与失败补偿。
- **未来 Rust owner：** Runtime Integration（OAuth token projection）与 Domain Module（Provider account OAuth intent）分切片。
- **Rust 重写与性能判断：** 本文件无性能成本；Rust 保持一次 completion 委托，指标为 completion 延迟、失败/重放率，oracle 为 fake completion workflow trace；不声称 OAuth external exactly-once。
- **验证 oracle：** 浏览器/设备 input 原样 forwarding、workflow throw 不泄露 token 的测试。
- **证据：** 本文件；`providers/accounts.ts`；`runtime-host/application/workflows/provider-oauth/provider-oauth-completion-workflow.ts`。

### runtime-host/application/providers/provider-account-jobs.ts

- **当前 owner：** Provider account create/update/delete 长任务提交 owner。
- **职责与关键 symbols：** 三个 job 常量、`ProviderAccountJobPort`、`createProviderAccountJobPort`。
- **旧语义与策略：** 三种 mutation 均直接 tasks.submit，不设置 dedupe、冷却、重试或 queue；update/delete 包装 accountId。
- **状态、存储与副作用：** 无状态；对 runtime task queue 入队。
- **并发与性能特征：** 当前 port 不抑制同账户并发 mutation；队列策略不在此定义。
- **调用/依赖边界：** `ProviderAccountsService.create/update/delete` 返回 202 submission；provider-account mutation workflow 执行任务。
- **故障、恢复与安全：** 入队错误由下游抛出；payload 可含 API key，任务持久化/日志 redaction 的保证不在本文件，需严格验证。
- **迁移分类：** Preserve：job 名和 payload wrapping；Intentional Improvement：可按 account 建串行键/secret-safe payload store，但必须先建立现有并发行为 oracle；Defect：缺源码/测试闭环，不能把无 dedupe 定为缺陷；待验证：任务队列是否持久化原始 payload/secret。
- **未来 Rust owner：** Foundation Kernel（安全任务提交）与 Domain Module（Provider command 类型）分切片。
- **Rust 重写与性能判断：** 已知旧成本是重复 mutation 可增加队列工作；保持当前可并发可见语义直到批准串行化，指标为同 account active tasks、冲突率、payload secret scan，oracle 为 task submission trace。
- **验证 oracle：** create/update/delete payload fixtures；同 account 并发提交行为基线；任务存储/日志不含 API key 的 security test。
- **证据：** 本文件；`providers/accounts.ts`；`runtime-host/application/workflows/provider-account/provider-account-mutation-workflow.ts`。

### runtime-host/application/providers/provider-accounts-projection-port.ts

- **当前 owner：** Provider account 到 runtime projection 的抽象契约 owner。
- **职责与关键 symbols：** `syncStoreToProjection`、key resolve/cleanup、删除 runtime provider key/config 方法。
- **旧语义与策略：** sync 返回 `storeModified`；account/key resolver 以完整 store/account 输入选择 API key；cleanup 分开移除 key 和 config。
- **状态、存储与副作用：** interface 无状态；实现修改 Runtime 的配置/secret store。
- **并发与性能特征：** 不规定批量、顺序、重试或幂等性。
- **调用/依赖边界：** accounts service 用于 secret resolve；provider projection sync/mutation workflow 用于 runtime 投影；OpenClaw projection 是具体实现所在，不是产品事实源。
- **故障、恢复与安全：** API key 仅从 resolver 返回给内部调用；contract 未规定日志/加密；remove 两步是否原子待验证。
- **迁移分类：** Preserve：账户投影、key resolve/cleanup 的端口分离；Intentional Improvement：Rust 必须显式记录 desired/applied/observed，当前仅有 sync 调用和 `storeModified`，无 observed receipt 证据；Defect：未证实；待验证：部分移除失败后的补偿/重试。
- **未来 Rust owner：** Runtime Integration。
- **Rust 重写与性能判断：** 无实现成本可断言；Rust port 保持 secret 仅私有投影，指标为 projection 成功/失败/收敛时间和 secret leak count，oracle 为 fake runtime fault-injection trace；不承诺 external exactly-once。
- **验证 oracle：** fake implementation 验证 key never enters public account DTO，key/config 部分失败时的 desired/applied/observed journal assertions。
- **证据：** 本文件；`providers/accounts.ts`、`provider-projection-sync-plan.ts`、provider projection sync workflow。

### runtime-host/application/providers/provider-model-capabilities.ts

- **当前 owner：** Vendor/protocol/媒体 contract 到可用模型能力集合的纯策略 owner。
- **职责与关键 symbols：** `MODEL_CAPABILITIES`、rules 表、`resolveProviderModelCapabilities`、`filterAllowedModelCapabilities`、`findDisallowedModelCapabilities`、`modelCapabilitiesToRuntimeInput`。
- **旧语义与策略：** custom media 以 contract 为准；其余按 vendor 固定能力并可由 protocol 覆盖；未知 vendor 降级 chat；去重保持首次出现顺序；imageUnderstand 决定 runtime input 有无 image。
- **状态、存储与副作用：** 纯数据计算。
- **并发与性能特征：** capability 数量固定，Set/filter 为常数规模。
- **调用/依赖边界：** accounts list 给 vendor UI 添加能力，model workflows 在 replace/projection 时过滤；依赖 registry type 与 media contract。
- **故障、恢复与安全：** 无效 media contract 产生空能力；未知 vendor 的 chat fallback 是容错而非 runtime 支持证明。
- **迁移分类：** Preserve：规则表、unknown chat fallback、去重顺序与 image runtime input；Intentional Improvement：无已批准项；Defect：未证实；待验证：vendor 宣称能力与实际 runtime capability discovery 的差异。
- **未来 Rust owner：** Domain Module（Provider capability policy）。
- **Rust 重写与性能判断：** 旧成本为固定小集合的 Set/filter；Rust 静态 enum/集合保持结果，指标为 capability matrix exact match，oracle 为全部 vendor/protocol/media fixture differential tests。
- **验证 oracle：** 每 vendor/protocol、custom media、未知 vendor、duplicates、image input 映射的表驱动测试。
- **证据：** 本文件；`provider-registry.ts`、`custom-media-provider-contracts.ts`、`providers/accounts.ts`。

### runtime-host/application/providers/provider-models-service.ts

- **当前 owner：** ProviderModel 产品事实的 application facade；明确不拥有 runtime model projection。
- **职责与关键 symbols：** `ProviderModelsApplicationService.readAll/read/readSelectable/replace/removeCredentialModels/syncRuntimeProjection` 与相关 ports。
- **旧语义与策略：** 所有方法原样委托 operations workflow；注释明确 MatchaClaw source of truth 是 `ProviderModel[]`，runtime projection 只是适配输出。
- **状态、存储与副作用：** 无本地状态；workflow 读写 models store、更新 routing，向 runtime/agent models projection。
- **并发与性能特征：** facade 常数；模型列表/投影成本在 workflow。
- **调用/依赖边界：** provider model routes/workflows 到服务；下游 models operations workflow 和 Runtime Integration projection ports。
- **故障、恢复与安全：** 不处理 secret；下游错误原样传播；投影失败与 source-of-truth 保留关系在 workflow 待验证。
- **迁移分类：** Preserve：`ProviderModel[]` 为产品 desired facts、runtime projection 非事实源；Intentional Improvement：Rust 需存 desired models、applied projection attempt、observed runtime acknowledgement 三态，旧代码尚无 observed 完整证据；Defect：未证实；待验证：models/routing 同步顺序和失败后收敛。
- **未来 Rust owner：** Domain Module（Provider models desired state）与 Runtime Integration（runtime/agent model projection）分切片。
- **Rust 重写与性能判断：** 本文件无算法成本；Rust 保持 source-of-truth 与 public results，指标为 model list latency、projection lag/failure、route pruning correctness，oracle 为 store/projection trace fixtures；不假定 external exactly-once。
- **验证 oracle：** `ProviderModel[]` replace/read/selectable、credential 删除清理、fake runtime projection failed/success receipt tests。
- **证据：** 本文件顶部注释及 methods；`runtime-host/application/workflows/provider-model/provider-models-operations-workflow.ts`、`provider-types.ts`。

### runtime-host/application/providers/provider-models-store.ts

- **当前 owner：** schemaVersion 1 ProviderModel[] persistence repository contract owner。
- **职责与关键 symbols：** store record/port/storage contracts与 `ProviderModelsStoreRepository`。
- **旧语义与策略：** record 为 `{schemaVersion:1,models}`；read/write 原样委托 persistence workflow。
- **状态、存储与副作用：** 自身无状态；下游 workflow 负责 JSON 文件 I/O。
- **并发与性能特征：** 无本层批处理/锁；模型数组大小决定 I/O/序列化成本但本文件未实现。
- **调用/依赖边界：** models persistence workflow 和 composition 组装；ProviderModels operations 服务使用。
- **故障、恢复与安全：** 不含 key；损坏/schema migration 异常下游定义。
- **迁移分类：** Preserve：schema shape/read-write abstraction；Intentional Improvement：可有事务/append storage，但要保留 migration/read recovery；Defect：未证实；待验证：未知 model 字段的 forward compatibility。
- **未来 Rust owner：** Domain Module（Provider model facts）与 Foundation Kernel（存储）分切片。
- **Rust 重写与性能判断：** 无已证实算法；Rust 保持 schema decoding，指标为 store 读写延迟、迁移/损坏恢复，oracle 为 persistence fixture test。
- **验证 oracle：** 空、多个 models、未知字段、坏 JSON、schema version fixtures。
- **证据：** 本文件；`runtime-host/application/workflows/provider-models-store/provider-models-store-persistence-workflow.ts`；`provider-models-service.ts`。

### runtime-host/application/providers/provider-oauth-account-service.ts

- **当前 owner：** OAuth token completion 后构建公开 Provider credential 元数据的纯策略 owner。
- **职责与关键 symbols：** `buildBrowserOAuthAccount` 与 `buildDeviceOAuthAccount`；`ProviderCredentialLike`。
- **旧语义与策略：** browser 仅 openai、authMode `oauth_browser`、默认 label OpenAI Codex，metadata 可保存 email/resource URL；device 支持 minimax global/CN/qwen、authMode `oauth_device`、预设 label/base URL；更新 `updatedAt`，保留已有 createdAt/enabled/部分 metadata。
- **状态、存储与副作用：** 仅 clock；不保存 access/refresh token，token 属于 completion projection 下游。
- **并发与性能特征：** O(字段数) 对象构造。
- **调用/依赖边界：** provider OAuth completion workflow 使用 account builder，再写 store/projection；accounts service 验证 token 输入后调用 completion port。
- **故障、恢复与安全：** 不接触 token 值；metadata `resourceUrl` 不是 secret 的断言需要下游 audit，当前文件无法证明；不处理 flow replay。
- **迁移分类：** Preserve：provider 限定、authMode、default label、时间/已有字段保留；Intentional Improvement：无已批准项；Defect：未证实；待验证：metadata resourceUrl/email 的隐私分类和 OAuth 重放处理。
- **未来 Rust owner：** Domain Module（Provider account metadata）。
- **Rust 重写与性能判断：** 旧成本为常数对象构造；Rust 保持字段选择和时间规则，指标为 account fixture equality/secret scan，oracle 为 browser/device fixed-clock tests。
- **验证 oracle：** 各 provider 默认 label/base URL、existing account merge、fixed clock、token 不出现在 account DTO 的测试。
- **证据：** 本文件；`oauth-runtime.ts`、`providers/accounts.ts`、provider-oauth completion workflow。

### runtime-host/application/providers/provider-projection-sync-plan.ts

- **当前 owner：** normalized Provider account 到 runtime config/secret projection plan 的纯计划 owner。
- **职责与关键 symbols：** `resolveRuntimeConfigProviderOverride`、`buildProviderProjectionSyncPlan`、`ProviderProjectionPolicyPort`、plan types。
- **旧语义与策略：** custom media 不生成普通 runtime override；custom/ollama 清理 endpoint suffix、带 headers/替换 keys；OpenAI browser OAuth 用 codex responses；device OAuth 由 policy 选 api/token env/auth header；每账户 API key trim 后为空即 null。
- **状态、存储与副作用：** 纯计划；读取 store 内 apiKeys 但不写、不调用 runtime。
- **并发与性能特征：** 对 A 个 normalized accounts 单次 O(A) map；headers 线性规范化。
- **调用/依赖边界：** provider projection sync workflow 消费 plan；registry 提供 backend config，policy 由 OpenClaw projection/infrastructure 实现。
- **故障、恢复与安全：** 不把 apiKey 放进 config override，只留在 account plan 的私有字段；没有 projection receipt、重试或 exactly-once 语义。
- **迁移分类：** Preserve：各 vendor/OAuth/custom URL 与 header 规则、空 key 为 null、media bypass；Intentional Improvement：Rust 记录 desired plan、applied call、observed runtime receipt 三态，且仅 private secret projection；Defect：未证实；待验证：replaceProviderKeys 清理与新配置 apply 的原子性。
- **未来 Rust owner：** Runtime Integration（provider runtime projection）；Matcha Platform Core（跨 runtime desired/applied/observed receipt grammar）分切片。
- **Rust 重写与性能判断：** 旧成本为 O(A) plan map；Rust 保持 plan 字段和不公开 key，指标为 plan build latency、projection convergence、partial failure/retry、secret leak count，oracle 为 vendor/OAuth plan fixtures 和 fault-injection receipt trace；不主张外部 exactly-once。
- **验证 oracle：** custom/ollama URL、OpenAI browser、device OAuth、media bypass、headers/key null 的 table-driven plan fixtures。
- **证据：** 本文件 `resolveRuntimeConfigProviderOverride`/`buildProviderProjectionSyncPlan`；`provider-store-model.ts`、`provider-registry.ts`。

### runtime-host/application/providers/provider-registry.ts

- **当前 owner：** 内建/兼容/local/custom Provider 的产品目录与默认配置 owner。
- **职责与关键 symbols：** `PROVIDER_DEFINITIONS`、`PROVIDER_VENDOR_DEFINITIONS` 及 lookup/env/config/UI/capability functions。
- **旧语义与策略：** 定义 provider id、认证模式、是否多账户、env 变量、默认 URL/API/header；额外仅 env providers 不进入主 definitions；Map lookup；keyable types 合并主目录和 extra env keys。
- **状态、存储与副作用：** 进程内静态表/Map；无 I/O。
- **并发与性能特征：** Map lookup O(1)，列表函数按目录长度 O(N)。
- **调用/依赖边界：** account normalize/validate、projection plan、accounts list、capability rules 依赖；runtime 配置投影将目录值翻译到 OpenClaw/runtime。
- **故障、恢复与安全：** 未知 type 返回 undefined；目录含 env 变量名而无 secret 值；不能据 placeholder 推导密钥存储位置。
- **迁移分类：** Preserve：目录 item、默认 auth/config、extra-env 分离及 lookup 行为；Intentional Improvement：新增/淘汰 provider 需产品兼容批准；Defect：未证实；待验证：静态默认 endpoint/model 的部署时可用性。
- **未来 Rust owner：** Domain Module（Provider catalog）。
- **Rust 重写与性能判断：** 旧成本是小静态表查找；Rust 静态 registry 保持 JSON/UI output，指标为 catalog fixture equality，oracle 为 all-ID/config/env lookup tests；无性能瓶颈。
- **验证 oracle：** 每个 provider id、auth modes、backend config、extra env provider、unknown lookup 的 snapshot/table tests。
- **证据：** 本文件；`account-runtime.ts`、`provider-validation.ts`、`provider-projection-sync-plan.ts`。

### runtime-host/application/providers/provider-store-model.ts

- **当前 owner：** Provider store 的规范化、legacy 清除和 runtime provider-key 去重选择策略 owner。
- **职责与关键 symbols：** `normalizeProviderStoreForProjection`、`ProviderProjectionKeyResolverPort`、`NormalizedProviderCredential`、string/integer helpers。
- **旧语义与策略：** 删除非 record/无 vendorId account 及相应 key；修正 account id/vendorId；删除 legacy model/fallback/default 字段；同 providerKey winner 依次按 alias 优先、updatedAt 降序、accountId 升序，删除其余；删除 legacy `defaultAccountId`。
- **状态、存储与副作用：** 原地 mutate 传入 store；调用方 `ProviderAccountsService.list` 在 `storeModified` 时持久化。
- **并发与性能特征：** 遍历 A accounts、按 provider-key group 排序，总成本约 O(A log A)；原地 delete 避免第二完整 store。
- **调用/依赖边界：** accounts list、projection plan/workflow 依赖；resolver 是 runtime-specific naming policy。
- **故障、恢复与安全：** 非法/重复数据被静默删除，可能丢 API key；没有备份/receipt；因无测试或业务回放闭环，不能断言这是 Defect。
- **迁移分类：** Preserve：数据修复、legacy 删除和确定性 winner ordering；Intentional Improvement：Rust 应在删除前以领域事实/迁移 receipt 可审计地记录 desired/applied/observed，而不是伪造外部 exactly-once；Defect：未证实；待验证：重复 providerKey 删除是否用户可见且是否应恢复。
- **未来 Rust owner：** Domain Module（Provider account migration/desired facts）与 Runtime Integration（provider key resolution）分切片。
- **Rust 重写与性能判断：** 已证实成本为 group/sort O(A log A) 和潜在一次 store rewrite；Rust 保持 winner 排序及删除集合，指标为 normalized accounts、删除数、处理延迟、数据恢复可用性，oracle 为恶意/legacy/duplicate store fixture differential tests。
- **验证 oracle：** 非 record、缺 vendor、id 修正、每个 legacy 字段、同 key ties（alias/time/id）的 fixed fixture tests；删除前后 key set trace。
- **证据：** 本文件 `normalizeProviderStoreForProjection`；`providers/accounts.ts:list`；`provider-projection-sync-plan.ts`。

### runtime-host/application/providers/provider-store-repository.ts

- **当前 owner：** schemaVersion 2 Provider account/API-key store repository contract owner。
- **职责与关键 symbols：** `ProviderStoreRecord`、port/storage contracts、`ProviderStoreRepository.read/write`。
- **旧语义与策略：** record 分离 `accounts` 与 `apiKeys`；repository 原样委托 persistence workflow。
- **状态、存储与副作用：** 无自身状态；下游 workflow 操作实际文件。
- **并发与性能特征：** 无锁/缓存/原子性实现；整个 record read/write 的大小随 account 数增长。
- **调用/依赖边界：** accounts service、OAuth completion、gateway prelaunch、OpenClaw application module 与 persistence workflow 使用（CodeGraph caller 集）。
- **故障、恢复与安全：** apiKeys 是 secret；本 contract 未说明加密/锁/atomic write；不得把此缺少声明认定为缺陷，需 adapter/source 测试闭环。
- **迁移分类：** Preserve：version 2、accounts/apiKeys 私有分离和 read/write port；Intentional Improvement：Foundation secret store 可替代文件，但 API key 不得进入 public config；Defect：未证实；待验证：实际 persistence 的加密、并发写、损坏恢复及 secret-at-rest 特性。
- **未来 Rust owner：** Foundation Kernel（secret/storage mechanism）与 Domain Module（Provider account record）分切片。
- **Rust 重写与性能判断：** 已知成本为全 record 序列化/I/O（实现侧待量测）；Rust 保持 accounts/key 分离，指标为 read/write latency、file size、recovery time、secret leak scan，oracle 为 persistence fixtures/fault injection；不凭接口声称原子性。
- **验证 oracle：** schema v2 read/write、secret 不出现在 public list、crash/interrupted write and concurrent mutation adapter tests。
- **证据：** 本文件；CodeGraph `ProviderStoreRepository` callers；provider-store persistence workflow；`providers/accounts.ts`。

### runtime-host/application/providers/provider-types.ts

- **当前 owner：** Provider、credential、model、route 与 secret 的共享类型/grammar owner。
- **职责与关键 symbols：** provider/protocol/auth/capability unions，`ProviderCredential`、`ProviderModel`、`CapabilityRouting`、`ProviderSecret`、`ModelSummary`。
- **旧语义与策略：** 限定 15 个 provider、4 种 API protocol、chat/media credential、七种能力与三种 secret 形态；model route 包含 primary/fallbacks/optional timeout。
- **状态、存储与副作用：** 纯类型和一个 Ollama placeholder 常量。
- **并发与性能特征：** 无运行时算法。
- **调用/依赖边界：** registry、account/model/routing/security projections 及 provider workflows 的共享契约；`ProviderSecret` 应留在私有 adapter 区域。
- **故障、恢复与安全：** 类型层表达 secret，但不强制 runtime redaction；routes 不含 observed receipt/attempt identity。
- **迁移分类：** Preserve：枚举和 DTO grammar；Intentional Improvement：Matcha Platform Core 可定义跨 runtime execution/receipt correlation，Provider domain 仍拥有领域模型；Defect：未证实；待验证：现有 JSON consumers 对未知 enum/字段的兼容性。
- **未来 Rust owner：** Domain Module（Provider domain types）与 Matcha Platform Core（跨 runtime receipt/correlation only）分切片。
- **Rust 重写与性能判断：** 无旧成本；Rust enums/serde DTO 保持 wire shape，指标为 serialization differential compatibility，oracle 为 provider API/store fixtures；无性能结论。
- **验证 oracle：** provider/auth/protocol/capability/secret JSON fixtures与 unknown input rejection/forward compatibility tests。
- **证据：** 本文件；`provider-registry.ts`、`provider-model-capabilities.ts`、`capability-routing-service.ts`。

### runtime-host/application/providers/provider-validation.ts

- **当前 owner：** Provider API key 的网络验证 profile、fallback probe 与错误分类 owner。
- **职责与关键 symbols：** `validateApiKeyWithProvider`、profile selector、OpenAI/Responses/Google/Anthropic probes、auth/error classifiers。
- **旧语义与策略：** 2xx 与 429 视 valid；401/403 与识别到的 400 auth error 视 invalid key；OpenAI 先 GET models，非 auth 失败才 fallback POST minimal probe；Ollama profile `none` 直接 valid；网络错误返回 `Connection error`。
- **状态、存储与副作用：** 用 `RuntimeHttpClientPort` 出网；不持久化 key；请求头承载 key。
- **并发与性能特征：** 每 validation 至少一个 HTTP 请求，某些 profile 可二次 fallback；无 timeout/限流在本文件，依赖 HTTP port。
- **调用/依赖边界：** `account-runtime.validateProviderApiKeyLocal` 和 accounts validation 调用；registry supplies config/headers；外部 provider 是 Runtime Integration 边界。
- **故障、恢复与安全：** key 不写日志；错误字符串含网络异常文本；429 false-positive-valid 是显式策略而非已证实缺陷；没有 retries。
- **迁移分类：** Preserve：profile/headers/URL 规范化、401/403/400 auth 归类、429 valid、models-to-probe fallback；Intentional Improvement：按批准可引入 timeout/circuit breaker，但须保留 classification；Defect：无源码+测试闭环，不能将 429 策略定性缺陷；待验证：各 provider 对 validation-probe 的计费/限流影响。
- **未来 Rust owner：** Runtime Integration。
- **Rust 重写与性能判断：** 已知成本是 1–2 次网络 round trip；Rust 保持请求顺序和 429/auth classification，指标为 validation latency、fallback rate、provider HTTP status distribution、false result rate，oracle 为 fake HTTP scripted trace；不做未经证实的并发 probe。
- **验证 oracle：** 各 profile URL/header/body，2xx/429/401/403/400-auth/400-nonauth、models fallback、network throw fixtures。
- **证据：** 本文件 `classifyAuthResponse`、`shouldFallbackFromModelsProbe`、`validateApiKeyWithProvider`；`account-runtime.ts`。

### runtime-host/application/providers/store-sync.ts

- **当前 owner：** Provider store 到 projection sync workflow 的极窄 facade/type re-export owner。
- **职责与关键 symbols：** `ProviderProjectionSyncService.syncProviderStore`，重导 projection policy/key/store/result ports。
- **旧语义与策略：** 不修改 store；一次 await `syncWorkflow.syncProviderStore(store)` 并返回其结果。
- **状态、存储与副作用：** 自身无状态；下游 workflow 读/写 runtime config、secret、agent model projection。
- **并发与性能特征：** 常数委托；批量/重试/锁不在本层。
- **调用/依赖边界：** provider mutation/prelaunch/workflow 到此 service；具体 OpenClaw projection 是 Runtime Integration。
- **故障、恢复与安全：** 异常直接传播；类型重导不提供 secret redaction 或 receipt durability。
- **迁移分类：** Preserve：single sync entrypoint 和返回 workflow result；Intentional Improvement：Rust 使用 desired/applied/observed ledger 表示 projection，不以此 facade 假称 external exactly-once；Defect：未证实；待验证：sync result 的字段是否足以表达 partial success/retry。
- **未来 Rust owner：** Runtime Integration（sync implementation）与 Matcha Platform Core（跨 runtime projection receipt grammar）分切片。
- **Rust 重写与性能判断：** 本文件无成本可优化；Rust 保持单 entrypoint，指标为 sync duration、per-provider failure/lag、receipt completeness，oracle 为 fake projection fault trace。
- **验证 oracle：** 空/多账户 store、partial projection failure、retry/resume 的 desired/applied/observed assertions。
- **证据：** 本文件；`runtime-host/application/workflows/provider-projection-sync/provider-projection-sync-workflow.ts`；`provider-projection-sync-plan.ts`。

### runtime-host/application/security/security-emergency-policy.ts

- **当前 owner：** 紧急 lockdown 时从当前 policy 生成严格安全 policy 的纯策略 owner。
- **职责与关键 symbols：** `createSecurityEmergencyLockdownPayload`。
- **旧语义与策略：** 先规范化当前输入，再设 strict；强制 autoHarden/monitors/audit/guards/block/logging，且 destructive/secrets 所有 severity 都 block；保留其余当前 destructive/secrets 字段。
- **状态、存储与副作用：** 纯 policy 对象变换。
- **并发与性能特征：** 常数大小对象复制/规范化。
- **调用/依赖边界：** security emergency response workflow 构造并写入/投影；依赖 normalizer/types。
- **故障、恢复与安全：** 输入坏时 normalizer 给 relaxed baseline 后再 lockdown；该策略本身不 apply runtime config。
- **迁移分类：** Preserve：lockdown 覆盖的字段和所有 severity block；Intentional Improvement：无已批准项；Defect：未证实；待验证：紧急响应是否需要回滚到精确前一 policy 的持久 receipt。
- **未来 Rust owner：** Domain Module（Security policy）。
- **Rust 重写与性能判断：** 旧成本为固定对象 clone；Rust 保持字段覆盖，指标为 policy fixture equality/紧急 apply 时间，oracle 为 normalizer+lockdown table tests。
- **验证 oracle：** 空/坏/自定义 policy 输入，断言 strict、block/monitor/audit 覆盖及保留字段。
- **证据：** 本文件；`security-policy-normalizer.ts`；`runtime-host/application/workflows/security-emergency/security-emergency-response-workflow.ts`。

### runtime-host/application/security/security-jobs.ts

- **当前 owner：** Security 任务命令到 runtime 长任务 queue 的提交与 dedupe key 策略 owner。
- **职责与关键 symbols：** 九类 security job 常量、`SecurityJobPort`、`createSecurityJobPort`。
- **旧语义与策略：** 每类均设 dedupe key；scan 按 scanPath、advisories 按 feed URL、remediation apply 按 actions 以 U+001F join、rollback 按 snapshotId 区分。
- **状态、存储与副作用：** 无状态；tasks.submit 入队。
- **并发与性能特征：** 相同 key 合并，不同 scan path/feed/actions/snapshot 可并行；actions join 的构成是公开任务 identity 细节。
- **调用/依赖边界：** Security operations workflow/service 提交；runtime task executor 执行实际 audit/remediation。
- **故障、恢复与安全：** 不处理 job failure；actions/path/feed URL 可能敏感或攻击性输入，其持久化/日志处理在任务/安全 workflow 待验证。
- **迁移分类：** Preserve：job 名、各 dedupe 构成；Intentional Improvement：可为 actions 使用结构化 hash，但需证明无碰撞/兼容任务 identity；Defect：未证实；待验证：U+001F 在 action 内容中的碰撞，以及 job payload redaction。
- **未来 Rust owner：** Foundation Kernel（任务 dedupe）与 Domain Module（Security command types）分切片。
- **Rust 重写与性能判断：** 已知成本是重复安全扫描/remediation 入队；Rust 保持相同 intent coalescing，指标为 dedupe hit、队列长度、执行次数、key collision rate，oracle 为 submission fixture trace。
- **验证 oracle：** 各 command 的 key fixtures、不同 actions order/values、scan/feed/rollback variants 与 secret-safe job log test。
- **证据：** 本文件 `createSecurityJobPort`；`security/service.ts`；security operations workflow。

### runtime-host/application/security/security-plugin-config-applier.ts

- **当前 owner：** 已存 security policy 向 Runtime plugin config apply 的单向集成 owner。
- **职责与关键 symbols：** `SecurityPluginConfigProjectionPort`、`SecurityPluginConfigApplier.applySavedPolicyToPluginConfig`。
- **旧语义与策略：** 每次先 read repository 当前 policy，再 await plugin config apply；没有 diff、缓存、结果 receipt 或补偿。
- **状态、存储与副作用：** repository 读文件；plugin projection 写 Runtime/OpenClaw config。
- **并发与性能特征：** 一次 read+apply 串行；重复调用会重复 projection。
- **调用/依赖边界：** security policy workflow/operations 调用；实现端是 Runtime Integration，而非 Platform security fact owner。
- **故障、恢复与安全：** read/apply 失败传播；未记录 applied/observed，不能声称 runtime 已实际生效；policy 不应含 secret。
- **迁移分类：** Preserve：read then apply 顺序与错误传播；Intentional Improvement：Rust 记录 desired policy、applied projection、observed runtime receipt 三态；Defect：未证实；待验证：重复 apply 幂等性和 runtime restart 后重放。
- **未来 Rust owner：** Runtime Integration。
- **Rust 重写与性能判断：** 旧成本是一读一写，无差分；Rust 可仅在 confirmed diff 时投影但必须保持每次调用可观察结果，指标为 apply calls、projection lag/failure、observed receipt，oracle 为 fake plugin fault/restart trace；不假称 exactly-once。
- **验证 oracle：** read failure/apply failure、相同 policy repeated call、restart/reconcile scenario with desired/applied/observed assertions。
- **证据：** 本文件；`security-policy-store.ts`；OpenClaw `openclaw-security-plugin-config-workflow.ts`/projection implementation boundary。

### runtime-host/application/security/security-policy-normalizer.ts

- **当前 owner：** Security policy 输入的纯 schema/default/allowlist normalizer owner。
- **职责与关键 symbols：** `normalizeSecurityPolicyPayload` 与各 scalar/list/action/preset/severity/runtime normalize helpers。
- **旧语义与策略：** preset 无效→relaxed，version 无效→1；action 只接受五值，failure mode 只接受三值；列表去空白去重；无效 boolean/number 回退 template；destructive categories 总从全局默认取值而不是 preset runtime 的 categories。
- **状态、存储与副作用：** 纯对象处理；template clone 使用 JSON stringify/parse。
- **并发与性能特征：** 固定深度对象与列表 O(L) 去重；JSON clone 的成本为模板大小。
- **调用/依赖边界：** security store read/write、emergency policy、plugin config workflow 使用；types/presets 是唯一规则来源。
- **故障、恢复与安全：** 类型坏输入不抛出而归一为安全默认；允许自定义 patterns/allowlists 是数据而非执行；pattern 的下游 regex 安全性待验证。
- **迁移分类：** Preserve：所有 fallback、白名单、list normalization、version floor 和 preset baseline；Intentional Improvement：结构化 clone 可取代 JSON clone但输出必须一致；Defect：无测试闭环证据；待验证：未知字段有意丢弃的客户端兼容性。
- **未来 Rust owner：** Domain Module（Security policy schema）。
- **Rust 重写与性能判断：** 已知成本是模板 JSON 深拷贝与 list O(L)；Rust typed clone 保持字段/默认，指标为 normalization output equality、allocation/latency，oracle 为 invalid/mixed payload differential fixture；不得因实现改变默认安全级别。
- **验证 oracle：** 每个 preset、invalid action/failure/version/number/list、所有 categories/severity 的 snapshot tests。
- **证据：** 本文件；`security-policy-presets.ts`、`security-emergency-policy.ts`、security store workflow。

### runtime-host/application/security/security-policy-presets.ts

- **当前 owner：** strict/balanced/relaxed 安全 policy 的静态 template 与默认 severity/category owner。
- **职责与关键 symbols：** destructive/secret defaults、categories、`PRESET_RUNTIME_TEMPLATES`、`cloneRuntimeTemplate`。
- **旧语义与策略：** 三 preset 明确不同 monitor/audit/destructive/secrets actions；audit egress allowlist 与 daily cap 在 template 固定；clone 深拷贝，调用者修改不影响模板。
- **状态、存储与副作用：** 只读常量，clone 产生内存对象。
- **并发与性能特征：** clone 为小固定对象 JSON round-trip；无共享可变状态。
- **调用/依赖边界：** normalizer 以 preset 作为 fallback；emergency policy 覆盖 strict；security UI/API 要映射相同 vocabulary。
- **故障、恢复与安全：** template 本身不执行 guard；allowlist 是策略数据，不证明 Runtime enforcement；变更默认可能显著改变安全可观察行为。
- **迁移分类：** Preserve：所有具体 template 值、clone 隔离；Intentional Improvement：无已批准项；Defect：未证实；待验证：现有 Runtime plugin 对每个字段的完整支持情况。
- **未来 Rust owner：** Domain Module（Security policy）。
- **Rust 重写与性能判断：** 旧成本为小模板 JSON clone；Rust typed copy 保持不共享状态，指标为 preset serialization equality 和 apply behavior, oracle 为 normalizer/security plugin fixtures；无性能主张。
- **验证 oracle：** 三 preset 完整 snapshot、clone 后 mutation 不污染下一次 clone、plugin projection payload fixtures。
- **证据：** 本文件；`security-policy-normalizer.ts`、`security-emergency-policy.ts`。

### runtime-host/application/security/security-policy-store.ts

- **当前 owner：** Security policy persistence workflow 的 repository facade owner。
- **职责与关键 symbols：** `SecurityPolicyRepository.getFilePath/read/write`，重导 storage port。
- **旧语义与策略：** 纯委托 workflow；没有缓存或额外 schema 逻辑。
- **状态、存储与副作用：** 下游 workflow 在 runtime data root `policies/security.policy.json` 读写并进行 normalization。
- **并发与性能特征：** 本层常数委托；文件锁/原子写未定义。
- **调用/依赖边界：** plugin config applier、security operations/policy workflow 使用；storage adapter 用 common filesystem port。
- **故障、恢复与安全：** 读写失败由 workflow；policy 文件不应包含 token，但该性质由 payload schema/adapter共同保证。
- **迁移分类：** Preserve：repository boundary和 getFilePath/read/write；Intentional Improvement：使用 Foundation 存储原语可提升崩溃恢复，需保留 missing/corrupt fallback；Defect：未证实；待验证：并发 policy writes 与磁盘故障的行为。
- **未来 Rust owner：** Domain Module（Security policy facts）与 Foundation Kernel（存储）分切片。
- **Rust 重写与性能判断：** 无本文件实现成本；Rust 保持 normalized read/write contract，指标为 write latency、crash recovery/parse fallback，oracle 为 storage workflow fixtures。
- **验证 oracle：** 首读缺文件、有效写读、坏 JSON、断电/并发写 storage adapter tests。
- **证据：** 本文件；`runtime-host/application/workflows/security-policy/security-policy-store-workflow.ts`；`security-plugin-config-applier.ts`。

### runtime-host/application/security/security-policy-types.ts

- **当前 owner：** Security policy、guard、rule catalog 的共享 type grammar owner。
- **职责与关键 symbols：** preset/action/severity/failure unions，runtime policy/payload，rule catalog platform/item types。
- **旧语义与策略：** policy 包含 monitors、allowlist、logging、destructive/secrets severity actions、patterns；rule catalog category 与 severity vocabulary 明确。
- **状态、存储与副作用：** 类型声明，无运行时实现。
- **并发与性能特征：** 无。
- **调用/依赖边界：** normalizer/presets/emergency/store/plugin/service/rule catalog 和 security workflows 共用。
- **故障、恢复与安全：** 类型不等于 runtime enforcement；未表达 policy apply receipt 或 secret fields。
- **迁移分类：** Preserve：所有 enum/DTO grammar；Intentional Improvement：可给 apply operation 添加 Platform receipt，但领域 policy 留在 Security Domain Module；Defect：未证实；待验证：外部 UI/Runtime 是否接受未知 future policy field。
- **未来 Rust owner：** Domain Module（Security policy types）。
- **Rust 重写与性能判断：** 无旧成本；Rust enums/serde schema 保持 JSON compatibility，指标为 schema round-trip，oracle 为 policy API/store fixtures。
- **验证 oracle：** 全 enum serialization、invalid enum rejection/normalization、policy JSON snapshot tests。
- **证据：** 本文件；`security-policy-normalizer.ts`、`security-rule-catalog.ts`。

### runtime-host/application/security/security-rule-catalog.ts

- **当前 owner：** 安全 UI/审计引用的静态高危命令 catalog 和平台筛选 owner。
- **职责与关键 symbols：** `SECURITY_RULE_CATALOG`、`listSecurityRuleCatalog`、platform normalizer。
- **旧语义与策略：** 支持 universal/linux/windows/macos/powershell；指定平台返回 universal 加该平台，非法平台按无筛选返回完整目录；结果含 success/total/items。
- **状态、存储与副作用：** 进程内静态表，无执行命令副作用。
- **并发与性能特征：** O(R) filter，R 当前固定且小。
- **调用/依赖边界：** `SecurityRuntimeService.listRuleCatalog` 提供给 route/UI；rule items 不等同真正 guard detection engine。
- **故障、恢复与安全：** 不执行/解析 command；未知 platform 不报错而全量返回，这一兼容策略不是 runtime 权限结论。
- **迁移分类：** Preserve：目录、筛选与非法 platform 全量 fallback；Intentional Improvement：无已批准项；Defect：未证实；待验证：catalog 是否必须与 Runtime guard 规则逐项对应。
- **未来 Rust owner：** Domain Module（Security catalog）。
- **Rust 重写与性能判断：** 旧成本为小数组 O(R) filter；Rust 静态 catalog 保持顺序和筛选，指标为 fixture equality，oracle 为每 platform/unknown table tests；无优化必要。
- **验证 oracle：** 无参数、各合法平台、大小写/空白、非法平台的 items/total snapshot。
- **证据：** 本文件；`security/service.ts`。

### runtime-host/application/security/service.ts

- **当前 owner：** Security domain 的 application facade：policy、audit、emergency、integrity、skills/advisory、remediation 公开用例。
- **职责与关键 symbols：** `SecurityRuntimeService` 的全部 workflow forwarding 方法与 `listRuleCatalog`。
- **旧语义与策略：** 用 queued/execute 对区分长任务请求和实际执行；仅 catalog 在本地处理；payload URL/actions 的解析委托 operations workflow。
- **状态、存储与副作用：** 无本地状态；下游写 policy、调用 gateway/plugin、scan/audit/remediation 和任务系统。
- **并发与性能特征：** 本层无锁；dedupe 属于 `SecurityJobPort`/workflow；heavy scan/audit 成本不在此文件。
- **调用/依赖边界：** security routes/capability 到服务；下游 security operations workflow 与 static catalog。
- **故障、恢复与安全：** workflow 错误不在 facade 拦截；不把 Runtime 内部权限/插件失败归 Platform；remediation 需要下游验证 actions。
- **迁移分类：** Preserve：公共用例集合、queued/execute 边界和 catalog response；Intentional Improvement：无已批准项；Defect：未证实；待验证：execute endpoints 是否仅受内部 job executor 调用、remediation 回滚完整性。
- **未来 Rust owner：** Delivery（security commands/queries）与 Domain Module（Security workflows）分切片。
- **Rust 重写与性能判断：** facade 无已证实热点；Rust 保持 command response/async boundary，指标为 route/job latency、audit/remediation success/failure, oracle 为 operation workflow trace fixtures。
- **验证 oracle：** 每个 method forwarding、queue vs execute、catalog filtering、failure propagation/authorization workflow tests。
- **证据：** 本文件；`security-jobs.ts`；`runtime-host/application/workflows/security-operations/security-operations-workflow.ts`。

### runtime-host/application/settings/defaults.ts

- **当前 owner：** runtime-host settings 的静态产品默认值 owner。
- **职责与关键 symbols：** `SETTINGS_DEFAULTS`，涵盖 UI、gateway、browser/proxy、ClawHub、updates、bundles/skills/security 等键。
- **旧语义与策略：** 所有键有明确 default；包含 gatewayToken/clawHubToken 空字符串，但不提供读取/公开 projection 规则；security 默认 relaxed/version 1。
- **状态、存储与副作用：** 只读进程常量。
- **并发与性能特征：** 无。
- **调用/依赖边界：** settings store workflow 用它创建默认、做类型归一；settings runtime-config sync workflow 根据 selected key 投影到 OpenClaw/Runtime。
- **故障、恢复与安全：** 默认 token 为空不是存储安全证明；公共 getAll 若返回 token 的行为必须由调用链验证，不可在本文件断言。
- **迁移分类：** Preserve：键集合和值；Intentional Improvement：secret settings 应进入 Foundation private secret projection，但先需维持已有公开 API 行为或明确 breaking change；Defect：未证实；待验证：gatewayToken/clawHubToken 在 settings read/API 路径是否脱敏。
- **未来 Rust owner：** Domain Module（Settings desired facts）与 Foundation Kernel（secret/redaction mechanism）分切片。
- **Rust 重写与性能判断：** 无算法成本；Rust defaults DTO 保持所有 key/value，指标为 settings default snapshot/secret exposure scan，oracle 为 store normalization fixtures。
- **验证 oracle：** 默认对象完整 snapshot，read/route response 不泄露敏感 token 的 security test（待补若当前未覆盖）。
- **证据：** 本文件；`runtime-host/application/workflows/settings-store/settings-store-workflow.ts`；`settings/service.ts`。

### runtime-host/application/settings/service.ts

- **当前 owner：** Settings application facade；拥有 reset 后 runtime config sync 的顺序。
- **职责与关键 symbols：** `SettingsService.getAll/patch/reset/getValue/setValue/executeRuntimeConfigSync` 和 `SettingsRuntimeConfigPort`。
- **旧语义与策略：** getAll/read value 直接 repository；patch/setValue 委托 sync workflow；reset 先 repository.reset，再 await workflow.reset，最后 200 `{success:true,settings}`；runtime sync execute 返回 success。
- **状态、存储与副作用：** repository 读/写 settings 文件；sync workflow 可修改 Runtime proxy/browser mode。
- **并发与性能特征：** reset 两个步骤串行；并发 patch/reset 调用的冲突策略不在本文件。
- **调用/依赖边界：** settings routes/capability 到服务；下游 settings store 和 settings-runtime-config sync workflow。
- **故障、恢复与安全：** reset 写成功但 sync 失败会抛出，当前无补偿/receipt；token fields 的 public projection 未由此文件过滤。
- **迁移分类：** Preserve：reset 先存储后 sync 及返回对象、patch/setValue delegation；Intentional Improvement：Rust 应记录 desired settings、applied runtime sync、observed runtime receipt 三态；Defect：无 test/call-chain 闭环，不能将部分失败定为缺陷；待验证：reset 后 sync failure 的重试/用户可见状态和 token redaction。
- **未来 Rust owner：** Domain Module（Settings desired facts）＋ Runtime Integration（proxy/browser projection）＋ Delivery（settings API）分切片。
- **Rust 重写与性能判断：** 已知成本为 reset 的一次文件写+一次 runtime projection；保持顺序，指标为 config sync lag/partial failure/recovery、settings read latency，oracle 为 fake store/runtime fault trace；不得声称 external exactly-once。
- **验证 oracle：** existing `tests/unit/settings-routes.proxy-sync.test.ts`；补充 reset storage-success/sync-fail、desired/applied/observed and secret-safe read tests。
- **证据：** 本文件；CodeGraph callers 和 `settings-store-workflow.ts`/`settings-runtime-config-sync-workflow.ts`。

### runtime-host/application/settings/settings-jobs.ts

- **当前 owner：** settings runtime config sync 任务的 submission contract owner。
- **职责与关键 symbols：** `SYNC_SETTINGS_RUNTIME_CONFIG_JOB`、payload `{settings,syncProxy,syncBrowserMode}`、`SettingsJobPort`、factory。
- **旧语义与策略：** 所有 sync 请求共用单一 dedupe key，无 payload 区分；最后被执行的 payload/queue merge 行为由 task system 决定，当前文件未定义。
- **状态、存储与副作用：** 无状态；tasks.submit 入队，payload 包含完整 settings record。
- **并发与性能特征：** 一个全局 key 抑制并发 sync；可能将不同 settings intents 合并，具体保留哪个不在此代码。
- **调用/依赖边界：** settings runtime-config sync workflow/application composition 使用；下游任务 executor 与 Runtime Integration sync。
- **故障、恢复与安全：** payload 或含 token；port 未提供 redaction；必须验证队列不记录/暴露 secret。未证明则不能称 Defect。
- **迁移分类：** Preserve：job name、payload fields、全局 dedupe key；Intentional Improvement：Rust 可以 desired version/correlation 合并且记录 applied/observed，而不是隐式丢意图；Defect：未证实；待验证：同 key 提交时 queue 的 winner 语义和 payload secret persistence。
- **未来 Rust owner：** Foundation Kernel（dedupe/correlation/secret-safe task transport）与 Domain Module（Settings sync intent）分切片。
- **Rust 重写与性能判断：** 可证实成本是频繁设置变更的重复 projection，现有全局 dedupe 降低该成本；保持最终 sync 可观察语义前，指标为 submit/execute 数、staleness、payload secret scan，oracle 为快速连续 patch trace。
- **验证 oracle：** 两个不同 settings payload 连续提交的 queue behavior；sync proxy/browser flag fixtures；job persistence log secret scan。
- **证据：** 本文件；`settings/service.ts`、settings runtime-config sync workflow、`runtime-contracts.ts`。

### runtime-host/application/settings/store.ts

- **当前 owner：** Settings store workflow 的薄 repository facade owner。
- **职责与关键 symbols：** `SettingsRepository.getAll/patch/setValue/reset`，重导环境 port。
- **旧语义与策略：** 每个公开方法原样 await settings workflow；无 cache、validator 或 response mapping。
- **状态、存储与副作用：** 下游 workflow 读写 `matchaclaw-settings.json`，合并 defaults 并检测 locale。
- **并发与性能特征：** 本层常数委托；全文件 JSON 读写、并发策略属于 workflow。
- **调用/依赖边界：** `SettingsService` 调用 repository；composition 以 OpenClaw environment/filesystem 注入 workflow。
- **故障、恢复与安全：** repository 不捕获异常；底层 workflow 当前读/parse 失败降级 `{}`，写失败传播；敏感键公开性待验证。
- **迁移分类：** Preserve：repository 方法与底层容错边界；Intentional Improvement：Foundation storage 可提供 atomic write，但必须保留 malformed/missing read defaults；Defect：未证实；待验证：多个窗口并发 patch 的 last-write 行为。
- **未来 Rust owner：** Domain Module（Settings repository）与 Foundation Kernel（storage）分切片。
- **Rust 重写与性能判断：** 本文件无算法；下游已知全 JSON read/write，Rust 保持 merge/normalization result，指标为 read/write latency、parse recovery、concurrent write loss，oracle 为 settings-store workflow fixtures。
- **验证 oracle：** valid/malformed/missing JSON、patch/set/reset, locale/default values, concurrent writer tests。
- **证据：** 本文件；`settings/service.ts`；CodeGraph 完整源码 `settings-store-workflow.ts` 与 OpenClaw environment path provider。

### runtime-host/application/usage/token-usage-history-jobs.ts

- **当前 owner：** token usage history refresh job submission owner。
- **职责与关键 symbols：** `REFRESH_TOKEN_USAGE_HISTORY_JOB`、`TokenUsageHistoryJobPort`、factory。
- **旧语义与策略：** 使用自身名称为 dedupe key 和 10 秒 refresh cooldown，避免轮询重复扫描。
- **状态、存储与副作用：** 无状态；tasks.submit 入队。
- **并发与性能特征：** 同一窗口只应有一个 refresh job；扫描成本在 usage workflow。
- **调用/依赖边界：** token usage history workflow/API 使用；依赖 runtime-job-throttle 和 long-task port。
- **故障、恢复与安全：** 本层无重试/错误处理；usage logs 可能含 provider/model 元数据但无 token contract。
- **迁移分类：** Preserve：job 名/dedupe/cooldown；Intentional Improvement：无已批准项；Defect：未证实；待验证：任务重启后 cooldown 与 recent cache 的关系。
- **未来 Rust owner：** Foundation Kernel（refresh dedupe）与 Domain Module（Usage command）分切片。
- **Rust 重写与性能判断：** 已证实旧成本是频繁扫描触发的队列增长；Rust 保持十秒 coalescing，指标为 scan count、queue depth、cache staleness，oracle 为模拟时钟 job trace。
- **验证 oracle：** 连续 refresh 的 dedupe/cooldown boundary tests 及 usage workflow scan invocation count。
- **证据：** 本文件；`runtime-job-throttle.ts`；`runtime-host/application/workflows/usage/token-usage-history-workflow.ts`。

### runtime-host/application/usage/token-usage-history.ts

- **当前 owner：** token usage transcript-layout contract 与 usage workflow repository facade owner。
- **职责与关键 symbols：** `extractSessionIdFromTranscriptFileName`、transcript/runtime data ports、`TokenUsageHistoryRepository.recent/refreshCache/isReady/scanRecent`。
- **旧语义与策略：** `.deleted.jsonl` 与 reset-deleted 排除；正常 `.jsonl` 与 `.jsonl.reset.*` 去后缀得 session id；repository 原样委托 workflow。
- **状态、存储与副作用：** layout port 发现 transcript files；workflow 管理 in-memory cache/扫描；本 file 不直接读内容。
- **并发与性能特征：** 文件名提取为字符串常数/线性；全目录 discovery 和 cache 策略在 layout/workflow，不在本文件。
- **调用/依赖边界：** usage workflow 注入 OpenClaw runtime data layout；cron/diagnostic 等不直接依赖此 repository。
- **故障、恢复与安全：** deleted transcript 显式不计入；layout/scan I/O error 由 workflow 定义；usage records 可能涉及 model/provider，无 secret redaction 实现于此。
- **迁移分类：** Preserve：deleted exclusion 与 reset filename grammar、repository API；Intentional Improvement：用 cursor/index 加速扫描要保持 file inclusion/exclusion；Defect：未证实；待验证：reset files 对同 session 的时间/重复使用语义。
- **未来 Rust owner：** Domain Module（Usage history）与 Runtime Integration（runtime transcript layout）分切片。
- **Rust 重写与性能判断：** 此文件可证实成本仅 filename parsing；下游目录扫描成本待 workflow evidence。Rust 保持 file selection，指标为 discovered file count、scan latency、cache staleness，oracle 为 filename and layout fixture differential tests。
- **验证 oracle：** 正常/deleted/reset/reset-deleted/non-jsonl filename table，fake workflow forwarding and layout discovery integration tests。
- **证据：** 本文件；CodeGraph relation `OpenClawRuntimeDataLayout → TokenUsageTranscriptLayoutPort`；usage workflow imports。

### runtime-host/application/usage/token-usage-parser.ts

- **当前 owner：** session transcript JSONL 中 token/cost usage 的容错解析和规范化 owner。
- **职责与关键 symbols：** `TokenUsageHistoryEntry`、`parseUsageEntriesFromJsonl`、usage number/shape parser。
- **旧语义与策略：** 倒序扫描至 limit；坏 JSON/无 timestamp/message/不相关 role 忽略；assistant 仅在自身有 usage 时采集，toolresult 从 details.usage 采集；支持多种 snake/camel/legacy token keys；usage null/非 object→error，全无值→missing，total 优先显式否则四类和。
- **状态、存储与副作用：** 纯字符串 JSON parse；不 I/O、不写缓存。
- **并发与性能特征：** `content.split` 先产生全量行数组，最坏 O(file bytes) 内存；倒序在达到 limit 后停止 JSON parse，但 split 成本已发生。
- **调用/依赖边界：** token usage history workflow 用 parser 消费 transcript files；输出供 usage API/UI。
- **故障、恢复与安全：** malformed entries 容错跳过；错误/缺失用状态而非 throw；不会采集非 assistant/tool-result usage；不记录 raw content，降低暴露面但 source text仍在调用方内存。
- **迁移分类：** Preserve：支持字段别名、role 筛选、状态三分、显式 total 优先、倒序/limit 顺序；Intentional Improvement：可流式逆向/索引减少全量 split，但必须保持同样最后 N entries 和坏行跳过；Defect：无源码/调用链/测试闭环，不能把全量 split 定性为缺陷；待验证：同一 transcript 内 assistant 与 toolresult usage 是否会双计。
- **未来 Rust owner：** Domain Module（Usage normalization）与 Runtime Integration（transcript format adapter）分切片。
- **Rust 重写与性能判断：** 已证实旧成本是全 content split/内存及最多 limit 条的 JSON parse；Rust 优化只能保持 reverse scan/limit 和所有 aliases/status，指标为大 JSONL 峰值内存、parse p95、条目数/总 token differential，oracle 为 malformed/mixed transcript fixtures and benchmark.
- **验证 oracle：** 每个 alias、number/string/invalid value、missing/error/available、assistant/toolresult、坏 JSON、limit/reverse order、explicit-total fixtures。
- **证据：** 本文件 `parseUsageFromShape`、`parseUsageEntriesFromJsonl`；`token-usage-history.ts` 与 usage history workflow。

## 当前 Git status 增量边界（2026-07-12）

- **`send-media.ts` 的职责收缩：**当前 diff 删除 `sendWithMediaViaGateway()`；本文件保留附件筛选、文件读取、base64 payload、文本引用和 `buildSendWithMediaGatewayParams()`。Gateway send、异常折叠为 `{success:false,error}` 和结果语义不再归该 helper，而是由 07 的 `SessionRunWorkflow` 经 endpoint-selected `RuntimeSessionTransport` 承接。参数构建不等于 runtime receipt、更不等于外部 delivery 或 exactly-once。
- **外部调用链：**renderer attachment preview/staging、chat store与 toast只作为 Delivery input/projection；它们不拥有文件授权、payload protocol或发送终态。Electron的 loopback/IPC/process-runtime也不是本分片领域事实；若其承载受管 Runtime lifecycle，须作为 Rust Local Process Host 的外部旧 owner归入对应 lifecycle migration slice，而不能反向把 chat/media归 Electron或Rust Foundation。
- **终态 owner：**媒体与文件/Workspace policy由相应 Domain Module持有，endpoint/session correlation归 Platform Core，具体 runtime prompt transport归 Runtime Integration，受控 I/O/secret handles归 Foundation，HTTP/UI仅是 Delivery。当前 Rust cutover、runtime send、secret redaction和附件生命周期均未执行验证。
