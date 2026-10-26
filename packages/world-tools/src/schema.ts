import { readFileSync } from 'node:fs'
import { validateJsonSchemaValue, type JsonSchemaObject } from 'openclaw/plugin-sdk/json-schema-runtime'

type Schema = Record<string, unknown>
type WorldResult = { success: true; data: unknown } | { success: false; error: unknown }

const exported = JSON.parse(readFileSync(new URL('../metadata/schema.json', import.meta.url), 'utf8')) as {
  format: string
  schemas: Record<'PeerRequest' | 'PeerResponse' | 'Failure', Schema>
}
if (exported.format !== 'matcha.world-public-api/1') throw new Error('World schema format is invalid')

const RESPONSE_KINDS: Record<string, readonly string[]> = {
  discover: ['discover'],
  query: ['query'],
  explain: ['explain'],
  action_propose: ['action_propose', 'accepted'],
  action_submit: ['accepted'],
  action_status: ['action_status'],
  observe: ['accepted'],
  change_propose: ['accepted'],
  branch_test: ['accepted'],
}

export function decodeResponse(operation: string, httpOk: boolean, value: unknown): WorldResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('World response envelope is invalid')
  const envelope = value as Record<string, unknown>
  const key = envelope.success === true ? 'data' : 'error'
  if (typeof envelope.success !== 'boolean' || envelope.success !== httpOk
      || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'success') || !Object.hasOwn(envelope, key)) {
    throw new Error('World response envelope is invalid')
  }
  const schema = envelope.success ? 'PeerResponse' : 'Failure'
  if (!validateJsonSchemaValue({ schema: exported.schemas[schema] as JsonSchemaObject, cacheKey: `matcha.world.${schema}`, value: envelope[key] }).ok) {
    throw new Error('World response does not match the public protocol schema')
  }
  if (envelope.success && !RESPONSE_KINDS[operation]?.includes((envelope.data as { kind: string }).kind)) {
    throw new Error('World response does not match the requested operation')
  }
  return value as WorldResult
}

export function parameters(operation: string): Schema {
  const root = exported.schemas.PeerRequest
  const definitions = root.$defs as Record<string, Schema>
  const variants = definitions.PeerOperation.oneOf as Schema[]
  const variant = variants.find(item => {
    const kind = (item.properties as Record<string, Schema>).kind
    return kind.const === operation || (Array.isArray(kind.enum) && kind.enum.length === 1 && kind.enum[0] === operation)
  })
  if (!variant) throw new Error(`World operation schema is missing: ${operation}`)
  const properties = root.properties as Record<string, Schema>
  return {
    type: 'object',
    additionalProperties: false,
    required: ['world', 'requestId', 'request'],
    properties: {
      world: properties.world,
      requestId: properties.requestId,
      request: (variant.properties as Record<string, Schema>).request,
    },
    $defs: definitions,
  }
}
