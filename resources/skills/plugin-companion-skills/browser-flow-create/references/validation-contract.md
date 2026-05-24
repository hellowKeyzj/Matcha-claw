# Web Platform Atlas Validation Contract

A Browser Flow asset set is complete only when the atlas is discoverable, evidence-backed, and honest about what is mapped, executable, partial, blocked, or unknown.

## Definition of Done

Do not report atlas or recipe work as completed unless all relevant items pass:

1. Platform boundary is correct.
2. `platform.json` records domains/base URL, platform type, context hints, terminology, success/error patterns, and risk rules when known.
3. Surfaces are modeled separately from views.
4. Views record regions, components, supported capabilities, context, evidence, unknowns, and freshness.
5. Components record labels, type, interaction pattern, actions/fields/columns/options when observable, and evidence.
6. Capabilities record intent, location, inputs, outputs, risk, execution mode, automation status, prerequisites, success signals, evidence, unknowns, and blockers.
7. Capabilities can exist without recipes; recipes exist only as executable projections of capabilities.
8. Recipe params schema is complete when a recipe exists.
9. Required params have descriptions; optional params have defaults or omission behavior.
10. Sample values are not hardcoded into recipe logic.
11. Semantic targets are used before locator fallback.
12. Primary atlas/recipe targets are not snapshot refs, component-library classes, raw CSS selectors, long XPath, or nth-child paths.
13. Risky capabilities and recipe steps have risk metadata and confirmation boundaries.
14. At least one safe real param set was validated in browser for each `validated` recipe.
15. Missing required params fail clearly for executable recipes.
16. Success state or extracted data is proven by trace evidence for executable recipes.
17. Requested generated outputs accept params, keep Python as the canonical runner, and use the minimal OpenClaw browser gateway client for `browser.request`.
18. Unsupported Browser Relay primitives, login, permission, popup, download, raw CDP, active-session fetch, or unobservable success gaps are marked partial or blocked.
19. Environment/context/freshness are explicit.
20. `<workspace>/browser-flows/INDEX.md` is updated.

## Validation Matrix

| Dimension | Required evidence |
|---|---|
| Platform | boundary, domains/base URL, type, terminology, context, risk rules |
| Surfaces | entry patterns, related views, entities, context, evidence refs |
| Views | regions, components, capabilities, route/entry path, freshness, evidence refs |
| Components | type, label, fields/actions/options/columns, interaction pattern, evidence refs |
| Capabilities | intent, inputs, outputs, risk, execution mode, automation status, prerequisites, success signals |
| Params | schema, required/optional/defaults, no hardcoded samples for recipes |
| Safe execution | Agent-side Browser Flow Protocol v1 execution succeeds with safe params for validated recipes |
| Missing input | required param omission fails with clear error for executable recipes |
| Risk boundary | destructive/submit/bulk/payment/approval/social/external actions stop before confirmation unless approved |
| Success | toast, URL, table row, entity state, extraction result, file evidence, request, or visible state proves completion |
| Trace | archaeology/execution trace records sources, observations, actions, errors, requests, recovery, unknowns |
| Generated output | Python runner accepts params, targets the v1 runner contract, and calls `browser.request` through the minimal OpenClaw browser gateway client; TypeScript/CLI entrypoints invoke Python without duplicating runtime logic |
| Environment/context | sandbox/staging/production/unknown and read-only/dry-run/manual-confirm/auto/blocked/not-suitable policy are explicit |
| Unsupported primitives | unsupported Browser Relay needs are recorded as partial or blocked |
| Index | platform, key surfaces, and important executable capabilities are discoverable in `browser-flows/INDEX.md` |

## Validation Report Shape

Every create, maintain, repair, or validate workflow report must include this structure:

```ts
type AtlasValidationReport = {
  platformId: string
  audited: {
    surfaces: string[]
    views: string[]
    components: string[]
    capabilities: string[]
    recipes: string[]
  }
  statusByAsset: Record<string, 'ready' | 'partial' | 'needs-maintenance' | 'blocked' | 'unknown' | 'not-suitable'>
  checks: Array<{
    assetId: string
    dimension: 'platform' | 'surface' | 'view' | 'component' | 'capability' | 'params' | 'safe-execution' | 'missing-input' | 'risk-boundary' | 'success' | 'trace' | 'generated-output' | 'environment-context' | 'unsupported-primitive' | 'index'
    status: 'pass' | 'partial' | 'fail' | 'blocked'
    evidence: string[]
    gap?: string
    nextWorkflow?: 'create-flow' | 'maintain-flow' | 'repair-flow' | 'validate-flow'
  }>
  generatedOutputs: Record<string, Array<'python' | 'typescript' | 'cli'>>
  tracePaths: string[]
  blockers: string[]
  recommendedNextWorkflow?: 'create-flow' | 'maintain-flow' | 'repair-flow' | 'validate-flow'
}
```

A report without evidence paths or explicit blockers is incomplete.

## Status Labels

- `ready`: all required checks pass for the asset's intended depth.
- `partial`: usable atlas coverage exists but non-critical evidence, scenario coverage, generated output, or primitive support is missing.
- `needs-maintenance`: stale, hardcoded, missing params, structurally incomplete, or unverified.
- `blocked`: permission, login, MFA, CAPTCHA, risky approval, missing data, unsupported primitive, or unverifiable success prevents completion.
- `unknown`: no source or browser evidence yet.
- `not-suitable`: unsafe, requires permission bypass, unsupported external side effect, or cannot be represented honestly.

## Blockers

Block instead of pretending completion when:

- browser login or permission is missing
- required files, params, records, or safe validation data are unavailable
- source material conflicts with browser evidence and cannot be resolved
- the final action is destructive, payment, purchase, public posting, external message, permission change, or approval without explicit approval
- success cannot be observed or extracted
- generated outputs cannot accept params
- current Browser Relay primitives cannot support the required browser operation
