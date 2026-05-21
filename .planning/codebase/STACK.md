# 技术栈

**分析日期：** 2026/05/21

## 语言

**主要语言：**
- TypeScript 5.9.3 - 主应用、Electron 主进程/预加载、renderer、runtime-host、OpenClaw 本地插件均使用 TypeScript；入口和配置见 `src/main.tsx`、`electron/main/index.ts`、`runtime-host/main.ts`、`packages/openclaw-browser-relay-plugin/src/application/browser-relay-runtime.ts`、`tsconfig.json`。
- JavaScript / ESM - 构建、打包和资源处理脚本使用 Node.js ESM/CJS；关键脚本见 `scripts/bundle-openclaw.mjs`、`scripts/bundle-openclaw-plugins.mjs`、`scripts/download-bundled-uv.mjs`、`scripts/run-electron-builder.mjs`。

**辅助语言：**
- CSS / Tailwind CSS - renderer 样式系统使用 Tailwind 与全局 CSS；配置见 `tailwind.config.js`、`postcss.config.js`、`src/styles/globals.css`。
- Python - 主仓库不直接以 Python 作为应用语言；通过 `uv` 和 OpenClaw skills/第三方工具链运行 Python 生态依赖，相关下载和镜像配置见 `scripts/download-bundled-uv.mjs`、`electron/utils/uv-env.ts`。
- Rust / Go - 在 `clawsuite-main/clawsuite-main/src-tauri/Cargo.toml`、`third_party/browser-suite/camoufox/legacy/launcher/go.mod` 中检测到第三方/实验性代码；不在 `pnpm-workspace.yaml` 的主工作区内。

## 运行时

**环境：**
- Electron 40.6.0 - 桌面应用容器；主进程入口为 `electron/main/index.ts`，打包入口为 `dist-electron/main/index.js`（`package.json`）。
- Node.js - 开发/CI 使用 Node.js；release workflow 使用 `actions/setup-node` 的 `node-version: '24'`（`.github/workflows/release.yml`），Windows 打包会下载并捆绑 Node.js 22.16.0 到 `resources/bin/win32-*`（`scripts/download-bundled-node.mjs`）。
- Browser runtime - renderer 使用 React 19、Vite 7、Electron preload IPC；入口见 `src/main.tsx`、`electron/preload/index.ts`。
- Runtime Host process - 独立子进程承载 OpenClaw 配置、插件和业务路由；入口见 `runtime-host/main.ts`，包描述见 `runtime-host/package.json`。
- OpenClaw Gateway - 由 Electron `utilityProcess.fork` 启动 `openclaw.mjs gateway`；编排逻辑见 `electron/gateway/manager.ts`、`electron/gateway/process-launcher.ts`、`electron/gateway/config-sync.ts`。

**包管理器：**
- pnpm 10.31.0 - `package.json` 的 `packageManager` 指定 `pnpm@10.31.0+sha512...`。
- Lockfile: present - `pnpm-lock.yaml` 存在并用于 `.github/workflows/release.yml` 的 `pnpm install --frozen-lockfile`。
- Workspace: `pnpm-workspace.yaml` 包含 `.`、`packages/openclaw-runtime-bundle`、`packages/memory-lancedb-pro`、`runtime-host`、`worktrees/plugins/sdk`；注意仓库中实际检测到的本地插件包位于 `packages/openclaw-browser-relay-plugin`、`packages/openclaw-matchaclaw-media-plugin`、`packages/openclaw-security-plugin`、`packages/openclaw-task-manager-plugin`，由构建脚本显式处理。

## 框架

