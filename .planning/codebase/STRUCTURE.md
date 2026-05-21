# Codebase Structure

**Analysis Date:** 2026/05/21

## Directory Layout

```
matchaclaw/
├── src/                         # React renderer application: pages, components, stores, clients, styles
│   ├── main.tsx                 # Renderer entry point and HashRouter mount
│   ├── App.tsx                  # Top-level route tree, app guards, global providers
│   ├── components/              # Shared UI/layout/runtime/update/settings/file-preview components
│   ├── pages/                   # Lazy-loaded route pages
│   ├── stores/                  # Zustand renderer state stores and store-domain helpers
│   ├── lib/                     # Renderer client utilities, host API wrappers, domain helpers
│   ├── services/                # Renderer service clients/adapters
│   ├── features/                # Feature-specific domain/runtime modules
│   ├── i18n/                    # i18next setup and locale bundles
│   ├── assets/                  # Renderer assets including provider icons and logo
│   ├── constants/               # Shared renderer constants
│   ├── styles/                  # Global CSS
│   └── types/                   # Renderer/shared TypeScript types
├── electron/                    # Electron main/preload, Host API, Gateway process, desktop services
│   ├── main/                    # Main process entry, bootstrap, window, IPC, Runtime Host/Gateway managers
│   ├── preload/                 # Context bridge and IPC channel allowlist
│   ├── api/                     # Local Host API server, route boundary, main-owned route handlers
│   ├── gateway/                 # OpenClaw Gateway lifecycle/config/process orchestration
│   ├── services/                # Main-process OpenClaw CLI and provider OAuth services
│   └── utils/                   # Main-process logging, paths, config, proxy, uv/env utilities
├── runtime-host/                # Separate Node runtime host process for business routes and OpenClaw orchestration
│   ├── main.ts                  # Runtime Host child process entry
│   ├── host-process.cjs         # Built-process bootstrap shim
│   ├── api/                     # Runtime route definitions and dispatch transport
│   ├── application/             # Runtime Host application services by domain
│   ├── composition/             # DI container, module registries, route/server composition
│   ├── core/                    # Runtime Host lifecycle/jobs/registry primitives
│   ├── openclaw-bridge/         # Gateway/OpenClaw bridge adapters
│   ├── plugin-engine/           # Plugin runtime engine support
│   ├── services/                # Runtime Host service implementations
│   └── shared/                  # Cross-process contracts and shared types
├── packages/                    # Bundled plugin packages and memory package
│   ├── openclaw-browser-relay-plugin/     # Browser relay OpenClaw plugin
│   ├── openclaw-task-manager-plugin/      # Task/background task OpenClaw plugin
│   ├── openclaw-security-plugin/          # Security policy/audit OpenClaw plugin
│   ├── openclaw-matchaclaw-media-plugin/  # Media capability OpenClaw plugin
│   └── memory-lancedb-pro/                # Memory package workspace
├── resources/                   # Packaged resources: icons, tools/extensions, skills, templates, screenshots
│   ├── tools/                   # Tool data including Chrome browser relay extension assets
│   ├── skills/                  # Preinstalled/bundled skills resources
│   ├── icons/                   # App icons
│   ├── agent-workspace-templates/ # Agent workspace templates
│   ├── connector-guide/         # Connector guide resources
│   └── context/                 # Packaged contextual resources
├── scripts/                     # Build, bundle, checks, installer, release helper scripts
├── tests/                       # Unit, integration, e2e, contract, benchmark tests
├── docs/                        # Project documentation
├── electron-builder.yml         # Electron Builder packaging config
├── vite.config.ts               # Renderer/main/preload Vite and Electron plugin config
├── vitest.config.ts             # Vitest configuration
├── playwright.config.ts         # Playwright e2e configuration
├── eslint.config.mjs            # ESLint configuration
├── tsconfig.json                # Renderer TypeScript config and aliases
├── tsconfig.node.json           # Node/Electron TypeScript config
├── tsconfig.runtime-host-process.json # Runtime Host process TypeScript config
├── pnpm-workspace.yaml          # pnpm workspace package list
├── package.json                 # Root scripts, dependencies, package metadata
└── pnpm-lock.yaml               # pnpm lockfile
```

## Directory Purposes

