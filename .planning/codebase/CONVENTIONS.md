# 编码规范

**分析日期：** 2026/05/21

## 命名模式

**文件：**
- 功能、服务、状态辅助和路由文件优先使用 kebab-case：`src/stores/chat/store-kernel.ts`、`src/lib/api-client.ts`、`electron/main/runtime-host-process-manager.ts`、`runtime-host/api/routes/settings-routes.ts`。
- React 组件文件通常使用 PascalCase：`src/components/layout/AgentSessionsPane.tsx`、`src/components/common/ErrorBoundary.tsx`；shadcn 风格基础组件可使用小写文件名并导出 PascalCase 组件，例如 `src/components/ui/button.tsx` 导出 `Button`。
- 测试文件按测试类型加后缀：`tests/unit/api-client.test.ts`、`tests/unit/agent-sessions-pane.test.tsx`、`tests/integration/platform-runtime-execute.integration.test.ts`、`tests/contract/runtime-host-transport-v1.contract.test.ts`、`tests/e2e/app-smoke.spec.ts`。
- 目录按层级或领域命名：`src/stores/chat/`、`src/services/openclaw/`、`electron/api/routes/`、`runtime-host/application/openclaw/`、`packages/openclaw-browser-relay-plugin/src/`。

**函数：**
- 普通函数、Hook、工具函数使用 camelCase：`invokeIpc` 位于 `src/lib/api-client.ts`，`hostApiFetch` 位于 `src/lib/host-api.ts`，`createTestRuntimeFileSystem` 位于 `tests/unit/helpers/runtime-file-system.ts`。
- 工厂函数使用 `create` 前缀：`createRuntimeHostProcessManager` 位于 `electron/main/runtime-host-process-manager.ts`，`createTestRuntimeHostContainer` 位于 `tests/unit/helpers/runtime-host-container.ts`。
- 规范化、解析、构建、校验类辅助函数使用动词前缀：`normalizeAppError` 位于 `src/lib/error-model.ts`，`headersToRecord` 和 `parseUnifiedProxyResponse` 位于 `src/lib/host-api.ts`，`requireJsonContentType` 位于 `electron/api/route-utils.ts`。
- Zustand store Hook 使用 `useXStore`：`useSettingsStore` 位于 `src/stores/settings.ts`，`useGatewayStore` 位于 `src/stores/gateway.ts`，`useChannelsStore` 位于 `src/stores/channels.ts`。

**变量：**
- 局部变量和对象字段使用 camelCase：`requestId`、`startedAt`、`durationMs` 位于 `src/lib/api-client.ts`；`setupComplete`、`telemetryEnabled` 位于 `src/stores/settings.ts`。
- 模块级常量使用 UPPER_SNAKE_CASE：`SLOW_REQUEST_THRESHOLD_MS` 位于 `src/lib/api-client.ts`，`HOST_API_PORT`、`SESSION_PROMPT_TIMEOUT_MS` 位于 `src/lib/host-api.ts`。
- 测试中的 mock 变量使用语义化后缀：`hostChannelsFetchSnapshotMock`、`hostChannelsDeleteConfigMock` 位于 `tests/unit/channels.store.test.ts`。

**类型：**
- interface、type、class 使用 PascalCase：`AppError`、`AppErrorCode` 位于 `src/lib/error-model.ts`，`SettingsState` 位于 `src/stores/settings.ts`，`BrowserActionResult` 位于 `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`。
- 单文件内部组件状态可使用 `Props` 和 `State`：`src/components/common/ErrorBoundary.tsx`。
- API 或跨层 DTO 在拥有该 API 的模块导出：`RuntimeJobSnapshot`、`RuntimeJobSubmission` 位于 `src/lib/host-api.ts`，`BrowserActionParams` 位于 `packages/openclaw-browser-relay-plugin/src/browser-action-contract.ts`。

## 代码风格

**格式化：**
- 使用 `.prettierrc` 中的 Prettier 设置：启用 semicolon、使用 single quote、`tabWidth: 2`、`trailingComma: "es5"`、`printWidth: 100`。
- JSX 属性和长参数列表超过宽度时分行，保持 2 空格缩进；示例见 `src/components/ui/button.tsx` 和 `src/App.tsx`。
- Tailwind class 字符串保持内联；需要组合动态 class 时使用 `cn`，例如 `src/components/ui/button.tsx` 从 `src/lib/utils.ts` 导入 `cn`。
- 导出的非 React 工具函数应写显式返回类型：`initializeDefaultTransports(): void` 位于 `src/lib/api-client.ts`，`hostApiFetch<T>(...): Promise<T>` 位于 `src/lib/host-api.ts`。

