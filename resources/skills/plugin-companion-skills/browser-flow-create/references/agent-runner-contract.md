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
- classifying whether persisted atlas/recipe assets still match the observed page and user goal
- applying verified non-risky incremental write-back when explicitly running in learning mode
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

## Asset Update Modes

The runner supports two explicit modes:

- `--asset-update-mode execution`: execute the saved recipe and write trace evidence. If the model still satisfies the observed page and user goal, report `patchStatus: no_changes`; if execution fails or evidence suggests drift, report suggestions without changing assets.
- `--asset-update-mode learning`: used by create, maintain, repair, and validate workflows. After execution, compare stable observed evidence against the persisted model and write back only verified deltas.

Patch status values:

- `no_changes`: the persisted model still works for the observed page and user goal; do not rewrite assets.
- `write_back`: missing facts, fresh validation evidence, recovered failures, stable component metadata, or failure evidence must be persisted.
- `suggest_only`: evidence is useful but not safe or certain enough to write automatically.
- `blocked`: risk, permission, or execution boundaries prevent automatic update.

Write-back is result-driven, not time-driven. Repeating the same successful run with the same stable observed signature must leave asset files byte-for-byte unchanged. TTL or age can prompt validation, but it must not by itself rewrite model assets.

Learning mode may update freshness, failure counts, evidence refs, supported Browser Relay actions, missing capability/component shells, stable observed labels/roles, and the managed `INDEX.md` section. It must not delete assets, lower risk, change `manual-confirm` to `auto`, rewrite recipe steps from guesses, or persist snapshot refs, raw selectors, XPath, `nth-child`, cookies, tokens, passwords, authorization headers, or sensitive request bodies.

`--validation-smoke` reruns the same read-safe recipe after write-back through `browser.request` to verify the updated assets can be reloaded and executed. Risky recipes skip external side-effect replay and use structural/risk validation only.

## Reliability Levels

Browser Flow uses progressive hardening. First executable recipes should target production-usable reliability for the known happy path, not throwaway click scripts, while still allowing honest partial output when browser evidence is limited.

Minimum first-run runner quality:

- parameterized business inputs with no hardcoded sample values in workflow logic
- canonical workspace runtime and trace writing
- risk metadata and confirmation boundary for side-effecting actions
- bounded timeout or bounded wait behavior for every UI step that can block
- semantic targets with enough context to avoid obvious duplicate-label ambiguity
- in-run outcome verification appropriate to the capability risk
- clear failure classification when params, target resolution, page state, verification, risk, or browser target handling fails

Reliability statuses:

- `draft`: executable shape exists but browser validation or outcome evidence is incomplete; use only for repair/learning.
- `usable`: known happy path is parameterized, bounded, traceable, risk-aware, and has basic in-run outcome verification.
- `partial-verification`: runner is usable but verification evidence is weak, fallback-based, or scoped; report verification strength and repair notes.
- `validated`: a safe real param set or approved risk boundary proves the outcome through trace evidence.
- `hardened`: repeated validation, strong structure-shaped verification, clear failure categories, and no-change behavior are proven.

Do not block all generated output only because the strongest possible verification primitive is unavailable. Do not mark a runner `validated` or `hardened` when it is only an action sequence, has weak verification, or depends on separate ad hoc post-run browser checks.

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
   - enforce bounded timeouts for UI operations that can block on readiness, transition, refresh, upload, navigation, or confirmation
5. Stop before any dry-run or manual-confirm boundary unless the user explicitly approves continuing.
6. Verify success criteria or extracted data against the business outcome, not just absence of runtime/browser errors.
7. Classify model delta from stable evidence: required actions, step kinds, resolved semantic target metadata, success/failure class, missing capability/component refs, and output/visible-state mismatch.
8. In learning mode, write verified deltas and a patch bundle under `evidence/patches/`; in execution mode, report suggestions without changing assets.
9. Write trace evidence and report success, partial status, or blockers.

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
2. Match active context such as current modal, drawer, focused panel, active tab, newly opened region, table/card row, or frame when the recipe or prior step establishes one.
3. Match role or interaction kind.
4. Match label, accessible name, visible text, title, or nearby text.
5. Match business context such as entity, table column, row key, form label, card field, modal title, or component action.
6. Use a bounded runtime fallback only for the current run.

