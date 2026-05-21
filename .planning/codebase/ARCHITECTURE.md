<!-- refreshed: 2026/05/21 -->
# Architecture

**Analysis Date:** 2026/05/21

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│              React renderer + routed desktop UI             │
│  `src/main.tsx` → `src/App.tsx` → `src/pages/*`             │
├──────────────────┬──────────────────┬───────────────────────┤
│ Pages/components │ Zustand stores   │ Renderer API clients   │
│ `src/pages/*`    │ `src/stores/*`   │ `src/lib/host-api.ts`  │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                 Electron preload + main process             │
│ `electron/preload/index.ts`, `electron/main/index.ts`       │
├─────────────────────────────┬───────────────────────────────┤
│ Host API + IPC proxy        │ Main-owned process controls    │
│ `electron/api/server.ts`    │ `electron/gateway/manager.ts` │
└───────────────┬─────────────┴───────────────┬───────────────┘
                │                             │
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Runtime Host child process                                  │
│ `runtime-host/main.ts`, `runtime-host/composition/*`        │
│ Owns business routes, OpenClaw config, sessions, plugins    │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw Gateway + local plugin packages + packaged assets  │
│ `electron/gateway/*`, `packages/*`, `resources/*`           │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Renderer entry | Initialize API transport, i18n, global CSS, and `HashRouter` React tree. | `src/main.tsx` |
| App shell | Own route definitions, global route guards, settings/provider/gateway/update initialization, theme application, and top-level error boundary. | `src/App.tsx` |
| Main layout | Compose title bar, sidebar, chat workspace takeover, pane sizing, and routed page outlet. | `src/components/layout/MainLayout.tsx` |
| Renderer host API client | Send backend requests through `hostapi:fetch`, normalize envelopes/errors, manage aborts, and create tokenized SSE fallback URLs. | `src/lib/host-api.ts` |
| Renderer IPC client | Wrap retained IPC invoke channels with request IDs, slow-request telemetry, and error normalization. | `src/lib/api-client.ts` |
| Host event subscription | Prefer `host:event` IPC fan-out; optionally fall back to tokenized `/api/events` SSE. | `src/lib/host-events.ts` |
| Settings store | Hydrate persisted settings from Runtime Host routes and mirror updates to host settings. | `src/stores/settings.ts` |
| Gateway store | Track Gateway/Runtime Host lifecycle, subscribe to host events, and bridge gateway notifications into chat/tasks/channel stores. | `src/stores/gateway.ts` |
| Chat store | Manage sessions, message history, pending approvals, streaming runtime state, and send/abort/session actions. | `src/stores/chat/store.ts` |
| Electron main entry | Configure Electron process, single-instance locks, lifecycle hooks, Gateway manager, Runtime Host manager, and app quit cleanup. | `electron/main/index.ts` |
| Main bootstrap | Create window/tray/menu, start Runtime Host, start Host API, register IPC, register host event bridge, apply settings, and optionally auto-start Gateway. | `electron/main/app-bootstrap.ts` |
| BrowserWindow factory | Create the isolated renderer window, preload script, platform title bar behavior, external URL policy, and dev/prod content loading. | `electron/main/main-window.ts` |
| Preload bridge | Expose `window.electron` with allowlisted IPC channels and file path helper under context isolation. | `electron/preload/index.ts` |
| IPC contract | Define retained invoke/event/once channels that renderer code may use. | `electron/preload/ipc-contract.ts` |
| IPC registration | Register host API proxy, gateway, shell, dialog, app, and window IPC handlers. | `electron/main/ipc-handlers.ts` |
| Host API server | Serve localhost HTTP routes on `127.0.0.1`, enforce bearer auth, and route main-owned handlers before Runtime Host proxy fallback. | `electron/api/server.ts` |
| Main API boundary | Define main-owned exact/prefix routes and classify all other `/api/*` routes as Runtime Host business routes. | `electron/api/route-boundary.ts` |
| Main API boundary guard | CI/check script that prevents reintroducing business routes into `electron/api/routes`. | `scripts/check-main-api-boundary.mjs` |
| Runtime Host proxy route | Forward business `/api/*` calls from Host API to Runtime Host via `RuntimeHostManager.request`. | `electron/api/routes/runtime-host-proxy.ts` |
| Host event bridge | Fan Gateway, Runtime Host, job, OAuth, license, team, and session events to SSE clients and renderer IPC. | `electron/main/host-event-bridge.ts` |
| Runtime Host manager | Spawn/control Runtime Host child process, proxy requests, execute main-only shell/OAuth actions, and emit lifecycle/job/gateway events. | `electron/main/runtime-host-manager.ts` |
| Gateway manager | Own OpenClaw Gateway process lifecycle, reconnect/reload/restart policy, readiness probes, stderr classification, and public status state. | `electron/gateway/manager.ts` |
| Runtime Host process | Compose infrastructure, system modules, application services, route dispatcher, HTTP server, jobs, and lifecycle. | `runtime-host/composition/runtime-host-composition.ts` |
| Runtime route registry | Convert module route definitions into dispatch handlers with error envelopes. | `runtime-host/composition/route-registry.ts` |
| Runtime route dispatcher | Match exact/prefix/pattern runtime routes and invoke the first handler that returns a response. | `runtime-host/api/dispatch/runtime-route-dispatcher.ts` |
| Runtime HTTP server | Expose `/health`, lifecycle endpoints, and `/dispatch` for parent-process calls. | `runtime-host/composition/runtime-host-server.ts` |
| Runtime system module registry | Register infrastructure, OpenClaw bridge, platform runtime, plugin runtime, and session runtime modules. | `runtime-host/composition/runtime-host-runtime-module-registry.ts` |
| Runtime application module registry | Register application service/route/job/lifecycle modules for openclaw, runtime, operations, and sessions. | `runtime-host/composition/runtime-host-module-registry.ts` |
| Runtime plugin registry | Maintain enabled plugin IDs, injected/discovered plugin catalog, refresh jobs, and Gateway restart on plugin enablement changes. | `runtime-host/application/plugins/runtime-plugin-registry.ts` |
| Browser relay plugin | Register a local OpenClaw service, Gateway method, and tool around a browser relay server/control service. | `packages/openclaw-browser-relay-plugin/src/application/browser-relay-runtime.ts` |
| Task manager plugin | Register task/background-task tools and Gateway methods for task persistence. | `packages/openclaw-task-manager-plugin/src/index.ts` |
| Security plugin | Keep adapter/application/core/infrastructure/vendor layers separated for policy, guard, and audit behavior. | `packages/openclaw-security-plugin/MODULE_BOUNDARIES.md` |

