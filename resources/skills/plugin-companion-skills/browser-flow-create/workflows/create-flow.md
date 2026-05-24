<purpose>
Create Web Platform Atlas assets from platform materials and live browser evidence. The job is to model what a web platform exposes — surfaces, views, components, entities, contexts, capabilities, evidence, and optional executable recipes — not to record a single happy-path click trace.
</purpose>

<required_reading>
@resources/skills/plugin-companion-skills/browser-flow-create/references/authoring-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/capability-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/parameter-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/validation-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/agent-runner-contract.md
@resources/skills/plugin-companion-skills/browser-flow-create/references/generated-output-contract.md
</required_reading>

<downstream_awareness>
Created assets feed into `browser-flow-use`. Future agents discover platforms through `browser-flows/INDEX.md`, inspect `platform.json`, read `atlas/**` to understand surfaces/views/components/capabilities, and execute only capabilities that have `flows/*.recipe.json` through the canonical Python Browser Flow runner using a minimal OpenClaw browser gateway client for `browser.request`. Browser Flow execution must not require plugin-native flow actions, raw CDP, Playwright, or a second browser kernel.
</downstream_awareness>

<core_model>
Always model in this order:

```text
WebPlatform -> Surface -> View -> Region -> Component -> Capability -> Recipe
```

A recipe is optional. A capability can be mapped and useful without being executable. Do not let recipe authoring replace page-by-page platform modeling.
</core_model>

<process>

<step name="source_intake" priority="first">
Accept platform materials in any form: operation manual, PDF, document, wiki, URL, markdown, screenshot, video, current browser page, spoken instruction, prior trace, failed run, or conversation summary.

Extract an `AtlasSourceDigest` using the Source Intake Output shape from `authoring-contract.md`:
- platform hints: name, aliases, domains, base URL, platform type, login hints, terminology, primary entities
- surface and view hints
- described capabilities, possible inputs, outputs, success states, risk signals, and unknowns

Do not generate recipes directly from source text. Source material creates hypotheses; browser evidence verifies them.
</step>

<step name="setup_check">
Confirm or infer:
- workspace where `browser-flows/` will be written
- platform name/base URL if known
- approved browser environment or test account
- requested output depth: atlas only, atlas plus selected recipes, python runner, typescript entrypoint, cli entrypoint

If login, MFA, CAPTCHA, permission, payment, purchase, messaging, posting, or approval is required, pause for the user. Do not bypass access controls.
</step>

<step name="platform_boundary">
Build or update `platform.json`.

Confirm platform boundary using login/session, domains, product shell, UI patterns, terminology, success/error patterns, and risk rules. Start with one platform and split only when auth, risk, UI, terminology, or product shell differs.
</step>

<step name="browser_archaeology">
Use the real browser to verify source claims with current Browser Relay primitives only.

For each relevant surface/view:
1. Open or focus the logged-in or approved session.
2. Use `snapshot` for semantic understanding and short-lived refs.
3. Use safe `act` requests only when needed to reveal menus, tabs, drawers, modals, filters, pagination, or non-risky state.
4. Capture visible inventory: navigation, regions, components, fields, filters, toolbar actions, cards, feeds, tables, row actions, forms, modals, drawers, toasts, uploads, downloads, media, comments, editors, metrics, charts, and links when observable.
5. Capture `requests`, `errors`, `console`, screenshots, or PDF evidence when useful and supported.
6. Mark unsupported artifact capture, popup handling, raw CDP needs, active-session fetch, or unobservable success as partial or blocked.
7. Record evidence in the `AtlasArchaeologyTrace` shape.

If source material conflicts with browser evidence, trust browser evidence and record the mismatch.
</step>

<step name="surface_view_archive">
Write or update first-class atlas files before considering recipes:

```text
<workspace>/browser-flows/platforms/<platform-id>/atlas/surfaces/<surface-id>.surface.json
<workspace>/browser-flows/platforms/<platform-id>/atlas/views/<view-id>.view.json
<workspace>/browser-flows/platforms/<platform-id>/atlas/components/<component-id>.component.json
<workspace>/browser-flows/platforms/<platform-id>/atlas/entities/<entity-id>.entity.json
<workspace>/browser-flows/platforms/<platform-id>/atlas/contexts/<context-id>.context.json
```

Each view should list its regions, components, supported capabilities, evidence refs, unknowns, blockers, context, and freshness. Components should record interaction patterns instead of vendor classes or brittle selectors.
</step>

<step name="capability_mining">
Convert page/component inventory into platform capabilities:

```text
View -> Region -> Component -> Capability
```

