# Verification baseline

## Existing evidence (not execution results)

This document records static inspection of existing test/document sources. No build or test was run while preparing the baseline.

| Evidence | What it currently proves | Limitation |
| --- | --- | --- |
| [runtime-host-delivery/control.ts](../../electron/main/runtime-host-delivery/control.ts) + Rust private control tests | DirectRuntimeHost private control command vocabulary and frame boundary | does not prove every product route E2E |
| [module_boundary_contract.rs](../../runtime-host/host/tests/module_boundary_contract.rs) | Host final-form removes legacy compatibility module and top-level transport production code | static boundary contract only |
| [module_platform_contract.rs](../../runtime-host/host/tests/module_platform_contract.rs) | module registry/loopback/private-control platform boundary | static contract only |
| owner/module focused tests | individual signed loopback route behavior | not a full unchanged-client/package proof |

## Required compatibility assertion matrix

### Transport

| Case | Required assertion |
| --- | --- |
| private control ready | Electron observes `ready` after bootstrap frame; timeout is bounded. |
| `host.health` | returns Host-private safe health projection; no public secret/native raw state. |
| `host.runtime.snapshot` | returns Host-private safe runtime snapshot; no PID/token/path/raw peer DTO leakage. |
| unknown private control command | rejected as invalid input. |
| product route authorization | signed decision binds endpoint/scope/capability/subject/input and rejects mismatch/expiry/replay. |
| product route response | module adapter returns public DTO projection directly; no `/dispatch` outer envelope. |
| stream/upgrade route | SSE/WS travels as loopback `RouteOutcome::Stream` / `Upgrade`, not JSON adapter fallback. |
| unknown loopback route | JSON 404 from Host HTTP substrate. |
| network/timeout child unavailable | Electron maps through the owning transport's existing public error projection. |

### Parent callbacks

For shell actions, gateway events and owner-specific typed operation events, recorder must capture:

```text
method, pathname, content-type, dispatch token,
version, action/eventName, payload, timeout,
HTTP response, child-side mapping, call count
```

owner-specific operation recorder 不再是产品门禁；每个异步 owner 需要自己的 typed operation event/query recovery proof。

### Renderer operations

For every migration owner, trace both TS and Rust through the same unchanged Renderer wrapper:

```text
request path/method/body
→ Electron route owner / signed loopback transport or private control command
→ Rust module route outcome / private command outcome
→ parent callbacks/events when applicable
→ Renderer success/error/terminal state
```

Normalize dynamic values:

```text
pid, port, token, requestId, runId, ownerOperationId, trace ID, timestamps
```

Compare shape and semantics, not literal dynamic values.

## Minimum test commands after edits

Run only after code changes / in an environment allowed to create test temp directories:

```powershell
node scripts/build-runtime-host-native.mjs --platform win32 --arch x64

cargo check --manifest-path runtime-host/Cargo.toml -p runtime-host
cargo test --manifest-path runtime-host/Cargo.toml -p runtime-host --test module_boundary_contract --test module_platform_contract
pnpm run check:runtime-host-crate-dag

pnpm exec vitest run tests/unit/runtime-host-delivery-control.test.ts
pnpm exec vitest run tests/contract/runtime-host-api-chain.contract.test.ts
```

Then run the smallest affected Renderer/store tests for the migrated operation owner.

## Fixture policy

- Fixtures must be named by capability/route and outcome.
- Do not snapshot secrets, private tokens, random paths or raw user data.
- Do not make generic queue internals fixtures for Rust architecture.
- Capture only externally observable owner-operation/event projection fields needed by current consumers.
- A test fixture using a removed legacy endpoint is historical evidence only, not permission to recreate that endpoint in Rust.

## Baseline completion criterion

The document set is complete as a **static contract map**. A Rust cutover block is only verified when:

1. its relevant route/capability/event rows have executable traces;
2. unresolved items affecting that block are decided;
3. unchanged Electron/Renderer calls work against Rust;
4. the corresponding TS owner is removed rather than retained as fallback.
