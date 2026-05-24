# Asset Routing Reference

Read this file when a user asks for a web-platform operation and the correct platform, capability, or recipe is not obvious from `browser-flows/INDEX.md` alone.

## Asset lookup order

Always resolve assets in this order:

```text
WebPlatform -> Surface -> View -> Region -> Component -> Capability -> Recipe
```

A recipe is an executable projection of a capability. A capability can be modeled and useful without having a recipe.

## Workspace search

1. Start from the current user or agent workspace when safe.
2. Look for `<workspace>/browser-flows/INDEX.md`.
3. If `INDEX.md` is missing but `<workspace>/browser-flows/platforms/` exists, inspect `platforms/*/platform.json` to recover the platform catalog.
4. If multiple workspaces may contain assets, inspect enough catalog metadata to choose; ask only when still ambiguous.

## Platform matching signals

Match a platform by:

- display name, aliases, and product terminology
- domain, base URL, or user-provided URL
- platform type, login/session hints, and product shell
- surfaces, views, entities, and capability names in `INDEX.md`
- existing evidence traces when the user references a prior run

If no platform matches, route to `browser-flow-create` create mode. Do not manually browse the platform as a substitute for missing modeling.

## Capability matching signals

Read the relevant capability records under `atlas/capabilities/` and match by:

- intent and user-facing operation
- required and optional inputs
- outputs and extracted values
- success signals and failure signals
- prerequisites, contexts, and role/session assumptions
- risk metadata and confirmation boundary
- automation status and `recipeId`
- blockers, unknowns, freshness, and evidence refs

Use surfaces, views, components, and contexts only as needed to disambiguate the capability.

## Routing outcomes

- Existing platform + matching capability + matching executable recipe: run with `browser-flow-use`.
- Existing platform + matching capability + no executable recipe: route to `browser-flow-create` maintain mode if execution is needed.
- Existing platform + missing or incomplete capability: route to `browser-flow-create` maintain/create mode.
- Missing platform: route to `browser-flow-create` create mode.
- Existing assets appear stale or contradictory: route to `browser-flow-create` maintain or repair mode with the observed evidence.
- User explicitly wants one-off browsing and no reusable modeling is relevant: route to `browser-relay`.

## Generated output policy

Generated Python, TypeScript, and CLI files are convenience entrypoints. The source of truth remains `platform.json`, `atlas/**`, and `flows/*.recipe.json`.

Offer generated output when the user asks for a callable script, when a new/repaired recipe has just been validated, or when an existing recipe lacks generated output and the user wants one. If the user declines, future work still starts from atlas and recipe discovery.