# Web Platform Atlas Authoring Contract

Use this reference only after `browser-flow-create` is triggered and the request requires source-driven platform modeling, atlas maintenance, recipe repair, or validation.

Sources are platform materials in any form: operation manuals, PDFs, docs, wiki pages, screenshots, videos, spoken instructions, current browser pages, prior traces, failed runs, or user corrections.

## Runtime Boundary

Web Platform Atlas authoring and Browser Flow execution must stay aligned with the current Browser Relay action contract. The browser plugin provides browser primitives and live evidence; it does not need to understand platforms, capabilities, recipes, or generated outputs.

Current supported Browser Relay actions are:

- session and tab management: `start`, `stop`, `status`, `profiles`, `tabs`, `open`, `focus`, `close`, `closeagenttabs`, `close_agent_tabs`
- page observation and navigation: `snapshot`, `navigate`, `scroll`, `highlight`
- step execution: `act` with click, type, fill, select, press, hover, drag, wait, resize, evaluate, scroll, close, and scrollIntoView requests
- artifacts and browser evidence: `screenshot`, `pdf`, `upload`, `dialog`, `requests`, `errors`, `console`, `storage`, `cookies`

There is no current Browser Relay raw CDP action, active-session fetch primitive, or plugin-native `runFlow`/`compileFlow`. If a page model, capability, or recipe requires unsupported browser control, mark that part partial or blocked instead of inventing support.

Browser Flow v1 is executed by one canonical Python runner that calls Browser Relay primitives through a minimal OpenClaw browser gateway client using `browser.request`. CLI or TypeScript outputs may invoke the Python runner but must not reimplement execution. If that gateway client is unavailable, generated Python execution is blocked rather than replaced with raw CDP, Playwright, or plugin-native flow actions.

## Accepted Sources

```ts
type AtlasAuthoringSource =
  | { kind: 'pdf'; path: string }
  | { kind: 'document'; path: string }
  | { kind: 'markdown'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'wiki'; url: string }
  | { kind: 'screenshot'; path: string }
  | { kind: 'video'; path: string }
  | { kind: 'currentPage'; targetId?: string }
  | { kind: 'trace'; path: string }
  | { kind: 'failedRun'; tracePath?: string; summary: string }
  | { kind: 'userCorrection'; content: string }
  | { kind: 'text'; content: string }
  | { kind: 'conversation'; summary: string }
```

If a source is missing, inaccessible, or ambiguous, record the unknown. Do not invent platform facts, selectors, URLs, credentials, success states, or capabilities.

## Source Intake Output

Every source intake step must produce a compact `AtlasSourceDigest` before browser archaeology begins. Source material creates hypotheses; browser evidence verifies them.

```ts
type AtlasSourceDigest = {
  sourceRefs: Array<{
    id: string
    kind: AtlasAuthoringSource['kind']
    location?: string
    summary: string
    confidence: 'source-only' | 'browser-confirmed' | 'conflicting' | 'unknown'
  }>
  platformHints: {
    name?: string
    aliases?: string[]
    baseUrl?: string
    domains?: string[]
    platformType?: string
    loginHints?: string[]
    terminology?: string[]
    primaryEntities?: string[]
  }
  surfaceHints: Array<{
    name: string
    entryPath?: string[]
    routeHint?: string
    sourceRefIds: string[]
  }>
  viewHints: Array<{
    name: string
    surface?: string
    routeHint?: string
    sourceRefIds: string[]
  }>
  describedCapabilities: Array<{
    name: string
    surface?: string
    view?: string
    intent: string
    possibleInputs: string[]
    possibleOutputs: string[]
    successSignals: string[]
    riskSignals: string[]
    sourceRefIds: string[]
  }>
  unknowns: string[]
}
```

Minimum rules:

- Every described capability must point back to one or more `sourceRefIds`.
- Browser-unverified claims remain hypotheses, not atlas facts.
- Conflicts between sources are recorded in `unknowns` until browser evidence resolves them.

## Workspace Assets

Write assets only under:

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

`platform.json` and `atlas/**` are source assets. `flows/*.recipe.json` exists only for executable capabilities. `generated/**` is derived output. Evidence files explain why atlas facts and recipes are trusted.