## Pattern Overview

**Overall:** Electron desktop shell with a React renderer, a narrow Electron main-process infrastructure boundary, a separate Runtime Host child process for business/application routes, and OpenClaw Gateway/local plugins below it.

**Key Characteristics:**
- Renderer code calls backend features through `src/lib/host-api.ts`; it does not call Runtime Host directly.
- Electron main owns OS/process-only concerns: windows, tray/menu, shell/dialog, updater, Host API token, Runtime Host child process, and Gateway process.
- Business API routes are concentrated in `runtime-host/api/routes/*` and registered by module registries in `runtime-host/composition/*`.
- `electron/api/routes/runtime-host-proxy.ts` is intentionally the final Host API fallback handler; main-owned routes are explicitly listed in `electron/api/route-boundary.ts` and mirrored by `electron/api/main-api-boundary.json`.
- Renderer state is held in Zustand stores under `src/stores/*`, with larger domains split into helper modules such as `src/stores/chat/*`.
- Local OpenClaw plugins under `packages/*` use plugin SDK entry points and expose tools/services/Gateway methods rather than importing renderer or Electron UI code.

## Layers

**Renderer UI Layer:**
- Purpose: Present pages, layout, controls, file previews, setup/settings screens, and chat workspace.
- Location: `src/main.tsx`, `src/App.tsx`, `src/pages/*`, `src/components/*`
- Contains: React components, route loading, UI state hooks, Tailwind/shadcn-style primitives, page-specific rendering logic.
- Depends on: `src/stores/*`, `src/lib/*`, `src/services/*`, `window.electron` from `electron/preload/index.ts`.
- Used by: Electron BrowserWindow loaded by `electron/main/main-window.ts`.

**Renderer State and Client Layer:**
- Purpose: Provide app state, backend client functions, host event subscription, telemetry, and domain adapters for pages/components.
- Location: `src/stores/*`, `src/lib/*`, `src/services/*`, `src/types/*`
- Contains: Zustand stores, `hostApiFetch` wrappers, IPC invocation wrappers, route preloaders, provider/security/channel/task clients.
- Depends on: `src/lib/api-client.ts`, `src/lib/host-api.ts`, Runtime Host shared types such as `runtime-host/shared/session-adapter-types`.
- Used by: `src/App.tsx`, route pages under `src/pages/*`, layout/components under `src/components/*`.

