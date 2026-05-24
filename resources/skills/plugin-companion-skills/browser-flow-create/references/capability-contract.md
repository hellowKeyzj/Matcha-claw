# Web Platform Atlas Contract

Browser Flow authoring starts with a Web Platform Atlas. A recipe is only the executable projection of a capability; it is not the center of the model.

## Hierarchy

Use this hierarchy for every platform:

```text
WebPlatform -> Surface -> View -> Region -> Component -> Capability -> Recipe -> Step -> SemanticTarget
```

Definitions:

- WebPlatform: one website, web product, SaaS app, marketplace, feed product, developer platform, admin console, or stable automation boundary.
- Surface: a major product area or interaction surface, such as repository, search, product detail, feed, checkout, dashboard, issue tracker, or admin table management.
- View: a concrete page, route, tab, drawer, modal, feed item, detail panel, wizard step, or embedded frame that can be observed.
- Region: a visible page section such as nav, filter bar, toolbar, table area, card list, comment drawer, media panel, checkout block, editor, or settings group.
- Component: an actionable or informative UI unit inside a region, such as search box, filter, table, form, card, media player, upload control, diff viewer, SKU selector, map, calendar, modal, drawer, or button group.
- Capability: a user-facing function the platform supports, such as search, filter, extract, export, upload, edit, publish, comment, like, add to cart, checkout, create issue, review PR, approve, or delete.
- Recipe: an optional parameterized execution plan for one capability or task flow.
- SemanticTarget: a durable target description based on labels, roles, visible names, business context, component id, view id, and interaction pattern.

A page is not a flow. A component is not a flow. A capability can exist without a recipe.

## Asset Tree

Write one atlas tree under the existing Browser Flow workspace root:

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

Do not create a second root for atlas assets. `browser-flows/` is the single persisted workspace; atlas assets are first-class children inside it.

## Platform Boundary

Create one platform directory per stable website or product boundary. Reuse the same platform when assets share login/session, domains, product shell, terminology, UI patterns, success/error patterns, and risk rules. Split only when sharing `platform.json` would confuse authentication, domains, risk model, product shell, or terminology.

`platform.json` should capture:

- platform id, display name, aliases, domains, base URL
- platform type such as commerce, social-feed, developer-platform, SaaS, admin-console, documentation, search, local-services, or unknown
- primary entities such as product, shop, order, repository, issue, pull request, video, creator, merchant, customer, invoice, approval, or document
- login/session check and context dimensions when known
- common success/error patterns, terminology, UI hints, and risk rules
- supported Browser Relay actions used by validated assets

## Surface and View Archive

Every mapped platform should prioritize page-by-page coverage before recipe authoring.

A surface record should capture:

- surface id, name, purpose, entry patterns, route/menu/feed/search patterns
- related views and primary entities
- context requirements such as anonymous, logged-in, role, city, locale, device, selected repository, selected shop, or selected account
- evidence refs and unknowns

A view record should capture:

- view id, surface id, name, route or entry path, view type
- regions and their visible labels
- components contained in each region
- capabilities supported by the view
- risk summary and evidence refs
- freshness metadata: last observed URL/signature when available, confidence, stale threshold, failure count

Use `View` instead of only `Page` because modern websites often expose capabilities in tabs, drawers, modals, feed cards, detail panels, and iframes.

## Component Inventory

For every relevant view, inventory observable components through current Browser Relay primitives: `snapshot`, `screenshot`, `requests`, `errors`, `console`, and safe `act` interactions when needed.

A component record should capture:

- component id, view id, region id, type, label/name/title when visible
- fields, columns, actions, row actions, tabs, filters, options, visible states, or extracted values when observable
- interaction patterns such as paginated table, virtual table, infinite feed, combobox, cascader, tree selector, rich text editor, media player, upload control, drag-and-drop target, modal confirmation, drawer form, iframe step, diff viewer, SKU selector, map, calendar, or checkout block
- capabilities it supports
- evidence refs, unknowns, blockers

Do not persist snapshot refs, component-library classes, raw CSS selectors, long XPath, or `nth-child` paths as primary component identity. Locator fallback belongs in evidence only.

## Capability Model

Capabilities are the main platform-function catalog. A capability record should capture:

| Field | Meaning |
|---|---|
| `capabilityId` | stable id such as `<platform>.<verb><object>` |
| `surfaceId` / `viewId` | where the capability is exposed |
| `componentIds` | components that support or trigger it |
| `intent` | user-facing outcome |
| `inputs` | business values, filters, files, entities, or context needed |
| `outputs` | state, entity, file, URL, table rows, metric, extracted data, or side effect |
| `risk` | read-only, extract, download, upload, draft, write, approval, destructive, payment, social-action, permission-change, external-message, or unknown |
| `executionMode` | auto, read-only, dry-run, manual-confirm, blocked, or not-suitable |
| `automationStatus` | unknown, discovered, mapped, candidate, recipe-ready, validated, generated, partial, blocked, or not-suitable |
| `recipeId` | optional executable projection |
| `preconditions` | required login, role, page state, existing records, safe test data, or prior output |
| `successSignals` | visible state, toast, URL, row/entity appears, file evidence, request status, or extracted value |
| `evidenceRefs` | source ids, trace ids, screenshot ids, request ids, snapshot ids, or observations |
| `unknowns` / `blockers` | unresolved facts and blockers |

Only capabilities with explicit intent, inputs, outputs, risk, success signals, and evidence may become recipes.

## Entities and Contexts

Use entities to model durable platform objects: product, order, video, creator, comment, merchant, repository, issue, pull request, workflow run, release, customer, invoice, material, report, approval, or document.

Use contexts to model visibility and behavior differences: anonymous/logged-in, role/permission, city/locale, desktop/mobile, selected workspace, selected repository, selected shop, selected account, environment, or feature gate.

Do not mistake “not visible in the current context” for “unsupported by the platform.” Record visibility evidence and context unknowns.

## Recipe Derivation

A recipe may be authored only after the related capability exists in `atlas/capabilities/`.

Recipes must reference atlas ids instead of rediscovering platform structure:

- `capabilityId`
- `surfaceId`
- `viewId`
- `componentId` where useful
- semantic targets based on labels, roles, business context, and interaction patterns
- params derived from capability inputs
- success criteria derived from capability success signals
- risk boundary derived from capability risk and execution mode

The atlas is the source of platform understanding. The recipe is the source of executable steps for one capability.

## Evidence Boundary

Coverage is evidence-based. No source or browser evidence means unknown, not unsupported.

- Missing from `INDEX.md` does not mean the platform lacks the capability.
- No saved recipe does not mean the capability cannot be automated.
- No recent validation does not mean a capability is safe to execute.
- Unsupported artifact capture, popup handling, active-session fetch, or unavailable Browser Relay primitive must be recorded as partial or blocked.
- Core code must stay platform-neutral; do not add platform-specific branches to product source.