## Archaeology Trace Shape

Every browser archaeology pass must write or prepare a trace with enough evidence for future agents to avoid rediscovery:

```ts
type AtlasArchaeologyTrace = {
  traceId: string
  platformId: string
  scope: 'platform' | 'surface' | 'view' | 'component' | 'capability' | 'recipe'
  scopeId?: string
  createdAt: string
  mode: 'create' | 'maintain' | 'repair' | 'validate'
  sources: AtlasAuthoringSource[]
  sourceDigest: AtlasSourceDigest
  platformBoundary: {
    decision: string
    domains: string[]
    baseUrl?: string
    contextEvidenceRefs: string[]
  }
  atlasCoverage: {
    surfaces: Array<{ id: string; status: AtlasCoverageStatus; evidenceRefs: string[]; unknowns: string[]; blockers: string[] }>
    views: Array<{ id: string; surfaceId?: string; status: AtlasCoverageStatus; evidenceRefs: string[]; unknowns: string[]; blockers: string[] }>
    components: Array<{ id: string; viewId?: string; status: AtlasCoverageStatus; evidenceRefs: string[]; unknowns: string[]; blockers: string[] }>
    capabilities: Array<{ id: string; viewId?: string; status: AtlasCoverageStatus; risk: CapabilityRisk; evidenceRefs: string[]; unknowns: string[]; blockers: string[] }>
  }
  observations: Array<{ id: string; summary: string; evidenceType: 'snapshot' | 'screenshot' | 'request' | 'error' | 'console' | 'user' }>
  actions: Array<{ step?: string; action: string; target?: string; result: 'success' | 'failed' | 'skipped'; evidenceRefs: string[] }>
  requests: Array<{ id: string; method: string; url: string; status?: number; purpose?: string }>
  errors: Array<{ id: string; source: 'browser' | 'network' | 'console' | 'runtime'; message: string; step?: string }>
  recoveryEvidence?: unknown[]
  atlasChangeSuggestions?: unknown[]
  recipeChangeSuggestions?: unknown[]
  unknowns: string[]
  blockers: string[]
}

type AtlasCoverageStatus = 'unknown' | 'discovered' | 'mapped' | 'candidate' | 'recipe-ready' | 'validated' | 'generated' | 'partial' | 'blocked' | 'not-suitable'

type CapabilityRisk = 'read-only' | 'extract' | 'download' | 'upload' | 'draft' | 'write' | 'approval' | 'destructive' | 'payment' | 'social-action' | 'permission-change' | 'external-message' | 'unknown'
```

Do not store credentials, cookies, tokens, sensitive request bodies, or long raw DOM dumps in traces.

## Environment, Context, and Freshness

Record context for every mapped or validated capability:

- environment: sandbox, staging, production, or unknown
- execution mode: read-only, dry-run, manual-confirm, auto, blocked, or not-suitable
- auth/role/permission/context: anonymous, logged-in, role, city, locale, device, repository, shop, account, workspace, or unknown

Record freshness metadata for atlas records and recipes: `lastObservedAt`, `lastValidatedAt`, `lastKnownUrl`, `lastKnownPageSignature` when available, confidence, stale threshold, and failure count.

## Evidence Rules

- Use `snapshot` for semantic page understanding, short-lived refs, ARIA/visible structure, and current state.
- Use `screenshot`, `requests`, `errors`, `console`, `pdf`, `storage`, or `cookies` only when useful and supported by the current Browser Relay action contract.
- Use `act.evaluate` only as bounded in-page logic for declared page reads or checks; never use it to click, fill, submit, navigate, execute local files, run shells, run package managers, or replace semantic targets.
- Unsupported download capture, popup handling, active-session fetch, raw CDP, or unobservable success must be recorded as partial or blocked.
- Locator fallbacks are evidence, not primary atlas identity.

## Index

`INDEX.md` should contain a concise platform catalog: platform ids, display names, aliases, domains, platform type, one-line summary, key surfaces, and important executable capability ids. Do not duplicate platform summaries into AGENTS files.
