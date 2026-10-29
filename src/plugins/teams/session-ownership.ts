import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { TeamRoleBindingRecord, TeamRunListItem } from '@/plugins/teams/services/team-runtime-client';
import type { TeamMeta } from '@/plugins/teams/types/team';

export interface TeamRoleChatTarget {
  teamId: string;
  runId: string;
  roleId: string;
  agentId: string;
  localSessionId: string;
  endpointSessionId: string;
  sessionIdentity: SessionIdentity;
}

export interface TeamRoleChatTargetIndex {
  readonly byIdentityKey: ReadonlyMap<string, TeamRoleChatTarget>;
  readonly bySessionKey: ReadonlyMap<string, TeamRoleChatTarget>;
  readonly localSessionKeys: ReadonlySet<string>;
  readonly endpointSessionIds: ReadonlySet<string>;
  readonly materializedSessionKeys: ReadonlySet<string>;
}

export interface TeamRoleSessionProbe {
  readonly sessionIdentity?: SessionIdentity | null;
  readonly sessionKey?: string | null;
  readonly endpointSessionId?: string | null;
}

export interface TeamRoleChatTargetIndexInput {
  readonly teams: readonly TeamMeta[];
  readonly runListByTeamId: Record<string, readonly TeamRunListItem[]>;
  readonly rolesByTeamId: Record<string, readonly TeamRoleBindingRecord[]>;
}

interface TeamRoleChatTargetIndexEntry {
  readonly identityKey: string;
  readonly localSessionKey: string;
  readonly endpointSessionId: string;
  readonly materializedSessionKey: string | null;
  readonly target: TeamRoleChatTarget;
}

function normalizeTeamRoleSessionKey(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function isOpenClawNativeEndpoint(identity: SessionIdentity): boolean {
  return identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw';
}

function resolveTeamRoleMaterializedSessionKey(role: TeamRoleBindingRecord): string | null {
  const endpointSessionId = normalizeTeamRoleSessionKey(role.endpointSessionId);
  if (!endpointSessionId || !isOpenClawNativeEndpoint(role.sessionIdentity)) {
    return null;
  }
  return `agent:${role.agentId}:${endpointSessionId}`;
}

function teamRoleTargetFromBinding(teamId: string, role: TeamRoleBindingRecord): TeamRoleChatTargetIndexEntry {
  const identityKey = buildSessionIdentityKey(role.sessionIdentity);
  const localSessionKey = normalizeTeamRoleSessionKey(role.localSessionId)
    ?? normalizeTeamRoleSessionKey(role.sessionIdentity.sessionKey)
    ?? '';
  const endpointSessionId = normalizeTeamRoleSessionKey(role.endpointSessionId) ?? '';
  const materializedSessionKey = resolveTeamRoleMaterializedSessionKey(role);
  return {
    identityKey,
    localSessionKey,
    endpointSessionId,
    materializedSessionKey,
    target: {
      teamId,
      runId: role.runId,
      roleId: role.roleId,
      agentId: role.agentId,
      localSessionId: localSessionKey,
      endpointSessionId,
      sessionIdentity: role.sessionIdentity,
    },
  };
}

function teamRoleTargetsFromRun(teamId: string, run: TeamRunListItem): TeamRoleChatTargetIndexEntry[] {
  return (run.sessions ?? []).map((role) => teamRoleTargetFromBinding(teamId, role));
}

function teamRoleTargetsFromBindings(teamId: string, roles: readonly TeamRoleBindingRecord[]): TeamRoleChatTargetIndexEntry[] {
  return roles.map((role) => teamRoleTargetFromBinding(teamId, role));
}

function collectTeamRoleChatTargetIndexEntries(input: TeamRoleChatTargetIndexInput): TeamRoleChatTargetIndexEntry[] {
  return input.teams.flatMap((team) => [
    ...teamRoleTargetsFromBindings(team.id, input.rolesByTeamId[team.id] ?? []),
    ...(input.runListByTeamId[team.id] ?? []).flatMap((run) => teamRoleTargetsFromRun(team.id, run)),
  ]);
}

export function buildTeamRoleChatTargetByIdentityKey(input: TeamRoleChatTargetIndexInput): Map<string, TeamRoleChatTarget> {
  return new Map(collectTeamRoleChatTargetIndexEntries(input).map((entry) => [entry.identityKey, entry.target] as const));
}

export function buildTeamRoleChatTargetIndex(input: TeamRoleChatTargetIndexInput): TeamRoleChatTargetIndex {
  const entries = collectTeamRoleChatTargetIndexEntries(input);
  const bySessionKey = new Map<string, TeamRoleChatTarget>();
  const localSessionKeys = new Set<string>();
  const endpointSessionIds = new Set<string>();
  const materializedSessionKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.localSessionKey) {
      localSessionKeys.add(entry.localSessionKey);
      bySessionKey.set(entry.localSessionKey, entry.target);
    }
    if (entry.endpointSessionId) {
      endpointSessionIds.add(entry.endpointSessionId);
      bySessionKey.set(entry.endpointSessionId, entry.target);
    }
    if (entry.materializedSessionKey) {
      materializedSessionKeys.add(entry.materializedSessionKey);
      bySessionKey.set(entry.materializedSessionKey, entry.target);
    }
  }
  return {
    byIdentityKey: new Map(entries.map((entry) => [entry.identityKey, entry.target] as const)),
    bySessionKey,
    localSessionKeys,
    endpointSessionIds,
    materializedSessionKeys,
  };
}

