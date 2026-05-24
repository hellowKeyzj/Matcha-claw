# Agent-side Browser Flow Runner Contract

Browser Flow v1 is executed by one canonical Python runner that calls Browser Relay primitives through a minimal OpenClaw browser gateway client. The runner consumes atlas-backed recipes; the browser plugin remains the browser control and evidence layer.

## Runtime Boundary

The browser plugin provides these current actions:

- session and tab management: `start`, `stop`, `status`, `profiles`, `tabs`, `open`, `focus`, `close`, `closeagenttabs`, `close_agent_tabs`
- page observation and navigation: `snapshot`, `navigate`, `scroll`, `highlight`
- step execution: `act` with click, type, fill, select, press, hover, drag, wait, resize, evaluate, scroll, close, and scrollIntoView requests
- artifacts and browser evidence: `screenshot`, `pdf`, `upload`, `dialog`, `requests`, `errors`, `console`, `storage`, `cookies`

Recipe steps must use only actions that are present in the current Browser Relay action contract. Session management actions may prepare or inspect the browser, but they should not be durable business steps unless the recipe explicitly models a tab/page boundary.

Python execution must go through a minimal OpenClaw browser gateway client that exposes one narrow operation: `browser.request(params) -> result`. The client may discover session, workspace, and gateway connection details from the active OpenClaw runtime or environment, but it must not start browsers, attach to CDP, reimplement Playwright, manage platform recipes, or bypass Browser Relay. If no gateway client is available in the current runtime, generated Python execution is `blocked` until that bridge exists.

There is no current Browser Relay raw CDP action, active-session fetch primitive, plugin-native `runFlow`, or plugin-native `compileFlow`. If a recipe requires unsupported browser control, report `partial`, `blocked`, or `not-suitable` instead of pretending support.

The runner is responsible for:

- loading `platform.json`, `atlas/**`, and `flows/*.recipe.json`
- validating params against the recipe schema
- enforcing capability and recipe risk metadata
- resolving semantic targets from live browser evidence
- calling Browser Relay primitives step by step through `browser.request`
- extracting structured values from snapshots or bounded in-page evaluation
- writing execution trace evidence
- validating success criteria
- reporting blockers and unsupported primitives honestly

The minimal gateway client is responsible only for:

- resolving the active OpenClaw gateway connection and session context
- sending validated Browser Relay action params to `browser.request`
- returning structured Browser Relay results and errors without hiding metadata
- redacting secrets in logs and traces

It is not responsible for recipe interpretation, semantic target resolution, risk decisions, browser startup, tab policy, CDP access, local script execution, or generated-output orchestration.

CLI or TypeScript outputs should be thin entrypoints into the Python runner, not independent runtimes.

## Recipe Runtime Declaration

Every v1 recipe must declare the agent-side runtime:

```json
{
  "runtime": {
    "kind": "agent-side",
    "protocol": "agent-browser-flow-v1",
    "requiredBrowserActions": ["snapshot", "act", "requests", "errors", "screenshot"]
  }
}
```

`requiredBrowserActions` must list only actions from the current Browser Relay action contract and only the actions actually needed by the recipe.

## Recipe Atlas References

Every recipe must reference the atlas capability it executes:

```json
{
  "capabilityId": "github.createIssue",
  "surfaceId": "github.repository",
  "viewId": "github.issue-list",
  "componentIds": ["github.new-issue-button", "github.issue-editor"]
}
```

The atlas explains what the platform supports. The recipe explains how to execute one selected capability.

## Minimal Gateway Client Shape

A generated or shared Python runner should depend on a tiny client with this conceptual shape:

```python
class OpenClawBrowserGatewayClient:
    @classmethod
    def from_environment(cls) -> "OpenClawBrowserGatewayClient": ...

    def request(self, params: dict) -> dict: ...
```

`request()` sends the params to OpenClaw gateway method `browser.request`. The params must already be Browser Relay action params produced by the runner. The result must preserve Browser Relay success/error structure so traces can record `unsupported_action`, `browser_unavailable`, stale refs, protocol errors, and risk-boundary blockers honestly.

Do not generate Python that imports Playwright, opens Chrome, connects to CDP, or calls a plugin-native `runFlow`. Those would create a second browser kernel.

## Execution Loop

To execute a recipe, the runner must:

1. Load platform, atlas, and recipe assets.
2. Validate required params, optional defaults, enum constraints, and secret flags.
3. Determine context, environment, risk, and execution mode from capability and recipe metadata.
4. For each step:
   - capture current page evidence with `snapshot` when target resolution or verification needs page evidence
   - resolve `SemanticTarget` to a current executable ref or bounded runtime fallback
   - call the matching Browser Relay primitive
   - record the primitive call, result, resolved target, and evidence refs
   - verify step-level expectations when declared
5. Stop before any dry-run or manual-confirm boundary unless the user explicitly approves continuing.
6. Verify success criteria or extracted data.
7. Write trace evidence and report success, partial status, or blockers.

## Semantic Target Resolution

Recipe targets must be durable semantic descriptions, not short-lived refs.

Primary target fields may include:

- atlas refs: surfaceId, viewId, regionId, componentId, capabilityId
- role, kind, label, name, text, or title
- scope such as form, filter area, table, row, modal, drawer, tab, nav, page section, card, feed item, editor, or media panel
- business context such as entity, field meaning, row key, column name, action meaning, or modal title
- interaction pattern such as combobox, cascader, tree selector, upload control, virtual table row, infinite feed item, rich text editor, iframe step, modal confirmation, drawer form, diff viewer, SKU selector, media player, map, or checkout block

Resolution order:

1. Match atlas scope.
2. Match role or interaction kind.
3. Match label, accessible name, visible text, title, or nearby text.
4. Match business context such as entity, table column, row key, form label, card field, modal title, or component action.
5. Use a bounded runtime fallback only for the current run.

Snapshot refs, raw selectors, component-library classes, XPath, and `nth-child` paths are runtime evidence or recovery hints only. Do not persist them as primary recipe targets.

## Primitive Mapping

| Step kind | Browser primitive |
|---|---|
| `open` | `browser` `open` |
| `navigate` | `browser` `navigate` |
| `snapshot` | `browser` `snapshot` |
| `click` | `browser` `act` request kind `click` |
| `type` | `browser` `act` request kind `type` |
| `fill` | `browser` `act` request kind `fill` |
| `select` | `browser` `act` request kind `select` |
| `press` | `browser` `act` request kind `press` |
| `hover` | `browser` `act` request kind `hover` |
| `drag` | `browser` `act` request kind `drag` |
| `scroll` | `browser` `scroll` or `browser` `act` request kind `scroll` |
| `scrollIntoView` | `browser` `act` request kind `scrollIntoView` |
| `waitForText` | `browser` `act` request kind `wait` with `text` |
| `waitForUrl` | `browser` `act` request kind `wait` with `url` |
| `waitForLoadState` | `browser` `act` request kind `wait` with `loadState` |
| `upload` | `browser` `upload` |
| `dialog` | `browser` `dialog` |
| `screenshot` | `browser` `screenshot` |
| `pdf` | `browser` `pdf` |
| `collectRequests` | `browser` `requests` |
| `collectErrors` | `browser` `errors` |
| `collectConsole` | `browser` `console` |
| `readStorage` / `writeStorage` | `browser` `storage` |
| `cookies` | `browser` `cookies` |
| `extract` | `browser` `snapshot` plus agent extraction, or bounded `evaluate` when declared |
| `assertVisible` / `assertText` | `browser` `snapshot` or `browser` `act` request kind `wait` |
| `assertRequest` | `browser` `requests` |
| `assertNoErrors` | `browser` `errors` |

## Trace Evidence

Every execution or validation trace must record:

- runtime protocol and recipe id
- platform id, capability id, and relevant atlas refs
- supplied params with secrets redacted
- step status and Browser Relay primitive calls
- semantic targets and resolved runtime refs or fallbacks
- snapshots, screenshots, requests, errors, console output, or extraction evidence used for verification
- success criteria status
- recovery evidence, atlas/recipe change suggestions, unknowns, and blockers

Do not store credentials, cookies, tokens, sensitive request bodies, or long raw DOM dumps.

## Unsupported Primitive Handling

Use:

- `partial` when the atlas or recipe is useful but lacks non-critical evidence, artifact capture, generated output, or scenario coverage
- `blocked` when login, permission, missing data, unsafe risk, unsupported download capture, popup handling, raw CDP need, active-session fetch, or unverifiable success prevents validation
- `not-suitable` when the workflow requires permission bypass, unsafe production mutation, payment bypass, or unsupported external side effects

Record the missing primitive and recommended next browser capability in the trace and final report.
