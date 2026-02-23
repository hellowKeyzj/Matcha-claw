import type { TeamMessageKind } from '@/types/team';

export function detectTeamMessageKind(text: string): TeamMessageKind {
  const normalized = text.trim().toUpperCase();
  if (normalized.startsWith('REPORT:')) {
    return 'report';
  }
  if (normalized.startsWith('PLAN:')) {
    return 'plan';
  }
  return 'normal';
}
