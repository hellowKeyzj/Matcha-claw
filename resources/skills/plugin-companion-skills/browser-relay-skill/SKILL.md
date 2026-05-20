---
name: browser-relay
description: "Load when the task needs MatchaClaw's real browser: opening or inspecting live web pages, using logged-in Chrome state, clicking/typing/forms, reading dynamic DOM, taking screenshots/PDFs, uploads, cookies/storage, network/errors, or any `browser` tool workflow. Prefer relay mode; use direct-cdp only when requested or debugging browser connection."
---

# browser-relay Skill

Use the `browser` tool as a real-browser control surface. Keep the loop short:

```text
open/focus/navigate -> snapshot -> act -> snapshot/other proof -> done
```

## Default Rules

- Prefer `connectionMode: "relay"` or omit `connectionMode`; it reuses the user's Chrome state.
- Use `direct-cdp` only when the user asks for it or when diagnosing relay connection failures.
- Use `snapshot` as the primary observation. Use `screenshot` for visual evidence, not as the main action target source.
- Treat refs from `snapshot` as short-lived. After navigation, rerender, list refresh, modal open/close, or failed action, run `snapshot` again.
- Do not guess a tab. Use `tabs` or explicit `targetId` when the target is unclear.
- After a page-changing `act`, verify with `snapshot`, `wait`, `errors`, `requests`, or `screenshot` as appropriate.
- Stop when the user's goal is met. Close only agent-created tabs; do not close the user's own pages unless asked.

## First Move

Choose the cheapest reliable start:

- Known URL and a new work page is fine: call `open`.
- User wants the current selected browser page: call `snapshot`; if it fails with no target, call `status` then `tabs`.
- Target tab is ambiguous: call `tabs`, then `focus` the chosen `targetId`.
- Browser/extension seems unavailable: call `status`; read `references/troubleshooting.md` only if status does not explain the issue.

Avoid a ritual `status` before every task. Use it on first connection, after failures, or when browser availability is unknown.

## Core Calls

Use these shapes unless the task needs more.

Open:

```json
{"action":"open","url":"https://example.com"}
```

Snapshot:

```json
{"action":"snapshot","compact":true}
```

Interactive-only snapshot for crowded pages:

```json
{"action":"snapshot","interactive":true,"compact":true}
```

Click a snapshot ref:

```json
{"action":"act","request":{"kind":"click","ref":"e3"}}
```

Type or submit:

```json
{"action":"act","request":{"kind":"type","ref":"e4","text":"search text","submit":true}}
```

Wait then re-observe:

```json
{"action":"act","request":{"kind":"wait","text":"Loaded","timeoutMs":10000}}
```

Screenshot proof:

```json
{"action":"screenshot","fullPage":false}
```

## Observation Strategy

Prefer the smallest observation that can answer the next decision:

- Need to operate: `snapshot`.
- Need only visible proof for the user: `screenshot`.
- Need page behavior debugging: `errors`, `requests`, then `snapshot`.
- Need specific page text on a long page: use `snapshot` with `filter` or scoped `selector` before scrolling blindly.
- Need lazy-loaded content: `scroll`, then `snapshot`.

## Common Gotchas

- `console` executes a JS expression; it is not the console-log viewer. Use `errors` or `requests` for diagnostics.
- `navigate` changes an existing target. Use `open` when creating an agent-owned work tab.
- `targetId` overrides the selected relay window. Pass it only when you are sure which tab to control.
- `highlight` is a ref sanity check, not a substitute for `snapshot`.
- Login walls: if target content is already visible, do not ask the user to log in. Ask only when the task is blocked by authentication.
- Multi-tab work is for independent subtasks. Do not split a single linear checkout/login/form flow across tabs.

## References

- Read `references/browser-tool-api.md` when you need exact parameters or more examples.
- Read `references/troubleshooting.md` when relay is unavailable, the wrong tab is controlled, refs go stale, or direct-cdp is being considered.
