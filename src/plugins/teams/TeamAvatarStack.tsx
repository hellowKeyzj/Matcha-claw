import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { AgentAvatar } from '@/plugins/agents/presentation/AgentAvatar';
import { selectAgentsResource, useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { buildRuntimeEndpointKey, runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import { useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import type { TeamRoleBindingRecord } from '@/types/team-design';
import { selectTeamSessionRoles, useTeamSessionProjection } from './session-projection';

export function TeamAvatarStack({ teamId, roles }: { teamId?: string; roles?: readonly TeamRoleBindingRecord[] }) {
  const team = useTeamSessionProjection((state) => state.teams.find((team) => team.id === teamId));
  const projectedRoles = useTeamSessionProjection(useShallow((state) => teamId ? selectTeamSessionRoles(state, teamId) : []));
  const agentsByRuntime = useSubagentsStore((state) => state.agentsByRuntime);
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const members = useMemo(() => {
    const bindings = roles ?? projectedRoles;
    const candidates = bindings.length > 0 ? bindings.map((role) => ({
      agentId: role.agentId, name: role.agentId, leader: role.roleId === 'leader', endpoint: role.endpointRef,
    })) : (team?.manualTeam?.members ?? []).map((member) => ({
      agentId: member.agentId, name: member.agentName, leader: member.isLeader,
      endpoint: member.endpoint ?? null,
    }));
    const membersByAgent = new Map<string, (typeof candidates)[number] & { key: string }>();
    for (const member of candidates) {
      const key = JSON.stringify([member.endpoint ? buildRuntimeEndpointKey(member.endpoint) : null, member.agentId]);
      const existing = membersByAgent.get(key);
      if (!existing || member.leader) membersByAgent.set(key, { ...member, key });
    }
    return [...membersByAgent.values()].sort((a, b) => Number(b.leader) - Number(a.leader)).map((member) => {
      const agent = selectAgentsResource({ agentsByRuntime }, member.endpoint).data?.find((agent) => agent.id === member.agentId);
      const endpoint = member.endpoint;
      const runtimeName = endpoint ? endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint))?.displayName
        ?? (endpoint.kind === 'native-runtime' ? `${endpoint.runtimeAdapterId} · ${endpoint.runtimeInstanceId}` : endpoint.endpointId) : null;
      const name = agent?.name || agent?.identity?.name || member.name;
      return { ...member, name, title: runtimeName ? `${name} · ${runtimeName}` : name, avatarSeed: agent?.avatarSeed, avatarStyle: agent?.avatarStyle };
    });
  }, [roles, projectedRoles, team, agentsByRuntime, endpoints]);
  if (members.length === 0) return <Users aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />;
  return <span className="isolate inline-flex shrink-0 -space-x-2" aria-hidden="true">
    {members.slice(0, 3).map((member, index) => <span key={member.key} className="relative inline-flex" style={{ zIndex: 3 - index }}>
      <AgentAvatar agentId={member.agentId} agentName={member.name} avatarSeed={member.avatarSeed} avatarStyle={member.avatarStyle} alt="" title={member.title} className="h-5 w-5 ring-2 ring-[hsl(var(--shell-surface-muted))]" />
    </span>)}
    {members.length > 3 ? <span className="relative grid h-5 min-w-5 place-items-center rounded-full bg-secondary px-1 text-[9px] text-muted-foreground ring-2 ring-[hsl(var(--shell-surface-muted))]">+{members.length - 3}</span> : null}
  </span>;
}