export function resolveTeamRoleChatTarget(targetsByIdentityKey: ReadonlyMap<string, TeamRoleChatTarget>, identity: SessionIdentity | null | undefined): TeamRoleChatTarget | null {
  if (!identity) {
    return null;
  }
  return targetsByIdentityKey.get(buildSessionIdentityKey(identity)) ?? null;
}

export function resolveTeamRoleChatTargetFromProbe(index: TeamRoleChatTargetIndex, probe: TeamRoleSessionProbe): TeamRoleChatTarget | null {
  const identityTarget = resolveTeamRoleChatTarget(index.byIdentityKey, probe.sessionIdentity);
  if (identityTarget) {
    return identityTarget;
  }
  const candidates = [
    probe.endpointSessionId,
    probe.sessionIdentity?.sessionKey,
    probe.sessionKey,
  ];
  for (const candidate of candidates) {
    const key = normalizeTeamRoleSessionKey(candidate);
    if (!key) {
      continue;
    }
    const target = index.bySessionKey.get(key);
    if (target) {
      return target;
    }
  }
  return null;
}

let cachedTeamRoleChatTargetIndexInput: TeamRoleChatTargetIndexInput | null = null;
let cachedTeamRoleChatTargetIndex: TeamRoleChatTargetIndex = buildTeamRoleChatTargetIndex({
  teams: [],
  runListByTeamId: {},
  rolesByTeamId: {},
});

export function selectTeamRoleChatTargetIndex(state: TeamRoleChatTargetIndexInput): TeamRoleChatTargetIndex {
  if (
    cachedTeamRoleChatTargetIndexInput
    && cachedTeamRoleChatTargetIndexInput.teams === state.teams
    && cachedTeamRoleChatTargetIndexInput.runListByTeamId === state.runListByTeamId
    && cachedTeamRoleChatTargetIndexInput.rolesByTeamId === state.rolesByTeamId
  ) {
    return cachedTeamRoleChatTargetIndex;
  }
  cachedTeamRoleChatTargetIndexInput = {
    teams: state.teams,
    runListByTeamId: state.runListByTeamId,
    rolesByTeamId: state.rolesByTeamId,
  };
  cachedTeamRoleChatTargetIndex = buildTeamRoleChatTargetIndex(cachedTeamRoleChatTargetIndexInput);
  return cachedTeamRoleChatTargetIndex;
}
