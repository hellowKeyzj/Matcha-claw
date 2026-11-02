import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, MoreHorizontal, Pencil, Plus, Search, SquarePen, Trash2, Users, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { AgentAvatar } from '@/plugins/agents/presentation/AgentAvatar';
import { useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { useTeamSessionProjection } from '@/plugins/teams/session-projection';
import { useChatStore, type ChatSession } from '@/plugins/chat/store';
import { selectAgentSessionsPaneState, type AgentSessionsPaneSessionEntry } from '@/plugins/chat/store/selectors';
import { buildRuntimeScopeKey } from '@/plugins/chat/store/session-identity';
import { isDeletableSession, type ChatSessionRuntimeEndpointNode } from '@/plugins/chat/store/types';
import type { AgentScope, SessionIdentity } from '@/types/desktop/runtime-address';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  resolveAgentScopeForRuntimeEndpoint,
  resolveSessionTitle,
  useAgentSessionsPaneViewModel,
} from './useAgentSessionsPaneViewModel';
import { buildSwitchboardAgentKey, type AgentSessionSwitchboardAgentResult } from './agent-session-switchboard-model';
import { TeamSessionsSidebar } from './TeamSessionsSidebar';

const EMPTY_AGENTS: [] = [];
const iconClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';
const pickerItemClass = 'min-h-9 rounded-md py-1.5 text-[13px] leading-5 data-[highlighted]:bg-[hsl(var(--shell-surface-hover))] motion-reduce:transition-none';
type SidebarMode = 'agents' | 'teams';
type SessionDraft = { key: string; title: string };
type SessionMutation =
  | { kind: 'rename' | 'delete'; draft: SessionDraft }
  | { kind: 'deleteAgent'; scope: AgentScope; name: string; identities: readonly SessionIdentity[] };

