import { buildSessionIdentityKey, type SessionIdentity } from './runtime-address';
import type { RuntimeProtocolId, RuntimeEndpointId } from './runtime-endpoint-types';

export interface RuntimeSessionIdentity {
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
}

export function buildSessionIdentityScopedMessageId(input: {
  identity: SessionIdentity;
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
    buildSessionIdentityKey(input.identity),
    runId,
    laneKey,
    input.role,
    String(input.messageIndex),
  ].join(':');
}