**`src/`:**
- Purpose: React renderer application loaded inside Electron BrowserWindow.
- Contains: App route tree, layout, pages, shared components, Zustand stores, host API client wrappers, i18n setup, renderer utilities.
- Key files: `src/main.tsx`, `src/App.tsx`, `src/lib/host-api.ts`, `src/lib/api-client.ts`, `src/lib/host-events.ts`, `src/lib/route-preload.ts`.

**`src/pages/`:**
- Purpose: Route-level UI pages loaded lazily by `src/lib/route-preload.ts` and rendered by `src/App.tsx`.
- Contains: Page directories for `Channels`, `Chat`, `Cron`, `Dashboard`, `Plugins`, `Providers`, `Security`, `Settings`, `Setup`, `Skills`, `SubAgents`, `Tasks`, and `Teams`.
- Key files: `src/pages/Chat/*`, `src/pages/Dashboard/index.tsx`, `src/pages/Settings/*`, `src/pages/Teams/index.tsx`, `src/pages/Teams/TeamChat.tsx`.

**`src/components/`:**
- Purpose: Reusable UI, app layout, settings panels, runtime daemons, update notifier, and file preview widgets.
- Contains: `common`, `layout`, `runtime`, `settings`, `ui`, `file-preview`, `task-center`, and `update` component groups.
- Key files: `src/components/layout/MainLayout.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/layout/TitleBar.tsx`, `src/components/runtime/TeamsRuntimeDaemon.tsx`, `src/components/ui/button.tsx`.

**`src/stores/`:**
- Purpose: Renderer-side Zustand stores and domain state helpers.
- Contains: Single-file stores for settings/gateway/providers/channels/etc. and a multi-file chat store submodule.
- Key files: `src/stores/settings.ts`, `src/stores/gateway.ts`, `src/stores/chat/store.ts`, `src/stores/chat/types.ts`, `src/stores/chat/selectors.ts`, `src/stores/plugins-store.ts`, `src/stores/security-policy-store.ts`, `src/stores/teams.ts`.

**`src/lib/`:**
- Purpose: Renderer utility/client layer shared across stores and pages.
- Contains: Host API wrappers, IPC wrappers, event subscription, telemetry, route preload, provider/security/channel/domain helper functions, Monaco loader, error model.
- Key files: `src/lib/host-api.ts`, `src/lib/api-client.ts`, `src/lib/host-events.ts`, `src/lib/error-model.ts`, `src/lib/route-preload.ts`, `src/lib/settings-runtime.ts`, `src/lib/security-runtime.ts`, `src/lib/provider-runtime.ts`.

**`src/services/`:**
- Purpose: Renderer service adapters for OpenClaw-related operations.
- Contains: OpenClaw task/plugin/subagent/session/agent runtime clients.
- Key files: `src/services/openclaw/task-manager-client.ts`, `src/services/openclaw/plugin-manager-client.ts`, `src/services/openclaw/session-runtime.ts`, `src/services/openclaw/subagent-template-catalog.ts`.

**`src/features/`:**
- Purpose: Feature-scoped renderer domain/runtime code that does not fit global stores/pages.
- Contains: `subagents` domain helpers and `teams` API/domain/runtime modules.
- Key files: `src/features/subagents/domain/prompt.ts`, `src/features/subagents/domain/workspace.ts`, `src/features/teams/api/runtime-client.ts`, `src/features/teams/runtime/orchestrator.ts`.

**`src/i18n/`:**
- Purpose: Internationalization setup and locale JSON bundles.
- Contains: `index.ts`, `language.ts`, and `locales/<language>/*.json` resource files.
- Key files: `src/i18n/index.ts`, `src/i18n/language.ts`.

**`electron/main/`:**
- Purpose: Electron main process entry and desktop/process orchestration.
- Contains: App bootstrap, main window creation, IPC modules, Runtime Host manager/process manager/client, Gateway event bridge, tray/menu/updater, process locks, quit lifecycle.
- Key files: `electron/main/index.ts`, `electron/main/app-bootstrap.ts`, `electron/main/main-window.ts`, `electron/main/ipc-handlers.ts`, `electron/main/host-event-bridge.ts`, `electron/main/runtime-host-manager.ts`, `electron/main/runtime-host-process-manager.ts`.

