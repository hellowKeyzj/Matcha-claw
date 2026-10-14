# matcha-agent architecture

`matcha-agent` 是 Claude Code 风格 CLI runtime：CLI/Ink UI 只是入口，真正执行核心是 `QueryEngine` + `query()` + tools/MCP/permission pipeline。

## Main flow

```text
User
  ↓
src/entrypoints/cli.tsx
  ↓
src/main.tsx
  ├─ repl / print / auth / plugin / mcp / daemon / acp / server / doctor
  ↓
src/screens/REPL.tsx
src/components/*
  ↓
src/QueryEngine.ts
  ├─ messages
  ├─ transcript
  ├─ compact
  ├─ permissions
  ├─ usage
  └─ file cache
  ↓
src/query.ts
  ↓
src/services/api/*
packages/builtin-tools/*
packages/mcp-client/*
```

## Key modules

- **Entry/bootstrap**: `src/entrypoints/cli.tsx`, `src/main.tsx`, `src/entrypoints/init.ts`
- **Session core**: `src/QueryEngine.ts`, `src/query.ts`, `src/context.ts`
- **Terminal UI**: `src/screens/REPL.tsx`, `src/components/*`, `packages/@ant/ink/*`
- **State**: `src/state/*`, `src/bootstrap/state.ts`
- **Tools**: `src/Tool.ts`, `src/tools.ts`, `packages/builtin-tools/*`
- **API/providers**: `src/services/api/*`, `src/utils/model/providers.ts`
- **MCP**: `packages/mcp-client/*`, MCP command surfaces in `src/main.tsx`
- **ACP**: `src/services/acp/*`, `packages/acp-link/*`
- **Daemon/background**: `src/daemon/*`, bg/job command handlers
- **App-server**: `src/app-server/*`

## App-server note

Product/runtime-host integration should not bind directly to `QueryEngine` in-process. Session effects and history/content reads use the app-server boundary; Rust no longer reads transcript JSONL directly. Pure history reads initialize → `session.transcript(direction, offset, limit)` → hydrate the returned page → cleanup, without snapshot/replay; canonical/live synchronization still uses snapshot (`includeMessages:false`), a transcript page, and native replay. Public Renderer/Electron APIs and model recovery are unchanged. [VERIFY: runtime-host/integrations/matcha-agent/src/session/history.rs:183-232] [VERIFY: runtime-host/integrations/matcha-agent/src/session/hydration/mod.rs:104-130] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/observation.rs:405-484]

```text
runtime-host adapter
  ↓ WS + JSON-RPC
src/app-server/main.ts
  ↓ worker stdio NDJSON
src/app-server/workers/workerEntry.ts
  ↓
QueryEngine.submitMessage()
```

Native history uses one service-lifetime reader: summary load/history/content share bounded metadata/source-span indexes, never full-text caches; path/file fingerprint changes invalidate them, cold reads necessarily scan (O(file bytes)), hot pages point-read, and shutdown clears the indexes. Transcript pages carry a real source span ≤200 within 512 KiB JSON, long text uses a ≤4 KiB preview/stable ref and ≤64 KiB UTF-8 content chunks, and title responses are ≤512 UTF-8 bytes. [VERIFY: matcha-agent/src/utils/sessionTranscriptRead.ts:27-167] [VERIFY: matcha-agent/src/utils/sessionTranscriptRead.ts:169-399] [VERIFY: matcha-agent/src/utils/sessionStoragePortable.ts:473-548] [VERIFY: matcha-agent/src/utils/sessionHistoryReadModel.ts:88-123] [VERIFY: matcha-agent/src/utils/sessionHistoryReadModel.ts:264-282] [VERIFY: matcha-agent/src/app-server/main.ts:1407-1413] [VERIFY: matcha-agent/src/app-server/main.ts:1647-1655]

Detailed design: [matcha-agent-app-server-architecture.md](matcha-agent-app-server-architecture.md).
