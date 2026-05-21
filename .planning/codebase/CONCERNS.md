# 代码库关注点

**分析日期：** 2026/05/21

## 技术债

**Browser relay 核心逻辑集中在大型有状态模块中：**
- 问题：`packages/openclaw-browser-relay-plugin/src/relay/server.ts` 同时承担 HTTP 路由、WebSocket 握手、extension 会话、CDP client 转发、target/session 映射、选择状态持久化、pending request 清理等职责；`packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts` 继续承载 browser action 参数归一化、cookie/file 处理、Playwright/direct-CDP 分派与错误映射。
- 文件：`packages/openclaw-browser-relay-plugin/src/relay/server.ts`, `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`, `packages/openclaw-browser-relay-plugin/src/playwright/actions.ts`, `tests/unit/openclaw-browser-relay-service.test.ts`, `tests/unit/openclaw-browser-relay-plugin.test.ts`
- 影响：修改 browser control、target 生命周期或 relay 认证边界时，需要同时理解 `extensionClients`、`cdpClients`、`browserSessions`、`pendingRequests`、`pendingTargetAttachments`、selection state 等共享状态，容易引入断连清理不完整、target 归属错误或 direct-CDP/extension 路径不一致。
- 建议：按职责拆出 target registry、extension connection lifecycle、CDP session bridge、HTTP JSON endpoints、selection persistence；先保留 `BrowserRelayServer` 对外接口，通过小步提取纯函数和窄接口降低回归面。

**`src/stores/subagents.ts` 聚合 UI 状态、RPC、缓存与草稿编排：**
- 问题：`src/stores/subagents.ts` 包含 Zustand store、`agents.*` RPC 调用、runtime 可见性轮询、配置展示缓存、localStorage avatar 持久化、导入导出校验、draft session 清理与 mutation 串行化。
- 文件：`src/stores/subagents.ts`, `src/features/subagents/domain/prompt.ts`, `src/features/subagents/domain/workspace.ts`, `tests/unit/subagents.store.test.ts`, `tests/unit/subagent-prompt.test.ts`
- 影响：界面层状态修改可能影响 runtime 同步或 agent mutation 顺序；`workspaceFallbackRootCache`、`configDisplayCache`、`queuedLoadAgentsTask`、`agentsSnapshotRetryTimer` 等模块级缓存让测试隔离、热更新和失败恢复更脆弱。
- 建议：将 RPC endpoint 选择、response normalization、runtime barrier、draft history polling 下沉到 `src/services/openclaw/` 或 `src/features/subagents/domain/`；Zustand action 只保留状态切换和 orchestration。

**runtime-host 进程管理混合构建修复与生命周期控制：**
- 问题：`electron/main/runtime-host-process-manager.ts` 在同一模块中处理 stale build 检测、执行 `pnpm run build:runtime-host-process`、子进程启动、health probe、auto-restart backoff、shutdown escalation 和日志转发。
- 文件：`electron/main/runtime-host-process-manager.ts:255`, `electron/main/runtime-host-process-manager.ts:262`, `electron/main/runtime-host-process-manager.ts:320`, `electron/main/runtime-host-process-manager.ts:398`, `tests/unit/runtime-host-process-manager.test.ts`
- 影响：开发模式 rebuild、生产启动、崩溃恢复共享控制路径；构建失败或慢构建会表现为 runtime-host 生命周期错误，修改启动逻辑时必须同时覆盖 packaged 与 development 两种行为。
- 建议：把 build freshness/rebuild 抽成可注入依赖，进程生命周期只依赖已解析的 `scriptPath`；测试中分别覆盖 rebuild 成功/失败、health timeout、auto-restart 上限和 shutdown escalation。

**`memory-lancedb-pro` 主实现文件职责过重：**
- 问题：`packages/memory-lancedb-pro/index.ts` 从配置校验、embedding、CLI 调用、memory store、Markdown mirror、reflection 文件分配到工具导出都集中在单文件；`packages/memory-lancedb-pro/cli.ts` 也包含大量命令解析、OAuth 状态、import/export/re-embed/upgrade 输出逻辑。
- 文件：`packages/memory-lancedb-pro/index.ts`, `packages/memory-lancedb-pro/cli.ts`, `packages/memory-lancedb-pro/src/llm-oauth.ts`
- 影响：memory 插件的配置、存储和 CLI 行为耦合，后续修改 OAuth、embedding 或 migration 时容易影响无关命令；大文件也降低审查效率。
- 建议：按 config、oauth、store、embedding、migration、cli-commands 分层拆分，并为 `parseJsonFromCliOutput()`、OAuth session、bulk import/re-embed 等边界补充窄单元测试。

