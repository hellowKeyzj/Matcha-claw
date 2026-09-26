export type SessionOwnership =
  | { readonly kind: 'ordinary' }
  | {
      readonly kind: 'team';
      readonly teamId: string;
      readonly teamRunId: string;
      readonly roleId: string;
      readonly sessionRef: string;
    };

export function isSessionOwnership(value: unknown): value is SessionOwnership {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'ordinary') return Object.keys(record).length === 1;
  return record.kind === 'team'
    && Object.keys(record).length === 5
    && typeof record.teamId === 'string' && record.teamId.length > 0
    && typeof record.teamRunId === 'string' && record.teamRunId.length > 0
    && typeof record.roleId === 'string' && record.roleId.length > 0
    && typeof record.sessionRef === 'string' && record.sessionRef.length > 0;
}
