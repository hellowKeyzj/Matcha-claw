<purpose>
Maintain existing Web Platform Atlas assets when platform surfaces/views/components drift, source material adds missing coverage, user corrections change the intended model, executable recipes break, or generated outputs become stale.
</purpose>

<required_reading>
@resources/skills/plugin-companion-skills/browser-flow-create/references/authoring-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/capability-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/parameter-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/validation-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/agent-runner-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/generated-output-contract.md
</required_reading>

<process>

<step name="load_current_assets" priority="first">
Inspect current assets:

```text
<workspace>/browser-flows/INDEX.md
<workspace>/browser-flows/platforms/<platform-id>/platform.json
<workspace>/browser-flows/platforms/<platform-id>/atlas/**
<workspace>/browser-flows/platforms/<platform-id>/flows/*.recipe.json
<workspace>/browser-flows/platforms/<platform-id>/evidence/**/*.trace.json
```

Classify the maintenance request as missing surface/view/component/capability coverage, stale page structure, stale platform metadata, incomplete capability inputs, stale recipe params, failed run follow-up, user correction, or generated output refresh.
</step>

<step name="rebuild_affected_context">
Rebuild only the affected slice:

```text
WebPlatform -> Surface -> View -> Region -> Component -> Capability -> Recipe
```

Use current materials, user correction, existing traces, browser evidence, coverage status, prerequisites, freshness, environment/context policy, async job evidence, and complex component notes. Do not patch from memory alone.
</step>

<step name="browser_reverification" gate="required">
Open or focus the current platform page with Browser Relay. Verify changed navigation, routes, visible regions, components, labels, fields, row actions, modals, drawers, required inputs, success states, risk prompts, and output structure.

Use only current Browser Relay primitives. Record unsupported raw CDP, active-session fetch, popup, download, or unobservable success needs as partial or blocked.

Record source mismatches and page drift in a new archaeology trace.
</step>

<step name="update_source_assets">
Update only the affected assets:

- `platform.json` for domains, platform type, login checks, terminology, UI hints, success/error patterns, context, or risk rules
- `atlas/surfaces/*.surface.json` for entry patterns, related views, entities, and context
- `atlas/views/*.view.json` for regions, components, supported capabilities, evidence, freshness, unknowns, and blockers
- `atlas/components/*.component.json` for component type, labels, fields/actions/options/columns, interaction patterns, and supported capabilities
- `atlas/entities/*.entity.json` and `atlas/contexts/*.context.json` when entity/context modeling changes
- `atlas/capabilities/*.capability.json` for intent, inputs, outputs, risk, execution mode, automation status, prerequisites, success signals, evidence, unknowns, and blockers
- `flows/<flow-id>.recipe.json` only when an executable capability's steps, params, semantic targets, success criteria, extraction targets, or risk metadata change
- `browser-flows/INDEX.md` for platform, key surface, or executable capability discoverability changes

Generated files are derived outputs; regenerate only after atlas or recipe source changes.
</step>

<step name="validate_changed_assets" gate="required">
Validate changed atlas assets against browser evidence. For changed recipes, execute through Agent-side Browser Flow Protocol v1 with safe params. If shared platform metadata or component identity changed, validate at least one representative capability or recipe using that metadata.
</step>

<step name="refresh_generated_outputs">
If the user requested a Python runner or TypeScript/CLI entrypoints, or existing generated outputs would become stale, regenerate derived outputs and verify the Python runner accepts params, uses the minimal OpenClaw browser gateway client for `browser.request`, and TypeScript/CLI invoke it without duplicating runtime logic.
</step>

<step name="report_maintenance_diff">
Report reason, affected atlas slice, assets changed, recipes validated, generated outputs refreshed, evidence trace paths, blockers, and an `AtlasValidationReport`.
</step>

</process>

<success_criteria>
- Existing platform boundary reused unless evidence requires a split
- Affected context rebuilt from atlas assets + browser evidence
- Atlas records updated before dependent recipes
- Changed recipes validated through Agent-side Browser Flow Protocol v1
- Params remain parameterized with no hardcoded samples
- Unsupported Browser Relay primitive needs are recorded as partial or blocked
- `INDEX.md` updated when platform, surface, or executable capability discoverability changes
- Generated outputs refreshed when needed
</success_criteria>
