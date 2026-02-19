import type { SubagentSummary } from '@/types/subagent';

const MAIN_AGENT_ID = 'main';
const FALLBACK_ROOT = '~/.openclaw/workspace-subagents';

export function normalizeSubagentNameToSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

function detectSeparator(pathname: string): '/' | '\\' {
  const slash = pathname.lastIndexOf('/');
  const backslash = pathname.lastIndexOf('\\');
  return backslash > slash ? '\\' : '/';
}

function trimTrailingSeparator(pathname: string, separator: '/' | '\\'): string {
  if (!pathname) {
    return pathname;
  }
  const escaped = separator === '\\' ? '\\\\' : '\\/';
  return pathname.replace(new RegExp(`${escaped}+$`), '');
}

function getParentDir(pathname: string): string {
  const separator = detectSeparator(pathname);
  const normalized = trimTrailingSeparator(pathname, separator);
  const index = normalized.lastIndexOf(separator);
  if (index < 0) {
    return '.';
  }
  if (index === 0) {
    return separator;
  }
  if (separator === '\\' && /^[A-Za-z]:$/.test(normalized.slice(0, index))) {
    return `${normalized.slice(0, index)}\\`;
  }
  return normalized.slice(0, index);
}

export function resolveSubagentWorkspaceRoot(agents: Pick<SubagentSummary, 'id' | 'workspace'>[]): string {
  const mainWorkspace = agents.find((agent) => agent.id === MAIN_AGENT_ID)?.workspace?.trim();
  if (!mainWorkspace) {
    return FALLBACK_ROOT;
  }
  const separator = detectSeparator(mainWorkspace);
  const parent = getParentDir(mainWorkspace);
  const base = trimTrailingSeparator(parent, separator);
  return base ? `${base}${separator}workspace-subagents` : `${separator}workspace-subagents`;
}

export function buildSubagentWorkspacePath(input: {
  name: string;
  agents: Pick<SubagentSummary, 'id' | 'workspace'>[];
}): string {
  const root = resolveSubagentWorkspaceRoot(input.agents);
  const separator = detectSeparator(root);
  const base = trimTrailingSeparator(root, separator);
  const slug = normalizeSubagentNameToSlug(input.name);
  return `${base}${separator}${slug}`;
}

export function hasSubagentNameConflict(
  name: string,
  agents: Pick<SubagentSummary, 'id'>[],
  opts?: { excludeAgentId?: string }
): boolean {
  const slug = normalizeSubagentNameToSlug(name);
  return agents.some((agent) => {
    if (opts?.excludeAgentId && agent.id === opts.excludeAgentId) {
      return false;
    }
    return String(agent.id) === slug;
  });
}
