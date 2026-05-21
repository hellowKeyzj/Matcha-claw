# 测试模式

**分析日期：** 2026/05/21

## 测试框架

**Runner：**
- 单元、集成、契约和 benchmark 风格测试使用 Vitest `^4.0.18`；测试位于 `tests/unit/`、`tests/integration/`、`tests/contract/`、`tests/benchmark/`。
- Vitest 配置文件：`vitest.config.ts`。
- `vitest.config.ts` 启用 `globals: true`、`environment: "jsdom"`、`setupFiles: ["./tests/setup.ts"]`，include 为 `tests/**/*.{test,spec}.{ts,tsx}`，exclude 为 `tests/e2e/**`。
- Electron E2E 使用 Playwright `@playwright/test` `^1.58.2`；测试位于 `tests/e2e/`。
- Playwright 配置文件：`playwright.config.ts`。
- `playwright.config.ts` 使用 `testDir: "./tests/e2e"`、`timeout: 90_000`、`fullyParallel: false`、`workers: 1`，失败时保留 trace、screenshot 和 video。

**断言库：**
- Vitest `expect` 用于普通断言、Promise 断言、mock 调用断言；示例见 `tests/unit/api-client.test.ts`、`tests/integration/platform-runtime-execute.integration.test.ts`、`tests/contract/runtime-host-transport-v1.contract.test.ts`。
- `@testing-library/jest-dom` 从 `tests/setup.ts` 全局加载，用于 DOM matcher，例如 `toBeInTheDocument`，示例见 `tests/unit/chat-input-mention.test.tsx`。
- Playwright `expect` 从 `tests/e2e/fixtures/electron.ts` 重新导出，用于 locator 和 page 断言，示例见 `tests/e2e/app-smoke.spec.ts`。

**运行命令：**
```bash
pnpm test                 # 运行 Vitest，排除 tests/e2e/**
pnpm test -- --watch      # 以 watch 模式运行 Vitest
pnpm test -- --coverage   # 按 vitest.config.ts 生成 coverage
pnpm test:contract        # 运行 tests/contract
pnpm test:e2e             # 先 build:vite，再运行 Playwright Electron E2E
pnpm test:e2e:headed      # headed 模式运行 Playwright Electron E2E
pnpm typecheck            # TypeScript no-emit 检查
pnpm lint                 # ESLint --fix
```

## 测试文件组织

**位置：**
- 单元测试放在 `tests/unit/`，不与源码共址：`tests/unit/api-client.test.ts`、`tests/unit/channels.store.test.ts`、`tests/unit/chat-input-mention.test.tsx`。
- 与 `openclaw-browser-relay-plugin` 相关的专门测试放在 `tests/openclaw-browser-relay-plugin/`：`tests/openclaw-browser-relay-plugin/installed-profile-discovery.test.ts`、`tests/openclaw-browser-relay-plugin/launch-profile-state.test.ts`。
- 集成测试放在 `tests/integration/`：`tests/integration/platform-runtime-execute.integration.test.ts`、`tests/integration/platform-tool-callback.integration.test.ts`。
- 契约测试放在 `tests/contract/`：`tests/contract/runtime-host-transport-v1.contract.test.ts`、`tests/contract/host-api-proxy-envelope.contract.test.ts`。
- E2E 测试放在 `tests/e2e/`：`tests/e2e/app-smoke.spec.ts`、`tests/e2e/settings-proxy.spec.ts`、`tests/e2e/chat/chat.spec.ts`。
- Vitest 全局 setup 位于 `tests/setup.ts`；E2E fixtures 位于 `tests/e2e/fixtures/`；单元辅助工具位于 `tests/unit/helpers/`。

**命名：**
- 单元测试使用 `*.test.ts` 或 `*.test.tsx`：`tests/unit/api-client.test.ts`、`tests/unit/chat-input-mention.test.tsx`。
- 集成测试使用 `*.integration.test.ts`：`tests/integration/platform-runtime-execute.integration.test.ts`。
- 契约测试使用 `*.contract.test.ts`：`tests/contract/runtime-host-transport-v1.contract.test.ts`。
- Playwright E2E 使用 `*.spec.ts`：`tests/e2e/app-smoke.spec.ts`。
- 测试描述可使用中文或英文；现有中文描述见 `tests/contract/runtime-host-transport-v1.contract.test.ts`、`tests/integration/platform-runtime-execute.integration.test.ts`、`tests/e2e/app-smoke.spec.ts`。

