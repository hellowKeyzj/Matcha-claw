import { createHash } from 'node:crypto';
import type { SharedCapability } from '../../../src/types/desktop/interconnect';
import { isRecord } from '../runtime-host-delivery/transport/client';

export interface SharedCapabilityCandidate {
  definition: Record<string, unknown>;
  descriptor: Omit<SharedCapability, 'sourceId' | 'presentation'>;
  presentation?: SharedCapability['presentation'];
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface SharedCapabilityProvider {
  id: string;
  list(): Promise<SharedCapabilityCandidate[]>;
}

export function isCapabilityPresentation(value: unknown): value is NonNullable<SharedCapability['presentation']> {
  return isRecord(value) && Object.keys(value).length === 4
    && ['runtime', 'plugin', 'agent', 'wiki', 'folder'].includes(value.kind as string)
    && ['targetId', 'targetName', 'operation'].every((key) => typeof value[key] === 'string' && value[key].length <= 4096)
    && value.targetId !== '' && value.operation !== '';
}

export function identifyCapability(candidate: SharedCapabilityCandidate): SharedCapability {
  // Presentation is not execution identity; preserve existing registrations and grants.
  const canonical = JSON.stringify({ version: 1, ...candidate.definition, descriptor: candidate.descriptor }, (_key, value: unknown) =>
    isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  return {
    sourceId: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    ...candidate.descriptor,
    ...(candidate.presentation ? { presentation: candidate.presentation } : {}),
  };
}
