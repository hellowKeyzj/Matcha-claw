# 外部集成

**分析日期：** 2026/05/21

## APIs 与外部服务

**AI 模型与 Provider：**
- OpenClaw Gateway - 本应用的模型、渠道、工具、插件统一入口。
  - SDK/Client: `openclaw@2026.4.23`、`openclaw/plugin-sdk`；进程编排见 `electron/gateway/manager.ts`、`electron/gateway/config-sync.ts`，runtime bridge 见 `runtime-host/composition/modules/gateway-bridge-module.ts`。
  - Auth: `OPENCLAW_GATEWAY_TOKEN`，由 runtime-host settings 生成/读取并传入 Gateway；见 `runtime-host/application/runtime-host/bootstrap.ts`、`electron/gateway/config-sync.ts`。
  - 用途/风险: Gateway 是会话、插件、渠道和 provider 的核心依赖；端口或 token 不一致会导致 renderer、runtime-host、Gateway 互相不可达。
- OpenAI / OpenAI-compatible - 聊天、OAuth、embedding、图片生成和自定义兼容 endpoint。
  - SDK/Client: `openai`（memory plugin）、OpenClaw provider runtime、`fetch`；OAuth 实现见 `electron/services/providers/oauth/openai-codex-oauth.ts`，media protocol 见 `packages/openclaw-matchaclaw-media-plugin/src/protocols/openai.ts`。
  - Auth: provider store 中的 API key/OAuth token；media fallback 环境变量为 `MATCHACLAW_MEDIA_<PROVIDER>_API_KEY` 或 `MATCHACLAW_MEDIA_API_KEY`（`packages/openclaw-matchaclaw-media-plugin/src/runtime-shared.ts`）。
  - 用途/风险: 兼容 endpoint 由用户配置 `baseUrl`，需要依赖 `provider-http` 的私网/dispatcher 策略避免 SSRF 风险。
- Google / Gemini - Gemini OAuth、Google Cloud Code Assist、Gemini-compatible media generation。
  - SDK/Client: `fetch`、本地 `gemini` CLI credential extraction、OpenClaw provider runtime；实现见 `electron/services/providers/oauth/gemini-cli-oauth.ts`、`packages/openclaw-matchaclaw-media-plugin/src/protocols/google.ts`。
  - Auth: `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`、`GEMINI_CLI_OAUTH_CLIENT_ID`、`OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`、`GEMINI_CLI_OAUTH_CLIENT_SECRET`，以及 provider store 中的 OAuth token；项目 ID可读 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID`。
  - 用途/风险: OAuth callback 使用本机 `http://127.0.0.1:8085/oauth2callback`；端口占用或 localhost 被拦截会导致登录失败。
- OpenRouter-compatible media/provider - 图片生成和 OpenClaw provider 请求。
  - SDK/Client: `fetch` + `openclaw/plugin-sdk/provider-http`；media 实现见 `packages/openclaw-matchaclaw-media-plugin/src/protocols/openrouter.ts`。
  - Auth: provider store API key 或 `MATCHACLAW_MEDIA_<PROVIDER>_API_KEY`。
  - 用途/风险: 开发模式下 Gateway fetch preload 会为 `openrouter.ai` 注入 `HTTP-Referer: https://matchaclaw-x.com` 与 `X-OpenRouter-Title: MatchaClaw`；见 `electron/gateway/process-launcher.ts`。
- MiniMax OAuth - 设备码/PKCE 登录，支持 global 和 cn 区域。
  - SDK/Client: `fetch`；实现见 `electron/services/providers/oauth/device-oauth-providers.ts`、`electron/services/providers/oauth/device-oauth-manager.ts`。
  - Auth: OAuth token 写入 runtime-host provider account flow；endpoint 为 `https://api.minimax.io` 或 `https://api.minimaxi.com`。
  - 用途/风险: 用户需要在外部浏览器完成 device authorization；轮询失败会中断 provider account 写入。
- Qwen OAuth - 设备码登录。
  - SDK/Client: `fetch`；实现见 `electron/services/providers/oauth/device-oauth-providers.ts`。
  - Auth: OAuth token 写入 runtime-host provider account flow；endpoint 为 `https://chat.qwen.ai/api/v1/oauth2/*`。
  - 用途/风险: 与 MiniMax 一样依赖外部浏览器和轮询 token endpoint。