const SessionRow = memo(function SessionRow({
  entry, isCurrent, onSwitch, onRename, onDelete,
}: {
  entry: AgentSessionsPaneSessionEntry;
  isCurrent: boolean;
  onSwitch: (key: string) => void;
  onRename: (session: ChatSession, title: string, trigger: HTMLButtonElement | null) => void;
  onDelete: (session: ChatSession, title: string, trigger: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation('common');
  const actionRef = useRef<HTMLButtonElement>(null);
  const title = resolveSessionTitle(entry, t);
  const editable = isDeletableSession(entry.session);
  return (
    <div className={cn('group relative flex min-w-0 items-center rounded-md', isCurrent ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/70')}>
      <button type="button" className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring', editable && 'group-hover:pr-8 group-focus-within:pr-8 group-has-[[data-state=open]]:pr-8 [@media(hover:none)]:pr-8')}
        aria-current={isCurrent ? 'true' : undefined} title={title} onClick={() => onSwitch(entry.session.key)}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {editable && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button ref={actionRef} type="button" className={cn(iconClass, 'pointer-events-none absolute right-0.5 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100')}
            aria-label={t('sidebar.renameSessionAria', { title })}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onRename(entry.session, title, actionRef.current)}><Pencil className="h-3.5 w-3.5" />{t('actions.rename')}</DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(entry.session, title, actionRef.current)}><Trash2 className="h-3.5 w-3.5" />{t('actions.delete')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
  );
});

const AgentGroup = memo(function AgentGroup({
  agent, sessions, currentSessionKey, active, endpoint, defaultExpanded,
  onSwitch, onRename, onDelete, onNewSession, onDeleteAgent,
}: {
  agent: AgentSessionSwitchboardAgentResult;
  sessions: AgentSessionsPaneSessionEntry[];
  defaultExpanded: boolean;
  currentSessionKey: string;
  active: boolean;
  endpoint: ChatSessionRuntimeEndpointNode | undefined;
  onSwitch: (key: string) => void;
  onRename: (session: ChatSession, title: string, trigger: HTMLButtonElement | null) => void;
  onDelete: (session: ChatSession, title: string, trigger: HTMLButtonElement | null) => void;
  onNewSession: (scope: AgentScope) => void;
  onDeleteAgent: (scope: AgentScope, name: string, identities: readonly SessionIdentity[], trigger: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(defaultExpanded);
  const actionRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const open = expanded;
  const scope = useMemo<AgentScope | null>(() => endpoint
    ? { kind: 'agent', endpoint: endpoint.endpoint, agentId: agent.agentId } : null, [agent.agentId, endpoint]);
  const newSessionScope = useMemo(() => endpoint?.target
    ? resolveAgentScopeForRuntimeEndpoint(endpoint.target, agent.agentId) : null, [agent.agentId, endpoint]);
  const deletableIdentities = useMemo(() => endpoint?.agents.find((entry) => entry.agentId === agent.agentId)?.sessions
    .filter(isDeletableSession).map((session) => session.sessionIdentity) ?? [], [agent.agentId, endpoint]);
  return (
    <section>
      <div className={cn('group/agent relative mb-0.5 flex items-center gap-0.5 rounded-md px-1 hover:bg-secondary/70', active && 'bg-secondary/70')}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left text-[13px] leading-5 font-medium text-foreground outline-none group-hover/agent:pr-14 group-focus-within/agent:pr-14 group-has-[[data-state=open]]/agent:pr-14 [@media(hover:none)]:pr-14 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('switchboard.agentSessionsAria', { name: agent.agentName })} aria-expanded={open} aria-controls={listId}
          title={`${agent.runtimeLabel} / ${agent.agentName}`} onClick={() => setExpanded(!open)}>
          <AgentAvatar agentId={agent.agentId} agentName={agent.agentName} avatarSeed={agent.avatarSeed} avatarStyle={agent.avatarStyle} className="h-5 w-5 shrink-0" />
          <span className="truncate">{agent.agentName}</span>
        </button>
        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover/agent:pointer-events-auto group-hover/agent:opacity-100 group-focus-within/agent:pointer-events-auto group-focus-within/agent:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button ref={actionRef} type="button" className={cn(iconClass, 'h-6 w-6')} aria-label={t('switchboard.agentActionsAria', { name: agent.agentName })}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem className="text-destructive" disabled={!scope || deletableIdentities.length === 0}
                onSelect={() => { if (scope) onDeleteAgent(scope, agent.agentName, deletableIdentities, actionRef.current); }}>
                <Trash2 className="h-3.5 w-3.5" />{t('switchboard.deleteAllSessions', { count: deletableIdentities.length })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" className={cn(iconClass, 'h-6 w-6')} disabled={!newSessionScope}
            aria-label={t('switchboard.newSessionForAgent', { name: agent.agentName })} title={t('sidebar.newSession')}
            onClick={() => { if (newSessionScope) { setExpanded(true); onNewSession(newSessionScope); } }}>
            <SquarePen className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div id={listId} hidden={!open} className="space-y-0.5">
        {open && <>
          {sessions.map((entry) => <SessionRow key={entry.session.key} entry={entry} isCurrent={entry.session.key === currentSessionKey}
            onSwitch={onSwitch} onRename={onRename} onDelete={onDelete} />)}
          {sessions.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{t('sidebar.noAgentSessions')}</p>}
        </>}
      </div>
    </section>
  );
});

export const AgentSessionsPane = memo(function AgentSessionsPane() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { sessionEntries, sessionsLoadedOnce, sessionsError, currentConversation, sessionRuntimeGraph, currentSessionKey,
    switchSession, openAgentConversation, newSessionForScope, renameSession, deleteSession, deleteAgentSessions } = useChatStore(useShallow(selectAgentSessionsPaneState));
  const managementScope = useSubagentsStore((state) => state.managementScope);
  const resource = useSubagentsStore((state) => state.agentsResource);
  const teams = useTeamSessionProjection((state) => state.teams);
  const runtimeEndpoints = sessionRuntimeGraph.endpoints;
  const pane = useAgentSessionsPaneViewModel({
    subagentManagementAgents: Array.isArray(resource.data) ? resource.data : EMPTY_AGENTS,
    subagentManagementAgentsResource: resource,
    subagentManagementRuntimeScopeKey: managementScope ? buildRuntimeScopeKey(managementScope.endpoint) : null,
    sessionEntries, sessionsLoadedOnce, sessionsError, runtimeEndpoints,
  });
  const [mode, setMode] = useState<SidebarMode>('agents');
  const [menuMode, setMenuMode] = useState<SidebarMode>('agents');
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const mutationReturnFocusRef = useRef<HTMLElement | null>(null);
  const [mutation, setMutation] = useState<SessionMutation | null>(null);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<'failed' | 'unknown' | null>(null);
  const agents = useMemo(() => pane.agentResults.flatMap((runtime) => runtime.agents), [pane.agentResults]);
  const selectedAgent = agents.find((agent) => agent.key === selectedAgentKey);
  const selectedTeam = teams.find((team) => team.id === selectedTeamId);
  const endpointByScope = useMemo(() => new Map(runtimeEndpoints.map((endpoint) => [endpoint.runtimeScopeKey, endpoint])), [runtimeEndpoints]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = useMemo(() => agents.filter((agent) => selectedAgentKey === null || agent.key === selectedAgentKey).map((agent) => ({
    agent,
    sessions: normalizedQuery ? agent.sessions.filter((entry) => resolveSessionTitle(entry, t).toLocaleLowerCase().includes(normalizedQuery)) : agent.sessions,
  })).filter((group) => !normalizedQuery || group.sessions.length > 0), [agents, normalizedQuery, selectedAgentKey, t]);
  const currentAgentKey = currentConversation ? buildSwitchboardAgentKey(currentConversation.runtimeScopeKey, currentConversation.agentId) : null;
  const startNewSession = useCallback((scope: AgentScope) => {
    void newSessionForScope(scope);
  }, [newSessionForScope]);
  const chooseAgent = (agent: AgentSessionSwitchboardAgentResult) => {
    setMode('agents');
    setSelectedAgentKey(agent.key);
    const endpoint = endpointByScope.get(agent.runtimeScopeKey);
    if (endpoint) openAgentConversation(agent.agentId, endpoint.endpoint);
  };
  const beginMutation = useCallback((kind: 'rename' | 'delete', session: ChatSession, title: string, trigger: HTMLButtonElement | null) => {
    if (!isDeletableSession(session)) return;
    mutationReturnFocusRef.current = trigger;
    setMutationError(null);
    setMutation({ kind, draft: { key: session.key, title } });
  }, []);
  const startRename = useCallback((session: ChatSession, title: string, trigger: HTMLButtonElement | null) => beginMutation('rename', session, title, trigger), [beginMutation]);
  const requestDelete = useCallback((session: ChatSession, title: string, trigger: HTMLButtonElement | null) => beginMutation('delete', session, title, trigger), [beginMutation]);
  const requestDeleteAgent = useCallback((scope: AgentScope, name: string, identities: readonly SessionIdentity[], trigger: HTMLButtonElement | null) => {
    if (identities.length === 0) return;
    mutationReturnFocusRef.current = trigger;
    setMutationError(null);
    setMutation({ kind: 'deleteAgent', scope, name, identities });
  }, []);
  const submitMutation = async () => {
    if (!mutation || pending || mutationError === 'unknown') return;
    if (mutation.kind === 'rename' && !mutation.draft.title.trim()) return;
    setPending(true);
    setMutationError(null);
    try {
      if (mutation.kind === 'rename') await renameSession(mutation.draft.key, mutation.draft.title.trim());
      else {
        const result = mutation.kind === 'deleteAgent'
          ? await deleteAgentSessions(mutation.scope, mutation.identities)
          : await deleteSession(mutation.draft.key);
        if (result.outcome !== 'succeeded') {
          setMutationError(result.outcome === 'unknown' ? 'unknown' : 'failed');
          return;
        }
      }
      setMutation(null);
    } catch {
      setMutationError('failed');
    } finally {
      setPending(false);
    }
  };
  const title = mode === 'agents'
    ? selectedAgentKey === null ? t('switchboard.allAgents') : selectedAgent?.agentName ?? t('switchboard.selectAgent')
    : selectedTeam?.name ?? t('switchboard.allTeams');
  return (
    <aside data-testid="agent-sessions-pane" className="flex h-full min-h-0 w-full min-w-0 flex-col bg-transparent">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2">
        <DropdownMenu open={menuOpen} onOpenChange={(open) => { setMenuOpen(open); if (open) setMenuMode(mode); }}>
          <DropdownMenuTrigger asChild>
            <button ref={pickerRef} type="button" className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-[hsl(var(--shell-surface-hover))] data-[state=open]:bg-[hsl(var(--shell-surface-hover))] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              aria-label={t(mode === 'agents' ? 'switchboard.selectAgent' : 'switchboard.selectTeam')}>
              <span className="truncate">{title}</span><ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[260px] max-w-[calc(100vw-24px)] rounded-[10px] border-border/60 p-1.5 shadow-whisper">
            <div className="flex gap-5 border-b border-border/50 px-2.5">
              {(['agents', 'teams'] as const).map((tab) => <DropdownMenuItem key={tab}
                className={cn('rounded-none px-0 py-0 text-[13px] leading-5 text-muted-foreground data-[highlighted]:bg-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none', menuMode === tab && 'font-medium text-foreground')}
                onSelect={(event) => { event.preventDefault(); setMenuMode(tab); }}>
                <span className={cn('border-b-2 border-transparent py-2', menuMode === tab && 'border-foreground')}>{t(`switchboard.tabs.${tab}`)}</span>
              </DropdownMenuItem>)}
            </div>
            <div className="max-h-[min(360px,60vh)] overflow-y-auto pt-1">
              <DropdownMenuItem className={pickerItemClass} onSelect={() => {
                setMode(menuMode);
                if (menuMode === 'agents') setSelectedAgentKey(null);
                else setSelectedTeamId(null);
              }}>
                {t(menuMode === 'agents' ? 'switchboard.allAgents' : 'switchboard.allTeams')}
                {(menuMode === 'agents' ? selectedAgentKey === null : selectedTeamId === null) && <Check className="ml-auto h-3.5 w-3.5" />}
              </DropdownMenuItem>
              {menuMode === 'agents' ? <>
                {pane.agentListState === 'loading' && <div role="status" aria-label={t('status.loading')} className="space-y-1 p-2"><div className="h-6 rounded-md bg-secondary" /><div className="h-6 rounded-md bg-secondary" /></div>}
                {(pane.agentListState === 'error' || pane.agentErrorMessage) && <p role="alert" className="px-2 py-2 text-xs text-destructive">{pane.agentErrorMessage || t('status.error')}</p>}
                {pane.agentResults.map((runtime) => runtime.agents.length > 0 && <div key={runtime.runtimeScopeKey}>
                  <DropdownMenuLabel className="px-2.5 pb-1 pt-3 text-xs font-medium text-muted-foreground">{runtime.runtimeLabel}</DropdownMenuLabel>
                  {runtime.agents.map((agent) => <DropdownMenuItem key={agent.key}
                    className={pickerItemClass}
                    onSelect={() => chooseAgent(agent)}>
                    <AgentAvatar agentId={agent.agentId} agentName={agent.agentName} avatarSeed={agent.avatarSeed} avatarStyle={agent.avatarStyle} className="h-6 w-6 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{agent.agentName}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{agent.sessionCount}</span>
                    <span className="w-3.5">{agent.key === selectedAgentKey && <Check className="h-3.5 w-3.5" />}</span>
                  </DropdownMenuItem>)}
                </div>)}
                {agents.length === 0 && pane.agentListState === 'ready' && <p className="px-2 py-2 text-xs text-muted-foreground">{t('sidebar.noSubagents')}</p>}
              </> : <>
                {teams.map((team) => <DropdownMenuItem key={team.id} className={pickerItemClass}
                  onSelect={() => { setMode('teams'); setSelectedTeamId(team.id); }}>
                  <Users className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{team.name}</span>
                  <span className="w-3.5 shrink-0">{selectedTeamId === team.id && <Check className="h-3.5 w-3.5" />}</span>
                </DropdownMenuItem>)}
                {teams.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{t('sidebar.noTeams')}</p>}
              </>}
            </div>
            {menuMode === 'agents' && <><DropdownMenuSeparator className="bg-border/50" /><DropdownMenuItem className={pickerItemClass} onSelect={() => navigate('/subagents')}><Plus className="h-3.5 w-3.5" />{t('switchboard.addAgent')}</DropdownMenuItem></>}
          </DropdownMenuContent>
        </DropdownMenu>
        <button ref={searchButtonRef} type="button" className={cn(iconClass, 'ml-auto', searchOpen && 'bg-secondary text-foreground')} aria-label={t('switchboard.searchSessions')}
          aria-expanded={searchOpen} title={t('switchboard.searchSessions')} onClick={() => {
            if (searchOpen) { setSearchOpen(false); setQuery(''); } else { setSearchOpen(true); }
          }}><Search className="h-3.5 w-3.5" /></button>
      </header>
      {searchOpen && <div className="px-3 pb-2">
        <Input ref={searchRef} autoFocus type="search" value={query} className="h-8 rounded-md text-[13px]" aria-label={t('switchboard.searchSessions')}
          placeholder={t('switchboard.searchPlaceholder')} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); setQuery(''); setSearchOpen(false); searchButtonRef.current?.focus(); }
          }} />
      </div>}
      <div data-testid="session-list-scroll-area" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {mode === 'teams' ? <TeamSessionsSidebar selectedTeamId={selectedTeamId} query={query} /> : <>
          {pane.sessionErrorMessage && <p role="alert" className="px-2 py-2 text-xs text-destructive">{pane.sessionErrorMessage}</p>}
          {pane.sessionListState === 'loading' && <div role="status" aria-label={t('status.loading')} className="space-y-2 p-2"><div className="h-7 rounded-md bg-secondary" /><div className="ml-6 h-6 rounded-md bg-secondary" /><div className="ml-6 h-6 rounded-md bg-secondary" /></div>}
          {visibleGroups.length === 0 && pane.sessionListState !== 'loading' && <p className="px-2 py-4 text-xs text-muted-foreground">{t(normalizedQuery ? 'switchboard.noSearchResults' : 'sidebar.noAgentSessions')}</p>}
          <div className="space-y-3">
            {visibleGroups.map(({ agent, sessions }, index) => <AgentGroup key={agent.key}
              agent={agent} sessions={sessions} defaultExpanded={index === 0}
              currentSessionKey={agent.key === currentAgentKey ? currentSessionKey : ''} active={agent.key === currentAgentKey}
              endpoint={endpointByScope.get(agent.runtimeScopeKey)}
              onSwitch={switchSession} onRename={startRename} onDelete={requestDelete}
              onNewSession={startNewSession} onDeleteAgent={requestDeleteAgent} />)}
          </div>
        </>}
      </div>
      <Dialog.Root open={mutation !== null} onOpenChange={(open) => { if (!open && !pending) setMutation(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-elevated outline-none"
            aria-busy={pending} onOpenAutoFocus={(event) => { event.preventDefault(); (mutation?.kind === 'rename' ? renameInputRef.current : cancelRef.current)?.focus(); }}
            onCloseAutoFocus={(event) => { event.preventDefault(); const target = mutationReturnFocusRef.current; if (target?.isConnected) target.focus(); else pickerRef.current?.focus(); }}
            onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onInteractOutside={(event) => { if (pending) event.preventDefault(); }}>
            <Dialog.Title className="pr-6 text-sm font-semibold">{mutation?.kind === 'deleteAgent'
              ? t('switchboard.deleteAgentSessionsTitle', { name: mutation.name })
              : mutation?.kind === 'rename' ? t('sidebar.renameSessionAria', { title: mutation.draft.title })
                : t('sidebar.deleteSessionDialogTitle', { title: mutation?.draft.title })}</Dialog.Title>
            <Dialog.Description className={mutation?.kind === 'rename' ? 'sr-only' : 'mt-2 text-sm text-muted-foreground'}>
              {mutation?.kind === 'deleteAgent' ? t('switchboard.deleteAgentSessionsDescription', { count: mutation.identities.length })
                : mutation?.kind === 'rename' ? t('sidebar.renameSessionAria', { title: mutation.draft.title })
                  : t('sidebar.deleteSessionDialogDescription', { title: mutation?.draft.title })}
            </Dialog.Description>
            <Dialog.Close asChild><button type="button" className={cn(iconClass, 'absolute right-3 top-3')} disabled={pending} aria-label={t('actions.close')}><X className="h-4 w-4" /></button></Dialog.Close>
            <form onSubmit={(event) => { event.preventDefault(); void submitMutation(); }}>
              {mutation?.kind === 'rename' && <Input ref={renameInputRef} className="mt-3" value={mutation.draft.title} disabled={pending}
                aria-label={t('sidebar.renameSessionAria', { title: mutation.draft.title })}
                onChange={(event) => { const title = event.target.value; setMutation((current) => current?.kind === 'rename' ? { ...current, draft: { ...current.draft, title } } : current); }} />}
              {mutationError && <p role="alert" className="mt-3 text-xs text-destructive">{t(mutationError === 'unknown' ? 'switchboard.deleteUnknown'
                : mutation?.kind === 'deleteAgent' ? 'switchboard.deleteAgentSessionsFailed'
                  : mutation?.kind === 'rename' ? 'switchboard.renameFailed' : 'switchboard.deleteFailed')}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild><Button ref={cancelRef} type="button" variant="outline" size="sm" className="motion-reduce:transition-none" disabled={pending}>{t('actions.cancel')}</Button></Dialog.Close>
                <Button type="submit" size="sm" className="motion-reduce:transition-none" variant={mutation?.kind === 'rename' ? 'default' : 'destructive'}
                  disabled={pending || mutationError === 'unknown' || (mutation?.kind === 'rename' && !mutation.draft.title.trim())}>
                  {pending ? t(mutation?.kind === 'rename' ? 'status.loading' : 'sidebar.deleteSessionDialogDeleting') : t(mutation?.kind === 'rename' ? 'actions.save' : 'sidebar.deleteSessionDialogConfirm')}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
});
