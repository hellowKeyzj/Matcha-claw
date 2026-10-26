import type { AccessPolicyRef, CommitReceipt, RetentionPolicy, WorldRef } from './world';
import type { WorldAccessIssue } from './world-access';

export type WorldEvaluationIntent = Readonly<{ world: WorldRef }>;
export type WorldEvaluationSummary = Readonly<{
  world: WorldRef;
  commitId: string;
  principalCount: number;
  grantCount: number;
  policyCount: number;
  retentionPolicyCount: number;
  caseAccess: AccessPolicyRef;
  caseRetention: RetentionPolicy;
}>;
export type WorldEvaluationIssue = WorldAccessIssue | (Omit<WorldAccessIssue, 'source' | 'reason'> & {
  source: 'main';
  reason: 'configuration-conflict' | 'ticket-invalid' | 'ticket-expired';
});
export type WorldEvaluationPrepareResult =
  | { outcome: 'prepared'; ticket: string; summary: WorldEvaluationSummary }
  | { outcome: 'cancel' }
  | { outcome: 'not-attempted'; error: WorldEvaluationIssue };
export type WorldEvaluationCommitIntent = Readonly<{ world: WorldRef; ticket: string; accept: boolean }>;
export type WorldEvaluationIdentity = Readonly<{ world: WorldRef; commitId: string }>;
export type WorldEvaluationCommitResult =
  | { outcome: 'cancel' }
  | { outcome: 'not-attempted'; error: WorldEvaluationIssue }
  | (WorldEvaluationIdentity & { outcome: 'confirmed'; receipt: CommitReceipt })
  | (WorldEvaluationIdentity & { outcome: 'rejected' | 'unknown'; error: WorldEvaluationIssue });
export type WorldEvaluationStatusResult =
  | { outcome: 'available'; world: WorldRef; configured: boolean; commitId: string | null }
  | { outcome: 'unavailable'; error: WorldEvaluationIssue };