## 已知缺陷

**Gemini browser OAuth 没有 manual/remote fallback：**
- 症状：`BrowserOAuthManager` 给 `loginGeminiCliOAuth()` 注入的 `prompt` 直接抛错，`loginGeminiCliOAuth()` 在 `ctx.isRemote` 为 true 时也直接抛出未实现错误。
- 文件：`electron/services/providers/oauth/browser-oauth-manager.ts:58`, `electron/services/providers/oauth/browser-oauth-manager.ts:59`, `electron/services/providers/oauth/gemini-cli-oauth.ts:675`, `electron/services/providers/oauth/gemini-cli-oauth.ts:679`
- 触发：Google/Gemini OAuth 无法绑定或接收 `127.0.0.1:8085` 回调，或运行环境需要 remote/manual completion。
- 影响：用户无法通过粘贴 callback URL/code 完成 Gemini CLI OAuth，登录流程直接失败。
- 建议：复用 OpenAI OAuth 的 `oauth:code` / `submitManualCode()` 事件模型，为 Gemini 增加 manual code path，并为 port-in-use、timeout、cancel 三类路径补测试。

**更新检查在开发模式下被标记为错误：**
- 症状：`checkForUpdates()` 在 `update:check` 没有返回 status 且没有 updater event 时，将状态设为 `error`，错误文案说明通常是 dev mode。
- 文件：`src/stores/update.ts:142`, `src/stores/update.ts:146`, `src/stores/update.ts:168`, `src/stores/update.ts:172`
- 触发：开发环境或任何 autoUpdater 跳过且未产生状态事件的场景。
- 影响：正常的开发模式检查会展示为错误，降低用户/测试对真实 updater 故障的辨识度。
- 建议：为 dev-mode/no-op 增加单独状态，例如 `idle` 或 `not_applicable`；仅把明确失败和 timeout 设为 `error`。

**Host API 支持 query token 鉴权，token 可能进入 URL 传播面：**
- 症状：`createHostApiRequestHandler()` 同时接受 `Authorization: Bearer` 和 `?token=`；测试也覆盖 `/api/events?token=...` 通过认证。
- 文件：`electron/api/server.ts:66`, `electron/api/server.ts:73`, `electron/api/server.ts:74`, `tests/unit/host-api-server-boundary.test.ts:142`, `tests/unit/host-api-server-boundary.test.ts:150`
- 触发：SSE 或其它 Host API 调用使用 query token。
- 影响：query token 更容易进入日志、浏览器历史、错误上报或 referrer 传播路径；虽然服务仅监听 `127.0.0.1`，仍扩大本地 token 暴露面。
- 建议：仅对无法设置 header 的 SSE fallback 保留 query token，并限制路径；优先使用 `Authorization` header，记录日志时确保剥离 query string。

## 安全考虑

**Browser relay 私钥硬编码在源码中：**
- 风险：`packages/openclaw-browser-relay-plugin/src/relay/keypair.ts` 同时包含 relay public key 和 private key，`BrowserRelayServer` 使用静态 private key 解密 extension 提供的 per-session key；代码库读取者即可获得该静态 private key。
- 文件：`packages/openclaw-browser-relay-plugin/src/relay/keypair.ts`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts`
- 当前缓解：relay 绑定 `127.0.0.1`；extension handshake 要求 `encryptedSessionKey`；`/cdp`、`/diagnostics`、`/json*` 使用 `x-phoenix-relay-token`；extension 消息握手后走加密传输。
- 建议：生成安装级或会话级 relay keypair，并在运行时把 public key 提供给 extension；将当前静态 private key 视为已公开材料，不再作为安全边界。

**relay `/status`、`/version` 与 `/cdp-reconnect` 未做 token 鉴权：**
- 风险：`/status` 返回连接状态、tabCount、relayPort、selectedBrowserInstanceId、selectedWindowId、browserCount 等本地自动化元数据，并设置 `Access-Control-Allow-Origin: *`；`/cdp-reconnect` 会关闭 extension clients。
- 文件：`packages/openclaw-browser-relay-plugin/src/relay/server.ts:876`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts:895`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts:900`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts:912`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts:916`
- 当前缓解：敏感的 CDP JSON route 和 WebSocket `/cdp` 需要 `x-phoenix-relay-token`；relay 只监听 loopback。
- 建议：未鉴权 endpoint 只返回最小 readiness，例如 `OK`；浏览器连接信息、selected window、reconnect 操作全部要求 `x-phoenix-relay-token`。

**renderer 可通过 `hostapi:token` 获取 Host API bearer token：**
- 风险：`registerHostApiProxyHandlers()` 暴露 `ipcMain.handle('hostapi:token', () => getHostApiToken())`；同一模块还允许 renderer 传入任意 `path`、`method`、`headers`、`body` 后由 main process 附加 bearer token 转发到本地 Host API。
- 文件：`electron/main/ipc/hostapi-proxy-ipc.ts:28`, `electron/main/ipc/hostapi-proxy-ipc.ts:43`, `electron/main/ipc/hostapi-proxy-ipc.ts:51`, `electron/main/ipc/hostapi-proxy-ipc.ts:62`, `electron/main/ipc/hostapi-proxy-ipc.ts:80`
- 当前缓解：目标 host/port 固定为 `http://127.0.0.1:${port}`；`Authorization` header 由 main process 覆盖。
- 建议：main process 按 route prefix 和 method 做 allowlist，特别限制 file、shell、provider OAuth、runtime-host proxy 等高权限路径；`hostapi:token` 仅用于必须直连 SSE 的最小场景，并避免暴露给普通 renderer 调用。

