# matcha-agent app-server architecture

Goal: expose `matcha-agent` as a production app-server. It is not an ACP shim, not a daemon shortcut, and not a second agent runtime. It is the protocol/process boundary around the existing Claude Code-style `QueryEngine` runtime.

## Topology

```text
Chat / IDE / product UI
  ↓ hostApiFetch / host:event
runtime-host MatchaAgentRuntimeAdapter
  ↓ WS + JSON-RPC 2.0
matcha-agent app-server main process
  ├─ protocol gateway
  ├─ ClientHub + backpressure
  ├─ SessionRegistry
  ├─ RunCoordinator
  ├─ ApprovalBroker
  ├─ EventStore / SnapshotStore / BlobStore / SessionIndex
  │    app-server protocol/runtime events, projections, blobs, metadata
  └─ WorkerSupervisor
       ↓ stdio NDJSON worker protocol
session worker process
       ↓
QueryEngine.submitMessage()
       ↓
query.ts / tools / MCP / transcript JSONL
     matcha-agent conversation content and recovery truth
```

## Non-goals

- Do not move `QueryEngine` into runtime-host.
- Do not expose worker IPC to runtime-host or UI.
- Do not make ACP the core contract. ACP can be reference/compat only.
- Do not persist provider secrets, raw auth headers, or credential file contents in events/snapshots.
- Do not create a second tool/MCP/runtime abstraction when existing matcha-agent modules can be reused.

## Ownership

| Concept | Owner | Notes |
|---|---|---|
| Logical session | main process | Product identity; stable across reload/crash/restart. |
| Worker process | `WorkerSupervisor` | Replaceable executor resource. |
| Prompt run | `RunCoordinator` | `runId` owns one prompt execution. |
| Approval | `ApprovalBroker` | Pending registry, not FIFO queue. |
| Session content / recovery | matcha-agent transcript JSONL | Conversation content and recovery truth; owned by existing `QueryEngine`/transcript pipeline. |
| App-server runtime events | `EventStore` | Append-only protocol/runtime event log ordered by `seq`; replay/projection source for app-server clients, not the agent transcript. |
| Current view | `SnapshotStore` | Rebuildable app-server projection from EventStore. |
| UI message identity | projection layer | `messageId`; never substitute for `runId`. |
| Raw SDK payload | `sdk.message` envelope | `SDKMessage` is payload, not transport contract. |

## Runtime boundaries

- Main process owns app-server protocol, app-server session metadata, app-server event replay, snapshots/projections, approvals, client backpressure, worker lifecycle, and run queue. It does not run or replace the agent runtime.
- Worker process owns one active `QueryEngine` session, tool execution, MCP connections, permission bridge, and the existing transcript/recovery pipeline.
- matcha-agent JSONL transcript remains the conversation-content and recovery truth.
- `EventStore` is an app-server protocol/runtime event log for replay and projection, not a second transcript.
- `QueryEngine` does not know WebSocket/runtime-host.
- runtime-host does not know worker IPC and must not read transcript JSONL directly.
- Chat does not depend on Claude Code SDK internals.

## Process model

```text
logical app-server session
  ├─ metadata: sessionId / cwd / model / permissionMode / lastSeq
  ├─ app-server replay log: events.jsonl
  ├─ rebuildable app-server projection: snapshot.json
  ├─ matcha-agent content/recovery truth: transcript JSONL owned by QueryEngine pipeline
  └─ active executor: worker pid, optional and replaceable
```

Rules:

- One active logical session maps to at most one worker process.
- Worker can be absent for unloaded/closed/queued-only states.
- Worker restart must not change `sessionId` or app-server event history.
- App-server `events.jsonl` is protocol/runtime replay history. It is not the matcha-agent conversation transcript.
- Session content recovery uses the existing matcha-agent transcript JSONL/recovery path.
- `setModel` / `setMode` updates app-server session metadata and restarts warm worker so next prompt initializes with new settings; active runs reject settings changes.
- Worker crash interrupts active worker-owned runs and cancels pending approvals owned by that worker.
- App-server restart does not persist raw queued prompt text. Recovered nonterminal runs become `run.interrupted(serverShutdown)` and recovered pending approvals become cancelled.

## Protocol surface

Transport:

- `GET /health`
- `GET /version`
- `GET /ws`
- WebSocket text frames = JSON-RPC 2.0

Methods:

- `initialize`
- `session.create`
- `session.load`
- `session.list`
- `session.close`
- `session.prompt`
- `session.cancel`
- `session.snapshot`
- `session.setModel`
- `session.setMode`
- `events.replay`
- `events.subscribe`
- `approval.respond`
- `models.list`
- `session.transcript`

Event envelope:

```ts
type AppServerEventEnvelope = {
  eventId: string
  sessionId: string
  seq: number
  runId?: string
  workerId?: string
  createdAt: string
  event: AppServerEvent
}
```

Event emission rule:

```text
state transition
  ↓
EventStore.append()
  ↓
SessionRegistry / SessionIndex metadata update
  ↓
SnapshotStore projection update
  ↓
ClientHub.broadcast() enqueue
```