**Preload Boundary Layer:**
- Purpose: Expose a restricted renderer API while Electron runs with `contextIsolation: true` and `nodeIntegration: false`.
- Location: `electron/preload/index.ts`, `electron/preload/ipc-contract.ts`
- Contains: `window.electron.ipcRenderer.invoke/on/once/off`, `openExternal`, `getPathForFile`, platform/dev flags, channel allowlists.
- Depends on: Electron `contextBridge`, `ipcRenderer`, `webUtils`.
- Used by: `src/lib/api-client.ts`, `src/lib/host-api.ts`, `src/lib/host-events.ts`, title bar and shell integrations.

**Electron Main Infrastructure Layer:**
- Purpose: Own desktop lifecycle, OS integration, secure renderer window, Host API server, IPC handlers, Runtime Host child process, Gateway process, updates, OAuth shell actions.
- Location: `electron/main/*`, `electron/api/*`, `electron/gateway/*`, `electron/services/*`, `electron/utils/*`
- Contains: `BrowserWindow` creation, app bootstrap, process lifecycle managers, route handlers, IPC handlers, proxy-aware fetch, settings/path utilities.
- Depends on: Electron main APIs, Node HTTP/process/fs/path APIs, Runtime Host manager, Gateway manager.
- Used by: Electron runtime entry configured in `vite.config.ts`.

**Host API Boundary Layer:**
- Purpose: Provide a single localhost HTTP boundary for renderer-initiated requests and internal Runtime Host callbacks.
- Location: `electron/api/server.ts`, `electron/api/routes/*`, `electron/api/route-boundary.ts`, `electron/api/main-api-boundary.json`
- Contains: Bearer-token auth, CORS, main-owned route handlers, SSE events, Runtime Host proxy fallback.
- Depends on: `GatewayManager`, `RuntimeHostManager`, `HostEventBus`, `electron/api/route-utils.ts`.
- Used by: `electron/main/ipc/hostapi-proxy-ipc.ts` and optional SSE consumers in `src/lib/host-events.ts`.

**Runtime Host Application Layer:**
- Purpose: Own business routes and application orchestration for OpenClaw settings, providers, sessions, channels, plugins, cron, security, license, teams, workbench, and files.
- Location: `runtime-host/application/*`, `runtime-host/api/routes/*`, `runtime-host/composition/*`
- Contains: Application services, route definitions, module registries, job/lifecycle registration, parent shell ports.
- Depends on: Runtime Host infrastructure modules, OpenClaw bridge, plugin runtime, parent transport client.
- Used by: Runtime Host HTTP dispatch from `electron/main/runtime-host-manager.ts`.

**Runtime Host System/Infrastructure Layer:**
- Purpose: Compose process-level infrastructure, OpenClaw bridge, platform runtime, plugin runtime, session runtime, parent transport, and jobs.
- Location: `runtime-host/core/*`, `runtime-host/openclaw-bridge/*`, `runtime-host/plugin-engine/*`, `runtime-host/services/*`, `runtime-host/shared/*`, `runtime-host/composition/modules/*`
- Contains: Container, lifecycle, job registry, HTTP transport, Gateway/OpenClaw bridge ports, shared contracts, platform runtime ledgers.
- Depends on: Node runtime and injected environment variables from `electron/main/runtime-host-manager.ts`.
- Used by: Runtime Host application service composition in `runtime-host/composition/runtime-host-composition.ts`.

**Gateway Process Layer:**
- Purpose: Start, stop, monitor, reconnect, and readiness-check the OpenClaw Gateway process.
- Location: `electron/gateway/*`
- Contains: Startup orchestration, process launcher, process policy, supervisor, config sync, restart controller, public status projection.
- Depends on: Runtime Host readiness routes, OpenClaw launch/config utilities, Electron utility process APIs.
- Used by: `electron/main/index.ts`, `electron/main/app-bootstrap.ts`, `runtime-host/application/gateway/*` through parent shell/control ports.

