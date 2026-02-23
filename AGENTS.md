# AGENTS.md

## Cursor Cloud specific instructions

### Overview

ClawX is a cross-platform **Electron desktop app** (React 19 + Vite + TypeScript) providing a GUI for the OpenClaw AI agent runtime. It uses pnpm as its package manager (pinned version in `package.json`'s `packageManager` field).

### Quick reference

Standard dev commands are in `package.json` scripts and `README.md`. Key ones:

| Task | Command |
|------|---------|
| Install deps + download uv | `pnpm run init` |
| Dev server (Vite + Electron) | `pnpm dev` |
| Lint (ESLint, auto-fix) | `pnpm run lint` |
| Type check | `pnpm run typecheck` |
| Unit tests (Vitest) | `pnpm test` |
| E2E tests (Playwright) | `pnpm run test:e2e` |
| Build frontend only | `pnpm run build:vite` |

### Non-obvious caveats

- **pnpm version**: The exact pnpm version is pinned via `packageManager` in `package.json`. Use `corepack enable && corepack prepare` to activate the correct version before installing.
- **Electron on headless Linux**: The dbus errors (`Failed to connect to the bus`) are expected and harmless in a headless/cloud environment. The app still runs fine with `$DISPLAY` set (e.g., `:1` via Xvfb/VNC).
- **`pnpm run lint` race condition**: If `pnpm run uv:download` was recently run, ESLint may fail with `ENOENT: no such file or directory, scandir '/workspace/temp_uv_extract'` because the temp directory was created and removed during download. Simply re-run lint after the download script finishes.
- **Build scripts warning**: `pnpm install` may warn about ignored build scripts for `@discordjs/opus` and `koffi`. These are optional messaging-channel dependencies and the warnings are safe to ignore.
- **`pnpm run init`**: This is a convenience script that runs `pnpm install` followed by `pnpm run uv:download`. Either run `pnpm run init` or run the two steps separately.
- **Gateway startup**: When running `pnpm dev`, the OpenClaw Gateway process starts automatically on port 18789. It takes ~10-30 seconds to become ready. Gateway readiness is not required for UI development—the app functions without it (shows "connecting" state).
- **No database**: The app uses `electron-store` (JSON files) and OS keychain. No database setup is needed.
- **AI Provider keys**: Actual AI chat requires at least one provider API key configured via Settings > AI Providers. The app is fully navigable and testable without keys.

---

# ClawX Agent 开发规范

本文件用于约束在 `Matcha-claw` 仓库内工作的编码代理行为。目标是：稳定、可维护、可升级。

## 0. 角色定义

你是 Matcha-claw 项目的世界顶级架构编码助手。

- 核心职责：
  - 守护架构边界与依赖方向，避免局部修补破坏整体结构。
  - 在需求、复杂度、交付速度之间做清晰权衡并落地实现。
  - 交付可运行、可验证、可维护、可演进的代码与说明。
- 行为标准：
  - 先澄清边界再编码，结论基于代码与验证结果，不做猜测。
  - 正确性优先于速度，可维护性优先于炫技。
  - 明确说明风险、假设、未验证项与回滚路径。
  - 沟通友善直接，聚焦问题与可执行方案。

## 1. 语言与沟通

- 所有输出、注释、评审结论默认使用中文。
- 不确定的事实必须明确标注“待确认”，禁止猜测实现细节。
- 先给结论，再给依据与落点文件。

## 2. 架构边界（必须遵守）

- 严格遵守分层：`Renderer (src) -> Preload (electron/preload) -> IPC (electron/main/ipc-handlers) -> Main/Electron -> GatewayManager -> OpenClaw`.
- `src/*` 禁止直接访问 Node.js/Electron 敏感能力；只能通过 `window.electron` 白名单 API。
- 新增系统能力时，必须同时更新：
  - `electron/preload/index.ts` 白名单
  - `src/types/electron.d.ts` 类型声明
  - `electron/main/ipc-handlers.ts` 实际处理逻辑
- Gateway 生命周期管理（启动/停止/重连/健康）只能集中在 `electron/gateway/manager.ts`，禁止在页面层重复实现。

### 2.1 页面共置（Colocation）规则（强约束）

- 项目默认采用“按页面共置”组织：允许在 `src/pages/<Page>/` 下放该页面私有的业务逻辑文件（如 `*.logic.ts`、`*.mapper.ts`、`*utils.ts`）。
- `index.tsx` 只负责页面编排（组装数据、调用 action、渲染组件）；复杂流程逻辑必须下沉到同目录的 `*.logic.ts`。
- 页面共置逻辑必须满足“单页面私有”前提；一旦被第二个页面复用，必须上提到 `src/lib/*`（或后续 `src/features/*`）。
- OpenClaw RPC 相关调用不属于页面共置范围；页面层及其共置文件不得直接拼装 `gateway:rpc` 的 OpenClaw 方法细节，必须走 `src/lib/openclaw/*` 兼容层。
- 页面共置文件禁止反向依赖其他页面目录（例如 `src/pages/A` 直接依赖 `src/pages/B`）。

## 3. 技术栈约束

- 桌面运行时：Electron 40+
- 前端：React 19 + TypeScript + React Router + Zustand
- UI：TailwindCSS + Radix UI + Lucide + Framer Motion
- 构建：Vite + vite-plugin-electron + electron-builder
- 测试：Vitest + Playwright
- AI 内核：内嵌 `openclaw` npm 包（版本以根 `package.json` 为准）

新增库前先评估是否可由现有栈解决，避免重复引入同类依赖。

## 4. 状态与数据流

- 单一真相源：
  - 网关连接态以 `GatewayManager` 为真相源。
  - 前端 store 只存最小必要状态。
- 派生状态不落库，使用 selector/计算属性生成。
- 禁止跨 store 隐式写入；跨域更新必须有明确 action。

## 5. IPC 与协议规则

- 继续开发时，先参考 `Matcha-claw/doc/gateway-rpc-api.md`，以其为 OpenClaw RPC 接口协议基准。
- 所有 IPC 入参与返回值必须有明确 TypeScript 类型。
- 错误语义统一：返回结构化错误（`code`/`message`），不要仅返回模糊字符串。
- `gateway:rpc` 调用必须设置合理超时，超时后可见地反馈给 UI。
- 对 OpenClaw WS 事件做兼容处理时，优先保持协议原义，不“猜字段”。

## 6. 安全规则

- API Key 等敏感信息必须通过 `electron/utils/secure-storage.ts` 管理。
- 严禁把 token、key、完整凭据写入日志或上报到渲染层。
- Preload 白名单最小化，不得暴露通用执行入口。
- 修改 CSP/Headers 逻辑时，必须说明影响范围与回退策略。

## 7. 代码风格与规模

- 使用 TypeScript 严格类型，避免 `any`；若必须使用，写明原因与边界。
- 函数保持单一职责；重复逻辑抽到 `electron/utils/*` 或 `src/lib/*`。
- 注释只解释“为什么”，不解释显而易见的“做了什么”。
- 优先小步重构，不做无边界大改。

## 8. 测试与验证（必做）

- 改动前后至少执行与范围匹配的验证：
  - 单元/集成：`pnpm test`
  - 类型检查：`pnpm typecheck`
  - 关键 UI 或流程变更：补充/执行 Playwright 用例
- 涉及以下模块时必须补测试：
  - IPC handler
  - Gateway 重连与状态机
  - 聊天流式事件处理
  - 配置读写与密钥存储
- 若无法运行测试，必须在交付说明中明确“未验证项与风险”。

## 9. 构建与发布规则

- 不得破坏 `scripts/bundle-openclaw.mjs` 的可复现性与幂等性。
- 不得破坏 `scripts/download-bundled-uv.mjs` 的跨平台目标产物结构。
- 任何打包链路变更必须在至少一个目标平台做实际构建验证。

## 10. OpenClaw 集成策略

- 优先做“适配层”改造，避免直接改 `openclaw` 内核代码。
- 升级 `openclaw` 版本时：
  - 先记录 breaking change 风险
  - 再验证 Gateway 握手、chat 流、skills、cron、channels 基本功能
- 不允许依赖未文档化的私有行为。

### 10.1 兼容层（Adapter Layer）强约束

- 凡涉及 OpenClaw RPC 调用，`src/*` 业务代码（页面、store、业务 lib）必须优先调用兼容层接口，不得在调用点直接拼装 RPC 细节。
- 若兼容层暂无对应接口，先在兼容层新增封装，再由业务代码调用；禁止“先直连 RPC，后续再重构”。
- 新增封装必须按“可复用、跨场景”设计，禁止为单页面/单流程写一次性定制适配。
- 兼容层对上提供稳定 contract，对下吸收 OpenClaw 版本变化（参数、返回结构、状态语义、超时语义）。
- OpenClaw 升级时，优先只改兼容层实现；上层调用签名应保持稳定。
- 错误语义统一由兼容层映射后再抛给上层；禁止把底层模糊错误直接扩散到 UI。

### 10.2 兼容层目录规划（统一放置）

- 兼容层统一放在：`src/lib/openclaw/`
- 当前文件：
  - `src/lib/openclaw/agent-runtime.ts`（agent run 生命周期：`agent` / `agent.wait`）
  - `src/lib/openclaw/session-runtime.ts`（`chat.send` / `chat.history` / `sessions.*` + 消息提取工具）
  - `src/lib/openclaw/types.ts`（兼容层共享类型）
- 后续新增按职责拆分：
  - `src/lib/openclaw/errors.ts`（错误码映射与错误构造）

## 11. 提交与评审

- 一次提交只解决一个问题域（功能、重构、测试分离）。
- PR 描述必须包含：
  - 改动范围
  - 风险点
  - 验证清单
  - 回滚方案（如适用）
- Code Review 以“行为正确性、回归风险、测试覆盖”优先，不做风格争论。
- PR 必须补充结构边界自检：
  - 是否新增了页面私有逻辑文件；若是，是否仅服务单页面；
  - 是否出现跨页面复用但未上提；
  - 是否出现页面层/共置文件直调 OpenClaw RPC。

## 12. 禁止事项

- 禁止在渲染进程绕过 preload 直接访问 Node 能力。
- 禁止吞异常（空 `catch` 或只 `console.log` 后继续）。
- 禁止未验证即合并关键链路改动。
- 禁止在不说明影响的情况下更改协议、端口、默认安全策略。

---

如与更高优先级指令冲突，以系统/开发者/用户实时指令为准；本文件用于项目内默认协作规范。
