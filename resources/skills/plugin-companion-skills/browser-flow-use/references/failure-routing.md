# Failure Routing Reference

Read this file when a saved recipe fails, recovers weakly, returns partial verification, or cannot prove the user's requested business outcome.

## Evidence to inspect

Inspect the runner result and trace before deciding next steps:

- failed step and step kind
- resolved semantic target and fallback evidence
- `patchStatus`
- `patchSuggestions`
- `appliedPatches`
- `rejectedPatches`
- `changedAssets`
- success criteria results
- extraction outputs
- browser errors, requests, and console evidence when available
- reliability level and verification strength
- blockers and unsupported primitive classifications

## Failure classes

Classify failures into one or more of these categories:

- no modeled platform
- missing surface, view, region, component, or capability coverage
- capability exists but no executable recipe
- missing, wrong, or hardcoded params
- stale platform, page, component, or capability model
- semantic target drift
- runtime semantic locator resolution failure
- ambiguous target caused by duplicate labels or missing scope
- hidden, offscreen, virtualized, iframe, modal, drawer, or covered target
- navigation, route, tab, popup, pagination, or refresh drift
- missing context, role, session, prerequisite data, or account state
- login, MFA, CAPTCHA, permission, approval, or access-control blocker
- unsupported Browser Relay primitive
- risk boundary changed
- stale success criteria or extraction target
- missing in-run outcome verification
- postcondition failure or visible-state mismatch
- weak, stale, partial, or externally rechecked evidence
- unbounded UI wait or timeout risk
- missing or stale workspace runtime
- reliability level overstated relative to trace evidence

## Route by failure class

- Missing platform: route to `browser-flow-create` create mode.
- Missing surface/view/component/capability: route to `browser-flow-create` maintain/create mode.
- No executable recipe: route to `browser-flow-create` maintain mode when repeatable execution is needed.
- Stale atlas or semantic target drift: route to `browser-flow-create` maintain or repair mode.
- Missing params: ask for only the missing business values and rerun the same recipe.
- Hardcoded sample values or incomplete param schema: route to `browser-flow-create` repair mode.
- Missing in-run outcome verification: route to `browser-flow-create` repair/validate mode.
- Weak or overstated reliability: route to `browser-flow-create` validate or repair mode.
- Missing runtime: route to `browser-flow-create` maintain/repair to refresh runtime.
- Access, MFA, CAPTCHA, approval, or permission blockers: ask the user for the approved access path or explicit approval; do not bypass controls.

## Patch status interpretation

- `no_changes`: the persisted model still satisfied the observed page and user goal. Report this and do not rewrite assets.
- `write_back`: verified non-risky deltas were persisted by the runner. Report changed assets and evidence.
- `suggest_only`: useful evidence exists but source asset changes need `browser-flow-create` judgment.
- `blocked`: risk, permission, runtime, or execution boundary prevents automatic progress.

## Reporting failures

Report:

- exact failed step or verification point
- expected outcome
- observed state
- failure class
- trace path
- whether rerun is possible with params only
- whether `browser-flow-create` must create, maintain, repair, or validate assets
- next user action only when access, approval, data, or business input is missing

Do not continue with manual browser clicking to make a failed modeled flow appear successful.