**Local Plugin Layer:**
- Purpose: Provide bundled MatchaClaw/OpenClaw plugin functionality.
- Location: `packages/openclaw-browser-relay-plugin/*`, `packages/openclaw-task-manager-plugin/*`, `packages/openclaw-security-plugin/*`, `packages/openclaw-matchaclaw-media-plugin/*`, `packages/memory-lancedb-pro/*`
- Contains: Plugin SDK entrypoints, tools, Gateway method adapters, application/domain/infrastructure code, plugin manifests.
- Depends on: OpenClaw plugin SDK packages and plugin-specific infrastructure.
- Used by: Runtime Host plugin catalog/build/bundle flow and OpenClaw Gateway plugin runtime.

**Build/Packaging Layer:**
- Purpose: Build Vite renderer, Electron main/preload, Runtime Host process, OpenClaw bundle, local plugins, bundled skills, icons, installers.
- Location: `vite.config.ts`, `electron-builder.yml`, `scripts/*`, `resources/*`, `vendor-patches/*`
- Contains: Chunking, bundling scripts, package builder hooks, generated resources, bundled tools/skills/extensions.
- Depends on: pnpm workspace from `pnpm-workspace.yaml`, Electron Builder, Vite plugin electron, zx scripts.
- Used by: `package.json` scripts such as `build`, `package:*`, `release`.

## Data Flow

### Primary Renderer Request Path

1. UI page/component triggers a store action or client wrapper (`src/App.tsx:133`, `src/stores/gateway.ts:76`, `src/stores/settings.ts:94`).
2. Renderer code calls `hostApiFetch` with a business or main-owned path (`src/lib/host-api.ts:188`).
3. `hostApiFetch` invokes `hostapi:fetch` through the retained IPC bridge (`src/lib/host-api.ts:210`, `src/lib/api-client.ts:63`).
4. Preload validates the channel against retained IPC allowlists before forwarding to Electron main (`electron/preload/index.ts:19`, `electron/preload/ipc-contract.ts:43`).
5. Electron main IPC handler attaches bearer auth, timeout headers, JSON body, and forwards to localhost Host API (`electron/main/ipc/hostapi-proxy-ipc.ts:43`).
6. Host API validates auth/content type and walks main-owned handlers before Runtime Host proxy fallback (`electron/api/server.ts:53`, `electron/api/server.ts:86`).
7. Main-owned routes handle infrastructure directly when listed in `electron/api/route-boundary.ts` (`electron/api/routes/gateway.ts:41`, `electron/api/routes/files.ts:40`).
8. Business `/api/*` routes are forwarded by `handleRuntimeHostProxyRoutes` to `RuntimeHostManager.request` (`electron/api/routes/runtime-host-proxy.ts:24`, `electron/api/routes/runtime-host-proxy.ts:58`).
9. Runtime Host manager dispatches to Runtime Host child HTTP transport (`electron/main/runtime-host-manager.ts:526`).
10. Runtime Host `/dispatch` invokes the runtime route dispatcher (`runtime-host/composition/runtime-host-server.ts:67`, `runtime-host/api/dispatch/runtime-route-dispatcher.ts:25`).
11. Module-registered route definitions call application services and return response envelopes (`runtime-host/composition/runtime-route-composition.ts:10`, `runtime-host/composition/route-registry.ts:68`).

### Startup and Process Lifecycle Flow

1. Vite Electron plugin points main entry at `electron/main/index.ts` and preload at `electron/preload/index.ts` (`vite.config.ts:124`, `vite.config.ts:146`).
2. Electron main disables hardware acceleration, applies single-instance locks, creates Gateway/Runtime Host managers, and waits for app readiness (`electron/main/index.ts:44`, `electron/main/index.ts:151`).
3. `bootstrapMainApplication` creates menu/window/tray, starts Runtime Host, loads persisted bootstrap settings, registers IPC, and starts Host API (`electron/main/app-bootstrap.ts:117`).
4. Runtime Host manager creates a child process manager with parent API URL, dispatch token, Gateway port, OpenClaw dir, app version, and user data dir env vars (`electron/main/runtime-host-manager.ts:173`).
5. Runtime Host process composes infrastructure, system modules, application services, route dispatcher, jobs, lifecycle, and HTTP server (`runtime-host/composition/runtime-host-composition.ts:53`).
6. Host API starts on `127.0.0.1` with a random token (`electron/api/server.ts:106`).
7. Renderer window loads dev server URL or packaged `dist/index.html` after Host API registration (`electron/main/main-window.ts:71`, `electron/main/app-bootstrap.ts:168`).
8. If enabled, Gateway auto-start first syncs provider auth bootstrap through Runtime Host, then starts Gateway manager (`electron/main/app-bootstrap.ts:84`).

