---
name: browser-flow-create
description: Creates and maintains Web Platform Atlas assets from platform materials and live browser evidence. Use when a website or web product should be preserved as a reusable AI-understandable model: surfaces, views, regions, components, entities, contexts, capabilities, evidence, and optional executable Browser Flow recipes with generated Python runner or TypeScript/CLI entrypoints. Applies to public websites, SaaS apps, commerce, social/feed products, developer platforms, admin consoles, and internal tools. Do not use for one-off browsing unless the user wants the platform/page capability model preserved.
user-invocable: true
---

<objective>
Create and maintain a Web Platform Atlas: a verified page-by-page model of what a web platform exposes, where each capability lives, what components support it, what inputs/outputs and risks apply, and which capabilities have executable Browser Flow recipes.

**How it works:**
1. Route the request to create, maintain, repair, or validate mode.
2. Load only the workflow for that mode.
3. Convert source material and browser evidence into one atlas model: platform, surfaces, views, regions, components, entities, contexts, capabilities, evidence, optional recipes, and generated outputs.
4. Verify claims with current Browser Relay primitives before reporting completion.

**Output:** verified assets under `<workspace>/browser-flows/` — `INDEX.md`, `platform.json`, `atlas/**`, `flows/*.recipe.json` only for executable capabilities, `evidence/**`, and requested `generated/` outputs.
</objective>

<execution_context>
Workflow files are loaded on-demand in the <process> section below — not upfront.
Do not pre-load workflow or reference files before mode routing.
</execution_context>

<context>
User request: $ARGUMENTS

Asset root is resolved in-workflow. If the user does not provide a workspace, infer the current agent workspace when safe; otherwise ask for the workspace before writing assets.

Sibling skills:
- Use `browser-flow-use` when the user only wants to inspect, execute, generate Python runners or thin entrypoints for, or diagnose existing atlas/flow assets.
- Use `browser-relay` for one-off browser operation where no reusable atlas or Browser Flow asset is relevant.
</context>

<process>
**Mode routing:**

If the request is to run, list, inspect, explain, or generate outputs for existing assets without changing the atlas:
Route to the sibling `browser-flow-use` skill. Stop here.

If the request includes a failed v1 execution trace, recovery evidence, recipe change suggestion, broken saved flow, or user correction for a failed executable capability:
Read and execute `workflows/repair-flow.md` end-to-end. Stop here.

If the request is to audit whether existing atlas assets are complete, reusable, safe, browser-evidenced, executable, or ready for future agents:
Read and execute `workflows/validate-flow.md` end-to-end. Stop here.

If the request is to add missing platform coverage, update stale pages/components/capabilities, adapt to page changes, refresh platform metadata, or regenerate outputs after atlas/recipe changes:
Read and execute `workflows/maintain-flow.md` end-to-end. Stop here.

Otherwise, if the user wants to preserve a website/platform/page workflow from platform materials, operation manuals, PDFs, docs, wiki pages, screenshots, videos, spoken descriptions, or current browser pages:
Read and execute `workflows/create-flow.md` end-to-end.

**MANDATORY:** Read the selected workflow file BEFORE taking authoring actions. The objective and success_criteria sections in this command file are summaries — the workflow file contains the full process, required reading, gates, artifact contracts, and completion rules. Do not improvise from this summary.

**Lazy loading:** Contract files are loaded inside each workflow's `<required_reading>` section. Do not read contracts that are not referenced by the selected workflow.
</process>

<success_criteria>
- Correct workflow selected for create, maintain, repair, or validate mode
- Platform materials and browser evidence are both considered when available
- Assets are modeled as `WebPlatform -> Surface -> View -> Region -> Component -> Capability -> Recipe`
- Views, components, and capabilities are first-class atlas assets; recipes are optional executable projections
- Claims are evidence-backed; unknowns and unsupported Browser Relay primitives are explicit
- Risk policy and confirmation boundary live at capability/recipe level when applicable
- Requested Python runner accepts params and TypeScript/CLI entrypoints invoke it without duplicating runtime logic
- `<workspace>/browser-flows/INDEX.md` is updated
- User receives atlas coverage, callable interfaces when present, evidence, generated outputs, and blockers
</success_criteria>