**结构：**
```text
tests/
├── setup.ts                         # Vitest 全局 DOM/Electron mock 和缓存重置
├── unit/                            # jsdom 单元和组件测试
│   ├── helpers/                     # 单元测试 builder、runtime-host test container
│   └── *.test.{ts,tsx}
├── openclaw-browser-relay-plugin/   # browser relay 插件专项测试
│   └── *.test.ts
├── integration/                     # 跨模块 runtime-host 集成测试
│   └── *.integration.test.ts
├── contract/                        # 稳定 transport/API 契约测试
│   └── *.contract.test.ts
├── benchmark/                       # Vitest benchmark/回归套件
│   └── *.test.ts
└── e2e/                             # Playwright Electron E2E
    ├── fixtures/                    # Electron launch、临时 home、host fixture
    ├── chat/
    └── *.spec.ts
```

## 测试结构

**Suite 组织：**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pattern from tests/unit/api-client.test.ts
describe('api-client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('forwards invoke arguments and returns result', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ ok: true });

    const result = await invokeIpc<{ ok: boolean }>('app:version');

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('app:version');
  });
});
```

**模式：**
- 使用 `describe` 按公开模块或行为分组：`describe('api-client', ...)` 位于 `tests/unit/api-client.test.ts`，`describe('channels store', ...)` 位于 `tests/unit/channels.store.test.ts`，`describe('runtime-host transport v1 contract', ...)` 位于 `tests/contract/runtime-host-transport-v1.contract.test.ts`。
- 有共享 mock 状态的 suite 在 `beforeEach` 中重置：`tests/unit/api-client.test.ts` 使用 `vi.resetAllMocks()`，`tests/unit/channels.store.test.ts` 使用 `vi.resetModules()` 和各 mock 的 `mockReset()`。
- 使用文件内 builder 生成重复数据形状：`buildSnapshot` 位于 `tests/unit/channels.store.test.ts`，`createRelayMock` 位于 `tests/unit/openclaw-browser-relay-service.test.ts`。
- 组件测试通过 React Testing Library 渲染真实 DOM：`render`、`screen`、`fireEvent` 用于 `tests/unit/chat-input-mention.test.tsx`。
- 契约测试使用 `beforeAll`/`afterAll` 启停真实进程：`tests/contract/runtime-host-transport-v1.contract.test.ts` 启动 runtime host process。
- 涉及文件系统或环境变量的测试必须在 `afterEach` 恢复状态：`tests/unit/channel-runtime-config.test.ts` 恢复 `process.env.OPENCLAW_CONFIG_DIR` 并删除临时目录。

## Mock

**框架：**
- Vitest：`vi.fn`、`vi.mock`、`vi.spyOn`、`vi.mocked`、`mockResolvedValueOnce`、`mockRejectedValueOnce`。
- Playwright：通过 fixture 注入 `electronApp`、`page`、`homeDir`，实现位于 `tests/e2e/fixtures/electron.ts`。

**模式：**
```typescript
// Global Electron renderer mock from tests/setup.ts
Object.defineProperty(window, 'electron', {
  value: mockElectron,
  writable: true,
});
```

```typescript
// Per-test IPC behavior from tests/unit/api-client.test.ts
const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
invoke
  .mockRejectedValueOnce(new Error('network timeout'))
  .mockResolvedValueOnce('MatchaClaw');

