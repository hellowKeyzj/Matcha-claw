# OpenClaw Plugin Development Guide

## 1. Architecture Overview: "Microservice in Sandbox"

An OpenClaw plugin is not just a script; it is a **Microservice** running within the Gateway process. It has its own lifecycle, storage, and API.

**Core Capabilities:**
1.  **Sense (Hooks)**: Intercept Agent execution flow (Tool Calls, Messaging).
2.  **Interact (RPC)**: Expose APIs for Frontend/Main Process consumption.
3.  **Persist (Storage)**: Isolated file system for databases and configs.
4.  **Notify (Events)**: Broadcast real-time updates to the UI.

## 2. The `context` Object (The Handle)

Every plugin receives a `context` object upon initialization. This is the only bridge to the OpenClaw host.

**Key Properties:**
*   `context.storagePath`: **(string)** Absolute path to a dedicated directory for this plugin.
    *   *Usage*: Store SQLite DBs, JSON configs, log files here. Do NOT touch the root project files.
*   `context.logger`: **(Logger)** Integrated logger.
    *   *Usage*: `context.logger.info('...')`. Logs will appear in the OpenClaw diagnostic view.
*   `context.config`: **(object)** Parsed configuration from `openclaw.json` -> `plugins.entries.{pluginName}`.
*   `context.hooks`: **(HookRegistry)** The registry to tap into the Agent loop.
*   `context.rpc`: **(RPCRegistry)** The registry to expose plugin methods.
*   `context.broadcast`: **(Function)** Emit events to the frontend via WebSocket.

## 3. Development Patterns

### A. Hook Pattern (The Interceptor)
Use Hooks to intervene in the Agent's execution.

**Supported Hooks:**
*   `before_tool_call`: Intercept tool execution. Can block or modify args.
*   `after_tool_call`: Inspect results, audit logging.
*   `before_llm_call`: (If supported) Inspect/Modify prompts.

**Implementation Rule:**
*   For potentially async operations (DB writes, Network), always use `tapPromise`.
*   **Blocking**: Throw an error or return a specific object (see Hook types) to stop execution.

```typescript
// Example: Intercept and Block
context.hooks.before_tool_call.tapPromise('MyPlugin', async (toolCall) => {
  if (toolCall.name === 'dangerous_tool') {
    throw new Error('Blocked by Security Policy');
  }
  return toolCall; // Must return the toolCall to proceed
});
```

### B. RPC Pattern (The Service Provider)
Use RPC to allow the Frontend (via Main Process) to query data or trigger actions.

**Implementation Rule:**
*   Methods should be stateless or rely on the plugin's singleton service.
*   Validate input arguments.

```typescript
// Example: Expose a Query API
context.rpc.register('my_plugin.get_stats', async (params) => {
  const stats = await myDbService.getStats(params.timeRange);
  return stats;
});
```

### C. Event Pattern (The Notifier)
Use Events to push real-time updates to the UI without polling.

**Implementation Rule:**
*   Event names should follow the convention: `domain.entity.action` (e.g., `guardian.policy.updated`).
*   Payloads must be JSON-serializable.

```typescript
// Example: Notify UI
context.broadcast('guardian.approval.requested', {
  sessionId: 'xxx',
  toolName: 'write_file',
  message: 'Needs your permission'
});
```

## 4. Data Persistence Strategy

**Single Source of Truth (SSOT):**
*   Config files (`policy.json`) and Databases (`audit.db`) **MUST** reside in `context.storagePath`.
*   **Do not** rely on `AppSettings` in the Main Process unless absolutely necessary. The plugin should own its data.

**Concurrency & Performance:**
*   **DB Writes**: Use async queues or batch writes. Do not block the Hook loop with synchronous DB IO.
*   **Config Reload**: Support hot-reloading via RPC. Do not restart the whole Gateway just to update config.

## 5. Error Handling & Safety

1.  **Isolation**: An error in a plugin Hook should ideally be caught to prevent crashing the entire Agent Loop. Use `try/catch` around critical logic.
2.  **Timeouts**: If a Hook involves network requests, enforce a timeout (e.g., 50ms - 500ms) to prevent stalling the Agent.
3.  **Fallback**: If a plugin fails to load a config, it should fallback to a safe default mode rather than crashing.

## 6. Testing Strategy

*   **Unit Tests**: Test logic (Rules, Normalization) independently of the OpenClaw context.
*   **Integration Tests**: Mock `context` object (hooks, rpc) to verify registration and RPC responses.
*   **E2E Tests**: Verify the loop: `Frontend API -> Main Process -> Plugin RPC -> Plugin Logic`.

## 7. Project Structure Recommendation

```
src/plugins/my-plugin/
├── index.ts              # Entry point: Register Hooks & RPC
├── controller.ts         # Orchestrator: Connects Hooks to Services
├── services/
│   ├── policy.service.ts # Logic for policy management
│   └── audit.service.ts  # Logic for data persistence
├── engine/
│   ├── rules.ts          # Core logic (e.g., Rules Engine)
│   └── types.ts          # TypeScript interfaces
├── storage/              # (Auto-created) DB/Config files live here at runtime
└── AGENTS.md             # This file
```