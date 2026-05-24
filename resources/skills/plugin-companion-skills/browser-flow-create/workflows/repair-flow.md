<purpose>
Repair an executable Browser Flow recipe or its supporting atlas records after Agent-side Browser Flow Protocol v1 execution failure, runtime recovery, recipe change suggestions, page drift, component drift, capability mismatch, or user correction.
</purpose>

<required_reading>
@resources/skills/plugin-companion-skills/browser-flow-create/references/authoring-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/capability-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/parameter-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/validation-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/agent-runner-contract.md
</required_reading>

<process>

<step name="read_failure_evidence" priority="first">
Collect the failed v1 execution result, trace path or payload, platform id, capability id, recipe id, failed step, `recoveryEvidence`, browser `errors`, browser `requests`, and any user correction or screenshot. If the trace contains suggested atlas or recipe patches from a future runner, inspect them as evidence only; current v1 execution does not require automatic patch application.
</step>

<step name="classify_failure">
Classify the failure:

- atlas drift: surface, view, region, component, or capability no longer matches the page
- semantic target drift: label, business context, intended target, or component action changed
- runtime semantic locator resolution failure: atlas/semantic target is still right but runtime selected the wrong executable node
- stale ref/locator fallback or recovery evidence
- hidden, offscreen, virtualized, iframe, drawer, modal, or covered target
- page layout, route, navigation, tab, feed, pagination, or popup behavior changed
- missing or wrong param
- hardcoded sample value
- capability inputs/outputs stale
- success criteria or extraction target stale
- risk boundary changed
- permission, login, session, MFA, CAPTCHA, role, context, or data prerequisite problem
- unsupported Browser Relay primitive or unsafe operation
</step>

<step name="decide_repair_mode" gate="required">
- Repair atlas records before recipes when the platform model is stale.
- Treat runtime atlas/recipe change suggestions as evidence only unless the current runner explicitly supports verified patch application.
- Re-run browser archaeology before applying risky, unverified, or structural changes.
- Repair capability inputs, param schema, atlas refs, and recipe references when params are incomplete or hardcoded.
- Ask the user when login, permissions, MFA, CAPTCHA, approval, missing data, or missing business input blocks execution.
</step>

<step name="revalidate_repair" gate="required">
Validate repaired atlas records against browser evidence. Execute the repaired recipe through Agent-side Browser Flow Protocol v1 with safe params. Repair is not complete until trace evidence proves success state, extracted data, or a correctly enforced risk boundary.
</step>

<step name="persist_repair">
Update only affected assets:

```text
atlas/surfaces/*.surface.json
atlas/views/*.view.json
atlas/components/*.component.json
atlas/capabilities/*.capability.json
atlas/entities/*.entity.json
atlas/contexts/*.context.json
flows/<flow-id>.recipe.json
evidence/archaeology/<timestamp>-<scope>.trace.json
browser-flows/INDEX.md if platform, surface, or executable capability summary changed
```

Regenerate the Python runner or TypeScript/CLI entrypoints if requested or if existing generated outputs would become stale.
</step>

<step name="report_repair">
Report an `AtlasRepairDiff`:

```ts
type AtlasRepairDiff = {
  platformId: string
  capabilityId?: string
  flowId?: string
  failureClassification: string
  changedAssets: Array<{ path: string; reason: string }>
  atlasChanges: Array<{
    assetId: string
    field: 'surface' | 'view' | 'region' | 'component' | 'entity' | 'context' | 'capability' | 'risk' | 'successSignal' | 'evidence' | 'freshness'
    before: string
    after: string
    evidenceRefs: string[]
  }>
  recipeChanges: Array<{
    stepId?: string
    field: 'params' | 'atlasRef' | 'semanticTarget' | 'step' | 'successCriteria' | 'extractionTarget' | 'riskMetadata' | 'generatedOutput'
    before: string
    after: string
    evidenceRefs: string[]
  }>
  riskHandling: 'browser-reverified' | 'manual-confirm-required' | 'blocked'
  validation: {
    safeParamsUsed: string[]
    successEvidence: string[]
    tracePath: string
  }
  generatedOutputsRefreshed: Array<'python' | 'typescript-entrypoint' | 'cli-entrypoint'>
  blockers: string[]
  nextUserAction?: string
}
```

Include failure classification, repair diff, risk handling, evidence trace path, generated outputs refreshed, and next user action if blocked.
</step>

</process>

<success_criteria>
- Failure classified from trace/browser evidence
- Atlas drift repaired before recipe drift when applicable
- Risky or structural patches are not applied blindly
- Params remain parameterized
- Repaired atlas assets are browser-evidenced
- Repaired recipe passes Agent-side Browser Flow Protocol v1 execution with safe params or stops at the correct risk boundary
- New archaeology trace records the repair evidence
- Generated outputs refreshed when stale or requested
</success_criteria>
