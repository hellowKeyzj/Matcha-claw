# 2026-03-14 Agent Platform Cutover Checklist（A+B+C）

## 目标

- 完成 Trait 驱动分层落地：`core/contracts -> core/application -> adapters -> host-shell`。
- Electron 主进程切换为“宿主壳层”，平台业务编排统一由 `platform-composition-root` + application service 承担。
- 完成 A/B/C 切流并保留可回滚路径。

## 阶段 A：双写验证（已完成）

- [x] 新增 `electron/main/platform-composition-root.ts`。
- [x] 新增 `electron/main/platform-ipc-facade.ts`。
- [x] IPC 可在旧链路同时双写到 application service。
- [x] `tests/unit/platform-integration/ipc-dual-write.test.ts` 通过。

## 阶段 B：主链路切换（已完成）

- [x] 平台主调用面切换到 `core/application`。
- [x] `gateway:status/health` 已接入 `platformFacade.runtimeHealth`。
- [x] 工具安装/调和/运行（`platform:*`）统一进入 facade -> application。
- [x] `tests/integration/platform-runtime-execute.integration.test.ts` 通过。
- [x] `tests/integration/platform-tool-callback.integration.test.ts` 通过。

## 阶段 C：冗余剥离（本轮完成）

- [x] 从 `electron/main/ipc-handlers.ts` 迁出平台业务分支到 `electron/adapters/platform/ipc/*`。
- [x] 新增并接入：
  - [x] `skill-config-ipc.ts`
  - [x] `cron-ipc.ts`
  - [x] `gateway-ipc.ts`
  - [x] `openclaw-ipc.ts`
  - [x] `provider-ipc.ts`
- [x] 主进程 `ipc-handlers.ts` 收敛为注册与宿主编排入口，不再承载上述大段业务实现。

## 门禁与验证

- [x] `pnpm run check:trait-boundary`
- [x] `pnpm run typecheck`
- [x] `pnpm run test:contract`
- [x] `pnpm test`
- [x] `pnpm run lint`（无 error，保留 1 条既有 warning）

## 回滚策略

1. 以提交粒度回滚：
- A（双写引入）/B（主链路切换）/C（冗余剥离）均为独立提交，可单独回退。

2. 运行时回滚：
- 异常时可临时回退到 A 阶段的双写保守路径。

3. 数据一致性回滚：
- 三账本调和异常时，仅回滚 platform adapter 与 reconciler，不影响宿主壳层基本运行。
