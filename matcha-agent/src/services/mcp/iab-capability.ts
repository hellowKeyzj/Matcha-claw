import { isAbsolute } from 'node:path'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && isAbsolute(value)
}

// Imported before bootstrap snapshots or any subprocess can inherit the launch env.
const target = (() => {
  const raw = process.env.MATCHA_IAB_STDIO
  for (const key of Object.keys(process.env)) {
    const name = key.toUpperCase()
    if (name === 'MATCHA_IAB_STDIO' || name === 'MATCHA_IAB_CAPABILITY') {
      delete process.env[key]
    }
  }
  if (raw === undefined) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (
      !record(value) ||
      Object.keys(value).length !== 3 ||
      !record(value.capability) ||
      Object.keys(value.capability).length !== 3 ||
      !uuid(value.capability.sessionId) ||
      !uuid(value.capability.instanceId) ||
      typeof value.capability.token !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.capability.token) ||
      !absolutePath(value.command) ||
      !Array.isArray(value.args) ||
      value.args.length !== 3 ||
      value.args[0] !== 'mcp' ||
      value.args[1] !== '--state-dir' ||
      !absolutePath(value.args[2])
    ) {
      throw new Error('Invalid private browser launch context')
    }
    return {
      command: value.command,
      args: [value.args[0], value.args[1], value.args[2]],
      capability: JSON.stringify({
        sessionId: value.capability.sessionId,
        instanceId: value.capability.instanceId,
        token: value.capability.token,
      }),
    }
  } catch {
    throw new Error('Invalid private browser launch context')
  }
})()

export function iabStdioEnv(
  name: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    const name = key.toUpperCase()
    if (name === 'MATCHA_IAB_STDIO' || name === 'MATCHA_IAB_CAPABILITY') {
      delete result[key]
    }
  }
  if (
    target &&
    name === 'matcha' &&
    command === target.command &&
    args.length === target.args.length &&
    args.every((arg, index) => arg === target.args[index])
  ) {
    result.MATCHA_IAB_CAPABILITY = target.capability
  }
  return result
}