const result = await invokeIpcWithRetry<string>('app:name', [], 1);
expect(result).toBe('MatchaClaw');
expect(invoke).toHaveBeenCalledTimes(2);
```

```typescript
// Module mock from tests/unit/channels.store.test.ts
vi.mock('../../src/lib/channel-runtime', () => ({
  hostChannelsFetchSnapshot: (...args: unknown[]) => hostChannelsFetchSnapshotMock(...args),
  hostChannelsDeleteConfig: (...args: unknown[]) => hostChannelsDeleteConfigMock(...args),
}));
```

```typescript
// Store state assertion from tests/unit/channels.store.test.ts
const { useChannelsStore } = await import('../../src/stores/channels');
const fetchPromise = useChannelsStore.getState().fetchChannels();
expect(useChannelsStore.getState().initialLoading).toBe(true);
```

**应该 Mock 的内容：**
- 通过 `tests/setup.ts` 全局 mock `window.electron`、`matchMedia` 和基础浏览器能力；普通单元测试不要重复定义这些对象。
- 渲染进程 IPC 边界使用 `vi.mocked(window.electron.ipcRenderer.invoke)` 注入结果，示例位于 `tests/unit/api-client.test.ts`。
- store 或外部服务依赖使用 `vi.fn()` 或 `vi.mock()` 替换，示例位于 `tests/unit/channels.store.test.ts`、`tests/unit/chat-input-mention.test.tsx`。
- 文件系统、OS、浏览器 profile、CDP/extension adapter 使用临时目录或模块 mock，示例位于 `tests/openclaw-browser-relay-plugin/installed-profile-discovery.test.ts`、`tests/unit/accio-browser-relay-tab-manager.test.ts`。
- runtime-host 集成测试应 mock 外部 port，而保留待测 composition/root 的真实代码，示例位于 `tests/integration/platform-runtime-execute.integration.test.ts`。

**不应该 Mock 的内容：**
- 不 mock 被测函数本身；`tests/unit/api-client.test.ts` 导入真实 `src/lib/api-client.ts`，`tests/unit/channels.store.test.ts` 动态导入真实 `src/stores/channels.ts`。
- 不 mock React Testing Library query 或 Playwright locator；组件和 E2E 测试应断言真实 DOM。
- 契约测试不 mock runtime-host process；`tests/contract/runtime-host-transport-v1.contract.test.ts` 通过 `electron/main/runtime-host-process-manager.ts` 启动 `runtime-host/host-process.cjs`。
- E2E 不 mock Electron app launch；`tests/e2e/fixtures/electron.ts` 启动已构建的 `dist-electron/main/index.js`。

## Fixtures 和工厂

**测试数据：**
```typescript
// Pattern from tests/unit/channels.store.test.ts
function buildSnapshot(channelId: string, accountId = 'main') {
  return {
    success: true,
    snapshot: {
      channelOrder: [channelId],
      channels: { [channelId]: { configured: true } },
      channelAccounts: { [channelId]: [{ accountId, connected: true, name: accountId }] },
      channelDefaultAccountId: { [channelId]: accountId },
    },
  };
}
```

```typescript
// Pattern from tests/e2e/fixtures/electron.ts
export const test = base.extend<ElectronFixtures>({
  homeDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'matchaclaw-e2e-home-'));
    try {
      await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});
```

**位置：**
- 全局 Vitest setup：`tests/setup.ts`。
- 单元测试辅助工具：`tests/unit/helpers/runtime-host-container.ts`、`tests/unit/helpers/runtime-file-system.ts`、`tests/unit/helpers/plugin-file-system.ts`。
- 文件内 builder：`buildSnapshot` 位于 `tests/unit/channels.store.test.ts`，`createRelayMock` 位于 `tests/unit/openclaw-browser-relay-service.test.ts`。
- Playwright Electron fixture：`tests/e2e/fixtures/electron.ts`。

## 覆盖率

**要求：**
- `vitest.config.ts` 未配置 coverage threshold；当前没有强制覆盖率门槛。
- Coverage reporter 配置为 `text`、`json`、`html`。
- Coverage exclude 包含 `node_modules/` 和 `tests/`。

**查看覆盖率：**
```bash
pnpm test -- --coverage
```

## 测试类型

**单元测试：**
- 范围：renderer helper、React 组件、Zustand store、Electron utility、runtime-host service、plugin 模块。
- 位置：`tests/unit/` 和 `tests/openclaw-browser-relay-plugin/`。
- 方法：导入真实实现，mock 跨进程、OS、浏览器或外部服务边界，断言公开行为。
- DOM 测试使用 `render`、`screen`、`fireEvent`、`waitFor`；示例位于 `tests/unit/chat-input-mention.test.tsx`。
- Store 测试通过 `useStore.getState()`、`setState` 或动态 import 控制状态；示例位于 `tests/unit/channels.store.test.ts`。

**集成测试：**
- 范围：runtime-host composition、service facade、跨模块桥接行为。
- 位置：`tests/integration/`。
- 方法：创建测试 container，注册真实 module root，mock 外部 port，断言 facade 调用；示例位于 `tests/integration/platform-runtime-execute.integration.test.ts`。

**契约测试：**
- 范围：稳定 transport/API envelope、状态码、版本字段、错误码。
- 位置：`tests/contract/`。
- 方法：断言精确响应结构；`tests/contract/runtime-host-transport-v1.contract.test.ts` 使用真实 HTTP `fetch` 请求 `/health` 和 `/dispatch`。

**E2E 测试：**
- Framework：Playwright Electron via `@playwright/test`。
- 位置：`tests/e2e/`。
- 方法：`pnpm test:e2e` 先运行 `pnpm run build:vite`，再通过 `tests/e2e/fixtures/electron.ts` 启动构建产物 `dist-electron/main/index.js`、`dist-electron/preload/index.js` 和 `dist/index.html`。
- E2E 每次使用临时 home/app-data 隔离状态；fixture 位于 `tests/e2e/fixtures/electron.ts`。
- 需要准备应用状态时，通过 localStorage 或 IPC 设置；示例 `ensureSetupComplete` 位于 `tests/e2e/app-smoke.spec.ts`。

## 常见模式

**异步测试：**
```typescript
// Promise rejection assertion from tests/unit/api-client.test.ts
const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
invoke.mockRejectedValueOnce(new Error('Gateway Timeout'));