- Memory embedding/rerank providers - 长期记忆 embedding、hybrid retrieval、rerank。
  - SDK/Client: `openai`、`@huggingface/transformers`、`@lancedb/lancedb`、HTTP rerank endpoints；实现和 schema 见 `packages/memory-lancedb-pro/index.ts`、`packages/memory-lancedb-pro/openclaw.plugin.json`。
  - Auth: memory plugin config 中的 `embedding.apiKey`、`retrieval.rerankApiKey`；支持 `openai-compatible`、`azure-openai`、`local-minilm`。
  - 用途/风险: `local-minilm` 不需要外部 embedding API；远程 embedding/rerank 依赖用户配置 `baseURL`、`apiVersion`、`rerankEndpoint`，默认 rerank endpoint 检测为 `https://api.jina.ai/v1/rerank`。
- `uv` / Python package mirrors - OpenClaw skills 和 Python 工具链安装/运行。
  - SDK/Client: bundled `uv` binary；下载脚本见 `scripts/download-bundled-uv.mjs`，运行时镜像配置见 `electron/utils/uv-env.ts`。
  - Auth: 不需要默认认证；镜像环境变量包括 `UV_PYTHON_INSTALL_MIRROR`、`UV_INDEX_URL`、`UV_CONFIG_FILE`。
  - 用途/风险: 中国网络优化会写入 `~/.openclaw/matchaclaw/uv.toml` 并使用 `https://registry.npmmirror.com/-/binary/python-build-standalone/`、`https://pypi.tuna.tsinghua.edu.cn/simple/`。
- Node.js binary download - Windows 打包时捆绑 Node.js。
  - SDK/Client: `fetch` in `scripts/download-bundled-node.mjs`。
  - Auth: Not applicable。
  - 用途/风险: 下载源为 `https://nodejs.org/dist/v22.16.0`；网络失败会阻断 `pnpm run prep:win-binaries`。

**消息渠道与 OpenClaw 插件：**
- Slack - OpenClaw 渠道/插件依赖。
  - SDK/Client: `@slack/bolt`、`@slack/web-api`；依赖声明见 `package.json`。
  - Auth: 由 OpenClaw/provider/channel 配置管理；具体 secret 不在源码中硬编码。
  - 用途/风险: 作为打包进 OpenClaw 或插件镜像的渠道能力，凭据由用户配置文件管理。
- Telegram - OpenClaw 渠道/插件依赖。
  - SDK/Client: `grammy`；依赖声明见 `package.json`。
  - Auth: 由 OpenClaw channel config 管理。
  - 用途/风险: 启动渠道时依赖 Gateway 的 provider/channel launch plan；见 `electron/gateway/config-sync.ts`。
- WhatsApp - OpenClaw 渠道/插件依赖。
  - SDK/Client: `@whiskeysockets/baileys@7.0.0-rc.9`；依赖声明和 `libsignal` override 见 `package.json`。
  - Auth: 由 OpenClaw channel config 管理。
  - 用途/风险: 原生/加密依赖属于 pnpm `onlyBuiltDependencies`，安装和打包环境需允许构建。
- DingTalk / WeCom / WeChat / QQ / Lark(Feishu) - 第三方 OpenClaw plugin mirror。
  - SDK/Client: `@soimy/dingtalk`、`@wecom/wecom-openclaw-plugin`、`@tencent-weixin/openclaw-weixin`、`@tencent-connect/openclaw-qqbot`、`@larksuite/openclaw-lark`。
  - Auth: 由各插件 config schema 和用户 OpenClaw 配置管理。
  - 用途/风险: 插件通过 `scripts/bundle-openclaw-plugins.mjs` 复制到 `build/openclaw-plugins/*`；缺包或 mirror 校验失败会阻断 package/release。

**本地桌面/浏览器服务：**
- Browser Relay Chrome Extension - 本地浏览器控制桥。
  - SDK/Client: `ws`、`playwright-core`、Chrome DevTools Protocol；服务实现见 `packages/openclaw-browser-relay-plugin/src/relay/server.ts`、Playwright 连接见 `packages/openclaw-browser-relay-plugin/src/playwright/session.ts`。
  - Auth: `x-phoenix-relay-token` relay header、RSA/AES-GCM session handshake；实现见 `packages/openclaw-browser-relay-plugin/src/relay/server.ts`。
  - 用途/风险: 只监听 loopback，默认插件配置端口为 `9236`（`packages/openclaw-browser-relay-plugin/openclaw.plugin.json`）；浏览器扩展资源位于 `resources/tools/data/extension/chrome-extension/browser-relay/`。