**核心：**
- Electron 40.6.0 - 桌面 shell、主进程、preload、自动更新、Utility Process；配置见 `vite.config.ts`、`electron-builder.yml`、`electron/main/index.ts`。
- React 19.2.4 / React DOM 19.2.4 - renderer UI；入口见 `src/main.tsx`、路由容器见 `src/App.tsx`。
- React Router DOM 7.13.0 - renderer 使用 `HashRouter` 与页面路由；入口见 `src/main.tsx`、`src/App.tsx`。
- Zustand 5.0.11 - renderer 状态管理；示例 stores 见 `src/stores/settings.ts`、`src/stores/chat/store.ts`、`src/stores/plugins-store.ts`。
- OpenClaw 2026.4.23 - AI Gateway 与插件运行平台；依赖声明见 `package.json`，进程启动和资源打包见 `electron/gateway/config-sync.ts`、`scripts/bundle-openclaw.mjs`。
- Runtime Host custom framework - 应用自有模块化后端层，使用 route definitions、repository、service、composition module；入口见 `runtime-host/composition/runtime-host-composition.ts`、`runtime-host/api/routes/*.ts`。

**测试：**
- Vitest 4.0.18 - 单元/集成测试 runner；配置见 `vitest.config.ts`，命令为 `pnpm test`、`pnpm test:contract`。
- jsdom 28.1.0 - Vitest DOM 环境；配置见 `vitest.config.ts`。
- Playwright Test 1.58.2 / playwright-core 1.59.1 - E2E 与 browser relay 控制；配置见 `playwright.config.ts`，browser relay runtime 使用 `playwright-core`（`packages/openclaw-browser-relay-plugin/src/playwright/session.ts`）。
- @testing-library/react 16.3.2 / @testing-library/jest-dom 6.9.1 - React 组件测试依赖；声明见 `package.json`。

**构建/开发：**
- Vite 7.3.1 - renderer 和 Electron 开发服务器，端口 `5173`；配置见 `vite.config.ts`。
- vite-plugin-electron 0.29.0 / vite-plugin-electron-renderer 0.14.6 - Electron main/preload build；配置见 `vite.config.ts`。
- electron-builder 26.8.1 - macOS/Windows/Linux 打包、资源复制、自动更新 metadata；配置见 `electron-builder.yml`。
- zx 8.8.5 - 构建脚本执行器；脚本见 `scripts/download-bundled-uv.mjs`、`scripts/bundle-openclaw-plugins.mjs`。
- TypeScript compiler - `pnpm typecheck` 执行 `tsc --noEmit`；配置见 `tsconfig.json`、`tsconfig.node.json`、`runtime-host/tsconfig.json`。
- ESLint 10 - `pnpm lint` 执行 `eslint . --fix`；配置见 `eslint.config.mjs`。
- Prettier - 格式配置见 `.prettierrc`。

## 关键依赖

**关键运行依赖：**
- `openclaw@2026.4.23` - Gateway、plugin SDK、AI 编排与插件运行基础；集成点见 `electron/gateway/*`、`runtime-host/openclaw-bridge/*`、`packages/*/openclaw.plugin.json`。
- `@matchaclaw/plugins-sdk@workspace:*` - runtime-host 与插件 SDK 工作区依赖；声明见 `package.json`、`runtime-host/package.json`。
- `memory-lancedb-pro@workspace:*` / `packages/memory-lancedb-pro` - 长期记忆插件，基于 LanceDB、hybrid retrieval、rerank；清单见 `packages/memory-lancedb-pro/openclaw.plugin.json`。
- `electron-updater@^6.8.3` - 自动更新；实现见 `electron/main/updater.ts`，发布源见 `electron-builder.yml`。
- `electron-store@^11.0.2` - Electron 本地窗口状态存储；使用点见 `electron/main/window.ts`。
- `ws@^8.19.0` - Browser Relay 的 HTTP/WebSocket/CDP 桥接；使用点见 `packages/openclaw-browser-relay-plugin/src/relay/server.ts`。
- `playwright-core@1.59.1` - Browser Relay 连接 CDP 和执行页面控制；使用点见 `packages/openclaw-browser-relay-plugin/src/playwright/session.ts`。
- `@lancedb/lancedb@^0.26.2` / platform optional packages - memory plugin 向量存储；声明见 `packages/memory-lancedb-pro/package.json`。
- `@huggingface/transformers@^4.1.0` - local MiniLM embeddings；声明见 `packages/memory-lancedb-pro/package.json`，模型下载脚本见 `packages/memory-lancedb-pro/scripts/download-local-minilm.mjs`。
- `openai@^6.21.0` - memory plugin 的 OpenAI-compatible LLM/embedding 客户端；声明见 `packages/memory-lancedb-pro/package.json`。