When multiple targets share the same role/name, the resolver or recipe must use durable context to disambiguate: containing component, dialog/drawer title, form section, row key, column/action meaning, newly appeared subtree, or previous-step context. Runtime order, ref ordinal, raw DOM position, or `nth-child` may break ties only as non-persisted recovery evidence, never as the primary target identity.

Snapshot refs, raw selectors, component-library classes, XPath, and `nth-child` paths are runtime evidence or recovery hints only. Do not persist them as primary recipe targets.

## Recipe Step Quality

Recipe steps must be bounded, evidence-driven, and component-aware:

- Do not encode one component tactic as a global recipe rule. For example, direct `type`, click-then-type, `fill`, keyboard input, or upload handling must be chosen from observed component behavior and current Browser Relay support.
- Every step that can wait on UI readiness, modal or drawer transitions, table refresh, pagination, upload/download, navigation, async job state, or confirmation must include a bounded `timeoutMs`, bounded wait condition, or explicit blocked status when the success state cannot be observed.
- Success cannot be inferred from the last action completing. Recipes must declare success criteria or extraction targets that prove the user-visible or business outcome.
- Prefer structure-shaped verification when the page exposes it: row present/absent, dialog closed, table result count changed, selected item visible, upload artifact listed, export/download evidence, async job state, request status, final URL, toast, or extracted typed fields.
- `assertNoErrors` is supporting evidence only; it must not be the sole success proof for create, edit, delete, submit, upload, export, approval, payment, or external-message workflows.
- If a postcondition is not observable with current Browser Relay primitives, the recipe is `partial` or `blocked`; do not move verification into a separate ad hoc browser check and call the runner complete.

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

## Snapshot and Verification Evidence Boundary

The runner may use snapshots for target resolution, extraction, and verification, but snapshot evidence has boundaries:

- Compact or diff snapshots prove only the returned scope and changed refs, not the entire page state.
- Empty interactive refs can mean the page is still settling, the scope is wrong, the element is non-interactive, or the Browser Relay primitive lacks enough evidence; retry boundedly, then classify the failure.
- Virtualized, paginated, filtered, or asynchronously refreshed lists require row/key/result-count verification in the relevant scope instead of assuming absence from a partial snapshot means absence from the platform.
- If visible state cannot prove the outcome, use supported request/error/console/file evidence or mark the recipe partial/blocked; do not hide uncertainty behind a successful final action.

## Trace Evidence

Every execution or validation trace must record:

- runtime protocol and recipe id
- platform id, capability id, and relevant atlas refs
- supplied params with secrets redacted
- step status and Browser Relay primitive calls
- semantic targets and resolved runtime refs or fallbacks
- snapshots, screenshots, requests, errors, console output, or extraction evidence used for verification
- success criteria status
- business outcome evidence, such as created entity present, deleted entity absent, extracted result shape, download/upload artifact evidence, final URL, toast, request, or visible state
- recovery evidence, atlas/recipe change suggestions, unknowns, and blockers
- failure classification when execution does not complete, using precise categories such as target resolution failure, ambiguous target, dialog or drawer not appeared, postcondition failed, verification inconclusive, browser target lost, unsupported primitive, unbounded wait risk, permission/login boundary, or risk boundary

Do not store credentials, cookies, tokens, sensitive request bodies, or long raw DOM dumps.

## Unsupported Primitive Handling

Use:

- `partial` when the atlas or recipe is useful but lacks non-critical evidence, artifact capture, generated output, or scenario coverage
- `blocked` when login, permission, missing data, unsafe risk, unsupported download capture, popup handling, raw CDP need, active-session fetch, or unverifiable success prevents validation
- `not-suitable` when the workflow requires permission bypass, unsafe production mutation, payment bypass, or unsupported external side effects

Record the missing primitive and recommended next browser capability in the trace and final report.