**Browser action `evaluate` 执行调用方提供的 JavaScript：**
- 风险：`evaluateFunctionOnPage()` 使用 `new Function` 和 `eval("(" + fnBody + ")")`，随后在 page context 执行；这是自动化能力，但等价于在受控浏览器页面执行任意脚本。
- 文件：`packages/openclaw-browser-relay-plugin/src/playwright/actions.ts:83`, `packages/openclaw-browser-relay-plugin/src/playwright/actions.ts:84`, `packages/openclaw-browser-relay-plugin/src/playwright/actions.ts:91`, `packages/openclaw-browser-relay-plugin/src/playwright/actions.ts:107`
- 当前缓解：执行路径依赖本地认证的 browser control；`timeoutMs` 被限制在 500 到 120000 ms。
- 建议：把 `evaluate` 标记为 privileged action，增加审计日志和调用源记录；不要把 `fnBody` 暴露给不可信 plugin/user input，必要时改为受限表达式或预定义动作。

**Markdown 渲染依赖 `dangerouslySetInnerHTML`，安全性取决于 `markdown-it` 的 `html: false` 配置：**
- 风险：多个组件把 markdown 渲染结果写入 DOM；当前 `createMarkdownRenderer()` 设置 `html: false`，但后续如果开启 HTML、添加不安全插件或绕过 `getOrBuildMarkdownBody()`，会产生 XSS 风险。
- 文件：`src/pages/Chat/md-pipeline.ts:192`, `src/pages/Chat/md-pipeline.ts:194`, `src/pages/Chat/assistant-message-body.tsx:110`, `src/pages/Chat/chat-message-parts.tsx:393`, `src/pages/Chat/chat-message-parts.tsx:595`, `src/components/file-preview/MarkdownPreview.tsx:22`
- 当前缓解：`MarkdownIt` 禁用原始 HTML；链接添加 `target="_blank"` 和 `rel="noopener noreferrer"`；KaTeX 渲染异常时使用 `escapeHtml()`。
- 建议：为 markdown HTML 安全边界增加测试，断言 `<script>`、事件属性、`javascript:` link 不会进入最终 DOM；如引入 HTML 支持，必须加入 DOM sanitizer。

**extension 安装页从 URL 参数拼接 HTML：**
- 风险：`install-helpers.js` 从 `window.location.search` 读取 `extensionPath`，再拼接到 `innerHTML`；`popup.js` 中 tab title/state 有 `escapeHtml()`，但 install path 逻辑没有同等转义。
- 文件：`resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/install-helpers.js:80`, `resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/install-helpers.js:95`, `resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/install-helpers.js:96`, `resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/popup.js:34`, `resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/popup.js:179`
- 当前缓解：该页面主要用于本地 extension 安装引导，参数由应用生成的预期较强；popup tab 内容使用 `escapeHtml()`。
- 建议：install page 使用 `textContent` 和显式 DOM 节点构建路径高亮，或复用 `escapeHtml()`；不要把 URL 参数直接拼进 `innerHTML`。

