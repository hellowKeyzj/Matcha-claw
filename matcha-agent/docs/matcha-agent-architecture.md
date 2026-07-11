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

Product/runtime-host integration should not bind directly to `QueryEngine` in-process. Use the app-server boundary instead:

```text
runtime-host adapter
  ↓ WS + JSON-RPC
src/app-server/main.ts
  ↓ worker stdio NDJSON
src/app-server/workers/workerEntry.ts
  ↓
QueryEngine.submitMessage()
```

Detailed design: [matcha-agent-app-server-architecture.md](matcha-agent-app-server-architecture.md).
