import { hostApiFetchDecoded } from './host-api';
import { decodeCallHistory, decodeCallPage, decodeCallRecord } from '@/types/call-log/decode';
import { callDetailDecoders } from '@/types/call-log/modules';
import type { CallHistory, CallModule, CallPage, CallQuery, CallRecord, CallStatus } from '@/types/call-log';

export const CALL_STATUSES: readonly CallStatus[] = [
  'received', 'accepted', 'running', 'waiting', 'succeeded', 'failed', 'rejected', 'unknown',
];
export const CALL_MODULES = Object.keys(callDetailDecoders) as CallModule[];

export function listCalls(query: CallQuery, signal?: AbortSignal): Promise<CallPage> {
  return hostApiFetchDecoded('/api/calls/list', decodeCallPage, {
    method: 'POST', body: JSON.stringify(query), signal,
  });
}

export function getCall(callId: string, signal?: AbortSignal): Promise<CallRecord> {
  return hostApiFetchDecoded('/api/calls/get', decodeCallRecord, {
    method: 'POST', body: JSON.stringify({ callId }), signal,
  });
}

export function getCallHistory(callId: string, module: CallModule, afterRevision?: number, signal?: AbortSignal): Promise<CallHistory> {
  return hostApiFetchDecoded('/api/calls/history', (value) => decodeCallHistory(value, module), {
    method: 'POST', body: JSON.stringify({ callId, afterRevision, limit: 50 }), signal,
  });
}
