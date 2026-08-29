# Process, lifecycle, configuration and WebSocket contract

## Child launch contract

Electron launches Rust `runtime-host` through `DirectRuntimeHost`.

| Item | Current contract |
| --- | --- |
| process | configured Rust executable path |
| stdio | `pipe` |
| bootstrap | one length-prefixed frame on stdin before readiness |
| private control | length-prefixed JSON control frames over stdin/stdout |
| ready signal | private control `ready` message |
| graceful shutdown | Electron ends child stdin; Rust treats EOF as control shutdown |
| force termination | `SIGKILL` fallback |

Source: [direct-host.ts](../../electron/main/runtime-host-delivery/direct-host.ts)、[main.rs](../../runtime-host/host/src/main.rs)。

The old TS child wrapper and IPC shutdown message are legacy evidence, not the active launch path for the current Rust delivery.

## Required child environment

Current Rust delivery passes owner-specific ports, parent callback material, state roots, provider private resolver and peer inputs in the private bootstrap frame rather than reconstructing them from legacy child env. The exact fields are bootstrap-internal and must not become Renderer API.

Legacy TS env variables remain migration evidence only:

| env | Meaning |
| --- | --- |
| `MATCHACLAW_RUNTIME_HOST_PORT` | legacy child HTTP port; invalid/missing fell back to `3211`. |
| `MATCHACLAW_RUNTIME_HOST_PARENT_API_BASE_URL` | legacy Electron Host API callback base URL. |
| `MATCHACLAW_RUNTIME_HOST_PARENT_DISPATCH_TOKEN` | legacy private callback token. |
| `MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT` | OpenClaw gateway port projection. |
| `MATCHACLAW_OPENCLAW_DIR` | OpenClaw location. |
| `MATCHACLAW_APP_PACKAGED` | packaged mode. |
| `MATCHACLAW_APP_VERSION` | app version. |
| `MATCHACLAW_APP_USER_DATA_DIR` | per-user app data root. |
| `MATCHACLAW_MATCHA_AGENT_APP_SERVER_ENABLED/URL/TOKEN` | Matcha agent app-server connection projection. |

## Port contract

| endpoint | default / source |
| --- | --- |
| Electron Host API | `13210` / `MATCHACLAW_PORT_MATCHACLAW_HOST_API` |
| Rust product loopback transports | concrete ports allocated by Electron bootstrap per transport family |
| matcha-agent app server | `3212` / `MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT` |
| OpenClaw gateway | `18789` / project config default/override path |

Source: [config.ts](../../electron/utils/config.ts#L9-L89)、[main.rs](../../runtime-host/host/src/main.rs)。All Host API and Rust product transport listeners bind loopback (`127.0.0.1`) under current implementation.

## Lifecycle states are layer-specific

| Layer | Current values |
| --- | --- |
| child root health | `starting`, `running`, `stopping`, `stopped`, `error` |
| Electron process runtime | `idle`, `starting`, `running`, `stopping`, `stopped`, `restarting`, `error` |
| RuntimeHostManager public state | same broader process-oriented state family |

Do not collapse them into one Rust enum. Child root health is the Rust compatibility surface; Electron owns process-manager states. The old transport document has a conflicting child lifecycle list; see [open-items.md](open-items.md)。

## Start and readiness

1. Electron spawns the Rust executable with stdio pipes.
2. Electron writes exactly one length-prefixed bootstrap frame to stdin.
3. Rust decodes bootstrap, constructs `Host`, spawns the Owner actor and binds configured loopback product transports.
4. Rust opens private framed control over the same stdio pair and emits the `ready` control message.
5. Electron treats control ready as process readiness; Host health/status remains a separate command/projection.

Current DirectRuntimeHost lifecycle defaults:

```text
ready timeout:              120s
graceful stop timeout:      5s before forceKill
restart:                    explicit replacement through RuntimeHostLifecycleOwner
unexpected exit:            publish exit/unavailable; no documented retry loop
```

Sources: [direct-host.ts](../../electron/main/runtime-host-delivery/direct-host.ts)、[lifecycle-owner.ts](../../electron/main/runtime-host-delivery/lifecycle-owner.ts)。

## Stop / restart

### Normal stop

Electron ends the child stdin stream. Rust control observes EOF and runs Host shutdown; if the child does not exit cleanly, Electron can force-terminate with `SIGKILL`. Source: [direct-host.ts](../../electron/main/runtime-host-delivery/direct-host.ts)、[main.rs](../../runtime-host/host/src/main.rs)。

### Restart surfaces

| Path / command | Owner | Meaning |
| --- | --- | --- |
| `POST /api/runtime-host/restart` | Electron main | full Rust child process restart. |
| private control `openclaw.lifecycle.restart` / `matcha.lifecycle.restart` | Rust Host / Integration | restart peer runtime lifecycle; no Rust child PID change. |

Do not make process restart and peer lifecycle restart aliases.

## Crash recovery

Current DirectRuntimeHost lifecycle publishes unexpected child exit as unavailable/exit observation. Explicit restart creates a replacement process; this is not request retry and not event replay. Do not document the old Node child backoff policy as current Rust delivery behavior without fresh code evidence.

## WebSocket: Remote Fleet terminal

```text
Renderer public exact path:
  /api/remote-fleet/terminal/stream

Electron:
  raw TCP proxy to child

child accepted prefix:
  /api/remote-fleet/terminal/
```

The WebSocket does not travel through `/dispatch`; it is an upgrade/raw stream boundary. Electron destroys disallowed upgrade paths. Rust Fleet server destroys unsupported/failed upgrades. Current evidence: [fleet.ts](../../electron/api/routes/fleet.ts)、[fleet transport](../../electron/main/runtime-host-delivery/transport/fleet.ts)、[Rust fleet transport](../../runtime-host/host/src/transport/fleet.rs)、[Rust fleet server](../../runtime-host/host/src/transport/fleet/server.rs)。

Terminal provider open is still under FleetOwner owner-local keyed-lane implementation; this is not product E2E/fault/backpressure/package/Windows verification.

## What Rust may change

Rust may change its executor, internal lifecycle implementation, internal background task mechanism and business owner structure. It must preserve:

- Electron-owned launch and bounded ready/exit behavior;
- one-shot private bootstrap and private control readiness;
- fixed loopback product transport boundaries;
- process restart vs peer lifecycle restart distinction;
- Remote Fleet terminal upgrade behavior where still exposed;
- parent callback token behavior without exposing it to Renderer.