- Host API loopback server - Electron main 提供给 runtime-host/renderer 的本机 HTTP API。
  - SDK/Client: Node `http` server；实现见 `electron/api/server.ts`、代理 IPC 见 `electron/main/ipc/hostapi-proxy-ipc.ts`。
  - Auth: 32-byte random bearer/query token，内部 runtime-host 路由可 bypass；见 `electron/api/server.ts`。
  - 用途/风险: 默认 `127.0.0.1:13210`；renderer 不应直接 fetch 本地 endpoint，lint 规则在 `eslint.config.mjs` 强制走 host-api/api-client proxy。
- Runtime Host loopback server - 独立子进程提供业务 API。
  - SDK/Client: Runtime Host HTTP client；启动和 base URL 见 `electron/main/runtime-host-manager.ts`、`electron/main/runtime-host-client.ts`。
  - Auth: 父进程下发 `parentDispatchToken` 和 internal dispatch token；环境变量见 `electron/main/runtime-host-manager.ts`。
  - 用途/风险: 默认 `127.0.0.1:3211`；主进程负责 lifecycle、health check 和 route forwarding。

## 数据存储

**数据库：**
- LanceDB local vector store - memory plugin 长期记忆向量数据库。
  - Connection: `dbPath` plugin config 或默认 OpenClaw/runtime-host 数据目录；schema 见 `packages/memory-lancedb-pro/openclaw.plugin.json`。
  - Client: `@lancedb/lancedb` 与平台 optional packages；依赖见 `packages/memory-lancedb-pro/package.json`。
  - 用途/风险: 本地文件型向量库，跨平台 optional native package 必须随插件打包；版本不匹配会影响 memory recall/store。

**文件存储：**
- Electron userData - 日志、窗口状态、进程锁等桌面状态。
  - 位置: `app.getPath('userData')`；日志和数据路径工具见 `electron/utils/paths.ts`、窗口状态见 `electron/main/window.ts`。
  - Client: `electron-store`、Node `fs`。
- OpenClaw config dir - OpenClaw 和 MatchaClaw runtime-host 配置。
  - 位置: 默认 `~/.openclaw`，可由 `OPENCLAW_CONFIG_DIR` 覆盖；解析见 `runtime-host/application/openclaw/openclaw-environment-repository.ts`。
  - 文件: `openclaw.json`、`matchaclaw-settings.json`、`matchaclaw-provider-accounts.json`、`matchaclaw-provider-models.json`、`matchaclaw-capability-routing.json`。
  - Client: runtime-host repositories；见 `runtime-host/application/settings/store.ts`、`runtime-host/application/providers/provider-store-repository.ts`、`runtime-host/application/openclaw/openclaw-config-repository.ts`。
- Bundled resources - 应用内置 OpenClaw、插件、skills、subagent templates、CLI、bin。
  - 位置: `resources/`、`build/openclaw/`、`build/openclaw-plugins/`、`build/preinstalled-skills/`；复制规则见 `electron-builder.yml`。
  - Client: build scripts 和 Electron runtime path helpers；见 `scripts/bundle-openclaw.mjs`、`scripts/bundle-openclaw-plugins.mjs`、`electron/utils/paths.ts`。

**缓存：**
- Provider store read cache - runtime-host 对 provider account JSON 做基于 `size + mtimeMs` 的内存缓存；实现见 `runtime-host/application/providers/provider-store-repository.ts`。
- Vite/Electron build cache - 未检测到自定义远程缓存；构建产物目录为 `dist`、`dist-electron`、`runtime-host/build`、`build`、`release`。
- 外部缓存服务: Not detected。

## 认证与身份

**Auth Provider：**
- Custom local provider accounts - API key/OAuth account 由 runtime-host provider store 管理。
  - Implementation: `runtime-host/application/providers/provider-store-repository.ts` 存储 `accounts` 与 `apiKeys`；OAuth 完成流程由 `electron/services/providers/oauth/*` 调用 runtime-host `/api/provider-accounts/oauth/complete-device`。
  - 用途/风险: 当前 repository 以 JSON 文件保存敏感 token/key；生成文档和日志时不要输出实际值。
- OpenAI browser OAuth - PKCE + localhost callback。
  - Implementation: `electron/services/providers/oauth/openai-codex-oauth.ts`，callback `http://localhost:1455/auth/callback`。
  - Auth: OAuth access/refresh token。
- Google/Gemini browser OAuth - PKCE + localhost callback + Gemini CLI credential extraction。
  - Implementation: `electron/services/providers/oauth/gemini-cli-oauth.ts`，callback `http://127.0.0.1:8085/oauth2callback`。
  - Auth: OAuth access/refresh token、可选 env client credentials。
