import type {
  CallChanged, CallHistory, CallModule, CallPage, CallRecord, CallStatus, CallTransition,
} from '../call-log';
import { decodeCallDetail, isCallModule } from './modules';

const statuses: readonly CallStatus[] = [
  'received', 'accepted', 'running', 'waiting', 'succeeded', 'failed', 'rejected', 'unknown',
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isCallId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

export function isCallStatus(value: unknown): value is CallStatus {
  return typeof value === 'string' && statuses.includes(value as CallStatus);
}

export function decodeCallRecord(value: unknown): CallRecord {
  if (!record(value)
    || !exact(value, ['callId', 'module', 'command', 'status', 'start', 'end', 'revision', 'detail'])
    || !isCallId(value.callId) || typeof value.module !== 'string' || !isCallModule(value.module)
    || typeof value.command !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.command)
    || !isCallStatus(value.status) || !integer(value.start)
    || !(value.end === null || (integer(value.end) && value.end >= value.start))
    || !integer(value.revision) || value.revision === 0) throw new Error('Invalid call record');
  const terminal = ['succeeded', 'failed', 'rejected', 'unknown'].includes(value.status);
  const detail = decodeCallDetail(value.module, value.detail);
  if (terminal !== (value.end !== null) || detail === undefined) throw new Error('Invalid call record');
  return {
    callId: value.callId, module: value.module, command: value.command, status: value.status,
    start: value.start, end: value.end, revision: value.revision, detail,
  } as CallRecord;
}

export function decodeCallPage(value: unknown): CallPage {
  if (!record(value) || !exact(value, ['items', 'next']) || !Array.isArray(value.items)
    || value.items.length > 200 || !(value.next === null || isCallId(value.next))) {
    throw new Error('Invalid call page');
  }
  return { items: value.items.map(decodeCallRecord), next: value.next };
}

export function decodeCallHistory(value: unknown, module: CallModule): CallHistory {
  if (!record(value) || !exact(value, ['items', 'next']) || !Array.isArray(value.items)
    || value.items.length > 200 || !(value.next === null || (integer(value.next) && value.next > 0))) {
    throw new Error('Invalid call history');
  }
  let revision = 0;
  const items = value.items.map((item): CallTransition => {
    if (!record(item) || !exact(item, ['revision', 'status', 'at', 'detail'])
      || !integer(item.revision) || item.revision <= revision
      || !isCallStatus(item.status) || !integer(item.at)) throw new Error('Invalid call history');
    const detail = decodeCallDetail(module, item.detail);
    if (detail === undefined) throw new Error('Invalid call history');
    revision = item.revision;
    return { revision: item.revision, status: item.status, at: item.at, detail } as CallTransition;
  });
  return { items, next: value.next };
}

export function decodeCallChanged(value: unknown): CallChanged {
  if (!record(value) || !exact(value, ['callId', 'revision']) || !isCallId(value.callId)
    || !integer(value.revision) || value.revision === 0) throw new Error('Invalid call change');
  return { callId: value.callId, revision: value.revision };
}
