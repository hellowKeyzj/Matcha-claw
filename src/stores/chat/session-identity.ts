import { buildRuntimeAddressKey, type RuntimeAddress } from '../../../runtime-host/shared/runtime-address';
import type { ChatStoreState } from './types';
import { getSessionMeta } from './store-state-helpers';

export interface SessionOperationTarget {
  sessionKey: string;
  runtimeAddress: RuntimeAddress;
}

export function buildRuntimeScopeKey(runtimeAddress: RuntimeAddress): string {
  if (runtimeAddress.kind === 'native-runtime') {
    return `native:${runtimeAddress.runtimeAdapterId}:${runtimeAddress.runtimeInstanceId}`;
  }
  return `connector:${runtimeAddress.protocolId}:${runtimeAddress.connectorId}:${runtimeAddress.endpointId}`;
}

export function buildSessionIdentityKey(runtimeAddress: RuntimeAddress, backendSessionKey: string): string {
  return `${buildRuntimeAddressKey(runtimeAddress)}::${backendSessionKey}`;
}

export function buildSessionRecordKey(runtimeAddress: RuntimeAddress, backendSessionKey: string): string {
  return buildSessionIdentityKey(runtimeAddress, backendSessionKey);
}

export function sameRuntimeAddressIdentity(left: RuntimeAddress, right: RuntimeAddress): boolean {
  return buildRuntimeAddressKey(left) === buildRuntimeAddressKey(right);
}

export function sameRuntimeEndpointScope(left: RuntimeAddress, right: RuntimeAddress): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'native-runtime' && right.kind === 'native-runtime') {
    return left.runtimeAdapterId === right.runtimeAdapterId
      && left.runtimeInstanceId === right.runtimeInstanceId;
  }
  if (left.kind === 'protocol-connector' && right.kind === 'protocol-connector') {
    return left.protocolId === right.protocolId
      && left.connectorId === right.connectorId
      && left.endpointId === right.endpointId;
  }
  return false;
}

export function findSessionRecordKey(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  backendSessionKey: string,
  runtimeAddress: RuntimeAddress,
): string | null {
  for (const [recordKey, record] of Object.entries(state.loadedSessions)) {
    if (
      record.meta.backendSessionKey === backendSessionKey
      && record.meta.runtimeAddress
      && sameRuntimeAddressIdentity(record.meta.runtimeAddress, runtimeAddress)
    ) {
      return recordKey;
    }
  }
  return null;
}

export function resolveSessionOperationTarget(state: ChatStoreState, recordKey: string): SessionOperationTarget {
  const meta = getSessionMeta(state, recordKey);
  if (!meta.backendSessionKey) {
    throw new Error(`Backend session key is required: ${recordKey}`);
  }
  if (!meta.runtimeAddress) {
    throw new Error(`RuntimeAddress is required: ${recordKey}`);
  }
  return {
    sessionKey: meta.backendSessionKey,
    runtimeAddress: meta.runtimeAddress,
  };
}