### Host Event Flow

1. Runtime Host and Gateway managers emit lifecycle/domain/job events (`electron/main/runtime-host-manager.ts:96`, `electron/gateway/manager.ts:49`).
2. `registerHostEventBridge` converts manager events to public event names (`electron/main/host-event-bridge.ts:104`).
3. `emitHostEvent` writes both SSE events and renderer IPC `host:event` envelopes (`electron/main/host-event-bridge.ts:94`, `electron/api/event-bus.ts:14`).
4. Renderer `subscribeHostEvent` registers event-specific handlers against a single IPC bridge, with optional SSE fallback (`src/lib/host-events.ts:115`).
5. Stores such as `useGatewayStore` update local snapshots and fan events into chat/task/channel stores (`src/stores/gateway.ts:172`).

### Gateway and Plugin Runtime Flow

1. Gateway manager requests launch context from Runtime Host via the control-ready probe configured in main (`electron/main/index.ts:178`, `electron/gateway/manager.ts:464`).
2. Gateway startup sequence finds existing gateways, waits for ports, starts the managed process, and waits for control readiness (`electron/gateway/manager.ts:157`).
3. Runtime Host system modules register OpenClaw bridge, Gateway control port, plugin runtime, session runtime, and platform runtime (`runtime-host/composition/runtime-host-runtime-module-registry.ts:93`).
4. Runtime plugin registry merges injected catalog with discovered catalog and tracks enabled plugin IDs (`runtime-host/application/plugins/runtime-plugin-registry.ts:62`).
5. Local plugin packages expose plugin entrypoints and tools/Gateway methods through OpenClaw plugin SDK (`packages/openclaw-browser-relay-plugin/src/application/browser-relay-runtime.ts:94`, `packages/openclaw-task-manager-plugin/src/index.ts:6`).
6. Enabling plugins can enqueue refresh and restart Gateway through parent shell control (`runtime-host/application/plugins/runtime-plugin-registry.ts:79`).

**State Management:**
- Renderer state uses Zustand stores in `src/stores/*`; persisted UI/settings fallback uses Zustand `persist` in `src/stores/settings.ts` while canonical settings sync to Runtime Host routes.
- Electron main keeps process/global singleton state in module variables in `electron/main/index.ts` and class instances such as `GatewayManager`.
- Runtime Host uses a container/module registry pattern in `runtime-host/composition/*` plus in-memory registries for lifecycle/jobs/plugins.
- Host events are push-based through IPC and SSE via `electron/main/host-event-bridge.ts`, `electron/api/event-bus.ts`, and `src/lib/host-events.ts`.

## Key Abstractions

**Host API Transport:**
- Purpose: Single renderer-to-backend request path with auth, timeout, abort, and response normalization.
- Examples: `src/lib/host-api.ts`, `electron/main/ipc/hostapi-proxy-ipc.ts`, `electron/api/server.ts`
- Pattern: Renderer IPC proxy to localhost HTTP server, then main-owned handler or Runtime Host dispatch.

**Main API Boundary:**
- Purpose: Keep Electron main routes limited to infrastructure concerns while Runtime Host owns business routes.
- Examples: `electron/api/route-boundary.ts`, `electron/api/main-api-boundary.json`, `scripts/check-main-api-boundary.mjs`
- Pattern: Explicit allowlist for main-owned route files/routes; proxy fallback for non-main `/api/*` routes.

**Runtime Host Module Registry:**
- Purpose: Compose routes, services, jobs, and lifecycle hooks without central monolithic service wiring.
- Examples: `runtime-host/composition/runtime-host-module-registry.ts`, `runtime-host/composition/runtime-host-runtime-module-registry.ts`, `runtime-host/composition/application-services.ts`
- Pattern: Named module registry with phases (`services`, `service-resolution`, `routes`, `jobs`, `lifecycle`, `connect`).

**Runtime Route Definitions:**
- Purpose: Express Runtime Host HTTP business routes as declarative method/path/handler records.
- Examples: `runtime-host/api/routes/runtime-host-routes.ts`, `runtime-host/api/routes/channel-routes.ts`, `runtime-host/api/routes/security-routes.ts`
- Pattern: `RuntimeRouteDefinition<Deps>[]` registered into `RuntimeHostRouteRegistry` and dispatched by exact/prefix/pattern match.

