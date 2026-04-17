import { normalizeSubagentNameToSlug } from '@/features/subagents/domain/workspace';

export const AGENT_AVATAR_PICKER_OPTION_COUNT = 12;
export const AGENT_AVATAR_STYLES = ['pixelArt', 'bottts', 'botttsNeutral'] as const;
export type AgentAvatarStyle = (typeof AGENT_AVATAR_STYLES)[number];
export const DEFAULT_AGENT_AVATAR_STYLE: AgentAvatarStyle = 'pixelArt';

function normalizeSeedSegment(value?: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return 'agent';
  }
  return normalizeSubagentNameToSlug(trimmed) || trimmed.toLowerCase();
}

export function resolveAgentAvatarSeed(input: {
  avatarSeed?: string;
  agentId?: string;
  agentName?: string;
}): string {
  const explicitSeed = input.avatarSeed?.trim();
  if (explicitSeed) {
    return explicitSeed;
  }
  const agentId = input.agentId?.trim();
  if (agentId) {
    return `agent:${normalizeSeedSegment(agentId)}`;
  }
  const agentName = input.agentName?.trim();
  if (agentName) {
    return `agent-name:${normalizeSeedSegment(agentName)}`;
  }
  return 'agent:default';
}

export function resolveAgentAvatarStyle(avatarStyle?: string): AgentAvatarStyle {
  if (avatarStyle === 'bottts' || avatarStyle === 'botttsNeutral' || avatarStyle === 'pixelArt') {
    return avatarStyle;
  }
  return DEFAULT_AGENT_AVATAR_STYLE;
}

export function buildTemplateAvatarSeed(templateId: string): string {
  return `template:${normalizeSeedSegment(templateId)}`;
}

export function buildAvatarPickerSeeds(input: {
  agentName?: string;
  page: number;
  count?: number;
}): string[] {
  const count = input.count ?? AGENT_AVATAR_PICKER_OPTION_COUNT;
  const base = normalizeSeedSegment(input.agentName);
  const page = Math.max(0, input.page);
  return Array.from({ length: count }, (_, index) => `picker:${base}:page:${page}:option:${index}`);
}