**Lint：**
- ESLint 配置位于 `eslint.config.mjs`，覆盖 `**/*.{ts,tsx}`，启用 `@eslint/js`、`@typescript-eslint`、`eslint-plugin-react-hooks`、`eslint-plugin-react-refresh`。
- `@typescript-eslint/no-unused-vars` 为 error；有意未使用的参数、变量、解构项使用 `_` 前缀。
- `@typescript-eslint/no-explicit-any` 为 warn；新增代码优先使用 `unknown`、泛型或 `Record<string, unknown>`，参考 `src/lib/host-api.ts` 和 `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`。
- `src/**/*.{ts,tsx}` 中禁止直接调用 `window.electron.ipcRenderer.invoke`；应通过 `invokeIpc` 或 `invokeApi`，唯一例外是 `src/lib/api-client.ts`。
- `src/**/*.{ts,tsx}` 中禁止直接 `fetch` 字面量 `http://localhost` 或 `http://127.0.0.1`；本地后端访问应通过 `hostApiFetch` 等封装，封装位于 `src/lib/host-api.ts`。
- `tsconfig.json` 对 `src` 启用 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`。

## 导入组织

**顺序：**
1. 外部包导入放在最前：`react`、`react-router-dom`、`zustand`、`@testing-library/react`、`vitest`；示例见 `src/App.tsx`、`src/stores/settings.ts`、`tests/unit/chat-input-mention.test.tsx`。
2. 应用别名导入放在外部包之后：`@/components/...`、`@/stores/...`、`@/lib/...`；示例见 `src/App.tsx` 和 `src/lib/host-api.ts`。
3. 同目录或同层级内部导入使用相对路径：`./telemetry`、`./error-model` 位于 `src/lib/api-client.ts`，`../utils/config` 位于 `electron/api/route-utils.ts`。
4. 类型导入使用 `import type`：`import type { ErrorInfo, ReactNode }` 位于 `src/App.tsx`，`import type { IncomingMessage, ServerResponse }` 位于 `electron/api/route-utils.ts`。

**路径别名：**
- `@/*` 映射到 `src/*`，配置位于 `tsconfig.json`、`vite.config.ts`、`vitest.config.ts`；渲染进程代码优先使用该别名。
- `@electron/*` 映射到 `electron/*`，配置位于 `tsconfig.json`、`vite.config.ts`、`vitest.config.ts`。
- `runtime-host/` 相关测试常用相对路径导入，例如 `tests/integration/platform-runtime-execute.integration.test.ts` 导入 `../../runtime-host/composition/modules/platform-runtime-module`。

## 错误处理

**模式：**
- 渲染进程 IPC 和 host API 错误统一规范化为 `AppError`：`normalizeAppError` 位于 `src/lib/error-model.ts`，调用点位于 `src/lib/api-client.ts` 和 `src/lib/host-api.ts`。
- 面向用户的错误文案通过 `toUserMessage` 生成，不直接展示原始后端异常；实现位于 `src/lib/api-client.ts`。
- `invokeIpcWithRetry` 只对 `TIMEOUT` 和 `NETWORK` 等可重试 `AppErrorCode` 重试；实现位于 `src/lib/api-client.ts`。
- Electron API 路由使用 `sendJson`、`sendNoContent`、`sendText` 等统一响应辅助函数；实现位于 `electron/api/route-utils.ts`。
- 浏览器 relay 插件返回结构化错误结果，不抛出裸字符串：`createErrorResult` 位于 `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`，返回 `ok: false`、`errorCode`、`recoverable`、`retryable`。
- 非关键持久化或诊断失败可使用窄范围 `catch` 降级：`src/stores/settings.ts` 在主进程设置不可达时保留 renderer persisted settings；`src/lib/host-api.ts` 在 abort 通知失败时忽略该附带通知。

## 日志

**框架：**
- 渲染进程使用 `console.info`、`console.warn`，并通过 `shouldLogApiRequests` 控制 API 日志；实现位于 `src/lib/api-client.ts`。
- UI 埋点使用 `trackUiEvent`，调用点包括 `src/lib/api-client.ts`、`src/lib/host-api.ts`、`src/stores/dashboard-usage.ts`。
- Electron main 使用集中 logger：`electron/utils/logger.ts` 提供 `debug`、`info`、`warn`、`error`、ring buffer 和异步文件写入。
- 插件服务使用注入 logger port：`PluginLogger` 用于 `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`。

**模式：**
- API 日志应包含稳定上下文：`requestId`、`channel`、`transport`、`durationMs` 位于 `src/lib/api-client.ts`；`path`、`method`、`source`、`durationMs` 位于 `src/lib/host-api.ts`。
- React Error Boundary 可直接使用 `console.error` 记录渲染错误：`src/App.tsx`、`src/components/common/ErrorBoundary.tsx`。
- 不记录 secrets、完整凭证或环境变量值；设置和 host API 代码记录路径、方法、状态和错误码，而不是 credential payload，参考 `src/lib/host-api.ts`。

## 注释

**何时注释：**
- 注释用于解释跨进程、降级、构建或平台相关的非显然逻辑；例如 `src/lib/host-api.ts` 中 abort IPC 的说明，`vite.config.ts` 中 `ELECTRON_RUN_AS_NODE` 清理说明。
- 对常规赋值、简单条件、直接返回不要补充重复性注释。
- 大型基础设施模块可使用短注释分区；示例见 `electron/utils/logger.ts`。

**JSDoc/TSDoc：**
- JSDoc 使用较少，主要出现在公共工具或基础组件：`src/components/common/ErrorBoundary.tsx`、`src/lib/utils.ts`。
- route、DTO、store 模块优先依赖清晰的导出类型命名，而不是长 JSDoc；示例见 `src/lib/host-api.ts` 和 `src/stores/settings.ts`。

## 函数设计

**大小：**
- 纯辅助函数应小而专注，并与所属模块共址：`classifyMessage` 位于 `src/lib/error-model.ts`，`headersToRecord` 位于 `src/lib/host-api.ts`，`asString`/`asBoolean` 位于 `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`。
- 复杂 store 逻辑应拆分到领域辅助模块，入口 store 只负责状态和动作编排；示例目录为 `src/stores/chat/`。
- UI 组件若状态较多，可把不复用的小组件或 view model 放在同领域文件或同目录中，例如 `src/components/layout/useAgentSessionsPaneViewModel.ts`。

**参数：**
- 多个相关依赖或选项使用对象参数：`BrowserControlServiceOptions` 位于 `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`，`HostApiRequestInit` 位于 `src/lib/host-api.ts`。
- 通用 IPC/API 封装保留小型位置参数签名并使用泛型返回：`invokeApi<T>(channel: string, ...args: unknown[])` 位于 `src/lib/api-client.ts`。
- 测试中的依赖应通过小型 mock port 或 builder 注入：`createRelayMock` 位于 `tests/unit/openclaw-browser-relay-service.test.ts`，`createTestRuntimeFileSystem` 位于 `tests/unit/helpers/runtime-file-system.ts`。

**返回值：**
- 异步 API 封装返回 `Promise<T>`，失败时抛出规范化错误：`invokeIpc`、`hostApiFetch`。
- 路由响应使用明确的 HTTP 状态和 JSON payload：`sendJson` 位于 `electron/api/route-utils.ts`。
- 插件动作返回可判定结果对象：`BrowserActionResult` 位于 `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`，调用方根据 `ok`、`errorCode`、`retryable` 分支。

## 模块设计

**导出：**
- 业务代码优先使用 named export；default export 主要用于框架配置或入口：`vitest.config.ts`、`playwright.config.ts`、`vite.config.ts`、`src/App.tsx`。
- side-effect 初始化保持显式：`initializeDefaultTransports()` 从 `src/main.tsx` 调用；i18n 初始化通过 `src/main.tsx` 导入 `src/i18n/index.ts`。
- 模块内常量只在需要跨模块复用时导出；内部默认设置保持文件内私有，例如 `defaultSettings` 位于 `src/stores/settings.ts`。

**Barrel 文件：**
- 使用窄 barrel 文件暴露领域入口：`src/assets/providers/index.ts` 汇总 provider SVG，package `index.ts` 暴露插件或包级 API。
- 避免新增宽泛的 app-wide barrel；直接导入拥有逻辑的具体模块，例如 `@/lib/host-api`、`@/components/ui/button`、`@/stores/channels`。

## 项目技能约束

- 未检测到 `.claude/skills/*/SKILL.md` 或 `.agents/skills/*/SKILL.md`；本规范仅基于实际代码、配置和测试文件。

---

*规范分析：2026/05/21*
