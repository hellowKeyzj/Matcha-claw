import type { TeamPhase } from '@/types/team';

const PHASE_FORBIDDEN_TOOL_PREFIXES: Partial<Record<TeamPhase, string[]>> = {
  discussion: ['sessions_', 'subagents', 'agent', 'gateway', 'nodes', 'cron'],
  planning: ['sessions_', 'subagents', 'agent', 'gateway', 'nodes', 'cron'],
  convergence: ['sessions_', 'subagents', 'agent', 'gateway', 'nodes', 'cron'],
};

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function isForbiddenByPrefixes(toolName: string, prefixes: string[]): boolean {
  const normalized = normalizeToolName(toolName);
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

export function findForbiddenToolsForPhase(input: {
  phase: TeamPhase;
  usedTools: string[];
}): string[] {
  const prefixes = PHASE_FORBIDDEN_TOOL_PREFIXES[input.phase] ?? [];
  if (prefixes.length === 0) {
    return [];
  }
  const unique = new Set<string>();
  input.usedTools.forEach((name) => {
    if (isForbiddenByPrefixes(name, prefixes)) {
      unique.add(normalizeToolName(name));
    }
  });
  return Array.from(unique);
}

