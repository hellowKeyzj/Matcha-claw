---
name: browser-flow-use
description: Use saved Web Platform Atlas and Browser Flow assets. Use for listing or inspecting modeled platforms, surfaces, views, components, capabilities, and existing executable recipes; running an existing recipe through the canonical Python Browser Flow runner; generating thin Python/TypeScript/CLI outputs for an existing recipe; or diagnosing usage-time failures. Do not use for one-off browser tasks without matching assets. If no matching atlas capability or recipe exists, route to `browser-flow-create` only when the user wants reusable platform modeling or workflow preservation; otherwise use `browser-relay`.
user-invocable: true
---

# Browser Flow Use

Use saved Web Platform Atlas and Browser Flow assets created by `browser-flow-create`. This skill consumes existing assets; it does not perform new authoring or browser archaeology.

It is the sibling of `browser-flow-create`:

- `browser-flow-create` creates, maintains, repairs, and validates atlas assets from sources, browser archaeology, page/component/capability modeling, recipes, and browser evidence.
- `browser-flow-use` consumes existing assets, explains what a platform/page/capability model says, chooses the right saved recipe when one exists, executes it through the canonical Python Browser Flow runner using a minimal OpenClaw browser gateway client for `browser.request`, generates thin CLI or TypeScript entrypoints when requested, and diagnoses usage-time results.

## Asset Root

Assets live under a user or agent workspace:

```text
<workspace>/browser-flows/
  INDEX.md
  platforms/<platform-id>/
    platform.json
    atlas/
      surfaces/<surface-id>.surface.json
      views/<view-id>.view.json
      components/<component-id>.component.json
      capabilities/<capability-id>.capability.json
      entities/<entity-id>.entity.json
      contexts/<context-id>.context.json
    flows/<flow-id>.recipe.json
    evidence/
      archaeology/<timestamp>-<scope>.trace.json
      snapshots/
      screenshots/
      network/
    generated/
      python/<flow-id>.py
      typescript/<flow-id>.ts
      cli/<flow-id>.cli
```

Do not expect one skill per platform or one skill per flow. Understand the asset tree directly.

## When to Use

Use this skill when the user asks to:

- list or inspect modeled platforms in a workspace
- explain what surfaces, views, components, entities, contexts, or capabilities are known
- identify where a platform capability lives and whether it has an executable recipe
- identify required params for an existing executable recipe
- run an existing saved browser workflow
- generate a Python runner or thin TypeScript/CLI entrypoints for an existing recipe
- inspect traces, recovery evidence, or recipe suggestions after v1 execution
- diagnose page drift, missing atlas assets, missing recipes, or failed recipes during normal use

Use `browser-flow-create` instead when the user asks to create new platform coverage, turn documents into atlas assets, structurally change atlas records or recipes, update assets after a page upgrade, fill missing capability coverage, or perform new browser archaeology.

## Runner Contract

Follow `resources/skills/plugin-companion-skills/browser-flow-create/references/agent-runner-contract.md` for Agent-side Browser Flow Protocol v1 execution, semantic target resolution, primitive mapping, trace evidence, and unsupported primitive handling.

## Workflow

1. Confirm or infer the workspace directory containing `browser-flows/`.
2. Read `browser-flows/INDEX.md` first when it exists; use it as the platform catalog.
3. Inspect `browser-flows/platforms/*/platform.json` to confirm the matched platform.
4. Inspect `atlas/**` to identify matched surfaces, views, components, capabilities, entities, and contexts.
5. If the user wants to execute, inspect the matched capability's `recipeId` and then read `flows/*.recipe.json`.
6. Read the recipe runtime declaration, atlas refs, params, risk metadata, success criteria, and extraction targets before running.
7. If `runtime.kind` is `agent-side`, `script`, or unspecified for a v1 asset, execute the recipe through the canonical Python Browser Flow runner using a minimal OpenClaw browser gateway client for `browser.request`.
8. If the user asks for generated code, generate the Python runner or thin TypeScript/CLI entrypoints that accept params and invoke the Python runner.
9. After execution, report extracted data, success evidence, trace path, recovery evidence, and atlas/recipe change suggestions.

## Runtime Param Schema

When preparing params for Agent-side Browser Flow Protocol v1 execution, follow the recipe schema exactly. The runtime-supported param types are:

- `string`
- `number`
- `boolean`
- `string[]`
- `number[]`
- `boolean[]`
- `object`

Do not invent new param types while using assets. Treat file paths as `string`, dates as `string`, and date ranges as `object` values when that is how the recipe describes them. Treat `secret: true` as a security flag and do not print the secret value in reports.

## Execute Existing Flow

Agent-side v1 execution shape:

```json
{
  "runtime": { "kind": "agent-side", "protocol": "agent-browser-flow-v1" },
  "workspaceDir": "/workspace",
  "recipe": { "id": "platform.flowId" },
  "params": {}
}
```

The skill executes this shape through the canonical Python runner, which reads the platform, atlas, and recipe assets, resolves semantic targets from live browser evidence, calls `browser.request` through the minimal OpenClaw browser gateway client, and writes trace evidence.

## Generate Existing Flow Runner or Entrypoint

Generated output request shape:

```json
{
  "runtime": { "kind": "agent-side", "protocol": "agent-browser-flow-v1" },
  "workspaceDir": "/workspace",
  "recipe": { "id": "platform.flowId" },
  "outputTarget": "python"
}
```

Generated Python runners must accept params and execute the v1 contract through the minimal OpenClaw browser gateway client for `browser.request`. Generated TypeScript/CLI entrypoints must invoke the Python runner instead of duplicating browser steps or runtime logic. If the gateway client is unavailable, report execution as blocked instead of falling back to raw CDP, Playwright, or plugin-native flow actions.

## Safety Boundaries

- Treat login, MFA, CAPTCHA, permissions, payments, purchases, postings, messages, and approvals as user-controlled boundaries.
- Do not bypass access controls or invent credentials.
- Respect capability and recipe risk metadata before destructive, approval, payment, messaging, permission, upload, download, social-action, or production-write steps.
- For `dry-run` or `manual-confirm` recipes, stop at the recorded confirmation point unless the user explicitly approves continuing.
- Do not use `evaluate` as a local script runner. It is only recipe-declared, bounded in-page logic through the current `browser` `act` evaluate primitive.

## Result Interpretation

When a run or validation artifact includes structured outputs, consume them instead of re-inventing status:

- `AtlasValidationReport` summarizes readiness across platform, surfaces, views, components, capabilities, params, safe execution, missing input, risk boundary, success evidence, trace, generated output, unsupported primitives, and index checks.
- `AtlasRepairDiff` explains failure classification, changed atlas assets, recipe changes, risk handling, validation evidence, refreshed outputs, blockers, and next user action.
- Runtime `FlowTrace` is execution evidence; archaeology traces are authoring/repair evidence. Use trace paths to explain what happened, but route structural updates to `browser-flow-create`.

## Failure Handling

When Agent-side Browser Flow Protocol v1 execution fails or recovers:

1. Inspect the returned trace, `recoveryEvidence`, atlas change suggestions, recipe change suggestions, and any patch suggestions recorded as evidence. Current v1 execution does not require automatic patch application.
2. Inspect browser `errors` and `requests` when behavior is unclear.
3. Classify failures as atlas drift, semantic target drift, runtime semantic locator resolution failure, stale ref/locator fallback, hidden/offscreen/covered target, component/page layout drift, navigation drift, missing data, missing context, unsupported primitive, or risk boundary change.
4. If required params are missing, ask the user for only those business values and re-run with the same recipe.
5. If v1 execution recovered by re-resolving the semantic target against current page evidence and verification succeeded, report the recovery without changing atlas or recipe assets.
6. If patch suggestions are present, treat them as evidence and route structural changes to `browser-flow-create` unless the current runner explicitly supports verified patch application.
7. If recovery evidence is insufficient, atlas records drifted, semantic targets drifted, the recipe no longer matches the capability, a needed capability/recipe is missing, or the user wants structural changes, route to `browser-flow-create` for asset maintenance, repair, or validation.

## Asset Maintenance Routing

`browser-flow-use` can diagnose usage-time issues, but it should not perform authoring work itself.

Route to `browser-flow-create` when:

- no matching platform, surface, view, capability, or recipe exists in `browser-flows/INDEX.md` or `atlas/**`
- capability inputs/outputs/risk/success signals are incomplete
- params schema is incomplete or hardcoded sample values appear in recipe logic
- a recipe needs new or reordered steps
- platform pages, components, or semantic targets changed and must be rediscovered
- a source document or user description adds missing platform or capability coverage
- a suggested patch is risky, unverified, or changes atlas/recipe structure
- repeated failures show the platform profile, context, params, success criteria, primitive support, or risk rules are incomplete

If runtime applied a verified non-risky patch during v1 execution, report it as an asset repair and include the updated asset path or version.

## Report Format

```text
Workspace: <workspace>
Platform: <platform-id/name>
Atlas: <surface/view/capability ids inspected>
Flow: <recipe-id/name or none>
Action: inspect-atlas | execute | generate-runner | generate-entrypoint
Params: <provided/missing/not applicable>
Result: <success/failure/blocked/partial>
Extracted: <key fields if any>
Trace: <trace path or id>
Suggestions: <atlas/recipe suggested changes or none>
Next: <only if user action is needed>
```
