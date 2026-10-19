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
- **App-server**: Rust `app-server/src/{gateway,session,cli,interaction}/*`, `app-server/src/events.rs`
- **Host adapter**: `runtime-host/integrations/matcha-agent/src/{client,session}/*`

## App-server note

产品/runtime-host 不在进程内绑定 `QueryEngine`：Rust `matcha-app-server` 通过 `/ws` 提供 JSON-RPC 2.0，管理会话、run、交互与持久化事件；执行通过子进程 CLI 的 stdio stream-json/control protocol。CLI 仍负责 `QueryEngine`、`query()`、provider 和工具执行。 [VERIFY: matcha-agent/app-server/src/gateway/mod.rs:98-116] [VERIFY: matcha-agent/app-server/src/gateway/dispatch.rs:154-167] [VERIFY: matcha-agent/app-server/src/cli/mod.rs:92-131]

```text
runtime-host adapter
  ↓ WebSocket /ws + JSON-RPC 2.0
app-server/src/gateway/* (Rust)
  ↓ session / cli owners
app-server/src/cli/*
  ↓ child process stdio NDJSON (stream-json + control)
src/entrypoints/cli.tsx → src/main.tsx → src/cli/print.ts
  ↓
QueryEngine.ask() → query() → providers / tools
```

历史读取使用 `sessions.get({sessionId, history:true, offset, limit})`：Rust app-server 直接读取 Agent runtime 下的原生 transcript JSONL，恢复会话父链并返回原始消息页 `{messages, total, nextOffset, managedInputMessageIds}`；输入身份集合由原生持久证据查询，runtime-host 在自身适配边界按 SDK 规则归一化与产品投影，不再走旧 TS app-server 的 snapshot/hydration 路径。 [VERIFY: matcha-agent/app-server/src/session/dispatch.rs:353-375] [VERIFY: matcha-agent/app-server/src/session/history.rs:28-81] [VERIFY: runtime-host/integrations/matcha-agent/src/session/history.rs:20-71] [VERIFY: runtime-host/integrations/matcha-agent/src/session/normalization.rs:121-225]

事件与历史页分离：app-server 将 `native.message` / `native.result` 等会话事实写入 SQLite，事件信封包含 `sessionId / seq / runId / kind / atMs / payload`；`events.replay` 与 `events.subscribe` 按 `afterSeq` 读取，订阅先补持久化事件再继续通知。 [VERIFY: matcha-agent/app-server/src/session/observation.rs:143-214] [VERIFY: matcha-agent/app-server/src/events.rs:14-23,50-77] [VERIFY: matcha-agent/app-server/src/gateway/subscriptions.rs:43-115]

TaskList/Todo 读写分离：`tasks.list/get(kind:"taskList")` / `todos.get` 始终读原生事项文件和 transcript 主链，不启动 CLI、不取 Provider 凭据；TaskList 遵循原生锁/schema/文件时间，Todo 按 CLI 恢复规则只表示已落盘状态，内部读取回执 `instanceId:null`。写入仍归 CLI 原生 owner，不改变 mutation receipt/unknown 或 product DTO。CLI 在最终 UUID 下原子保存 `runtime/session-env/<UUID>/task-context.json` 的精确 `{listId:<sanitized string>,todoV2:<bool>}` binding，不镜像任务；缺文件时按既有非秘密 env/`--team-name` headless 规则解析。Session 的 `native_files` / `persisted_history` 只提供身份、受管路径和原生主链，不接管 TaskList 业务。 [VERIFY: matcha-agent/app-server/src/task.rs] [VERIFY: matcha-agent/app-server/src/task/files.rs] [VERIFY: matcha-agent/app-server/src/task/todos.rs] [VERIFY: matcha-agent/app-server/src/session/mod.rs] [VERIFY: matcha-agent/src/utils/tasks.ts] [VERIFY: matcha-agent/src/cli/print.ts] [VERIFY: runtime-host/integrations/matcha-agent/src/tasks/mod.rs]

Session executor 还负责实例空闲资源回收：连续空闲 5 分钟后才发原生 `prepare_to_sleep`；CLI 原子封输入，busy/resident、非持久化与仅内存不可恢复状态保持存活，可恢复时落盘/flush 并复查后返回 ready。Session 独立 sleep handoff 做 close、consumer join、transcript 与真实 graceful exit 确认，不走取消队列的 `close_execution`；逻辑 Session 保持 open，新消息照常进入 durable 队列并按同 UUID resume 新 instance，未知结果不重发。这里是实现机制，不是本轮实机验收结论。 [VERIFY: matcha-agent/app-server/src/session/idle.rs] [VERIFY: matcha-agent/app-server/src/session/execution.rs] [VERIFY: matcha-agent/app-server/src/cli/idle.rs] [VERIFY: matcha-agent/app-server/src/session/instance.rs] [VERIFY: matcha-agent/src/cli/print.ts] [VERIFY: matcha-agent/src/cli/structuredIO.ts] [VERIFY: matcha-agent/src/entrypoints/sdk/controlSchemas.ts]

Detailed design: [matcha-agent-app-server-architecture.md](matcha-agent-app-server-architecture.md).
