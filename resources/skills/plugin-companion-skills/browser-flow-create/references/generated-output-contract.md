# Generated Output Contract

Generated Python, TypeScript, and CLI files are derived from atlas-backed recipes. The atlas and recipe remain the source of truth. Python execution is handled by the canonical Browser Flow runner, which executes Agent-side Browser Flow Protocol v1 by calling Browser Relay primitives through a minimal OpenClaw browser gateway client. Generated Python, TypeScript, and CLI outputs must be thin entrypoints into that runner, not independent runtimes.

## Principle

Generated outputs must behave like parameterized commands for an atlas capability, not one-off recordings.

They must:

- accept params from caller input
- validate or forward params according to the recipe schema
- identify the platform, capability, and recipe ids
- execute the workspace-local canonical Python runner under `browser-flows/_runtime/` with params, or invoke it through a thin TypeScript/CLI entrypoint
- return structured JSON success/failure output
- preserve trace or trace reference
- pass through, not recalculate or suppress, recipe reliability level, verification strength, and repair notes from the canonical runner output
- avoid embedding validation sample values as fixed workflow logic
- preserve the canonical runner's bounded timeout behavior and business outcome verification; generated code must not reinterpret exit code or the final Browser Relay action as success

## Generic CLI Entrypoint

The generic CLI shape should invoke the Python runner with recipe id and params:

```bash
browser-flow run \
  --workspace ./workspace \
  --recipe github.createIssue \
  --params params.json
```

or equivalent key/value params:

```bash
browser-flow run \
  --workspace ./workspace \
  --recipe github.createIssue \
  --param title="Bug report" \
  --param body="Steps to reproduce..."
```

## Platform CLI Entrypoint

If a platform CLI entrypoint is generated, it should expose semantic flags derived from recipe params:

```bash
github-flow create-issue \
  --repo owner/name \
  --title "Bug report" \
  --body "Steps to reproduce..." \
  --submit-mode draft
```

CLI entrypoints are convenience outputs. They must invoke the Python runner and must not duplicate platform-specific logic outside the recipe.

## Workspace Runtime Distribution

When generating or repairing executable outputs, copy the canonical runtime into the workspace:

```text
<workspace>/browser-flows/_runtime/
  agent_browser_flow_runner.py
  openclaw_browser_client.py
```

Use `runtime/distribute_workspace_runtime.py` from this skill to refresh that directory and create the platform Python entrypoint. Do not rely on OpenClaw automatically copying skill runtime files into `workspace-subagents`; generated outputs must be self-contained at the workspace level.

The generated platform Python file must only be a thin wrapper that locates `<workspace>/browser-flows/_runtime/agent_browser_flow_runner.py` and invokes it with:

```bash
python browser-flows/_runtime/agent_browser_flow_runner.py \
  --workspace-dir <workspace> \
  --recipe-id <recipe-id> \
  --params-json <json> \
  --asset-update-mode execution
```

For create, maintain, repair, or validate workflows that should learn from the run, use `--asset-update-mode learning`; use `--validation-smoke` only when the safe write-back must be immediately reloaded and rerun.

## Python Output

Generated Python output is a convenience entrypoint into the workspace-local runtime. It should accept params as JSON input or `@params.json`, forward them to `_runtime/agent_browser_flow_runner.py`, and stream the canonical runner's structured JSON result unchanged.

Generated Python must not implement its own browser client, shell out to `openclaw tool browser`, import Playwright, attach to CDP, start Chrome, or call a plugin-native `runFlow`/`compileFlow`. If the active runtime cannot provide gateway env vars for `browser.request`, the canonical runner must report `failed` or `blocked` rather than silently falling back to a second browser kernel or returning plan-only success.

Generated Python must not add a separate post-run browser recheck to compensate for an incomplete recipe. If a create, delete, edit, upload, export, or submit flow needs verification, the recipe must include the bounded verification step so the canonical runner's JSON result and trace already contain the outcome evidence.

## TypeScript Output

TypeScript output should accept typed or JSON params and invoke the workspace-local canonical Python runner through the generated Python entrypoint or `_runtime/agent_browser_flow_runner.py`. It must not reimplement semantic target resolution, risk handling, trace writing, browser gateway calls, or success validation:

```ts
await runPythonBrowserFlow({
  workspaceDir: './workspace',
  recipeId: 'github.createIssue',
  params: {
    title: 'Bug report',
    body: 'Steps to reproduce...',
    submitMode: 'draft',
  },
})
```

## Output Shape

Success:

```json
{ "ok": true, "platformId": "...", "capabilityId": "...", "flowId": "...", "result": {}, "extracted": {}, "reliability": { "level": "usable", "verificationStrength": "scoped", "repairNotes": [] }, "trace": {} }
```

Failure:

```json
{ "ok": false, "platformId": "...", "capabilityId": "...", "flowId": "...", "error": { "code": "...", "message": "..." }, "reliability": { "level": "draft", "verificationStrength": "none", "repairNotes": ["..."] }, "trace": {} }
```

A generated output is stale if its accepted params no longer match the recipe params schema, its referenced capability no longer matches the atlas, or it hides/drops the runner's reliability and verification evidence fields.