**OAuth session 明文持久化到磁盘：**
- 风险：`saveOAuthSession()` 把 `access_token` 和 `refresh_token` 写入 JSON 文件；虽然设置 `mode: 0o600`，但 Windows ACL 与不同文件系统上的权限语义并不完全等价。
- 文件：`packages/memory-lancedb-pro/src/llm-oauth.ts:451`, `packages/memory-lancedb-pro/src/llm-oauth.ts:456`, `packages/memory-lancedb-pro/src/llm-oauth.ts:457`, `packages/memory-lancedb-pro/src/llm-oauth.ts:462`
- 当前缓解：写入使用 `mode: 0o600`；已检查代码没有在该函数中打印 token 值。
- 建议：优先使用 OS credential storage；至少在 Windows 上显式校验 ACL，并为 token 文件路径增加安全目录约束。

## 性能瓶颈

**extension popup 每秒固定刷新：**
- 问题：`popup.js` 在 `chrome.storage.onChanged` 事件刷新之外，还在 popup 打开期间 `setInterval(() => refresh(), 1000)`。
- 文件：`resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/popup.js:252`, `resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/popup.js:257`, `resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/popup.js:261`, `resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/popup.js:262`
- 原因：状态同步同时使用事件驱动和固定轮询。
- 改进路径：以 `chrome.storage.onChanged` 和 runtime messages 为主，固定轮询降级为低频 fallback，或只在连接中/错误恢复阶段启用。

**Subagent runtime 可见性与 draft 输出等待使用固定轮询：**
- 问题：`waitUntilAgentVisibleInRuntimeList()` 每 120 ms 轮询 `agents.list` 最多 3 秒；`waitForDraftOutputFromHistoryWithTimeout()` 每 500 ms 读取 history 最多 180 秒。
- 文件：`src/stores/subagents.ts:51`, `src/stores/subagents.ts:52`, `src/stores/subagents.ts:56`, `src/stores/subagents.ts:57`, `src/stores/subagents.ts:993`, `src/stores/subagents.ts:1002`, `src/stores/subagents.ts:1007`, `src/stores/subagents.ts:1038`, `src/stores/subagents.ts:1046`
- 原因：store 通过 repeated RPC reads 等待 runtime eventual consistency。
- 改进路径：runtime-host 提供 agent-created/draft-complete 事件或 long-poll endpoint；保留轮询作为兼容 fallback，并对并发 draft 做退避。

**runtime-host health probe 高频短轮询：**
- 问题：`waitForHealthReady()` 在启动期间每 120 ms 调用 `probeHealth()`，每次 fetch 超时 800 ms。
- 文件：`electron/main/runtime-host-process-manager.ts:292`, `electron/main/runtime-host-process-manager.ts:320`, `electron/main/runtime-host-process-manager.ts:323`, `electron/main/runtime-host-process-manager.ts:328`
- 原因：启动状态没有基于 child stdout/IPC ready event 的明确信号。
- 改进路径：让 runtime-host child 在 ready 后向 parent 发一次明确事件或写入 readiness pipe；health endpoint 轮询只作为兜底。

## 脆弱区域

**Browser relay target/session 生命周期：**
- 文件：`packages/openclaw-browser-relay-plugin/src/relay/server.ts`, `packages/openclaw-browser-relay-plugin/src/relay/ownership.ts`, `packages/openclaw-browser-relay-plugin/src/relay/selection-state.ts`, `packages/openclaw-browser-relay-plugin/src/playwright/session.ts`, `tests/unit/openclaw-browser-relay-plugin.test.ts`, `tests/unit/openclaw-browser-relay-session.test.ts`, `tests/unit/accio-browser-relay-dispatch.test.ts`
- 脆弱原因：正确性依赖 WebSocket 关闭、pending request timeout、target attach/detach、selected window、owner file 和 persisted selection 同步清理；任何一个路径遗漏都会留下 stale target 或错误选择。
- 安全修改：修改前先为 extension disconnect、CDP client disconnect、target close、relay stop during pending request、selected window removal 增加回归测试。
- 测试覆盖：已有 relay plugin/service/session/action 测试；仍缺少 `/status` 认证边界、`/cdp-reconnect` 鉴权、`pendingTargetAttachments` timer cleanup 的细粒度测试。

