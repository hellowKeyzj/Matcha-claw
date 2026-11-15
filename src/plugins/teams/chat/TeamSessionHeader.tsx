import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { AgentAvatar } from '@/plugins/agents/presentation/AgentAvatar';
import { getSubagentManagementScope, selectAgentsResource, useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { useChatStore } from '@/plugins/chat/store';
import type { ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { buildRuntimeEndpointKey, buildSessionIdentityKey, runtimeEndpointsEqual, sessionIdentitiesEqual } from '@/types/desktop/runtime-address';
import { isRuntimeEndpointReady, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { cn } from '@/lib/utils';
import { selectTeamSessionRoles, useTeamSessionProjection } from '../session-projection';

const memberClass = 'relative inline-flex h-10 min-w-0 max-w-40 shrink items-center gap-2 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none';

export const TeamSessionHeader = memo(function TeamSessionHeader({ isActive, visible, sessionIdentity, ownership }: ChatWorkspaceContentProps) {
  const { t } = useTranslation('teams');
  const teamId = ownership?.kind === 'team' ? ownership.teamId : null;
  const runId = ownership?.kind === 'team' ? ownership.teamRunId : null;
  const roles = useTeamSessionProjection(useShallow((state) => teamId && runId ? selectTeamSessionRoles(state, teamId, runId) : []));
  const agentsByRuntime = useSubagentsStore((state) => state.agentsByRuntime);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const openSessionIdentity = useChatStore((state) => state.openSessionIdentity);
  useEffect(() => {
    if (!isActive || !visible) return;
    const requested = new Set<string>();
    for (const role of roles) {
      const endpoint = role.sessionIdentity.endpoint;
      const key = buildRuntimeEndpointKey(endpoint);
      const runtime = endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint));
      if (requested.has(key) || !runtime || !isRuntimeEndpointReady(runtime)
        || selectAgentsResource(useSubagentsStore.getState(), endpoint).status !== 'idle') continue;
      requested.add(key);
      const scope = getSubagentManagementScope(endpoint);
      if (scope) void loadAgents({ scope });
    }
  }, [isActive, visible, roles, endpoints, loadAgents]);
  const members = useMemo(() => [...roles].sort((a, b) => Number(b.roleId === 'leader') - Number(a.roleId === 'leader')).map((role) => {
    const endpoint = role.sessionIdentity.endpoint;
    const agent = selectAgentsResource({ agentsByRuntime }, endpoint).data.find((agent) => agent.id === role.agentId);
    const runtimeName = endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint))?.displayName
      ?? (endpoint.kind === 'native-runtime' ? `${endpoint.runtimeAdapterId} · ${endpoint.runtimeInstanceId}` : endpoint.endpointId);
    const agentName = agent?.name?.trim() || agent?.identity?.name?.trim() || role.agentId;
    return { ...role, key: JSON.stringify([role.roleId, role.sessionRef, buildSessionIdentityKey(role.sessionIdentity)]),
      name: role.roleId === 'leader' ? `${t('chat.leader')} · ${agentName}` : agentName, runtimeName,
      avatarSeed: agent?.avatarSeed, avatarStyle: agent?.avatarStyle,
      selected: sessionIdentity !== null && sessionIdentitiesEqual(sessionIdentity, role.sessionIdentity) };
  }), [roles, agentsByRuntime, endpoints, sessionIdentity, t]);
  const navRef = useRef<HTMLElement>(null);
  const [visibleCount, setVisibleCount] = useState(1);
  const shown = isActive && visible && sessionIdentity !== null && teamId !== null && runId !== null && members.length > 0;
  useLayoutEffect(() => {
    const node = navRef.current;
    if (!node) return;
    const resize = () => setVisibleCount(node.clientWidth >= 560 ? 3 : node.clientWidth >= 360 ? 2 : 1);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);
  if (!shown) return null;
  const selected = members.find((member) => member.selected);
  const displayed = members.slice(0, visibleCount);
  if (selected && !displayed.includes(selected)) displayed[displayed.length - 1] = selected;
  const overflow = members.filter((member) => !displayed.includes(member));
  return <div className="shrink-0 px-5 sm:px-8" data-testid="team-session-header">
    <nav ref={navRef} aria-label={t('chat.memberSessions')} className="flex h-11 min-w-0 items-center gap-4">
      {displayed.map((member) => <button key={member.key} type="button" aria-pressed={member.selected}
        title={`${member.name} · ${member.runtimeName}`} onClick={() => openSessionIdentity({ sessionIdentity: member.sessionIdentity, endpointSessionId: member.endpointSessionId })}
        className={cn(memberClass, member.selected && 'font-medium text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground')}>
        <AgentAvatar agentId={member.agentId} agentName={member.name} avatarSeed={member.avatarSeed} avatarStyle={member.avatarStyle} alt="" className="h-5 w-5" />
        <span className="min-w-0 text-left leading-tight"><span className="block truncate">{member.name}</span><span className="block truncate text-[10px] font-normal text-muted-foreground">{member.runtimeName}</span></span>
      </button>)}
      {overflow.length > 0 && <div className="shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label={t('chat.moreMembers')} title={t('chat.moreMembers')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
            <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
          </button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60 max-w-[calc(100vw-24px)]">
            {overflow.map((member) => <DropdownMenuItem key={member.key} title={`${member.name} · ${member.runtimeName}`}
              onSelect={() => openSessionIdentity({ sessionIdentity: member.sessionIdentity, endpointSessionId: member.endpointSessionId })}>
              <AgentAvatar agentId={member.agentId} agentName={member.name} avatarSeed={member.avatarSeed} avatarStyle={member.avatarStyle} alt="" className="h-5 w-5" />
              <span className="min-w-0 flex-1"><span className="block truncate">{member.name}</span><span className="block truncate text-xs text-muted-foreground">{member.runtimeName}</span></span>
            </DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
    </nav>
  </div>;
});
