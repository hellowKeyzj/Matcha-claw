# Runner Contract Reference

Read this file before executing a matched Browser Flow recipe or diagnosing a runner-related failure.

## Runtime boundary

Browser Flow v1 executes through one canonical Python runner:

```text
<workspace>/browser-flows/_runtime/agent_browser_flow_runner.py
```

The runner calls Browser Relay primitives through:

```text
<workspace>/browser-flows/_runtime/openclaw_browser_client.py
```

The gateway client exposes only `browser.request(params) -> result`. It must not start browsers, attach to CDP, import Playwright, implement semantic target resolution, manage recipes, or bypass Browser Relay.

## Preflight checks

Before execution, confirm:

- `_runtime/agent_browser_flow_runner.py` exists
- `_runtime/openclaw_browser_client.py` exists
- generated Python is a thin entrypoint into `_runtime/agent_browser_flow_runner.py`
- generated TypeScript or CLI invokes the Python runner instead of duplicating browser logic
- the entrypoint's actual argument parser or README has been read before choosing command syntax
- params are passed exactly as the entrypoint expects, preferably via `@params.json` when supported
- no generated output contains `plan-only`, `BrowserToolClient`, `openclaw tool browser`, raw CDP, Playwright, plugin-native `runFlow`, or plugin-native `compileFlow`

Do not infer CLI flags from recipe param names. A recipe param named `tagName` does not imply the entrypoint accepts `--tagName`.

If preflight fails, route to `browser-flow-create` maintain/repair to refresh runtime with `runtime/distribute_workspace_runtime.py`.

## Param invocation

Generated Python entrypoints commonly accept either a single JSON positional argument or an `@params.json` file. Always verify the concrete entrypoint before invocation.

Preferred pattern:

```bash
uv run python browser-flows/platforms/<platform-id>/generated/python/<flow-id>.py @tmp/<flow-id>-params.json
```

Use inline JSON only when shell quoting is safe:

```bash
uv run python browser-flows/platforms/<platform-id>/generated/python/<flow-id>.py '{"tagName":"example","description":"example"}'
```

Do not call:

```bash
uv run python browser-flows/platforms/<platform-id>/generated/python/<flow-id>.py --tagName example --description example
```

unless that exact flag interface is defined in the entrypoint.

## Execution mode

Use normal execution mode for saved-flow runs. Execution mode may write trace evidence and patch suggestions, but it must not persist source atlas or recipe changes.

Use learning, repair, maintain, or validation modes only through `browser-flow-create`.

## Runner responsibilities

The runner must:

1. Load `platform.json`, `atlas/**`, and `flows/*.recipe.json`.
2. Validate required params, optional defaults, enum constraints, and secret flags.
3. Enforce capability and recipe risk metadata.
4. Resolve semantic targets from current browser evidence.
5. Call Browser Relay primitives step by step through `browser.request`.
6. Record primitive calls, results, resolved targets, evidence refs, and trace output.
7. Enforce bounded waits or timeouts for blocking UI operations.
8. Stop at dry-run or manual-confirm boundaries unless the user explicitly approved continuing.
9. Verify success criteria or extracted data against the business outcome.
10. Report blockers and unsupported primitives honestly.

## Success interpretation

Do not treat a completed click, type, fill, navigation, or lack of browser errors as business success.

Success requires recipe-declared evidence such as:

- row present or absent
- dialog closed after submit
- visible toast plus matching target state
- table result count or row content changed
- selected item visible
- uploaded artifact listed
- export or download evidence
- async job state
- final URL
- extracted typed fields
- request/status evidence when declared

If success is action-only or externally rechecked, report partial verification and route to `browser-flow-create` repair/validate.

## Reliability interpretation

- `draft`: executable shape exists but validation or outcome evidence is incomplete.
- `usable`: known happy path is parameterized, bounded, traceable, risk-aware, and basically verified in-run.
- `partial-verification`: runner is usable but verification evidence is weak, fallback-based, or scoped.
- `validated`: safe real params or an approved risk boundary prove the outcome through trace evidence.
- `hardened`: repeated validation and strong failure categories are proven.

Do not call a recipe `validated` or `hardened` when evidence is action-only, stale, or dependent on an ad hoc post-run browser check.