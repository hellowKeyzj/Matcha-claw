import { buildRuntimeAddressKey, type RuntimeAddress } from './runtime-address';
import type { RuntimeProtocolId, RuntimeEndpointId } from './runtime-endpoint-types';

export interface RuntimeSessionIdentity {
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
}

export function buildRuntimeAddressScopedMessageId(input: {
  address: RuntimeAddress;
  sessionKey: string;
  runId: string;
  laneKey: string;
  role: string;
  messageIndex: number;
}): string {
  const runId = input.runId.trim();
  if (!runId) {
    throw new Error('Runtime message identity requires runId');
  }
  const laneKey = input.laneKey.trim();
  if (!laneKey) {
    throw new Error('Runtime message identity requires laneKey');
  }
  return [
    buildRuntimeAddressKey(input.address),
    input.sessionKey,
    runId,
    laneKey,
    input.role,
    String(input.messageIndex),
  ].join(':');
}
