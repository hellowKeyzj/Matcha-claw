# Owner-local async operation contract

## Final owner/facade model

The public and internal compatibility surfaces are retired. Runtime Host does not expose a generic asynchronous-operation API or maintain a cross-owner queue, registry, priority policy, retry policy, retention store, or result store.

The retained model is owner-local typed operation state. A concrete owner/facade owns admission, progress, terminal outcome and recovery query.

## Final-form rule

```text
needs real business result to continue
  -> command waits for the owner/native fact and returns that fact

submission accepted is enough
  -> command returns accepted + owner-local operationId
  -> owner/facade typed query observes running/completed/failed/unknown
  -> owner/facade typed event is only a best-effort hint
```

Examples:

```text
Session send
  -> wait for OpenClaw/Matcha to return the real runId/queued result
  -> HTTP returns runId
  -> tokens/completion continue through session delta/timeline
```

```text
Toolchain prepare
  -> Renderer lazy hostToolchainPrepare after explicit main-entry
  -> Electron POST /api/toolchain/uv/prepare
  -> Electron toolchainTransport.prepare()
  -> modules/toolchain owner loopback waits for the real uv/Python result
```

```text
Diagnostics collect and other accepted-only operations
  -> return owner-local operationId
  -> concrete owner/facade typed query observes running/completed/failed/unknown
  -> concrete owner/facade typed event is only a best-effort hint
```

## Contract shape

Each async owner defines its own public DTO. Shared generic fields are naming conventions, not a Host-wide operation type:

```text
operationId
status: accepted | running | succeeded | failed | unknown
progress?        // owner-defined
result?          // owner-defined and secret-safe
error?           // owner-defined public error
updatedAt?
```

No owner may expose private auth material, raw native payload, process argv, secret paths or trace-only fields through operation DTOs or events.

## Foundation execution boundary

```text
owner command
  -> OperationHandle<T> / ServiceHandle<T>
  -> owner-defined state and terminal oracle
  -> owner-local typed query/event
```

`foundation::execution` only manages task lifecycle, cancellation and join. It does not own business facts, store results, decide retry policy or provide a recovery projection.

## Cutover checklist per async operation

- identify the concrete owner/facade;
- define the owner-local operation id and typed query/event;
- prove the completion/failure/unknown oracle;
- prove lost event recovery through the query path;
- remove any generic async-operation producer or compatibility lookup for that operation;
- keep Renderer/Electron route ownership unchanged unless the operation block explicitly authorizes and updates that public contract.