**`electron/main/ipc/`:**
- Purpose: Main-process IPC handler modules grouped by concern.
- Contains: App, dialog, gateway, host API proxy, shell, and window IPC handlers.
- Key files: `electron/main/ipc/hostapi-proxy-ipc.ts`, `electron/main/ipc/gateway-ipc.ts`, `electron/main/ipc/shell-ipc.ts`, `electron/main/ipc/window-ipc.ts`.

**`electron/preload/`:**
- Purpose: Secure bridge between isolated renderer and Electron main.
- Contains: Context bridge implementation and retained IPC channel contract.
- Key files: `electron/preload/index.ts`, `electron/preload/ipc-contract.ts`.

**`electron/api/`:**
- Purpose: Main-process localhost Host API and explicit route boundary between Electron infrastructure and Runtime Host business routes.
- Contains: HTTP server, event bus, route utilities, boundary spec/source, and main-owned route handlers.
- Key files: `electron/api/server.ts`, `electron/api/route-boundary.ts`, `electron/api/main-api-boundary.json`, `electron/api/event-bus.ts`, `electron/api/routes/runtime-host-proxy.ts`.

**`electron/api/routes/`:**
- Purpose: Main-owned Host API route handlers only.
- Contains: App/SSE, diagnostics, files, Gateway controls, logs, Runtime Host internal callbacks, Runtime Host process controls, and Runtime Host proxy fallback.
- Key files: `electron/api/routes/app.ts`, `electron/api/routes/gateway.ts`, `electron/api/routes/runtime-host-internal.ts`, `electron/api/routes/runtime-host-process.ts`, `electron/api/routes/runtime-host-proxy.ts`.

**`electron/gateway/`:**
- Purpose: OpenClaw Gateway lifecycle and startup orchestration.
- Contains: Manager, state controller, lifecycle/restart controllers, process launcher, process policy, supervisor, readiness checks, config sync, startup recovery/stderr handling.
- Key files: `electron/gateway/manager.ts`, `electron/gateway/startup-orchestrator.ts`, `electron/gateway/process-launcher.ts`, `electron/gateway/config-sync.ts`, `electron/gateway/public-status.ts`.

**`electron/services/`:**
- Purpose: Main-process services that require OS/browser/process capabilities.
- Contains: OpenClaw CLI service and provider OAuth browser/device managers.
- Key files: `electron/services/openclaw/openclaw-cli-service.ts`, `electron/services/providers/oauth/browser-oauth-manager.ts`, `electron/services/providers/oauth/device-oauth-manager.ts`.

**`electron/utils/`:**
- Purpose: Shared main-process utility functions.
- Contains: Ports/config, paths, logging/tracing, proxy fetch, uv environment/setup, Windows shell helpers, runtime package resolution.
- Key files: `electron/utils/config.ts`, `electron/utils/logger.ts`, `electron/utils/paths.ts`, `electron/utils/proxy-fetch.ts`, `electron/utils/uv-env.ts`.

**`runtime-host/`:**
- Purpose: Independent Node process that hosts MatchaClaw business/application routes and OpenClaw runtime coordination.
- Contains: Runtime process entry/shim, API route definitions, composition/DI modules, application services, core primitives, OpenClaw bridge, plugin engine, shared contracts.
- Key files: `runtime-host/main.ts`, `runtime-host/host-process.cjs`, `runtime-host/composition/runtime-host-composition.ts`, `runtime-host/composition/runtime-host-server.ts`.

**`runtime-host/api/`:**
- Purpose: Runtime Host HTTP dispatch and declarative business route definitions.
- Contains: Dispatch envelope/route dispatcher and route definition files for capability routing, channels, clawhub, cron, files, gateway, license, OpenClaw, plugins, providers, security, sessions, settings, skills, subagents, tasks, teams, toolchain, workbench.
- Key files: `runtime-host/api/dispatch/runtime-route-dispatcher.ts`, `runtime-host/api/dispatch/dispatch-route-handler.ts`, `runtime-host/api/routes/runtime-host-routes.ts`, `runtime-host/api/routes/session-routes.ts`, `runtime-host/api/routes/security-routes.ts`.

**`runtime-host/application/`:**
- Purpose: Domain/application service implementations behind Runtime Host routes.
- Contains: `channels`, `chat`, `cron`, `files`, `gateway`, `license`, `openclaw`, `platform-runtime`, `plugins`, `providers`, `runtime-host`, `security`, `sessions`, `settings`, `skills`, `subagents`, `tasks`, `teams`, `toolchain`, and `workbench` modules.
- Key files: `runtime-host/application/openclaw/service.ts`, `runtime-host/application/gateway/service.ts`, `runtime-host/application/plugins/runtime-plugin-registry.ts`, `runtime-host/application/sessions/service.ts`.

