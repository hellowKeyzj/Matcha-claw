import { TaskStoreError } from './errors.js'

export function toNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskStoreError('invalid_params', `${field} is required`)
  }
  return value.trim()
}

export function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') {
      continue
    }
    const value = item.trim()
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    result.push(value)
  }
  return result
}
