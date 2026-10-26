import Ajv2020 from 'ajv/dist/2020.js'
import { z } from 'zod/v4'
import type { ToolInputJSONSchema } from '../Tool.js'
import exported from './schema.json'

type Schema = Record<string, unknown>
export type WorldResult =
  | { success: true; data: unknown }
  | { success: false; error: unknown }

if (exported.format !== 'matcha.world-public-api/1') {
  throw new Error('World schema format is invalid')
}
const ajv = new Ajv2020({ strict: false, validateFormats: false })
let validateResponse: ReturnType<typeof ajv.compile> | undefined
let validateFailure: ReturnType<typeof ajv.compile> | undefined
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

export function decodeResponse(
  operation: string,
  httpOk: boolean,
  value: unknown,
): WorldResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('World response envelope is invalid')
  const envelope = value as Record<string, unknown>
  const key = envelope.success === true ? 'data' : 'error'
  if (
    typeof envelope.success !== 'boolean' ||
    envelope.success !== httpOk ||
    Object.keys(envelope).length !== 2 ||
    !Object.hasOwn(envelope, 'success') ||
    !Object.hasOwn(envelope, key)
  ) {
    throw new Error('World response envelope is invalid')
  }
  const validate = envelope.success
    ? (validateResponse ??= ajv.compile(exported.schemas.PeerResponse))
    : (validateFailure ??= ajv.compile(exported.schemas.Failure))
  if (!validate(envelope[key]))
    throw new Error('World response does not match the public protocol schema')
  if (
    envelope.success &&
    !RESPONSE_KINDS[operation]?.includes((envelope.data as { kind: string }).kind)
  ) {
    throw new Error('World response does not match the requested operation')
  }
  return value as WorldResult
}

export function parameters(operation: string) {
  const root = exported.schemas.PeerRequest as Schema
  const definitions = root.$defs as Record<string, Schema>
  const variants = definitions.PeerOperation!.oneOf as Schema[]
  const variant = variants.find(item => {
    const kind = (item.properties as Record<string, Schema>).kind!
    return (
      kind.const === operation ||
      (Array.isArray(kind.enum) &&
        kind.enum.length === 1 &&
        kind.enum[0] === operation)
    )
  })
  if (!variant) throw new Error('World operation schema is missing')
  const properties = root.properties as Record<string, Schema>
  const json: ToolInputJSONSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['world', 'requestId', 'request'],
    properties: {
      world: properties.world,
      requestId: properties.requestId,
      request: (variant.properties as Record<string, Schema>).request,
    },
  }
  const selected: Record<string, Schema> = {}
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') {
        const name = item.slice('#/$defs/'.length)
        if (!item.startsWith('#/$defs/') || !definitions[name])
          throw new Error('World schema reference is invalid')
        if (!Object.hasOwn(selected, name)) {
          selected[name] = definitions[name]
          collect(definitions[name])
        }
      } else collect(item)
    }
  }
  collect(json)
  json.$defs = selected
  const validate = ajv.compile(json)
  const input = z
    .strictObject({
      world: z.unknown(),
      requestId: z.string(),
      request: z.unknown(),
    })
    .superRefine((value, context) => {
      if (!validate(value))
        context.addIssue({
          code: 'custom',
          message: 'World request does not match the public protocol schema',
        })
    })
  return { input, json }
}