**Process Managers:**
- Purpose: Encapsulate child process lifecycles, health, restart/reconnect behavior, and event publication.
- Examples: `electron/main/runtime-host-manager.ts`, `electron/main/runtime-host-process-manager.ts`, `electron/gateway/manager.ts`
- Pattern: Manager interfaces/classes expose start/stop/restart/health/request operations and emit events through EventEmitter-like subscriptions.

**Renderer Store Modules:**
- Purpose: Keep UI domain state and side effects near the renderer while delegating persistence/business work to Host API.
- Examples: `src/stores/gateway.ts`, `src/stores/settings.ts`, `src/stores/chat/store.ts`, `src/stores/chat/*`
- Pattern: Zustand stores with actions; large stores delegate mutations to helper modules.

**Host Events:**
- Purpose: Deliver Gateway/Runtime Host/session/job/OAuth events to renderer without polling.
- Examples: `electron/main/host-event-bridge.ts`, `electron/api/event-bus.ts`, `src/lib/host-events.ts`
- Pattern: Electron main emits `host:event` IPC envelopes and SSE events; renderer multiplexes by `eventName`.

**OpenClaw Plugin Entry:**
- Purpose: Package local functionality as OpenClaw plugins.
- Examples: `packages/openclaw-browser-relay-plugin/src/application/browser-relay-runtime.ts`, `packages/openclaw-task-manager-plugin/src/index.ts`, `packages/openclaw-security-plugin/src/index.ts`
- Pattern: Plugin SDK entrypoint registers services, tools, and Gateway methods; plugin internals use application/domain/infrastructure folders where present.

## Entry Points

**Electron main process:**
- Location: `electron/main/index.ts`
- Triggers: Electron starts `dist-electron/main/index.js` from `package.json` main field and Vite Electron plugin.
- Responsibilities: Electron app configuration, locks, Runtime Host/Gateway managers, app lifecycle, quit cleanup, bootstrap invocation.

**Electron preload script:**
- Location: `electron/preload/index.ts`
- Triggers: BrowserWindow `webPreferences.preload` in `electron/main/main-window.ts`.
- Responsibilities: Expose safe renderer APIs and enforce IPC channel allowlist.

**React renderer:**
- Location: `src/main.tsx`
- Triggers: Vite renderer loads `index.html` and mounts React root.
- Responsibilities: Initialize default transports/i18n/styles and mount `App` inside `HashRouter`.

**App route tree:**
- Location: `src/App.tsx`
- Triggers: React render from `src/main.tsx`.
- Responsibilities: App-level store initialization, license/setup route guard, theme, lazy page routes, `MainLayout`, `TeamsRuntimeDaemon`, update notifier, toaster.

**Host API server:**
- Location: `electron/api/server.ts`
- Triggers: `startHostApiServer` during `bootstrapMainApplication`.
- Responsibilities: Authenticated localhost HTTP API, main-owned routes, SSE events, Runtime Host proxy.

**Runtime Host child process:**
- Location: `runtime-host/main.ts`
- Triggers: Runtime Host process manager spawned by `electron/main/runtime-host-manager.ts` after build via `scripts/build-runtime-host-process.mjs`.
- Responsibilities: Start composed Runtime Host HTTP server and exit on startup failure.

**Runtime Host composition:**
- Location: `runtime-host/composition/runtime-host-composition.ts`
- Triggers: `createRuntimeHostProcess().start()` from `runtime-host/main.ts`.
- Responsibilities: Register infrastructure, system modules, app services/routes/jobs/lifecycle, parent transport, and HTTP dispatch server.

**Local plugin entrypoints:**
- Location: `packages/openclaw-browser-relay-plugin/src/index.ts`, `packages/openclaw-task-manager-plugin/src/index.ts`, `packages/openclaw-security-plugin/src/index.ts`, `packages/openclaw-matchaclaw-media-plugin/src/index.ts`
- Triggers: Plugin discovery/bundling and OpenClaw plugin runtime.
- Responsibilities: Register plugin services/tools/Gateway methods and plugin metadata.

