import type { TeamPhase } from '@/types/team';

const ALLOWED_PHASE_TRANSITIONS: Record<TeamPhase, TeamPhase[]> = {
  discussion: ['planning', 'convergence'],
  planning: ['discussion', 'team-setup', 'convergence'],
  'team-setup': ['discussion', 'planning', 'convergence'],
  convergence: ['discussion', 'planning', 'execution'],
  execution: ['discussion', 'done'],
  done: ['discussion'],
};

export function canTransitionTeamPhase(from: TeamPhase, to: TeamPhase): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function ensureTeamPhaseTransition(input: {
  from: TeamPhase;
  to: TeamPhase;
}): { ok: true } | { ok: false; error: string } {
  if (canTransitionTeamPhase(input.from, input.to)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Invalid phase transition: ${input.from} -> ${input.to}`,
  };
}