**`runtime-host/composition/`:**
- Purpose: Runtime Host dependency injection, module registration, application/system service composition, route registry, and HTTP server runner.
- Contains: Container, route registry, module registries, application service composition, Runtime Host process/server/runner, module-specific composition files under `modules`.
- Key files: `runtime-host/composition/runtime-host-composition.ts`, `runtime-host/composition/runtime-host-module-registry.ts`, `runtime-host/composition/runtime-host-runtime-module-registry.ts`, `runtime-host/composition/runtime-route-composition.ts`, `runtime-host/composition/route-registry.ts`.

**`runtime-host/core/`:**
- Purpose: Framework-neutral runtime primitives.
- Contains: Jobs, lifecycle, and registry utilities.
- Key files: `runtime-host/core/jobs.ts`, `runtime-host/core/lifecycle.ts`, `runtime-host/core/registry.ts`.

**`runtime-host/shared/`:**
- Purpose: Types/contracts shared across renderer, Electron main, Runtime Host, and tests.
- Contains: Gateway errors, parent transport contracts, session adapter types, update version helpers, Runtime Host constants.
- Key files: `runtime-host/shared/session-adapter-types.ts`, `runtime-host/shared/gateway-error.ts`, `runtime-host/shared/parent-transport-contracts.ts`, `runtime-host/shared/runtime-host-constants.ts`.

**`packages/openclaw-browser-relay-plugin/`:**
- Purpose: Local OpenClaw plugin for browser relay/control.
- Contains: Plugin manifest/package, runtime entry, relay server, browser control service, Playwright/direct CDP helpers, browser launch helpers, state and action contracts.
- Key files: `packages/openclaw-browser-relay-plugin/src/index.ts`, `packages/openclaw-browser-relay-plugin/src/application/browser-relay-runtime.ts`, `packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts`, `packages/openclaw-browser-relay-plugin/src/relay/server.ts`.

**`packages/openclaw-task-manager-plugin/`:**
- Purpose: Local OpenClaw plugin for task/todo tools and task persistence.
- Contains: Application tool/gateway adapters, domain task types/status, infrastructure stores, schemas, shared errors/params.
- Key files: `packages/openclaw-task-manager-plugin/src/index.ts`, `packages/openclaw-task-manager-plugin/src/application/task-tools.ts`, `packages/openclaw-task-manager-plugin/src/infrastructure/session-task-store.ts`, `packages/openclaw-task-manager-plugin/src/schemas/task-store-schema.ts`.

**`packages/openclaw-security-plugin/`:**
- Purpose: Local OpenClaw plugin for security policy, runtime guard, destructive detection, audit, and remediation.
- Contains: Adapter/application/core/infrastructure/vendor layers with explicit module boundaries.
- Key files: `packages/openclaw-security-plugin/MODULE_BOUNDARIES.md`, `packages/openclaw-security-plugin/src/adapters/openclaw/plugin.ts`, `packages/openclaw-security-plugin/src/application/security-runtime.ts`, `packages/openclaw-security-plugin/src/core/runtime-guard.ts`.

**`packages/openclaw-matchaclaw-media-plugin/`:**
- Purpose: Local OpenClaw plugin for MatchaClaw media capability integration.
- Contains: Plugin manifest/package and source entry/module files.
- Key files: `packages/openclaw-matchaclaw-media-plugin/openclaw.plugin.json`, `packages/openclaw-matchaclaw-media-plugin/package.json`, `packages/openclaw-matchaclaw-media-plugin/src/*`.

**`packages/memory-lancedb-pro/`:**
- Purpose: Workspace package for memory/LanceDB functionality included by root dependencies.
- Contains: Package entrypoints, source modules, scripts, tests, examples, and multilingual README files.
- Key files: `packages/memory-lancedb-pro/index.ts`, `packages/memory-lancedb-pro/cli.ts`, `packages/memory-lancedb-pro/src/store.ts`, `packages/memory-lancedb-pro/src/tools.ts`.

