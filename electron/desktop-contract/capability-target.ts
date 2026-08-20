import type { RuntimeScope } from './runtime-address';

/**
 * Renderer-only opaque target projection for fixed product transports.
 * Runtime Host does not decode this shape as a dynamic routing grammar.
 */
export type CapabilityTarget = Readonly<{
  kind: string;
  readonly [field: string]: unknown;
}>;

export type CapabilityTargetKind = CapabilityTarget['kind'];

export function buildCapabilityTargetKey(target: CapabilityTarget | null | undefined): string {
  if (target === null || target === undefined) {
    return JSON.stringify({ type: 'capability-target', kind: 'none' });
  }
  assertCapabilityTarget(target);
  if (target.kind !== 'license' || target.subject !== 'key') {
    throw new Error('CapabilityTarget is not shared with Runtime Host');
  }
  return JSON.stringify({ type: 'capability-target', kind: 'license', subject: 'key' });
}

export function assertCapabilityTarget(input: unknown): asserts input is CapabilityTarget {
  const error = validateCapabilityTarget(input);
  if (error) throw new Error(error);
}

/** Only the remaining fixed Electron license route has a cross-layer target. */
export function validateCapabilityTarget(input: unknown): string | null {
  return isRecord(input)
    && hasExactKeys(input, ['kind', 'subject'])
    && input.kind === 'license'
    && input.subject === 'key'
    ? null
    : 'CapabilityTarget is invalid';
}

export function targetBelongsToScope(target: CapabilityTarget | null | undefined, scope: RuntimeScope): boolean {
  return target !== null
    && target !== undefined
    && validateCapabilityTarget(target) === null
    && scope.kind === 'app';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
