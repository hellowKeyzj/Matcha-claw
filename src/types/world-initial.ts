import type { Failure } from './world';

export type InitialWorldIssue = Pick<Failure, 'code' | 'stage' | 'diagnosticId' | 'recovery' | 'details'> & (
  | { source: 'renderer'; reason: 'response-unconfirmed' }
  | { source: 'world'; reason: 'world-rejected' | 'outcome-unknown' }
  | { source: 'control'; reason: 'control-rejected' | 'outcome-unknown' | 'timed-out' | 'not-delivered' | 'unknown-delivery' | 'host-unavailable' | 'protocol-invalid' }
  | { source: 'main'; reason: 'authorization-unavailable' | 'authorization-denied' | 'connection-unavailable' | 'configuration-unavailable' | 'configuration-invalid' | 'configuration-conflict' | 'bootstrap-invalid' | 'storage-not-configured' | 'invalid-request' | 'import-busy' | 'ready-unconfirmed' }
);
