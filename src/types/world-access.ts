import type { CommitReceipt, Failure, WorldRef } from './world';

/** The renderer supplies only its selected World or a Main-issued confirmation ticket. */
export type WorldAccessIntent = Readonly<{ world: WorldRef }>;
export type WorldAccessCommitIntent = Readonly<{ world: WorldRef; ticket: string; accept: boolean }>;
export type WorldAccessIdentity = Readonly<{
  world: WorldRef;
  commitId: string;
  grantId: string;
}>;
export type WorldAccessIssue = Pick<Failure, 'code' | 'stage' | 'diagnosticId' | 'recovery' | 'details'> & (
  | { source: 'world'; reason: 'world-rejected' | 'outcome-unknown' }
  | { source: 'control'; reason: 'control-rejected' | 'outcome-unknown' | 'timed-out' | 'not-delivered' | 'unknown-delivery' | 'host-unavailable' | 'protocol-invalid' }
  | { source: 'main'; reason: 'authorization-unavailable' | 'authorization-denied' | 'configuration-unavailable' | 'configuration-invalid' | 'world-mismatch' | 'invalid-request' | 'import-busy' | 'receipt-unconfirmed' | 'ticket-invalid' | 'ticket-expired' }
);
export type WorldAccessPrepareResult =
  | { outcome: 'cancel' }
  | { outcome: 'not-attempted'; error: WorldAccessIssue }
  | { outcome: 'prepared'; ticket: string; summary: WorldAccessIdentity & Readonly<{ preview: string }> };
export type WorldAccessImportResult =
  | { outcome: 'cancel' }
  | { outcome: 'not-attempted'; error: WorldAccessIssue }
  | (WorldAccessIdentity & { outcome: 'confirmed'; receipt: CommitReceipt })
  | (WorldAccessIdentity & { outcome: 'rejected'; error: WorldAccessIssue })
  | (WorldAccessIdentity & { outcome: 'unknown'; error: WorldAccessIssue });