**Build/package orchestration:**
- Location: `package.json`, `vite.config.ts`, `scripts/build-runtime-host-process.mjs`, `scripts/bundle-openclaw.mjs`, `scripts/bundle-openclaw-plugins.mjs`, `scripts/run-electron-builder.mjs`
- Triggers: pnpm scripts such as `dev`, `build`, `package`, and `release`.
- Responsibilities: Build renderer/main/preload/runtime-host, bundle OpenClaw/plugins/skills/resources, run Electron Builder.

## Architectural Constraints

- **Threading/process model:** Renderer runs in an isolated Electron renderer process; Electron main runs Node/Electron event loop; Runtime Host runs as a separate child process; Gateway runs as a managed external/utility process through `electron/gateway/manager.ts`.
- **Renderer isolation:** `electron/main/main-window.ts` uses `nodeIntegration: false` and `contextIsolation: true`; renderer must access backend functionality through `electron/preload/index.ts` and retained IPC channels in `electron/preload/ipc-contract.ts`.
- **Host API auth:** `electron/api/server.ts` generates a random Host API token and requires bearer/query token auth except `/internal/runtime-host/*` callbacks.
- **Main/business route split:** New business `/api/*` routes belong in `runtime-host/api/routes/*`; main routes must be explicitly added to `electron/api/route-boundary.ts` and `electron/api/main-api-boundary.json` and pass `scripts/check-main-api-boundary.mjs`.
- **Runtime Host proxy order:** `electron/api/server.ts` requires `handleRuntimeHostProxyRoutes` as the final fallback handler in `routeHandlers`.
- **Path aliases:** TypeScript/Vite map `@/*` to `src/*` and `@electron/*` to `electron/*` in `tsconfig.json` and `vite.config.ts`.
- **Global state:** Electron main keeps module-level `mainWindow`, `gatewayManager`, `hostEventBus`, `runtimeHostManager`, and `hostApiServer` in `electron/main/index.ts`; renderer host events keep singleton hub state on `window` in `src/lib/host-events.ts`; Runtime Host composition registers singleton service instances in `RuntimeHostContainer`.
- **Circular coupling to manage carefully:** `GatewayManager` and `RuntimeHostManager` are mutually connected after construction in `electron/main/index.ts` (`gatewayManager.setRuntimeHostManager(runtimeHostManager)`), so constructors stay lightweight and cross-calls occur through interfaces after both exist.
- **Runtime Host env contract:** `electron/main/runtime-host-manager.ts` injects `MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT`, `MATCHACLAW_OPENCLAW_DIR`, `MATCHACLAW_APP_PACKAGED`, `MATCHACLAW_APP_VERSION`, and `MATCHACLAW_APP_USER_DATA_DIR`; `runtime-host/composition/runtime-host-composition.ts` requires parent API base URL and dispatch token env vars.
- **Package workspace scope:** `pnpm-workspace.yaml` includes root app, `packages/openclaw-runtime-bundle`, `packages/memory-lancedb-pro`, `runtime-host`, and `worktrees/plugins/sdk`; several local plugin folders are bundled by scripts rather than listed as pnpm workspace packages.
- **Project skills:** No `.claude/skills/*/SKILL.md` or `.agents/skills/*/SKILL.md` files were detected in this worktree, so no project skill-specific architecture rules are available.

## Anti-Patterns

### Adding business routes to Electron main

**What happens:** A feature adds `electron/api/routes/<business>.ts` and imports it directly in `electron/api/server.ts`.
**Why it's wrong:** Main API route files are intentionally restricted by `electron/api/route-boundary.ts`, `electron/api/main-api-boundary.json`, and `scripts/check-main-api-boundary.mjs`; business routes bypass Runtime Host composition and blur process ownership.
**Do this instead:** Add `RuntimeRouteDefinition` entries under `runtime-host/api/routes/*`, register them through `runtime-host/composition/modules/*` and `runtime-host/composition/runtime-host-module-registry.ts`, and call them from renderer via `src/lib/host-api.ts`.

### Calling backend routes directly from renderer fetch

**What happens:** Renderer code constructs `fetch('http://127.0.0.1:13210/...')` or calls Runtime Host directly.
**Why it's wrong:** Direct fetch bypasses `hostapi:fetch` timeout/abort behavior, token injection, envelope decoding, telemetry, and IPC security boundaries in `src/lib/host-api.ts` and `electron/main/ipc/hostapi-proxy-ipc.ts`.
**Do this instead:** Add a wrapper in `src/lib/*` or `src/services/*` that calls `hostApiFetch` from `src/lib/host-api.ts`.