**`resources/`:**
- Purpose: Static/runtime resources copied into packaged app.
- Contains: Icons, screenshots, connector guides, context resources, skills, agent workspace templates, CLI/tool/extension data.
- Key files: `resources/icons/*`, `resources/tools/data/extension/chrome-extension/browser-relay/*`, `resources/skills/*`, `resources/agent-workspace-templates/*`.

**`scripts/`:**
- Purpose: Build, bundle, validation, packaging, release, installer, and generated-resource scripts.
- Contains: Runtime Host build, OpenClaw/plugin/skill bundlers, boundary checks, icon generation, uv/node downloaders, Electron Builder runner, installer scripts.
- Key files: `scripts/build-runtime-host-process.mjs`, `scripts/bundle-openclaw.mjs`, `scripts/bundle-openclaw-plugins.mjs`, `scripts/bundle-preinstalled-skills.mjs`, `scripts/check-main-api-boundary.mjs`, `scripts/check-openclaw-plugin-mirrors.mjs`, `scripts/run-electron-builder.mjs`.

**`tests/`:**
- Purpose: Automated validation across unit, integration, contract, e2e, benchmark, and plugin-specific scenarios.
- Contains: Test setup, directories for `unit`, `integration`, `contract`, `e2e`, `benchmark`, and `openclaw-browser-relay-plugin`.
- Key files: `tests/setup.ts`, `tests/unit/*`, `tests/contract/*`, `tests/e2e/*`.

