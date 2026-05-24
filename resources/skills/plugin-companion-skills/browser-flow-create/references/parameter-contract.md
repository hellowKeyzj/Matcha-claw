# Parameter Contract

Every executable Browser Flow recipe is a callable projection of an atlas capability. Parameters are the public interface of that executable capability.

## Discovery Questions

Before authoring recipe steps, identify from the capability model:

- Which capability inputs change between runs?
- Which context values are fixed by the current platform state?
- Which values are validation samples only?
- Which values are fixed UI labels or semantic targets?
- Which values are sensitive secrets?
- Which values have defaults?
- Which values are enums?
- Which string values represent file paths or directories?
- Which values affect risk, such as submit vs draft or public vs private?
- Which values should be extracted from prior steps instead of supplied by the user?

## Param Types

Use only the runtime-supported recipe param types:

- `string`
- `number`
- `boolean`
- `string[]`
- `number[]`
- `boolean[]`
- `object`

Use `enum` as a constraint on one of those base types, not as a separate runtime type. Use `secret: true` as a security flag, not as a param type.

Represent files, dates, and date ranges with these existing types:

- file path: `string` with a description such as "path to the file to upload"
- date: `string` with a description such as "date in YYYY-MM-DD format"
- date range: `object` with a description such as `{ start: string, end: string }`

Do not invent new param types for platform-specific concepts. Platform-specific meaning belongs in the param name, description, enum values, capability inputs, and recipe steps.

Each required param needs a description. Optional params need a default or clear omission behavior.

## Anti-Hardcoding Rules

Never hardcode user sample values as workflow logic. Do not hardcode validation sample values.

Wrong:

```json
{ "upload": { "file": "D:/demo.mp4" } }
```

Right:

```json
{ "upload": { "pathsFrom": "videoPath" } }
```

Wrong:

```json
{ "fill": { "target": { "kind": "field", "label": "标题" }, "value": "新品介绍" } }
```

Right:

```json
{ "fill": { "target": { "kind": "field", "label": "标题" }, "valueFrom": "title" } }
```

Do not turn stable UI labels into params. `上传素材`, `搜索`, `标题`, menu names, tab names, and button labels are semantic targets unless the user says the label itself varies by workflow.

## Parameter Question Protocol

When inputs are missing or ambiguous, ask only for business values that cannot be inferred from sources, atlas records, or browser evidence. Do not ask the user to choose selectors, refs, or implementation details.

Use this question shape:

```text
Capability: <capability-id>
Recipe: <flow-id if selected>
Missing business input: <param-name>
Why needed: <capability input, step, or business rule that needs it>
Accepts: <string | number | boolean | string[] | number[] | boolean[] | object, plus enum constraint or secret flag when needed>
Default/omission behavior: <default, optional behavior, or none>
Sample for validation only: <safe example value, never recipe logic>
```

Ask in batches when several params are related, such as upload metadata, report filters, search filters, checkout fields, or issue metadata. Block recipe authoring when a required param has no business meaning, no safe sample, or no success criterion.

## Parameter Output Shape

Every selected executable capability must produce a parameter contract before recipe authoring:

```ts
type FlowParameterContract = {
  capabilityId: string
  flowId: string
  required: Array<{
    name: string
    type: string
    description: string
    source: 'user' | 'extracted' | 'context'
    validationSample?: string
    riskAffecting?: boolean
    secret?: boolean
  }>
  optional: Array<{
    name: string
    type: string
    description: string
    default?: unknown
    omissionBehavior: string
    validationSample?: string
    riskAffecting?: boolean
    secret?: boolean
  }>
  fixedPlatformLabels: string[]
  fixedAtlasRefs: Array<{ kind: 'surface' | 'view' | 'component' | 'capability'; id: string }>
  extractedParams: Array<{ name: string; fromStep: string; description: string }>
  unresolvedQuestions: string[]
}
```

`validationSample` values are for browser verification only; recipe steps must use `valueFrom`, `pathsFrom`, context values, or extracted values.

## Risk Params

Params that change side effects must be represented explicitly. Example:

```json
{
  "submitMode": {
    "type": "string",
    "enum": ["draft", "submit"],
    "default": "draft",
    "description": "draft saves safely; submit may require confirmation"
  }
}
```

Risky enum values must map to capability risk metadata and recipe confirmation boundaries.

A recipe is incomplete if params are missing, ambiguous, undocumented, or if sample values are embedded as fixed steps.