**UI/体验：**
- `@radix-ui/*` - Dialog、Select、Tabs、Toast、Tooltip 等 UI primitives；依赖声明见 `package.json`。
- `lucide-react@^0.563.0` - 图标库；示例见 `src/components/file-preview/SheetViewer.tsx`。
- `framer-motion@^12.34.2` - 动画库；依赖声明见 `package.json`。
- `sonner@^2.0.7` - toast 通知；依赖声明见 `package.json`。
- `tailwindcss@^3.4.19` / `tailwind-merge@^3.5.0` / `class-variance-authority@^0.7.1` / `clsx@^2.1.1` - 样式组合；配置见 `tailwind.config.js`。
- `@monaco-editor/react@^4.7.0` / `monaco-editor@^0.55.1` - 内置代码编辑/差异视图；封装见 `src/lib/monaco/loader.ts`。
- `katex@^0.16.45` - 数学公式渲染样式；入口导入见 `src/main.tsx`。
- `pdfjs-dist@^5.7.284`、`xlsx@^0.18.5` - 文档/表格预览能力；`xlsx` 动态加载见 `src/components/file-preview/SheetViewer.tsx`，PDF 使用浏览器 `iframe` Blob 预览见 `src/components/file-preview/PdfViewer.tsx`。

**渠道/插件生态：**
- `@slack/bolt@^4.6.0`、`@slack/web-api@^7.15.0`、`grammy@^1.42.0`、`@whiskeysockets/baileys@7.0.0-rc.9`、`@soimy/dingtalk@^3.5.3`、`@wecom/wecom-openclaw-plugin@^2026.4.23`、`@tencent-weixin/openclaw-weixin@^2.1.9`、`@tencent-connect/openclaw-qqbot@1.6.6`、`@larksuite/openclaw-lark@2026.4.8` - OpenClaw 渠道插件和第三方插件镜像；打包逻辑见 `scripts/bundle-openclaw-plugins.mjs`。
- `clawhub@^0.5.0` - skill/插件生态 CLI；路径工具见 `electron/utils/paths.ts`，skills 服务见 `runtime-host/application/skills/clawhub*.ts`。

**基础设施：**
- `@sinclair/typebox@^0.34.48` - schema/type definitions；依赖声明见 `package.json`、`packages/memory-lancedb-pro/package.json`。
- `tar@^6.2.1`、`sharp@^0.34.5`、`png2icons@^2.0.1` - 资源、压缩和图标处理；脚本见 `scripts/generate-icons.mjs`。
- `@aws-sdk/client-bedrock@3.1020.0` - 检测为 devDependency；主仓库源码未发现直接 import，主要作为 OpenClaw/扩展生态兼容依赖保留。

## 配置

**环境配置：**
- `.env.example` 存在，用于记录开发、Gateway 和 release 相关变量；不要读取或提交真实 `.env` 内容。
- 端口默认值集中在 `electron/utils/config.ts`：`MATCHACLAW_DEV=5173`、`MATCHACLAW_HOST_API=13210`、`MATCHACLAW_RUNTIME_HOST=3211`、`OPENCLAW_GATEWAY=18789`。
- 端口覆盖使用 `MATCHACLAW_PORT_MATCHACLAW_HOST_API`、`MATCHACLAW_RUNTIME_HOST_PORT`；读取逻辑见 `electron/utils/config.ts`。
- runtime-host 配置/数据目录支持 `OPENCLAW_CONFIG_DIR`、`MATCHACLAW_RUNTIME_HOST_DATA_DIR`、`MATCHACLAW_RUNTIME_HOST_SETTINGS_FILE`、`MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE`、`MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE`、`MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE`；解析见 `runtime-host/application/openclaw/openclaw-environment-repository.ts`。
- OpenClaw Gateway 启动环境由 `electron/gateway/config-sync.ts` 生成：`OPENCLAW_GATEWAY_TOKEN`、`OPENCLAW_SKIP_CHANNELS`、`CLAWDBOT_SKIP_CHANNELS`、`OPENCLAW_NO_RESPAWN`、provider env、proxy env、uv mirror env。
- Renderer feature flag 检测到 `VITE_ENABLE_LEGACY_IM_CHANNELS_FEATURE`；使用点见 `src/types/channel.ts`。
- 测试/诊断环境变量包括 `MATCHACLAW_E2E`、`MATCHACLAW_E2E_USER_DATA_DIR`、`MATCHACLAW_TRACE_LOG_LEVEL`、`SECURITY_BENCH`、`DESTRUCTIVE_AB_BENCH`；使用点见 `electron/main/index.ts`、`electron/utils/trace-logger.ts`、`tests/benchmark/*.test.ts`。