**`.planning/codebase/`:**
- Purpose: Generated codebase maps for planning and execution agents.
- Contains: Architecture/structure and other focus-area markdown maps.
- Key files: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`.

## Key File Locations

**Entry Points:**
- `src/main.tsx`: React renderer entry and router mount.
- `src/App.tsx`: Route definitions, global initialization, route guards, providers.
- `electron/main/index.ts`: Electron main process entry and lifecycle orchestration.
- `electron/preload/index.ts`: Renderer preload bridge.
- `runtime-host/main.ts`: Runtime Host child process entry.
- `packages/openclaw-browser-relay-plugin/src/index.ts`: Browser relay plugin entry.
- `packages/openclaw-task-manager-plugin/src/index.ts`: Task manager plugin entry.
- `packages/openclaw-security-plugin/src/index.ts`: Security plugin entry.

**Configuration:**
- `package.json`: Root scripts, dependencies, package metadata, pnpm package manager declaration.
- `pnpm-workspace.yaml`: Workspace packages.
- `tsconfig.json`: Renderer TypeScript strict config and `@/*`, `@electron/*` aliases.
- `tsconfig.node.json`: Node/Electron TypeScript config.
- `tsconfig.runtime-host-process.json`: Runtime Host process TypeScript config.
- `vite.config.ts`: Vite renderer build, Electron main/preload entries, manual chunks, aliases.
- `vitest.config.ts`: Vitest setup.
- `playwright.config.ts`: Playwright e2e setup.
- `eslint.config.mjs`: ESLint setup.
- `.prettierrc`: Prettier formatting config.
- `electron-builder.yml`: Electron Builder packaging config.
- `tailwind.config.js`: Tailwind theme/content config.
- `postcss.config.js`: PostCSS config.

**Core Logic:**
- `src/lib/host-api.ts`: Renderer Host API wrapper and typed convenience methods.
- `src/lib/api-client.ts`: Renderer IPC wrapper and error normalization.
- `src/lib/host-events.ts`: Renderer host event subscription multiplexer.
- `src/stores/gateway.ts`: Gateway/Runtime Host event and lifecycle state.
- `src/stores/chat/store.ts`: Chat/session/approval state entry.
- `electron/api/server.ts`: Host API server.
- `electron/api/route-boundary.ts`: Main-owned vs Runtime Host business route classification.
- `electron/main/ipc/hostapi-proxy-ipc.ts`: Renderer-to-Host API IPC proxy.
- `electron/main/runtime-host-manager.ts`: Parent-side Runtime Host manager.
- `electron/gateway/manager.ts`: Gateway lifecycle manager.
- `runtime-host/composition/runtime-host-composition.ts`: Runtime Host composition root.
- `runtime-host/composition/runtime-host-module-registry.ts`: Runtime app module registry.
- `runtime-host/composition/runtime-host-runtime-module-registry.ts`: Runtime system module registry.
- `runtime-host/api/dispatch/runtime-route-dispatcher.ts`: Runtime route dispatcher.
- `runtime-host/composition/route-registry.ts`: Runtime route registration/error wrapper.
- `runtime-host/application/plugins/runtime-plugin-registry.ts`: Runtime plugin catalog/enabled state.

**Testing:**
- `tests/setup.ts`: Test setup file.
- `tests/unit/`: Unit tests for renderer/electron/runtime/plugin modules.
- `tests/integration/`: Integration tests.
- `tests/contract/`: Contract tests, including route/boundary expectations.
- `tests/e2e/`: Playwright tests.
- `tests/openclaw-browser-relay-plugin/`: Browser relay plugin tests.
- `vitest.config.ts`: Test runner config.
- `playwright.config.ts`: E2E runner config.

**Boundary and Guard Checks:**
- `electron/api/main-api-boundary.json`: Data spec for allowed main route files and routes.
- `electron/api/route-boundary.ts`: Source boundary constants and helper predicates.
- `scripts/check-main-api-boundary.mjs`: Enforces main API boundary.
- `scripts/check-trait-boundary.mjs`: Enforces trait/boundary constraints.
- `scripts/check-openclaw-plugin-inputs.mjs`: Validates OpenClaw plugin inputs before packaging.
- `scripts/check-openclaw-plugin-mirrors.mjs`: Validates plugin mirror state during packaging.

**Build and Packaging:**
- `scripts/build-runtime-host-process.mjs`: Builds Runtime Host process.
- `scripts/bundle-openclaw.mjs`: Bundles OpenClaw runtime.
- `scripts/bundle-openclaw-plugins.mjs`: Bundles local/OpenClaw plugins.
- `scripts/bundle-preinstalled-skills.mjs`: Bundles preinstalled skills.
- `scripts/run-electron-builder.mjs`: Runs Electron Builder.
- `scripts/after-pack.cjs`: Electron Builder after-pack hook.
- `vendor-patches/@larksuite__openclaw-lark@2026.4.8.patch`: pnpm patched dependency patch.

## Naming Conventions

**Files:**
- React component/page files use `PascalCase.tsx` for components: `src/components/layout/MainLayout.tsx`, `src/pages/Chat/ChatInput.tsx`.
- Route page entry files commonly use `index.tsx`: `src/pages/Dashboard/index.tsx`, `src/pages/Channels/index.tsx`.
- Renderer stores use domain names in `kebab-case.ts` or domain folders: `src/stores/provider-model-catalog.ts`, `src/stores/chat/store.ts`.
- Runtime/Electron infrastructure files use `kebab-case.ts`: `electron/main/runtime-host-manager.ts`, `runtime-host/composition/runtime-host-composition.ts`, `runtime-host/api/routes/provider-models-routes.ts`.
- Plugin packages use `kebab-case` source files and folder names: `packages/openclaw-task-manager-plugin/src/application/task-tools.ts`.
- Config files use conventional names: `vite.config.ts`, `vitest.config.ts`, `electron-builder.yml`, `tsconfig.json`.

**Directories:**
- Renderer route directories use `PascalCase`: `src/pages/Settings`, `src/pages/SubAgents`, `src/pages/Teams`.
- Renderer shared component/domain directories use `kebab-case` or lowercase: `src/components/file-preview`, `src/components/task-center`, `src/components/ui`.
- Runtime Host and Electron architecture directories use lowercase/kebab-case: `runtime-host/application/platform-runtime`, `electron/gateway`, `electron/api/routes`.
- Plugin package directories use `openclaw-*-plugin`: `packages/openclaw-browser-relay-plugin`, `packages/openclaw-security-plugin`.

**Route Files:**
- Runtime Host route files are named `<domain>-routes.ts`: `runtime-host/api/routes/security-routes.ts`, `runtime-host/api/routes/session-routes.ts`.
- Main-owned Host API route files are short domain names under allowlist: `electron/api/routes/gateway.ts`, `electron/api/routes/files.ts`.

**Stores:**
- Zustand store exports use `use<Domain>Store`: `useSettingsStore` in `src/stores/settings.ts`, `useGatewayStore` in `src/stores/gateway.ts`, `useChatStore` in `src/stores/chat/store.ts`.
- Large store domains use helper modules with action-oriented names: `src/stores/chat/send-handlers.ts`, `src/stores/chat/session-actions.ts`, `src/stores/chat/event-actions.ts`.

## Where to Add New Code

**New renderer page/route:**
- Primary code: Add a page directory/file under `src/pages/<PageName>/`.
- Route registration: Add a lazy route export in `src/lib/route-preload.ts`.
- App route: Add a `<Route>` in `src/App.tsx` under the appropriate `MainLayout` or standalone section.
- Navigation/sidebar: Update `src/components/layout/Sidebar.tsx` if the route needs sidebar navigation.
- State/client code: Put shared state in `src/stores/<domain>.ts` or `src/stores/<domain>/`; put Host API wrappers in `src/lib/<domain>-runtime.ts` or `src/services/<domain>/*`.
- Tests: Add renderer/store tests under `tests/unit/` and e2e coverage under `tests/e2e/` when route behavior is user-visible.

**New renderer component:**
- Shared primitive: `src/components/ui/<component>.tsx`.
- Shared app component: `src/components/common/<Component>.tsx`.
- Layout component: `src/components/layout/<Component>.tsx`.
- Page-local component: place beside the owning page in `src/pages/<PageName>/`.
- Feature-specific component: use `src/components/<domain>/` when multiple pages use it.

**New renderer state domain:**
- Simple state: `src/stores/<domain>.ts`.
- Complex async/event state: `src/stores/<domain>/store.ts`, `src/stores/<domain>/types.ts`, `src/stores/<domain>/selectors.ts`, and helper modules following `src/stores/chat/*`.
- Host API wrappers: `src/lib/<domain>-runtime.ts` or `src/services/<domain>/*`.
- Tests: `tests/unit/<domain>*.test.ts`.

**New business API route:**
- Route definition: `runtime-host/api/routes/<domain>-routes.ts`.
- Application service: `runtime-host/application/<domain>/service.ts` and supporting files under `runtime-host/application/<domain>/`.
- Module registration: Register services/routes/jobs/lifecycle through `runtime-host/composition/modules/*` and `runtime-host/composition/runtime-host-module-registry.ts`.
- Renderer client: Add wrapper functions in `src/lib/<domain>-runtime.ts` or `src/services/<domain>/*` using `hostApiFetch`.
- Tests: Add Runtime Host route/service tests under `tests/unit/` or `tests/integration/`; add boundary/contract tests under `tests/contract/` when applicable.

**New main-owned infrastructure route:**
- Route handler: Add or extend a file under `electron/api/routes/` only for OS/main-process infrastructure concerns.
- Boundary updates: Update both `electron/api/route-boundary.ts` and `electron/api/main-api-boundary.json`.
- Server registration: Register the handler in `electron/api/server.ts` before `handleRuntimeHostProxyRoutes`.
- Boundary check: Ensure `scripts/check-main-api-boundary.mjs` permits the route/file.
- Renderer client: Use `hostApiFetch` from `src/lib/host-api.ts`; do not call localhost fetch directly.

**New IPC channel:**
- Prefer Host API route first.
- If IPC is required for main-only UI/OS behavior, add the channel to the correct group in `electron/preload/ipc-contract.ts`.
- Register handler in `electron/main/ipc/<domain>-ipc.ts` and call it from `electron/main/ipc-handlers.ts`.
- Renderer call site should use `invokeIpc`/`invokeApi` from `src/lib/api-client.ts`.

**New Runtime Host system module:**
- Module services/infrastructure: Add files under `runtime-host/composition/modules/` and implementation under `runtime-host/application/*`, `runtime-host/services/*`, or `runtime-host/openclaw-bridge/*` as appropriate.
- Registration: Add module entry to `RUNTIME_HOST_SYSTEM_MODULES` in `runtime-host/composition/runtime-host-runtime-module-registry.ts`.
- Lifecycle/jobs: Register through `registerRuntimeHostSystemModuleLifecycle` and `registerRuntimeHostSystemModuleJobs` patterns.

**New Runtime Host application module:**
- Services/routes: Add `register*ApplicationServices`, `resolve*ApplicationServices`, and route registration in `runtime-host/composition/modules/*`.
- Module registry: Add module entry to `RUNTIME_HOST_APPLICATION_MODULES` and `RUNTIME_HOST_ROUTE_MODULES` in `runtime-host/composition/runtime-host-module-registry.ts`.
- Route definitions: Add declarative route definitions under `runtime-host/api/routes/<domain>-routes.ts`.

**New Gateway lifecycle behavior:**
- Process state/reconnect policy: `electron/gateway/process-policy.ts`, `electron/gateway/state.ts`, or `electron/gateway/restart-controller.ts`.
- Startup flow: `electron/gateway/startup-orchestrator.ts`, `electron/gateway/supervisor.ts`, `electron/gateway/process-launcher.ts`.
- Public status mapping: `electron/gateway/public-status.ts` and renderer state in `src/stores/gateway.ts`.

**New local OpenClaw plugin:**
- Package location: `packages/openclaw-<name>-plugin/`.
- Required files: `package.json`, `openclaw.plugin.json`, `src/index.ts`.
- Internal layering: Use `src/application`, `src/domain` or `src/core`, `src/infrastructure`, `src/shared`, and `src/schemas` as needed; follow `packages/openclaw-task-manager-plugin/src/*` or `packages/openclaw-security-plugin/MODULE_BOUNDARIES.md`.
- Bundling: Update plugin bundle scripts/config as needed in `scripts/bundle-openclaw-plugins.mjs` and verify with `scripts/check-openclaw-plugin-inputs.mjs` / `scripts/check-openclaw-plugin-mirrors.mjs`.
- Tests: Add plugin tests under `tests/unit/` or `tests/<plugin-name>/`.

**New packaged static resource:**
- App icons: `resources/icons/`.
- Browser relay extension/tool data: `resources/tools/data/extension/chrome-extension/browser-relay/`.
- Preinstalled skills: `resources/skills/` and bundle through `scripts/bundle-preinstalled-skills.mjs`.
- Agent workspace templates: `resources/agent-workspace-templates/`.
- Connector guides: `resources/connector-guide/`.

**Utilities:**
- Renderer utilities: `src/lib/<utility>.ts`.
- Electron main utilities: `electron/utils/<utility>.ts`.
- Runtime Host shared contracts: `runtime-host/shared/<contract>.ts`.
- Runtime Host internal utilities: place near owning domain under `runtime-host/application/<domain>/` or `runtime-host/core/`.
- Build utilities/scripts: `scripts/<name>.mjs` or `scripts/lib/*`.

## Special Directories

**`dist/`:**
- Purpose: Vite renderer build output.
- Generated: Yes.
- Committed: No.

**`dist-electron/`:**
- Purpose: Vite Electron main/preload build output.
- Generated: Yes.
- Committed: No.

**`release/` or Electron Builder output directories:**
- Purpose: Packaged installers/artifacts from Electron Builder.
- Generated: Yes.
- Committed: No.

**`node_modules/`:**
- Purpose: pnpm-installed dependencies.
- Generated: Yes.
- Committed: No.

**`resources/`:**
- Purpose: Source static resources bundled into the app.
- Generated: Mixed; many files are source assets, some catalogs/bundles may be generated by scripts.
- Committed: Yes.

**`vendor-patches/`:**
- Purpose: pnpm patch files for dependencies.
- Generated: No; maintained patch artifacts.
- Committed: Yes.

**`packages/memory-lancedb-pro/`:**
- Purpose: Workspace package with its own package metadata, tests, examples, and scripts.
- Generated: No.
- Committed: Yes.

**`packages/*/src/vendor/`:**
- Purpose: Vendored plugin-specific runtime components such as security runtime subsets.
- Generated: No.
- Committed: Yes.

**`worktrees/plugins/sdk`:**
- Purpose: pnpm workspace entry for plugin SDK when present.
- Generated: Environment/worktree dependent.
- Committed: Not detected in this worktree listing.

**`.claude/`:**
- Purpose: Agent/worktree metadata in this execution environment.
- Generated: Yes.
- Committed: No in normal source tree.

**`.planning/codebase/`:**
- Purpose: Generated architecture/codebase maps consumed by GSD planning/execution commands.
- Generated: Yes.
- Committed: Project/process dependent.

**`.env.example`:**
- Purpose: Example environment configuration.
- Generated: No.
- Committed: Yes.
- Note: Real `.env*` files must not be read or documented with contents.

**Project skill directories:**
- Purpose: Optional agent skill instructions under `.claude/skills/` or `.agents/skills/`.
- Generated: Project dependent.
- Committed: Not detected; no `SKILL.md` files found in this worktree.

---

*Structure analysis: 2026/05/21*
