# AGENTS.md

## Cursor Cloud specific instructions

### Overview

MatchaClaw is a cross-platform **Electron desktop app** (React 19 + Vite + TypeScript) providing a GUI for the OpenClaw AI agent runtime. It uses pnpm as its package manager (pinned version in `package.json`'s `packageManager` field).

### Linked References

- `@docs/gateway-rpc-api.md` — OpenClaw Gateway RPC 开发基线（握手、帧结构、方法清单、实现层差异与调用边界）。
- `@docs/gateway-events-api.md` — OpenClaw Gateway 事件开发基线（事件总表、`agent/chat` 语义、慢连接策略、`node.event` 上报事件）。
- `@docs/hook-extension-points.md` — OpenClaw 插件 Hook 完整插入点（触发位置、优先级/执行顺序、返回值与异常语义）。

> 约束：凡涉及 OpenClaw 接口、事件流或插件扩展的开发，必须先对齐上述文档，再进入实现。

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
- **Token usage history implementation**: Dashboard token usage history is not parsed from console logs. It reads OpenClaw session transcript `.jsonl` files under the local OpenClaw config directory, extracts assistant messages with `message.usage`, and aggregates fields such as input/output/cache/total tokens and cost from those structured records.
- **Renderer/Main API boundary (important)**:
  - Renderer must use `src/lib/host-api.ts` and `src/lib/api-client.ts` as the single entry for backend calls.
  - Do not add new direct `window.electron.ipcRenderer.invoke(...)` calls in pages/components; expose them through host-api/api-client instead.
  - Do not call Gateway HTTP endpoints directly from renderer (`fetch('http://127.0.0.1:18789/...')` etc.). Use Main-process proxy channels (`hostapi:fetch`, `gateway:httpProxy`) to avoid CORS/env drift.
  - Transport policy is Main-owned and fixed as `WS -> HTTP -> IPC fallback`; renderer should not implement protocol switching UI/business logic.
- **Doc sync rule**: After any functional or architecture change, review `README.md`, `README.zh-CN.md`, and `README.ja-JP.md` for required updates; if behavior/flows/interfaces changed, update docs in the same PR/commit.

## 全局开发策略

- **重构兼容性策略**：当前项目尚未发布正式版本，任何重构默认不要求保持历史版本兼容性；优先保证结构清晰与长期可维护性。

## git提交规范（全局）

以下规则用于**所有“要求我提交代码”**的场景，默认执行：

- **提交粒度**：一次仅提交一个完整能力或一个完整修复，保持原子性，不混入无关改动。
- **实现流程**：先明确边界与改动清单，再落地实现，再验证通过后再提交。
- **架构约束**：必须遵循现有框架边界（如 `host-api/api-client`、既有 `store/i18n/路由` 模式），禁止引入平行实现或重复轮子。
- **冗余治理**：与本次能力无关的代码不带入；旧残留、冲突逻辑和临时兜底应在同次提交内清理干净。
- **测试要求（TDD）**：
  - 先补失败用例，再实现修复，再跑通过
  - 提交前至少覆盖本次改动的关键行为回归
  - 用户要求“都测吧”时，执行相关测试集而非仅 smoke
- **提交信息要求**：
  - 提交标题和摘要使用中文
  - 必须明确写出“新增了什么功能、修改了什么行为、删了什么冗余”
  - 禁止信息不足的标题（例如仅写“迁移/调整/优化”而无具体内容）
  - 允许使用规范前缀（如 `feat/fix/refactor(scope): ...`）