**Host API 与 renderer IPC 权限边界：**
- 文件：`electron/api/server.ts`, `electron/main/ipc/hostapi-proxy-ipc.ts`, `src/lib/host-api.ts`, `tests/unit/host-api-server-boundary.test.ts`, `tests/unit/host-api.test.ts`, `tests/unit/ipc-contract.test.ts`
- 脆弱原因：Host API 使用 bearer token 保护本地 HTTP，但 renderer IPC 可以触发 main process 携带 token 代理请求；route handler 顺序还要求 `handleRuntimeHostProxyRoutes` 必须是最后 fallback。
- 安全修改：新增 Host API route 时同时更新 `electron/api/route-boundary.ts`、IPC allowlist、单元测试；避免让 renderer-originated path 默认进入 runtime-host proxy。
- 测试覆盖：已有 server boundary 与 host-api client 测试；缺少 `hostapi:fetch` main-process allowlist 和高权限路径拒绝测试。

**Markdown 渲染管线：**
- 文件：`src/pages/Chat/md-pipeline.ts`, `src/lib/chat-markdown-body.ts`, `src/pages/Chat/assistant-message-body.tsx`, `src/pages/Chat/chat-message-parts.tsx`, `src/components/file-preview/MarkdownPreview.tsx`
- 脆弱原因：DOM 安全依赖 `markdown-it` 配置和统一入口；多个 UI 组件直接使用 `dangerouslySetInnerHTML`，如果未来新增渲染入口不走同一 pipeline，安全策略会分叉。
- 安全修改：新增 markdown 渲染场景时必须通过 `getOrBuildMarkdownBody()` 或等效受测管线；不要在组件内临时创建 `MarkdownIt({ html: true })`。
- 测试覆盖：需要补充 markdown XSS regression tests 和 file-preview 渲染测试。

## 扩展限制

**Browser relay 依赖单进程内存状态：**
- 当前容量：`BrowserRelayServer` 在内存中维护所有 extension clients、CDP clients、browser sessions、pending requests 和 target state。
- 限制：浏览器、窗口、tab、pending CDP 请求数量增加时，Map 和 timer 数量同步增长；relay 重启会丢失内存状态，依赖 extension/browser 重新连接恢复。
- 扩展路径：为每个 browserInstance/session 设置 pending request 上限和 timeout 指标；把 target registry 与 pending request manager 抽出，便于做容量控制和诊断。

**Host API request body 以 JSON envelope 方式处理：**
- 当前容量：`electron/api/server.ts` 要求 JSON Content-Type，runtime-host dispatch route 也围绕 JSON envelope 传输。
- 限制：大文件或长任务不适合走普通 JSON route，会增加内存占用并占用单次 request 生命周期。
- 扩展路径：文件上传/下载使用专用 streaming route；为 route 增加 size limit、timeout、cancellation propagation。

## 风险依赖

**`@whiskeysockets/baileys>libsignal` 使用 GitHub commit override：**
- 风险：`package.json` 将 `@whiskeysockets/baileys>libsignal` override 到 GitHub commit。
- 文件：`package.json:15`, `package.json:16`, `package.json:87`
- 影响：全新安装和 CI 依赖 GitHub 可用性及该 commit 存在；安全更新也不会自动跟随发布版。
- 迁移计划：优先使用正式 release 包；若必须 pin fork，应镜像到可控 registry，并在 CI 中验证 clean install。

**`@larksuite/openclaw-lark` 使用 vendor patch：**
- 风险：`package.json` 对 `@larksuite/openclaw-lark@2026.4.8` 应用 `vendor-patches/@larksuite__openclaw-lark@2026.4.8.patch`。
- 文件：`package.json:28`, `package.json:29`, `package.json:104`
- 影响：依赖升级或 lockfile 更新时 patch 可能失效，需要手工合并；安装阶段问题会阻塞 package/release。
- 迁移计划：将 patch upstream，或用 workspace adapter 隔离差异；CI 增加 patched dependency 行为验证。

**Native/large runtime dependencies 增加跨平台打包脆弱性：**
- 风险：`pnpm.onlyBuiltDependencies` 允许 `electron`、`koffi`、`node-llama-cpp`、`onnxruntime-node`、`sharp` 等 native/large package 执行构建脚本。
- 文件：`package.json:3`, `package.json:4`, `package.json:7`, `package.json:9`, `package.json:10`, `package.json:11`, `package.json:13`
- 影响：Windows/macOS/Linux 打包可能因二进制下载、架构支持、签名或 notarization 配额失败。
- 迁移计划：native dependency 升级必须跑三平台 package checks；缓存二进制产物；避免在 release CI 中重复 notarization 提交。

