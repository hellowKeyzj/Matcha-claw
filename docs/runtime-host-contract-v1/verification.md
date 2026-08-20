# Verification baseline

## Existing evidence (not execution results)

This document records static inspection of existing test/document sources. No build or test was run while preparing the baseline.

| Evidence | What it currently proves | Limitation |
| --- | --- | --- |
| [runtime-host-transport-v1.contract.test.ts](../../tests/contract/runtime-host-transport-v1.contract.test.ts) | real child startup; root health happy path; v1 version/method rejection; one dispatch success path | does not cover full failure/status matrix or parent callbacks |
| [runtime-host-api-chain.contract.test.ts](../../tests/contract/runtime-host-api-chain.contract.test.ts) | multiple business APIs travel through real child `/dispatch` | harness primarily checks outer `success`, not all envelope/status invariants |
| [runtime-host-process-dispatch-envelope.test.ts](../../tests/unit/runtime-host-process-dispatch-envelope.test.ts) | parser version/route/body-size rules | unit-only, not real process wire trace |
| [runtime-host-process-dispatch-route-handler.test.ts](../../tests/unit/runtime-host-process-dispatch-route-handler.test.ts) | route hit/miss and stats behavior | does not replace end-to-end failure matrix |
| [runtime-host-process-manager.test.ts](../../tests/unit/runtime-host-process-manager.test.ts) | start/restart/stop/crash recovery and selected local routes | fixture includes legacy surface that must be audited |

## Required compatibility assertion matrix

### Transport

| Case | Required assertion |
| --- | --- |
| root health running | HTTP 200; version, `ok`, lifecycle, pid, uptime type/meaning |
| valid dispatch | HTTP status equals outer `status`; version 1; success/data shape |
| bad version | 400 / `BAD_REQUEST` |
| bad method | 400 / `BAD_REQUEST` |
| route without leading slash | 400 / `BAD_REQUEST` |
| malformed JSON / empty / null / array / primitive | explicit classified behavior; currently not fully frozen |
| body size boundary | exact max and max+1; `413 / PAYLOAD_TOO_LARGE` if retained |
| unknown route | 404 / `NOT_FOUND` |
| controlled handler exception | 500 / `INTERNAL_ERROR` |
| invalid child response received by Electron | Electron maps to 502 / `INVALID_TRANSPORT_PAYLOAD` |
| network/timeout child unavailable | Electron maps to 503 / `UPSTREAM_UNAVAILABLE` |

### Parent callbacks

For shell actions, gateway events and runtime-job events, recorder must capture:

```text
method, pathname, content-type, dispatch token,
version, action/eventName, payload, timeout,
HTTP response, child-side mapping, call count
```

The existing API-chain harness has a material blind spot: it does not currently represent the production `/internal/runtime-host/runtime-jobs` endpoint while child forwarding errors can be swallowed. A passing API-chain test alone therefore does not prove job notification compatibility.

### Renderer operations

For every migration owner, trace both TS and Rust through the same unchanged Renderer wrapper:

```text
request path/method/body
→ Electron /dispatch body
→ child status/outer envelope/data
→ parent callbacks/events
→ Renderer success/error/terminal state
```

Normalize dynamic values:

```text
pid, port, token, requestId, runId, jobId, trace ID, timestamps
```

Compare shape and semantics, not literal dynamic values.

## Minimum test commands after edits

Run only after code changes / in an environment allowed to create test temp directories:

```powershell
pnpm run build:runtime-host-process

pnpm exec vitest run tests/contract/runtime-host-transport-v1.contract.test.ts
pnpm exec vitest run tests/contract/runtime-host-api-chain.contract.test.ts

pnpm exec vitest run `
  tests/unit/runtime-host-process-dispatch-envelope.test.ts `
  tests/unit/runtime-host-process-dispatch-route-handler.test.ts `
  tests/unit/runtime-host-client.test.ts `
  tests/unit/runtime-host-internal-routes.test.ts
```

Then run the smallest affected Renderer/store tests for the migrated operation owner.

## Fixture policy

- Fixtures must be named by capability/route and outcome.
- Do not snapshot secrets, private tokens, random paths or raw user data.
- Do not make generic queue internals fixtures for Rust architecture.
- Capture only externally observable job/event projection fields needed by current consumers.
- A test fixture using a removed legacy endpoint is evidence to classify, not permission to recreate that endpoint in Rust.

## Baseline completion criterion

The document set is complete as a **static contract map**. A Rust cutover block is only verified when:

1. its relevant route/capability/event rows have executable traces;
2. unresolved items affecting that block are decided;
3. unchanged Electron/Renderer calls work against Rust;
4. the corresponding TS owner is removed rather than retained as fallback.