await expect(invokeIpc('gateway:status')).rejects.toMatchObject({ code: 'TIMEOUT' });
```

```typescript
// Controlled promise from tests/unit/channels.store.test.ts
let resolveFetch: ((value: ReturnType<typeof buildSnapshot>) => void) | null = null;
hostChannelsFetchSnapshotMock.mockReturnValue(
  new Promise<ReturnType<typeof buildSnapshot>>((resolve) => {
    resolveFetch = resolve;
  }),
);

const fetchPromise = useChannelsStore.getState().fetchChannels();
expect(useChannelsStore.getState().initialLoading).toBe(true);
resolveFetch?.(buildSnapshot('wecom'));
await fetchPromise;
```

```typescript
// Playwright assertion from tests/e2e/app-smoke.spec.ts
await expect(page.getByTestId('settings-page')).toBeVisible();
await expect(page).toHaveURL(/\/settings/);
```

**错误测试：**
```typescript
// Error normalization from tests/unit/api-client.test.ts
invoke.mockRejectedValueOnce(new Error('Gateway Timeout'));
await expect(invokeIpc('gateway:status')).rejects.toMatchObject({ code: 'TIMEOUT' });
```

```typescript
// Contract error envelope from tests/contract/runtime-host-transport-v1.contract.test.ts
expect(response.status).toBe(400);
expect(payload).toEqual(expect.objectContaining({
  version: RUNTIME_HOST_TRANSPORT_VERSION,
  success: false,
  status: 400,
  error: expect.objectContaining({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('Unsupported transport version'),
  }),
}));
```

**DOM 查询：**
- 优先使用无障碍查询：`screen.getByRole('textbox')`、`screen.getByRole('listbox')`、`screen.getByRole('option', { name: /@coding-agent/i })` 位于 `tests/unit/chat-input-mention.test.tsx`。
- 页面级 E2E 可使用 `data-testid` 标记稳定区域：`page.getByTestId('settings-page')` 位于 `tests/e2e/app-smoke.spec.ts`。
- icon-only button 应补充 `aria-label` 或 `title`，使测试和辅助技术能稳定定位；现有 E2E 使用 `page.getByTitle(...)` 模式。

**状态清理：**
- `tests/setup.ts` 在每个 Vitest case 后执行 `vi.clearAllMocks()`。
- `tests/setup.ts` 在每个 Vitest case 后调用 `__resetSubagentsStoreInternalCachesForTest` 和 `__resetSubagentTemplateCatalogCacheForTest`（如果模块导出这些函数）。
- 使用 fake timers 的测试在 `afterEach` 调用 `vi.useRealTimers()`，示例位于 `tests/unit/channels.store.test.ts`。
- 临时目录测试在 `afterEach` 删除目录并恢复环境变量，示例位于 `tests/unit/channel-runtime-config.test.ts`。
- E2E fixture 在 `finally` 中删除临时 home 目录并恢复 `ELECTRON_RUN_AS_NODE`，实现位于 `tests/e2e/fixtures/electron.ts`。

---

*测试分析：2026/05/21*