For one session, the complete pipeline is serialized: the next `seq` must not enter it until the preceding event has completed every stage (including an explicitly recorded projection failure). Pipelines for different sessions may run in parallel. Append precedes broadcast. `ClientHub.broadcast()` completes when the envelope is enqueued in each applicable per-client transport queue; it does not wait for socket writes. Slow clients are closed rather than blocking worker drain or event persistence. `events.subscribe(..., afterSeq)` treats `afterSeq` as the client-provided replay lower bound at subscription time, never as a server-side live-delivery cursor. After a successful append, a projection failure must be explicitly recorded but must not block later projection stages or live delivery: EventStore remains the durable truth, and SnapshotStore can be rebuilt from it. This ordering governs app-server events only; it does not redefine matcha-agent transcript persistence.

## Session lifecycle

### Create / load

```text
session.create
  ↓
SessionRegistry + SessionIndex
  ↓
session.created event
  ↓
snapshot projection

session.load
  ├─ app-server runtime session: recover EventStore/Snapshot state, then optional session.loaded event
  └─ transcript-only history: return read-only summary from matcha-agent history read model
```

Transcript-only history is not written to `SessionIndex` by `session.list`, `session.load`, `session.transcript`, or `session.snapshot`. It enters app-server runtime state only when a method needs app-server-owned state, such as `session.prompt` or settings mutation.

### Prompt

```text
session.prompt
  ↓
RunCoordinator.enqueue(runId)
  ↓
run.queued event
  ↓
WorkerSupervisor.ensureWorker(session metadata)
  ↓ worker.initialize
  ↓ session.prompt
  ↓ worker event stream
  ↓ run.completed / run.failed / run.cancelled
  ↓ drain next queued run
```

### Cancel

```text
session.cancel
  ├─ queued run: RunCoordinator.cancel → run.cancelled event, no worker required
  └─ running/waiting run: approval cancel + session.cancel command to worker
```

A queued cancellation must become terminal even if no worker exists. Worker-owned cancellation is settled by worker event stream.

### Close

```text
session.close
  ↓
cancel pending approvals/runs
  ↓
shutdown worker
  ↓
session.closed event
  ↓
remove SessionIndex + registry entry
```

`session.closed` must not resurrect the session in registry/index.

### Crash / heartbeat

```text
worker.ready / worker.heartbeat
  ↓
WorkerSupervisor heartbeat window refresh
  ↓
registry workerState refresh only
```

Heartbeat is lifecycle signal, not durable chat history. It should not spam EventLog. Timeout converts active worker-owned runs to `run.interrupted` and marks worker crashed.

## Worker IPC

stdout = structured NDJSON frames. stderr = logs only.

Commands:

- `worker.initialize`
- `session.prompt`
- `session.cancel`
- `approval.response`
- `session.flush`
- `worker.shutdown`

Notifications:

- `worker.ready`
- `worker.heartbeat`
- `event`
- `approval.request`
- `run.completed`
- `run.failed`
- `worker.fatal`

IPC rules:

- Each command has request id and response frame.
- Worker stdout parser must flush partial frame on exit.
- Main process owns timeout classification and pending request cleanup.
- Worker stderr is diagnostic tail only; it is not protocol.
- Worker-generated approval id is preserved end-to-end.
- Frames that carry worker identity must match the supervisor-assigned worker id; mismatch is a protocol error and kills the worker.
- Worker stdout writes are serialized and respect stream backpressure.
- Packaged app-server spawns workers from the current executable and entrypoint by default.
- Dev app-server launch injects the same Bun define/feature args into worker args after the app-server worker separator; runtime-host and product UI must not know worker launch internals.

## Worker session bridge

Worker initialization reuses matcha-agent runtime modules:

```text
worker.initialize payload
  ↓
createWorkerSession()
  ├─ AppStateStore default state
  ├─ getCommands(cwd)
  ├─ getAgentDefinitionsWithOverrides(cwd)
  ├─ getClaudeCodeMcpConfigs(cwd)
  ├─ getMcpToolsCommandsAndResources()
  ├─ assembleToolPool(permissionContext, mcpTools)
  └─ QueryEngine({ cwd, tools, commands, mcpClients, agents, canUseTool })
```

`QueryEngine` remains the execution core and keeps existing transcript/recovery semantics. The app-server worker only adapts prompt input, SDK messages, tool/approval events, and terminal run status into the app-server protocol. It must not introduce a second agent runtime, second tool/MCP abstraction, or second conversation transcript.

## Approval flow

```text
worker canUseTool ask
  ↓ approval.request
main ApprovalBroker pending map
  ↓ approval.requested event
client approval.respond
  ↓ approval.response command
worker resolves canUseTool
  ↓ approval.resolved event
```

Rules:

- Approval is keyed by `approvalId`.
- Approval belongs to one `sessionId`, `runId`, `workerId`, and tool call.
- Duplicate response returns existing terminal decision.
- Approval response validates first, sends worker command, then commits broker state and appends `approval.resolved`; failed worker send leaves the approval pending.
- Late approval requests for inactive runs are rejected and recorded as worker protocol errors, not projected as pending approvals.
- Cancelling run/worker resolves pending approvals as cancelled.