- MiniMax/Qwen device OAuth - device code flow。
  - Implementation: `electron/services/providers/oauth/device-oauth-providers.ts`、`electron/services/providers/oauth/device-oauth-manager.ts`。
  - Auth: OAuth access/refresh token。
- Gateway token - OpenClaw Gateway 本地 RPC 认证。
  - Implementation: settings 中 `gatewayToken`，启动时传 `--token` 与 `OPENCLAW_GATEWAY_TOKEN`；见 `runtime-host/application/runtime-host/bootstrap.ts`、`electron/gateway/config-sync.ts`。

## 监控与可观测性

**错误追踪：**
- 外部错误追踪服务: Not detected。
- 本地日志: `electron/utils/logger.ts` 写入 Electron `userData/logs`，路径工具见 `electron/utils/paths.ts`。
- Runtime/API telemetry: renderer API client 对慢请求和错误调用 `trackUiEvent`；见 `src/lib/api-client.ts`。
- Update logs: `electron-updater` logger 被桥接到应用 logger；见 `electron/main/updater.ts`。
- Gateway logs: Gateway manager 记录启动、stderr 分类、重连、doctor repair；见 `electron/gateway/manager.ts`、`electron/gateway/startup-stderr.ts`。

**日志：**
- Approach: 主进程、Gateway、runtime-host 和插件均以本地日志/console 为主；插件日志通过 OpenClaw plugin logger 注入，例如 `packages/openclaw-browser-relay-plugin/src/relay/server.ts`。
- Sensitive handling: Gateway 启动日志会 sanitize `--token` 参数；见 `electron/gateway/manager.ts`。

## CI/CD 与部署

**托管/分发：**
- Desktop artifacts - 使用 `electron-builder` 输出 `release` 目录；配置见 `electron-builder.yml`。
- Auto-update primary - `generic` provider，URL 为 `https://www.supercnm.top/claw-update`；配置见 `electron-builder.yml`。
- Auto-update fallback - GitHub Releases，`owner: hellowKeyzj`、`repo: Matcha-claw`；配置见 `electron-builder.yml`。
- Public links - 应用菜单链接 `https://matchaclaw-x.com`、`https://github.com/ValueCell-ai/MatchaClaw/issues`、`https://docs.openclaw.ai`；见 `electron/main/menu.ts`。