## 缺失关键能力

**Gemini OAuth manual completion：**
- 问题：Gemini OAuth 明确缺少 remote/manual fallback。
- 文件：`electron/services/providers/oauth/gemini-cli-oauth.ts:675`, `electron/services/providers/oauth/gemini-cli-oauth.ts:679`, `electron/services/providers/oauth/browser-oauth-manager.ts:58`, `electron/services/providers/oauth/browser-oauth-manager.ts:59`
- 阻塞：无法使用本地 callback 的用户不能完成 Gemini CLI OAuth。

**relay 状态端点的严格鉴权模式：**
- 问题：`/status` 和 `/version` 未鉴权返回本地自动化状态，`/cdp-reconnect` 未鉴权触发 reconnect。
- 文件：`packages/openclaw-browser-relay-plugin/src/relay/server.ts:876`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts:900`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts:912`
- 阻塞：无法实现“本地网页不能探测 MatchaClaw relay 活动”的更严格安全姿态。

**Host API IPC allowlist：**
- 问题：`hostapi:fetch` 当前接受 renderer 提供的 path/method，由 main process 携带 Host API token 转发。
- 文件：`electron/main/ipc/hostapi-proxy-ipc.ts:43`, `electron/main/ipc/hostapi-proxy-ipc.ts:51`, `electron/main/ipc/hostapi-proxy-ipc.ts:80`
- 阻塞：无法细粒度限制 renderer 可调用的高权限 Host API route。

## 测试覆盖缺口

**relay 安全边界测试：**
- 未测试内容：`/status` 最小暴露字段、`/version` 暴露策略、`/cdp-reconnect` 是否需要 token、`/json*` 和 `/diagnostics` 缺少/错误 `x-phoenix-relay-token` 时的拒绝行为。
- 文件：`packages/openclaw-browser-relay-plugin/src/relay/server.ts`, `tests/unit/openclaw-browser-relay-plugin.test.ts`, `tests/unit/openclaw-browser-relay-session.test.ts`, `tests/unit/accio-browser-relay-dispatch.test.ts`
- 风险：未来新增 endpoint 可能意外暴露 browser metadata 或控制能力。
- 优先级：高

**Host API IPC 权限测试：**
- 未测试内容：`hostapi:fetch` 对高权限 path 的 main-process allowlist/denylist；`hostapi:token` 仅被 SSE fallback 使用；query token 不进入普通 route。
- 文件：`electron/main/ipc/hostapi-proxy-ipc.ts`, `electron/api/server.ts`, `tests/unit/host-api-server-boundary.test.ts`, `tests/unit/host-api.test.ts`
- 风险：renderer compromise 或 XSS 后可扩大到本地 Host API 控制面。
- 优先级：高

**Markdown XSS 回归测试：**
- 未测试内容：assistant message、tool raw output、file preview 对 `<script>`、inline event handler、`javascript:` link、恶意 KaTeX 输入的渲染结果。
- 文件：`src/pages/Chat/md-pipeline.ts`, `src/pages/Chat/assistant-message-body.tsx`, `src/pages/Chat/chat-message-parts.tsx`, `src/components/file-preview/MarkdownPreview.tsx`
- 风险：渲染配置或插件变化可能绕过当前 `html: false` 安全假设。
- 优先级：高

**OAuth fallback 与取消路径测试：**
- 未测试内容：Gemini manual fallback 未实现；OpenAI manual fallback 的 `pendingManualCodeResolve` / `pendingManualCodeReject` 在 cancel、timeout、重复 startFlow 下的清理。
- 文件：`electron/services/providers/oauth/browser-oauth-manager.ts`, `electron/services/providers/oauth/gemini-cli-oauth.ts`, `electron/services/providers/oauth/openai-codex-oauth.ts`
- 风险：OAuth 失败后留下 stale pending resolver，或用户无法恢复登录流程。
- 优先级：中

**Subagent 缓存和 mutation failure path：**
- 未测试内容：`configDisplayCache`、`workspaceFallbackRootCache`、`queuedLoadAgentsTask`、`agentsSnapshotRetryTimer`、draft session cleanup 与 `agentMutationChain` 失败恢复的组合路径。
- 文件：`src/stores/subagents.ts`, `tests/unit/subagents.store.test.ts`
- 风险：UI 展示 stale agent config，或一次失败后阻塞后续 agent mutation。
- 优先级：中

---

*关注点审计：2026/05/21*
