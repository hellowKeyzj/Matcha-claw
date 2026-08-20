# Async completion projection (no generic RuntimeJob architecture)

## Migration decision

```text
Delete internally:
  Host-wide RuntimeJobQueue
  RuntimeJobRegistry
  critical/default/low global priority queues
  generic retry/retention/result store as a runtime-host domain

Keep at compatibility boundary:
  RuntimeJobSnapshot-shaped result
  runtimeHost.jobGet
  runtime-job:done
  runtime-job:progress
```

The retained elements exist because Renderer currently depends on them; they do **not** define Rust’s internal architecture.

## Renderer-visible contract

Renderer declares a job projection with:

```text
id, type, status,
queuedAt, startedAt?, finishedAt?,
attempts, maxAttempts,
progress?, result?, error?
```

`status` is one of `queued | running | succeeded | failed`. Source: [host-api.ts](../../src/lib/host-api.ts#L55-L80)。

The compatibility lookup is capability execution:

```json
{
  "id": "runtime.host",
  "operationId": "runtimeHost.jobGet",
  "scope": { "kind": "runtime-instance", "endpoint": {} },
  "target": { "kind": "runtime-job", "jobId": "..." },
  "input": { "jobId": "..." }
}
```

Source: [host-api.ts](../../src/lib/host-api.ts#L697-L705)。

## Renderer waiting behavior

`waitForRuntimeJobResult()`:

1. subscribes to `runtime-job:done`;
2. polls `runtimeHost.jobGet` immediately and then with exponential interval;
3. resolves `succeeded`, rejects `failed`;
4. treats missing job as error only after a 2s grace;
5. defaults to 120s total timeout, 500ms initial and 5s maximum polling interval.

This means `runtime-job:done` is a low-latency hint; queryable terminal state is the recovery path. Source: [host-api.ts](../../src/lib/host-api.ts#L707-L796)。

Known Renderer consumers include cron, skills, plugins, provider/channel/settings/security mutations, diagnostics, session hydration, connector refresh and Toolchain install. The old Setup path is retained as `hostUvInstallAll(endpoint): Promise<RuntimeJobSubmission>`: it submits through Electron `/api/capabilities/execute`, then waits through `runtimeHost.jobGet` and `runtime-job:done/progress`; `GET /api/toolchain/uv/check` remains the public readiness query. Rust OpenClaw Toolchain owner-local operation/projection is the fact source, while private control commands remain internal to Electron Main/Host. `runtimeHost.jobGet` currently validates that target `jobId` and input `jobId` match before entering the owner path. Terminal event projection, unchanged-client, native fault/integration and Windows/package proof are still pending; keep this block `IMPLEMENTED`, not `VERIFIED`/`CUTOVER`. See [host-api.ts](../../src/lib/host-api.ts)、[Setup/index.tsx](../../src/pages/Setup/index.tsx)、[capabilities.ts](../../electron/api/routes/capabilities.ts)、[dispatch.rs](../../runtime-host/host/src/control/dispatch.rs)。

## Existing TS layers are not one model

| Layer | Shape / purpose |
| --- | --- |
| TS `RuntimeJobQueue` | internal queue record includes `queue`, scheduling/retry/retention detail. |
| Electron legacy helper | compressed `{ id, type, status, result?, error? }`. |
| Renderer projection | accepts timestamp/attempt/progress fields but not queue name. |
| Background task projection | further maps generic status to legacy background task status. |

Do not mechanically translate any historical TS job layer into Rust’s canonical state. Current Rust compatibility evidence is [job_compatibility.rs](../../runtime-host/host/src/projection/job_compatibility.rs)、[dispatch.rs](../../runtime-host/host/src/control/dispatch.rs) and Electron [capabilities.ts](../../electron/api/routes/capabilities.ts); deleted TS `RuntimeJobQueue` / registry / background-manager files are forensic sources only, not active owners.

## Rust final-form rule

For every asynchronous product operation, assign a concrete owner:

```text
concrete owner’s operation/task/run
  → owner-local state or peer-runtime native state
  → compatibility projection keyed by existing job ID
  → runtimeHost.jobGet and done/progress at the transport boundary
```

No single Rust `JobQueue` owns unrelated cron, skill, plugin, provider, gateway, session or security facts.

The compatibility projection must only expose what the existing client needs. It must not invent queue priority, generic retry policy, cancellation semantics or a second persistent source of truth.

## Current delivery constraints

- child forwards done/progress to parent best-effort;
- event failure is swallowed in current composition;
- Electron buses are non-durable;
- polling is the client’s compensation path.

Therefore a concrete Rust owner must preserve a queryable enough terminal projection for current Renderer behavior, but it does not need to claim reliable event delivery the TS system never had.

## Cutover checklist per operation

- identify operation’s true state owner;
- prove its completion/failure oracle;
- preserve existing submission result shape;
- provide lookup for the old ID while Renderer depends on it;
- emit `done`/`progress` only with established payload shape;
- prove the same terminal behavior through existing Renderer wrapper;
- delete the old TS producer when the Rust owner is active.