**CI Pipeline：**
- GitHub Actions release workflow - `.github/workflows/release.yml` 构建 macOS/Windows/Linux，并发布到 GitHub Releases。
- GitHub Actions debug installer workflow - `.github/workflows/debug-installer.yml` 检测到用于调试安装包。
- Release secrets - `GITHUB_TOKEN`/`GH_TOKEN`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`、`CSC_LINK`、`CSC_KEY_PASSWORD`；见 `.github/workflows/release.yml`、`.env.example`。
- macOS notarization - CI 先 validate Apple credentials，再构建、签名、公证，并记录 submission id 避免重复提交；见 `.github/workflows/release.yml`。
- Package commands - `pnpm run package:*` 与 `pnpm run release` 串联 runtime-host build、Vite build、OpenClaw bundle、plugin mirror check、preinstalled skills bundle、electron-builder；见 `package.json`。

## 环境配置

**关键环境变量：**
- `OPENCLAW_GATEWAY_PORT` - `.env.example` 中记录的 Gateway port；代码默认 `OPENCLAW_GATEWAY=18789` 在 `electron/utils/config.ts`。
- `MATCHACLAW_PORT_MATCHACLAW_HOST_API` - 覆盖 Host API loopback port；见 `electron/utils/config.ts`、`electron/api/server.ts`。
- `MATCHACLAW_RUNTIME_HOST_PORT` - 覆盖 runtime-host loopback port；见 `electron/utils/config.ts`。
- `OPENCLAW_CONFIG_DIR` - 覆盖 OpenClaw config dir；见 `runtime-host/application/openclaw/openclaw-environment-repository.ts`。
- `MATCHACLAW_OPENCLAW_DIR` - 覆盖 runtime-host 看到的 OpenClaw package dir；见 `runtime-host/application/openclaw/openclaw-environment-repository.ts`。
- `MATCHACLAW_RUNTIME_HOST_DATA_DIR`、`MATCHACLAW_RUNTIME_HOST_SETTINGS_FILE`、`MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE`、`MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE`、`MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE` - 覆盖 runtime-host 数据文件位置；见 `runtime-host/application/openclaw/openclaw-environment-repository.ts`。
- `MATCHACLAW_MEDIA_API_KEY`、`MATCHACLAW_MEDIA_<PROVIDER>_API_KEY` - MatchaClaw Media plugin API key fallback；见 `packages/openclaw-matchaclaw-media-plugin/src/runtime-shared.ts`。
- `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`、`GEMINI_CLI_OAUTH_CLIENT_ID`、`OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`、`GEMINI_CLI_OAUTH_CLIENT_SECRET` - Gemini OAuth client credential override；见 `electron/services/providers/oauth/gemini-cli-oauth.ts`。
- `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_PROJECT_ID` - Gemini OAuth/Code Assist project resolution；见 `electron/services/providers/oauth/gemini-cli-oauth.ts`。
- `UV_PYTHON_INSTALL_MIRROR`、`UV_INDEX_URL`、`UV_CONFIG_FILE` - 运行时由 `electron/utils/uv-env.ts` 注入给 OpenClaw/Gateway 子进程。
- `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 族 - proxy env 由 `electron/gateway/config-sync.ts` 通过 `electron/utils/proxy.ts` 注入；具体 env key 以实现为准。
- `VITE_ENABLE_LEGACY_IM_CHANNELS_FEATURE` - renderer legacy IM channels feature flag；见 `src/types/channel.ts`。
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`、`CSC_LINK`、`CSC_KEY_PASSWORD`、`GH_TOKEN`、`GITHUB_TOKEN` - release/signing/publishing；见 `.env.example`、`.github/workflows/release.yml`。

**Secrets 位置：**
- 本地开发示例: `.env.example` 仅记录变量名和占位值；不要读取真实 `.env`。
- 运行时用户凭据: 默认写入 `~/.openclaw/matchaclaw-provider-accounts.json` 或 `MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE` 指定文件；repository 见 `runtime-host/application/providers/provider-store-repository.ts`。
- OpenClaw 主配置: 默认 `~/.openclaw/openclaw.json` 或 `OPENCLAW_CONFIG_DIR` 指定目录；repository 见 `runtime-host/application/openclaw/openclaw-config-repository.ts`。
- CI secrets: GitHub Actions `secrets.*`；使用点见 `.github/workflows/release.yml`。

## Webhooks 与回调

**传入：**
- OpenAI OAuth callback - `http://localhost:1455/auth/callback`，本地临时 HTTP server；实现见 `electron/services/providers/oauth/openai-codex-oauth.ts`。
- Google/Gemini OAuth callback - `http://127.0.0.1:8085/oauth2callback`，本地临时 HTTP server；实现见 `electron/services/providers/oauth/gemini-cli-oauth.ts`。
- Host API - `http://127.0.0.1:13210` 默认，只监听 loopback；实现见 `electron/api/server.ts`。
- Runtime Host API - `http://127.0.0.1:3211` 默认，只由主进程/host client 使用；管理见 `electron/main/runtime-host-manager.ts`。
- OpenClaw Gateway - `http://127.0.0.1:18789` 默认；ready/status/route bridge 见 `electron/gateway/manager.ts`、`runtime-host/composition/modules/gateway-bridge-module.ts`。
- Browser Relay - 默认 `http://127.0.0.1:9236`，提供 HTTP `/json/*`、WebSocket `/extension`、WebSocket `/cdp`；实现见 `packages/openclaw-browser-relay-plugin/src/relay/server.ts`。

**传出：**
- Auto-update check/download - `https://www.supercnm.top/claw-update` 和 GitHub Releases；配置见 `electron-builder.yml`、实现见 `electron/main/updater.ts`。
- OAuth authorization/token/userinfo - OpenAI、Google、MiniMax、Qwen endpoints；实现见 `electron/services/providers/oauth/*.ts`。
- Provider/model/media requests - OpenClaw Gateway/provider runtime、MatchaClaw Media plugin、memory plugin 会访问用户配置的 `baseUrl`、embedding、rerank、image generation endpoints；实现见 `packages/openclaw-matchaclaw-media-plugin/src/*`、`packages/memory-lancedb-pro/src/*`。
- Browser/CDP relay - Browser Relay 与 Chrome extension、本地 CDP WebSocket 通信；实现见 `packages/openclaw-browser-relay-plugin/src/relay/server.ts`、`packages/openclaw-browser-relay-plugin/src/playwright/session.ts`。
- Build-time downloads - `uv` 从 GitHub Releases 下载，Node.js 从 `nodejs.org` 下载，MiniLM 模型由 `packages/memory-lancedb-pro/scripts/download-local-minilm.mjs` 下载；脚本见 `scripts/download-bundled-uv.mjs`、`scripts/download-bundled-node.mjs`、`package.json`。

---

*集成审计：2026/05/21*
