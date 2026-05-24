---
name: browser-flow-use
description: Uses existing Web Platform Atlas and Browser Flow assets before operating a browser. Use when a web-platform task may match saved browser-flows assets: inspect modeled platforms, match capabilities, execute existing recipes through the workspace-local canonical Python runner, generate thin outputs, or diagnose usage-time failures. Don't use for creating or repairing atlas assets, inventing browser steps, general Playwright/CDP automation, or one-off browsing when reusable modeling is required; route missing or stale coverage to browser-flow-create.
user-invocable: true
---

# Browser Flow Use

Use persisted Web Platform Atlas assets as the default path for browser-platform work. Treat requests like “create a tag in FCloud” as an asset lookup first, not as a fresh click-by-click browser task.

## Core Rules

- Search existing `browser-flows/` assets before browser operation.
- Read `browser-flows/INDEX.md` first when it exists.
- Match platform, then capability, then recipe.
- Execute matching recipes only through the workspace-local canonical runner or a generated thin entrypoint that delegates to it.
- Read the generated Python entrypoint or README before invoking it. Do not guess CLI flag names.
- Pass user business values as recipe params. Prefer an `@params.json` file or the entrypoint's documented single JSON positional argument; do not invent `--tagName`-style flags unless the entrypoint explicitly defines them.
- Do not hardcode names, descriptions, dates, search terms, or secrets into assets.
- Report success only from runner success criteria, extraction outputs, trace evidence, reliability, and verification strength.
- Do not use raw step-by-step browser actions when a modeled platform may exist.
- Do not create plugin-native `runFlow`/`compileFlow`, raw CDP, Playwright, or a second browser-kernel path.
- Route asset creation, maintenance, repair, validation, runtime refresh, and recipe generation work to `browser-flow-create`.

## Supporting References

Read these files only when their extra detail is needed:

- `references/asset-routing.md`: platform/capability/recipe matching is ambiguous, missing, stale, or cross-workspace.
- `references/runner-contract.md`: executing a recipe, checking generated outputs, interpreting runner evidence, or diagnosing runtime problems.
- `references/failure-routing.md`: execution fails, verification is weak, patch status is unclear, or asset repair may be needed.

## Procedure

### Step 1: Resolve the asset workspace

1. Identify the workspace that contains `browser-flows/`.
2. If the workspace is ambiguous, inspect likely workspace roots enough to choose.
3. If no safe workspace can be inferred, ask only for the workspace or platform context needed to find `browser-flows/`.

### Step 2: Search the platform catalog

1. Read `browser-flows/INDEX.md` when present.
2. Match the requested platform by display name, alias, domain, URL, product terminology, surface name, or capability name.
3. Read `references/asset-routing.md` if catalog recovery, platform matching, or workspace selection is ambiguous.
4. If `INDEX.md` is missing but `browser-flows/platforms/` exists, inspect platform directories to recover the catalog.
5. If no matching platform exists, route to `browser-flow-create` create mode so platform modeling and the requested operation happen together. Do not manually browse as a substitute.

### Step 3: Match the modeled capability

For a matched platform, inspect only the assets needed to map the user goal:

```text
platforms/<platform-id>/platform.json
platforms/<platform-id>/atlas/capabilities/*.capability.json
platforms/<platform-id>/atlas/surfaces/*.surface.json when needed
platforms/<platform-id>/atlas/views/*.view.json when needed
platforms/<platform-id>/atlas/components/*.component.json when needed
platforms/<platform-id>/atlas/contexts/*.context.json when context matters
```

1. Match the requested operation to a capability by intent, inputs, outputs, success signals, risk metadata, prerequisites, blockers, and `recipeId`.
2. Read `references/asset-routing.md` if the capability match is ambiguous or incomplete.
3. If the platform exists but the capability is missing or incomplete, route to `browser-flow-create` maintain/create mode.
4. Do not infer page capabilities from memory or live clicking when atlas coverage is missing.

### Step 4: Select an executable recipe

1. If the capability references a recipe, read `platforms/<platform-id>/flows/<flow-id>.recipe.json`.
2. Inspect runtime declaration, atlas refs, required params, optional defaults, enum constraints, secret flags, risk metadata, confirmation boundary, bounded waits, success criteria, extraction targets, reliability, verification strength, repair notes, and blockers.
3. If no matching executable recipe exists and execution is needed, route to `browser-flow-create` maintain mode to create and validate the recipe.
4. If the user only asked to inspect assets, stop after reporting the matched atlas and recipe status.

### Step 5: Preflight the runner

Before executing an `agent-side`, `script`, or unspecified v1 recipe, check:

```text
<workspace>/browser-flows/_runtime/agent_browser_flow_runner.py
<workspace>/browser-flows/_runtime/openclaw_browser_client.py
```

Read `references/runner-contract.md` before executing a recipe or diagnosing generated output/runtime behavior.

If either file is missing or stale, route to `browser-flow-create` maintain/repair to refresh runtime via `runtime/distribute_workspace_runtime.py`.

Do not execute generated Python that contains `plan-only`, `BrowserToolClient`, `openclaw tool browser`, raw CDP, Playwright, plugin-native `runFlow`, or plugin-native `compileFlow`.

### Step 6: Build params