**构建配置：**
- `vite.config.ts` - Vite、React、Electron main/preload 构建、manual chunks、alias、dev server port。
- `electron-builder.yml` - 多平台打包、资源复制、`asar`、`asarUnpack`、auto-update `publish`、macOS notarize、Windows NSIS、Linux AppImage/deb/rpm。
- `tsconfig.json` - renderer TypeScript strict、ES2022、DOM lib、alias `@/*` 和 `@electron/*`。
- `tsconfig.node.json`、`tsconfig.runtime-host-process.json`、`runtime-host/tsconfig.json` - Node/Electron/runtime-host 编译约束。
- `vitest.config.ts` - Vitest globals、jsdom、setup、coverage。
- `playwright.config.ts` - E2E testDir、single worker、trace/screenshot/video。
- `eslint.config.mjs` - TypeScript/React hooks lint，并禁止 renderer 直接调用本地 HTTP endpoint。
- `.prettierrc` - `semi: true`、`singleQuote: true`、`tabWidth: 2`、`trailingComma: es5`、`printWidth: 100`。
- `tailwind.config.js`、`postcss.config.js` - Tailwind content、theme tokens、动画插件、autoprefixer。

## 平台要求

**开发：**
- 需要 Node.js + pnpm；CI 明确使用 Node.js 24 和 pnpm cache（`.github/workflows/release.yml`）。
- 需要执行 `pnpm install --frozen-lockfile` 以匹配 `pnpm-lock.yaml`；本地初始化命令为 `pnpm run init`，会安装依赖并下载 `uv`（`package.json`）。
- 推荐通过 `pnpm run dev` 启动：先构建 runtime-host process，再启动 Vite/Electron（`package.json`）。
- 运行测试命令：`pnpm test`、`pnpm test:e2e`、`pnpm test:contract`；配置见 `vitest.config.ts`、`playwright.config.ts`。
- OpenClaw 和本地插件构建依赖 `pnpm run build:runtime-host-process`、`pnpm run build:vite`、`zx scripts/bundle-openclaw.mjs`、`zx scripts/bundle-openclaw-plugins.mjs`。

**生产：**
- 目标平台：macOS x64/arm64、Windows x64/arm64、Linux x64/arm64；配置见 `electron-builder.yml`。
- 打包输出目录：`release`；配置见 `electron-builder.yml`。
- 应用产物包含 `dist`、`dist-electron`、`runtime-host/build/**`、`runtime-host/host-process.cjs`、`resources/`、`build/openclaw/`、`build/openclaw-plugins/`、预装 skills 和 subagent templates；配置见 `electron-builder.yml`。
- macOS 需要 hardened runtime、entitlements、notarize；CI 使用 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`、`CSC_LINK`、`CSC_KEY_PASSWORD`，流程见 `.github/workflows/release.yml`。
- Windows 使用 NSIS，未配置代码签名证书验证更新签名；`electron-builder.yml` 中 `win.verifyUpdateCodeSignature: false`。
- Linux 输出 AppImage、deb、rpm，并声明 GTK/NSS/X11/AT-SPI 等系统依赖；配置见 `electron-builder.yml`。

## 项目技能索引

- 未检测到 `.claude/skills/*/SKILL.md` 或 `.agents/skills/*/SKILL.md`；本次技术栈分析没有可加载的项目技能约束。

---

*技术栈分析：2026/05/21*
