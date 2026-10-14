import { isRecord } from '../client';
import type { SessionModelIdentity, SessionModelState } from './session-contract';

// Catalog and model-selection accept plain strings, unlike the SessionView contract.
export function isSessionModelState(value: unknown): value is SessionModelState {
  return isRecord(value)
    && Object.keys(value).every((key) => ['selected', 'active', 'overrideSource', 'selectionId'].includes(key))
    && (value.selected === undefined || isSessionModelIdentity(value.selected))
    && (value.active === undefined || isSessionModelIdentity(value.active))
    && (value.overrideSource === undefined || value.overrideSource === 'user' || value.overrideSource === 'auto')
    && (value.selectionId === undefined || typeof value.selectionId === 'string');
}

function isSessionModelIdentity(value: unknown): value is SessionModelIdentity {
  return isRecord(value)
    && ['model', 'ref'].every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => ['provider', 'model', 'ref'].includes(key))
    && typeof value.model === 'string'
    && typeof value.ref === 'string'
    && (value.provider === undefined || typeof value.provider === 'string');
}
