<purpose>
Audit existing Web Platform Atlas and Browser Flow recipe assets for completeness, page-by-page coverage, evidence quality, safety, generated-output correctness, and future-agent discoverability.
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

<step name="load_asset_set" priority="first">
Inspect:

```text
<workspace>/browser-flows/INDEX.md
<workspace>/browser-flows/platforms/<platform-id>/platform.json
<workspace>/browser-flows/platforms/<platform-id>/atlas/**
<workspace>/browser-flows/platforms/<platform-id>/flows/*.recipe.json
<workspace>/browser-flows/platforms/<platform-id>/evidence/**/*.trace.json
```
</step>

<step name="check_platform_completeness">
Verify platform assets include id, display name, aliases when known, domains or base URL, platform type, primary entities, login/session check, contexts when known, terminology, success/error patterns, risk rules, and important surfaces/executable capability ids in `INDEX.md`.
</step>

<step name="check_atlas_completeness">
Verify first-class atlas coverage:

- surfaces have purpose, entry patterns, related views, entities, context, evidence, unknowns, and blockers
- views have regions, components, supported capabilities, route/entry path, context, evidence, freshness, unknowns, and blockers
- components have type, label/name/title when visible, fields/actions/options/columns when observable, interaction patterns, supported capabilities, evidence, unknowns, and blockers
- entities and contexts exist when platform behavior depends on durable objects or role/location/account/device/workspace context
- capabilities have intent, surface/view/component refs, inputs, outputs, risk, execution mode, automation status, prerequisites, success signals, evidence, freshness, unknowns, and blockers
</step>

<step name="check_recipe_completeness">
For each recipe, verify it references an existing capability, has explicit business intent through that capability, complete params schema, no hardcoded sample values, semantic targets, interaction patterns, no primary snapshot refs or brittle selectors, success criteria, extraction targets when applicable, risk metadata, confirmation boundary, browser trace evidence, prerequisites, environment/context policy, freshness, async or complex component notes, and evidence boundary.
</step>

<step name="check_generated_outputs">
If generated outputs exist or were requested, verify the Python runner accepts params, calls the recipe by id or embedded recipe with params, and uses the minimal OpenClaw browser gateway client for `browser.request`. Verify TypeScript and CLI entrypoints invoke the Python runner instead of reimplementing workflow logic. They must not be one-off scripts with fixed sample paths, titles, accounts, or dates.
</step>

<step name="score_assets">
Classify each atlas asset and recipe:

- `ready`: passes definition of done for its intended depth
- `partial`: useful but missing optional evidence, generated output, scenario validation, or non-critical metadata
- `needs-maintenance`: stale, hardcoded, missing params, missing atlas refs, or structurally incomplete
- `blocked`: permission, login, unsafe risk, missing data, unsupported primitive, or unverifiable success
- `unknown`: not enough evidence yet
- `not-suitable`: unsafe or cannot be represented honestly

Route `needs-maintenance` and `blocked` cases to maintain or repair workflow.
</step>

<step name="report_validation">
Report an `AtlasValidationReport` with platform, audited surfaces/views/components/capabilities/recipes, ready assets, partial gaps, needs-maintenance reasons, blockers, generated output status, index status, evidence paths, and recommended next workflow.
</step>

</process>

<success_criteria>
- Platform discoverability checked
- Atlas surface/view/component/capability coverage checked
- Recipe parameterization checked where recipes exist
- Browser trace evidence checked
- Generated outputs checked for parameterized execution
- Unsupported Browser Relay primitive gaps are explicit
- Each asset receives ready/partial/needs-maintenance/blocked/unknown/not-suitable status
- Next workflow is recommended for gaps
</success_criteria>