Group UI elements into user-facing functions such as search, filter, browse, open detail, extract, export, upload, edit, publish, comment, like, add to cart, checkout, create issue, review PR, approve, delete, sync, or generate report.

For each capability write or update:

```text
<workspace>/browser-flows/platforms/<platform-id>/atlas/capabilities/<capability-id>.capability.json
```

Record intent, surface/view/component ids, inputs, outputs, risk, execution mode, automation status, optional recipe id, prerequisites, success signals, evidence refs, freshness, unknowns, and blockers.
</step>

<step name="automation_selection">
Classify each capability:
- `auto`: safe read/search/extract/draft workflow in the approved environment
- `read-only`: inspect, search, filter, or extract without side effects
- `dry-run`: can navigate and fill until a concrete risky confirmation boundary
- `manual-confirm`: requires explicit user approval at a concrete browser state
- `blocked`: login, permission, data, primitive, or evidence gap blocks automation
- `not-suitable`: unsafe, unverifiable, permission bypass, payment bypass, or unsupported external side effect

Prefer a small set of high-confidence executable recipes over many speculative recipes. Keep non-executable capabilities in the atlas.
</step>

<step name="parameter_discovery" gate="required_when_recipe_selected">
For every selected executable capability, define its callable interface before authoring steps.

Use the Parameter Question Protocol and produce a `FlowParameterContract` from `parameter-contract.md`.

Inputs come from the capability model. Identify required params, optional params, defaults, enum constraints, secret flags, extracted params, risk-affecting params, validation sample values, and fixed platform labels.

Hard gate: if business inputs are unclear, ask the user. Do not hardcode sample values into recipe logic.
</step>

<step name="recipe_authoring">
Author recipes only for selected capabilities:

```text
<workspace>/browser-flows/platforms/<platform-id>/flows/<flow-id>.recipe.json
```

A recipe must reference its `capabilityId`, surface/view/component ids when useful, param schema, semantic targets, success criteria, extraction targets, and risk metadata.

Use semantic targets first. Use `valueFrom` or equivalent param references for business inputs. Do not persist snapshot refs, component-library classes, raw CSS selectors, long XPath, or nth-child paths as primary targets. Browser Relay resolves executable locators from current page evidence at action time.
</step>

<step name="browser_validation" gate="required_when_recipe_selected">
Execute each selected recipe through Agent-side Browser Flow Protocol v1 with safe real params.

The runner must call existing Browser Relay primitives step by step through `browser.request`, resolve semantic targets from live page evidence, write trace evidence, and verify required params, clear missing-param failure, safe/draft path success, risky confirmation boundary, success criteria, and extraction targets. If the minimal OpenClaw browser gateway client is unavailable, validation is blocked rather than replaced with raw CDP or Playwright.

Do not mark a recipe verified until browser evidence proves success state or extracted data. Atlas-only capabilities can be mapped without recipe validation, but their automation status must not be `validated`.
</step>

<step name="generated_outputs">
If requested, generate the canonical `python` runner or thin `typescript`/`cli` entrypoints according to the Generated Output Contract.

Generated outputs must accept params. Python executes Agent-side Browser Flow Protocol v1 through the minimal OpenClaw browser gateway client for `browser.request`; TypeScript and CLI outputs must invoke the Python runner instead of reimplementing workflow logic.
</step>

<step name="platform_index">
Update:

```text
<workspace>/browser-flows/INDEX.md
```

Keep it concise: platform id, display name, aliases, domains, platform type, one-line summary, key surfaces, and important executable capability ids. Do not write platform summaries into AGENTS files.
</step>

<step name="final_report">
Report atlas coverage, mapped surfaces/views/components/capabilities, executable recipe ids, callable interfaces, required/optional params, v1 execution shape, generated Python runner or entrypoints, risk boundaries, browser evidence, trace paths, index update, blockers, and an `AtlasValidationReport`.
</step>

</process>

<success_criteria>
- Source digest created from materials and browser evidence
- Platform boundary and platform metadata recorded
- Surface/view/component archive written before recipes
- Capabilities modeled as first-class atlas assets
- Recipes are optional executable projections of capabilities
- Params schema has no hardcoded sample values
- Risk classification and confirmation boundary are explicit
- Browser Relay primitive support is truthful; unsupported needs are partial or blocked
- Agent-side Browser Flow Protocol v1 validates selected recipes with safe params and trace evidence
- Requested generated Python runner or entrypoints accept params and execute through the v1 contract
- `browser-flows/INDEX.md` is updated
- Final report includes atlas coverage, callable interfaces when present, and blockers
</success_criteria>
