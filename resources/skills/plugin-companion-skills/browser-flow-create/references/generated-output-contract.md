# Generated Output Contract

Generated Python, TypeScript, and CLI files are derived from atlas-backed recipes. The atlas and recipe remain the source of truth. Python is the canonical Browser Flow runner and executes Agent-side Browser Flow Protocol v1 by calling Browser Relay primitives through a minimal OpenClaw browser gateway client. TypeScript and CLI outputs must be thin entrypoints into the Python runner, not independent runtimes.

## Principle

Generated outputs must behave like parameterized commands for an atlas capability, not one-off recordings.

They must:

- accept params from caller input
- validate or forward params according to the recipe schema
- identify the platform, capability, and recipe ids
- execute the canonical Python runner with params, or invoke it through a thin TypeScript/CLI entrypoint
- return structured JSON success/failure output
- preserve trace or trace reference
- avoid embedding validation sample values as fixed workflow logic

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

## Python Output

Python output is the canonical runner API. It should accept params as function input or JSON input and execute Agent-side Browser Flow Protocol v1 through a minimal OpenClaw browser gateway client that calls `browser.request`:

```python
client = OpenClawBrowserGatewayClient.from_environment()

run_flow(
    workspace_dir="./workspace",
    recipe_id="github.createIssue",
    params={
        "title": "Bug report",
        "body": "Steps to reproduce...",
        "submitMode": "draft",
    },
    browser_client=client,
)
```

Generated Python must not import Playwright, attach to CDP, start Chrome, or call a plugin-native `runFlow`/`compileFlow`. If the active runtime cannot provide an OpenClaw gateway client for `browser.request`, generated Python execution is blocked rather than silently falling back to a second browser kernel.

## TypeScript Output

TypeScript output should accept typed or JSON params and invoke the canonical Python runner. It must not reimplement semantic target resolution, risk handling, trace writing, or success validation:

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
{ "ok": true, "platformId": "...", "capabilityId": "...", "flowId": "...", "result": {}, "extracted": {}, "trace": {} }
```

Failure:

```json
{ "ok": false, "platformId": "...", "capabilityId": "...", "flowId": "...", "error": { "code": "...", "message": "..." }, "trace": {} }
```

A generated output is stale if its accepted params no longer match the recipe params schema or its referenced capability no longer matches the atlas.
