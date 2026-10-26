import type { ResourceRef, WorldHint, WorldRef } from '../../../src/types/world';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';

export type WorldChangedHint = Extract<WorldHint, { kind: 'changed' }>;
export type WorldResyncHint = Extract<WorldHint, { kind: 'resync_required' }>;
const RESOURCE_KEYS = {
  object: 'id', relation: 'id', definition: 'id', assertion: 'id', evidence: 'id', support: 'id',
  watch: 'id', head: 'channel', state: 'id', binding: 'id', operation: 'id', source: 'id',
  package: 'id', change_set: 'id', branch: 'id', task: 'id', case: 'id', test_case: 'id', suite: 'id', evaluation: 'id',
} as const satisfies Record<ResourceRef['kind'], 'id' | 'channel'>;

export function isWorldChangedEvent(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['type', 'world', 'incarnation', 'resource', 'revision'])
    && isWorldRef(value.world) && decimal(value.incarnation) && decimal(value.revision) && resource(value.resource);
}
export function isWorldResyncEvent(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['type', 'world', 'incarnation']) && isWorldRef(value.world) && decimal(value.incarnation);
}
export function isWorldRef(value: unknown): value is WorldRef {
  return isRecord(value) && hasExactKeys(value, ['tenantId', 'worldId']) && id(value.tenantId) && id(value.worldId);
}
function resource(value: unknown): value is ResourceRef {
  if (!isRecord(value) || typeof value.kind !== 'string' || !Object.hasOwn(RESOURCE_KEYS, value.kind)) return false;
  const key = RESOURCE_KEYS[value.kind as keyof typeof RESOURCE_KEYS];
  return hasExactKeys(value, ['kind', key]) && id(value[key]);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}