## Persistence

- `sessions/index.json`: app-server session records for sessions with app-server runtime state.
- `sessions/<sessionId>/events.jsonl`: append-only app-server protocol/runtime event log for replay and projection.
- `sessions/<sessionId>/snapshot.json`: latest rebuildable app-server projection.
- `sessions/<sessionId>/blobs/*`: large app-server payload storage.
- Existing matcha-agent transcript JSONL: conversation content and recovery truth, owned by worker-side `QueryEngine`/transcript pipeline.

Store rules:

- Event append is serialized per session and allocates `seq` from a per-session latest-seq cache after first read.
- Session index mutations are serialized in-process.
- Snapshot writes are serialized per session and must not overwrite newer versions with older versions.
- Corrupt/missing snapshot is tolerated; rebuild app-server projection from EventStore.
- EventStore/Snapshot are public app-server runtime artifacts and must be redacted before persistence when payloads may contain secrets.
- EventStore replay restores app-server protocol/runtime state; matcha-agent session content recovery comes from the existing transcript JSONL path.

## Streaming and backpressure

```text
worker event frame
  ↓
main envelope append
  ↓
ClientHub queue per client
  ↓
JSON-RPC notification: { method: "event", params: envelope }
```

Performance rules:

- Main process never runs model/tool execution.
- WebSocket sends are queued per client to preserve order.
- Slow clients are closed on message-count or byte-budget overflow instead of blocking EventStore/worker drain.
- Heartbeats update worker liveness without durable EventLog spam.
- Snapshot is app-server projection cache; app-server projection correctness comes from EventStore.
- Conversation-content correctness and recovery come from the existing matcha-agent transcript JSONL, not from app-server event replay.
- Heavy model/model-option modules are dynamically imported from `models.list`, not top-level loaded by server bootstrap.

## Security defaults

- Bind `127.0.0.1` by default.
- Remote deployment requires explicit auth token and TLS at deployment boundary.
- `/ws` auth supports Bearer header or `rcs.auth.<base64url-token>` WebSocket subprotocol.
- Plaintext `token.*` / `bearer.*` WebSocket subprotocols are not accepted.
- Browser `Origin` must be loopback when server binds loopback.
- Workspace paths use realpath/normalize; no string `includes` checks.
- Deny sensitive paths before allow: `.git`, `.claude`, settings, MCP config, shell profiles, credential files.
- Worker env must be allowlisted/private-projected.
- Debug endpoints default closed.

## runtime-host adapter seam

runtime-host should treat matcha-agent as a peer capability exposed through the app-server protocol boundary. The app-server is not a second agent runtime; it forwards to the existing worker-side `QueryEngine` runtime:

```text
runtime-host MatchaAgentRuntimeAdapter
  ├─ open / keep WS connection
  ├─ JSON-RPC request/response
  ├─ event replay after last seq
  ├─ event subscription for live projection
  ├─ approval.respond forwarding
  └─ snapshot fallback for hydration
```

Adapter responsibilities:

- Map runtime-host session commands to app-server JSON-RPC methods.
- Use `session.transcript` for historical conversation hydration; do not read transcript JSONL directly.
- Use `events.replay`, `events.subscribe`, and `session.snapshot` for app-server runtime synchronization.
- Persist last seen `seq` per logical session; `seq` is app-server event order, not transcript offset.
- Project app-server events into runtime-host canonical session view.
- Keep runtime-host facts independent from worker PID/process details.

## Implementation map

- `src/app-server/protocol/*`: JSON-RPC, event, worker contracts.
- `src/app-server/transport/*`: WebSocket gateway and client backpressure.
- `src/app-server/stores/*`: EventLog, Snapshot, Blob, SessionIndex.
- `src/app-server/sessions/*`: SessionRegistry and run queue.
- `src/app-server/approvals/*`: ApprovalBroker.
- `src/app-server/workers/*`: worker process wrapper, supervisor, worker entry, QueryEngine bridge.
- `src/app-server/main.ts`: composition root.
- `src/entrypoints/cli.tsx`: `app-server` and `--matcha-agent-worker-entry` fast paths.

## Acceptance checklist

- Main process does not run `QueryEngine`.
- Worker process emits structured NDJSON on stdout only.
- app-server does not become a second agent runtime.
- JSONL transcript/recovery remains the matcha-agent session content truth.
- EventStore is the app-server protocol/runtime replay source; Snapshot is rebuildable from it.
- runtime-host uses app-server protocol and never reads transcript JSONL directly.
- `seq` orders app-server session events.
- `runId` owns prompt execution; `messageId` owns projected UI message identity.
- `session.close` cannot resurrect closed session through later event metadata updates.
- queued `session.cancel` becomes terminal without worker.
- warm worker restarts after model/mode changes when no run is active.
- active run blocks model/mode changes.
- app-server restart reconciles nonterminal runs/approvals without replaying raw prompts.
- pending approvals resolve on run cancel or worker crash.
- client backpressure cannot block worker/event persistence.
- app-server contract remains WS + JSON-RPC, not ACP.
