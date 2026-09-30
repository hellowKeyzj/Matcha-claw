export type SecurityEffect = 'confirmed' | 'rejected' | 'unavailable' | 'unknown';
export type SecurityOperation =
  | 'quickAudit' | 'checkIntegrity' | 'rebaselineIntegrity' | 'scanSkills'
  | 'checkAdvisories' | 'previewRemediation' | 'applyRemediation' | 'rollbackRemediation';
export type SecurityEmergencyEffect = 'applied' | 'target_rejected' | 'outcome_unknown' | 'unavailable';

export type SecurityCallDetail =
  | { kind: 'policyRead' }
  | { kind: 'policyReplace'; correlation: string; revision: number | null; effect: SecurityEffect | null }
  | { kind: 'emergency'; correlation: string; outcome: SecurityEmergencyEffect | null }
  | { kind: 'audit'; page: number; pageSize: number; total: number | null; outcome: SecurityEffect | null }
  | { kind: 'operation'; correlation: string; operation: SecurityOperation; outcome: SecurityEffect | null }
  | { kind: 'operationReceipt'; correlation: string }
  | { kind: 'ruleCatalog' };

declare module '../call-log' {
  interface CallDetailByModule { security: SecurityCallDetail }
}

const EFFECTS = ['confirmed', 'rejected', 'unavailable', 'unknown'] as const;
const OPERATIONS = ['quickAudit', 'checkIntegrity', 'rebaselineIntegrity', 'scanSkills', 'checkAdvisories', 'previewRemediation', 'applyRemediation', 'rollbackRemediation'] as const;
const EMERGENCY_EFFECTS = ['applied', 'target_rejected', 'outcome_unknown', 'unavailable'] as const;

export function decodeSecurityCallDetail(value: unknown): SecurityCallDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const detail = value as Record<string, unknown>;
  const exact = (keys: string[]) => Object.keys(detail).length === keys.length && keys.every((key) => Object.hasOwn(detail, key));
  const integer = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
  const nullableMember = (field: unknown, members: readonly string[]) => field === null || typeof field === 'string' && members.includes(field);
  const correlation = () => typeof detail.correlation === 'string' && detail.correlation.length > 0 && new TextEncoder().encode(detail.correlation).length <= 256 && !detail.correlation.includes('\0');
  switch (detail.kind) {
    case 'policyRead': case 'ruleCatalog':
      if (exact(['kind'])) return { kind: detail.kind };
      break;
    case 'policyReplace':
      if (exact(['kind', 'correlation', 'revision', 'effect']) && correlation() && (detail.revision === null || integer(detail.revision)) && nullableMember(detail.effect, EFFECTS)) {
        return { kind: 'policyReplace', correlation: detail.correlation as string, revision: detail.revision as number | null, effect: detail.effect as SecurityEffect | null };
      }
      break;
    case 'emergency':
      if (exact(['kind', 'correlation', 'outcome']) && correlation() && nullableMember(detail.outcome, EMERGENCY_EFFECTS)) {
        return { kind: 'emergency', correlation: detail.correlation as string, outcome: detail.outcome as SecurityEmergencyEffect | null };
      }
      break;
    case 'audit':
      if (exact(['kind', 'page', 'pageSize', 'total', 'outcome']) && integer(detail.page) && (detail.page as number) > 0 && (detail.page as number) <= 10_000 && integer(detail.pageSize) && (detail.pageSize as number) > 0 && (detail.pageSize as number) <= 200 && (detail.total === null || integer(detail.total)) && nullableMember(detail.outcome, EFFECTS)) {
        return { kind: 'audit', page: detail.page as number, pageSize: detail.pageSize as number, total: detail.total as number | null, outcome: detail.outcome as SecurityEffect | null };
      }
      break;
    case 'operationReceipt':
      if (exact(['kind', 'correlation']) && correlation()) return { kind: 'operationReceipt', correlation: detail.correlation as string };
      break;
    case 'operation':
      if (exact(['kind', 'correlation', 'operation', 'outcome']) && correlation() && typeof detail.operation === 'string' && OPERATIONS.includes(detail.operation as SecurityOperation) && nullableMember(detail.outcome, EFFECTS)) {
        return { kind: 'operation', correlation: detail.correlation as string, operation: detail.operation as SecurityOperation, outcome: detail.outcome as SecurityEffect | null };
      }
      break;
  }
  return undefined;
}
