export const TEAM_AGENT_ID_PREFIX = 'mct-';

export function buildTeamManagedAgentId(teamId: string, roleId: string): string {
  const teamHash = stableHash(teamId);
  const roleHash = stableHash(roleId);
  const roleSlug = slugId(roleId).slice(0, 32).replace(/-+$/g, '') || 'role';
  return `${TEAM_AGENT_ID_PREFIX}${teamHash}-${roleSlug}-${roleHash}`;
}

export function teamManagedAgentTeamPrefix(teamId: string): string {
  return `${TEAM_AGENT_ID_PREFIX}${stableHash(teamId)}-`;
}

function slugId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