1. Build params from the user request and the recipe schema exactly.
2. Read the target entrypoint's actual argument parser or README before choosing command syntax.
3. Prefer writing params to a temporary JSON file and invoking the entrypoint with `@path/to/params.json` when supported.
4. Use inline JSON as the single positional argument only when quoting is safe for the shell.
5. Do not convert recipe params into guessed CLI flags such as `--tagName` or `--description` unless the entrypoint explicitly defines those flags.
6. Supported param types are `string`, `number`, `boolean`, `string[]`, `number[]`, `boolean[]`, and `object`.
7. Ask only for required business values that cannot be safely inferred.
8. Treat `secret: true` values as sensitive and do not print them in reports.

### Step 7: Execute through the canonical runner

Run the workspace-local canonical Python runner in execution mode for normal saved-flow execution.

The runner must load platform, atlas, and recipe assets; validate params; resolve semantic targets from live browser evidence; call Browser Relay through `browser.request`; write trace evidence; validate success criteria; and report patch suggestions without source-asset write-back in execution mode.

Conceptual execution shape:

```json
{
  "runtime": { "kind": "agent-side", "protocol": "agent-browser-flow-v1" },
  "workspaceDir": "/workspace",
  "recipe": { "id": "platform.flowId" },
  "params": {}
}
```

### Step 8: Interpret the result

1. Read the structured runner result before reporting.
2. Read `references/runner-contract.md` when interpreting success evidence, reliability, or generated-output behavior.
3. Use success criteria, extraction outputs, trace path, `patchStatus`, `patchSuggestions`, `appliedPatches`, `rejectedPatches`, `changedAssets`, browser errors, requests, console evidence, reliability, verification strength, blockers, and unsupported primitive classifications.
4. Do not add a separate ad hoc browser recheck to compensate for a recipe that lacks in-run outcome verification.
5. If the recipe cannot prove the business outcome, read `references/failure-routing.md`, report `partial` or `failed verification`, and route to `browser-flow-create` repair/validate.

### Step 9: Offer generated outputs only when useful

Ask whether to generate or refresh a Python runner or thin TypeScript/CLI entrypoint only when:

- a new or repaired executable recipe has just been created or validated by `browser-flow-create`
- the user explicitly asks for a reusable script or CLI
- an existing recipe has no generated output and the user wants a callable artifact

If generated output is declined, keep using the atlas and recipe on future runs. Declining generated output does not make future executions raw browser tasks.

## Routing Rules

Route to `browser-flow-create` when:

- no matching platform exists in `browser-flows/INDEX.md` or `platforms/*/platform.json`
- the platform exists but the needed surface, view, component, or capability is missing
- a capability's inputs, outputs, risks, success signals, prerequisites, or blockers are incomplete
- a capability exists but has no executable recipe and repeatable execution is needed
- a recipe lacks in-run outcome verification or relies on action-only success
- a recipe has hardcoded sample values, incomplete params, stale semantic targets, stale success criteria, or unbounded waits
- a recipe's reliability level is missing, overstated, or unsupported by trace evidence
- pages, components, or semantic targets changed and must be rediscovered
- workspace runtime files are missing or stale
- repeated failures show incomplete platform context, params, success criteria, primitive support, or risk rules

Route to `browser-relay` only when no reusable modeling is relevant and the user explicitly wants one-off browser operation.

Answer directly when the request is conceptual and no asset inspection is needed.

## Failure Handling

When execution fails or verification is weak:

1. Read `references/failure-routing.md`.
2. Classify the failure as missing platform, missing capability, no executable recipe, missing params, stale model, semantic target drift, ambiguous target, missing in-run verification, stale success criteria, risk boundary change, access/session problem, stale runtime, unsupported Browser Relay primitive, or overstated reliability.
3. Ask the user only when access, approval, missing data, or required business input blocks progress.
4. Route asset changes, recipe changes, runtime refresh, repair, and validation to `browser-flow-create` with the user goal, matched assets, observed gap, trace path, and needed mode.
5. Do not patch atlas or recipe source files inside `browser-flow-use`.

## Safety Boundaries

- Treat login, MFA, CAPTCHA, permissions, payments, purchases, postings, messages, approvals, deletes, and external side effects as user-controlled boundaries.
- Do not bypass access controls or invent credentials.
- Respect capability and recipe risk metadata before destructive, approval, payment, messaging, permission, upload, download, social-action, or production-write steps.
- For `dry-run` or `manual-confirm` recipes, stop at the recorded confirmation point unless the user explicitly approves continuing.
- Use recipe-declared bounded `evaluate` only through Browser Relay `act`; do not use `evaluate` as a local script runner.

## Report Format

```text
Workspace: <workspace>
Platform: <platform-id/name or none>
Atlas: <surface/view/capability ids inspected or none>
Flow: <recipe-id/name or none>
Reliability: <level and verification strength, or none>
Action: inspect-atlas | execute | generate-runner | generate-entrypoint | route-create | route-maintain | route-repair | route-relay
Params: <provided/missing/not applicable; redact secrets>
Result: success | failure | blocked | partial | routed
Extracted: <key fields if any>
Trace: <trace path or id if any>
Suggestions: <atlas/recipe suggested changes or none>
Next: <only if user action is needed>
```

## Completion Checklist

- Existing platform assets were searched before browser operation.
- Platform, capability, and recipe selection came from `INDEX.md`, `platform.json`, `atlas/**`, and `flows/*.recipe.json`.
- Existing executable recipes ran only through the canonical workspace-local Python runner.
- User inputs were parameterized according to the recipe schema.
- Success was reported only from runner outcome verification, extraction outputs, and trace evidence.
- Missing platform, capability, recipe, verification, runtime, or freshness coverage was routed to `browser-flow-create`.
- Generated outputs were offered only when useful, and declining them did not bypass atlas/recipe reuse.