### Expanding preload IPC without contract updates

**What happens:** Renderer code invokes a new IPC channel not listed in `electron/preload/ipc-contract.ts`.
**Why it's wrong:** `electron/preload/index.ts` rejects non-retained channels and throws `Invalid IPC channel`, so runtime behavior fails under context isolation.
**Do this instead:** Prefer Host API routes for backend work. If the action is genuinely main-only infrastructure, add the channel to the appropriate retained group in `electron/preload/ipc-contract.ts` and register the handler in `electron/main/ipc-handlers.ts` or a submodule under `electron/main/ipc/*`.

### Putting renderer/UI imports into Runtime Host or plugin core

**What happens:** `runtime-host/*` or `packages/openclaw-security-plugin/src/core/*` imports from `src/components`, `src/stores`, or Electron route modules.
**Why it's wrong:** Runtime Host runs as a Node child process and plugin core should be framework-independent; `packages/openclaw-security-plugin/MODULE_BOUNDARIES.md` explicitly forbids core-to-adapter/UI coupling.
**Do this instead:** Share only serializable contracts under `runtime-host/shared/*`, plugin `domain`/`core` types, or renderer-local adapters in `src/lib/*`.

### Creating large monolithic renderer stores

**What happens:** Complex store actions are implemented inline in a single `src/stores/*.ts` file.
**Why it's wrong:** Existing complex domains such as chat keep `src/stores/chat/store.ts` thin and move execution logic to focused helper modules; inline monoliths make event and async state changes hard to test and reason about.
**Do this instead:** For large domains, create a subdirectory under `src/stores/<domain>/` with `types.ts`, action helpers, selectors, and a small `store.ts` entry similar to `src/stores/chat/*`.

## Error Handling

**Strategy:** Normalize errors at process/transport boundaries and return structured success/error envelopes for Host API and Runtime Host dispatch.

**Patterns:**
- Renderer IPC calls catch and normalize to `AppError` via `normalizeAppError` in `src/lib/api-client.ts` and `src/lib/host-api.ts`.
- Host API catches unexpected handler errors and returns `500` JSON with `success: false` in `electron/api/server.ts`.
- Runtime route registry catches route handler exceptions and returns `{ success: false, error: String(error) }` with status `500` in `runtime-host/composition/route-registry.ts`.
- Runtime Host main process logs startup failure and exits with code `1` in `runtime-host/main.ts`.
- Gateway manager logs startup/reconnect/reload failures, updates lifecycle state, and schedules reconnects in `electron/gateway/manager.ts`.
- Plugin runtime handlers wrap Gateway responses in plugin-specific error envelopes, for example `withGatewayGuard` in `packages/openclaw-browser-relay-plugin/src/application/browser-relay-runtime.ts`.

## Cross-Cutting Concerns

**Logging:** Electron main/gateway/runtime-host code uses logger utilities such as `electron/utils/logger.ts`, `electron/utils/trace-logger.ts`, and Runtime Host logger ports; renderer request logging is opt-in/dev in `src/lib/api-client.ts` and telemetry is emitted through `src/lib/telemetry.ts`.

**Validation:** Host API validates auth and JSON content type in `electron/api/server.ts`; Runtime Host route utilities and application services validate payloads; local plugins include schema/domain validation such as `packages/openclaw-task-manager-plugin/src/schemas/*` and security policy/core checks in `packages/openclaw-security-plugin/src/core/*`.

**Authentication:** Host API uses an in-memory random bearer token from `electron/api/server.ts`; provider OAuth flows that require desktop/browser/device capabilities are retained in main and exposed to Runtime Host through shell actions in `electron/main/runtime-host-manager.ts`; license gating is checked through Runtime Host license routes from `src/App.tsx`.

**Routing:** Renderer uses `HashRouter` in `src/main.tsx`; app pages are lazy-loaded via `src/lib/route-preload.ts`; Host API routes are split by main-owned allowlist vs Runtime Host business proxy; Runtime Host route modules use declarative `RuntimeRouteDefinition` arrays.

**Packaging resources:** `resources/*` contains icons, skills, connector guides, tool/extension data, and screenshots; scripts under `scripts/*` bundle OpenClaw, local plugins, preinstalled skills, runtime host process, uv/node binaries, and installer assets.

---

*Architecture analysis: 2026/05/21*
