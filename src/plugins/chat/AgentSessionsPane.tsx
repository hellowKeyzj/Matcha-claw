import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, Loader2, MoreHorizontal, Pencil, Plus, Search, Server, SquarePen, Trash2, Users, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { AgentAvatar } from '@/plugins/agents/presentation/AgentAvatar';
import { useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { useChatStore } from '@/plugins/chat/store';
import { selectAgentSessionsPaneState, type AgentSessionsPaneRuntimeEndpoint, type AgentSessionsPaneSession, type AgentSessionsPaneSessionEntry } from '@/plugins/chat/store/selectors';
import { isDeletableSession } from '@/plugins/chat/store/types';
import type { AgentScope, SessionIdentity } from '@/types/desktop/runtime-address';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  resolveAgentScopeForRuntimeEndpoint,
  resolveSessionTitle,
  useAgentSessionsPaneViewModel,
} from './useAgentSessionsPaneViewModel';
import { buildSwitchboardAgentKey, type AgentSessionSwitchboardAgentResult } from './agent-session-switchboard-model';
import { TeamSessionsSidebar } from './TeamSessionsSidebar';
import { showWorkspaceChat } from '@/plugins/workspace/actions';

const iconClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';
const runtimeStatusLabels = {
  starting: 'switchboard.runtimeStarting',
  failed: 'switchboard.runtimeFailed',
  stopped: 'switchboard.runtimeStopped',
  unavailable: 'switchboard.runtimeStatusUnavailable',
} as const;
type SidebarMode = 'agents' | 'teams';
type SessionDraft = { key: string; title: string };
type SessionMutation =
  | { kind: 'rename' | 'delete'; draft: SessionDraft }
  | { kind: 'deleteAgent'; scope: AgentScope; name: string; identities: readonly SessionIdentity[] };

function SessionRunningIndicator() {
  const { t } = useTranslation('common');
  const label = t('status.running');
  return <span role="img" aria-label={label} title={label}
    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-current text-blue-600 shadow-[0_0_6px_currentColor] motion-safe:animate-[session-running-breathe_2s_ease-in-out_infinite] dark:text-blue-400" />;
}

const SessionRow = memo(function SessionRow({
  entry, isCurrent, onSwitch, onRename, onDelete,
}: {
  entry: AgentSessionsPaneSessionEntry;
  isCurrent: boolean;
  onSwitch: (key: string) => void;
  onRename: (session: AgentSessionsPaneSession, title: string, trigger: HTMLButtonElement | null) => void;
  onDelete: (session: AgentSessionsPaneSession, title: string, trigger: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation('common');
  const actionRef = useRef<HTMLButtonElement>(null);
  const title = resolveSessionTitle(entry, t);
  const editable = isDeletableSession(entry.session);
  return (
    <div className={cn('group relative flex min-w-0 items-center rounded-md', isCurrent ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/70')}>
      <button type="button" className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring', editable && 'group-hover:pr-8 group-focus-within:pr-8 group-has-[[data-state=open]]:pr-8 [@media(hover:none)]:pr-8')}
        aria-current={isCurrent ? 'true' : undefined} title={title} onClick={() => onSwitch(entry.session.key)}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {entry.isRunning && <SessionRunningIndicator />}
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
  agent, sessions, currentSessionKey, active, endpoint,
  onSwitch, onRename, onDelete, onNewSession, onDeleteAgent,
}: {
  agent: AgentSessionSwitchboardAgentResult;
  sessions: AgentSessionsPaneSessionEntry[];
  currentSessionKey: string;
  active: boolean;
  endpoint: AgentSessionsPaneRuntimeEndpoint | undefined;
  onSwitch: (key: string) => void;
  onRename: (session: AgentSessionsPaneSession, title: string, trigger: HTMLButtonElement | null) => void;
  onDelete: (session: AgentSessionsPaneSession, title: string, trigger: HTMLButtonElement | null) => void;
  onNewSession: (scope: AgentScope) => void;
  onDeleteAgent: (scope: AgentScope, name: string, identities: readonly SessionIdentity[], trigger: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const open = expanded;
  const running = !open && agent.sessions.some((entry) => entry.isRunning);
  const scope = useMemo<AgentScope | null>(() => endpoint
    ? { kind: 'agent', endpoint: endpoint.endpoint, agentId: agent.agentId } : null, [agent.agentId, endpoint]);
  const newSessionScope = useMemo(() => endpoint?.target
    ? resolveAgentScopeForRuntimeEndpoint(endpoint.target, agent.agentId) : null, [agent.agentId, endpoint]);
  const deletableIdentities = useMemo(() => endpoint?.agents.find((entry) => entry.agentId === agent.agentId)?.deletableIdentities
    ?? [], [agent.agentId, endpoint]);
  return (
    <section>
      <div className={cn('group/agent relative flex items-center gap-0.5 rounded-md px-1 hover:bg-secondary/70', active && 'bg-secondary/50')}>
        <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[13px] leading-5 font-medium text-foreground outline-none group-hover/agent:pr-14 group-focus-within/agent:pr-14 group-has-[[data-state=open]]/agent:pr-14 [@media(hover:none)]:pr-14 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={running ? `${t('switchboard.agentSessionsAria', { name: agent.agentName })} · ${t('status.running')}` : t('switchboard.agentSessionsAria', { name: agent.agentName })} aria-expanded={open} aria-controls={listId}
          title={`${agent.runtimeLabel} / ${agent.agentName}`} onClick={() => setExpanded(!open)}>
          <AgentAvatar agentId={agent.agentId} agentName={agent.agentName} avatarSeed={agent.avatarSeed} avatarStyle={agent.avatarStyle} className="h-5 w-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{agent.agentName}</span>
          {running && <SessionRunningIndicator />}
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
      <div id={listId} hidden={!open} className="mb-1 space-y-0.5 border-l border-border/50 pl-1">
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
  const { sessionEntries, sessionsError, currentConversation, runtimeEndpoints, currentSessionKey,
    switchSession, newSessionForScope, renameSession, deleteSession, deleteAgentSessions } = useChatStore(useShallow(selectAgentSessionsPaneState));
  const agentsByRuntime = useSubagentsStore((state) => state.agentsByRuntime);
  const pane = useAgentSessionsPaneViewModel({ agentsByRuntime, sessionEntries, sessionsError, runtimeEndpoints });
  const [mode, setMode] = useState<SidebarMode>('agents');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const mutationReturnFocusRef = useRef<HTMLElement | null>(null);
  const [mutation, setMutation] = useState<SessionMutation | null>(null);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<'failed' | 'unknown' | null>(null);
  const [diagnosticDraftFailed, setDiagnosticDraftFailed] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRuntimes = useMemo(() => pane.agentResults.map((runtime) => ({
    ...runtime,
    agents: runtime.agents.map((agent) => ({
      agent,
      sessions: normalizedQuery ? agent.sessions.filter((entry) => resolveSessionTitle(entry, t).toLocaleLowerCase().includes(normalizedQuery)) : agent.sessions,
    })).filter((group) => !normalizedQuery || group.sessions.length > 0),
  })).filter((runtime) => !normalizedQuery || runtime.agents.length > 0), [pane.agentResults, normalizedQuery, t]);
  const currentAgentKey = currentConversation ? buildSwitchboardAgentKey(currentConversation.runtimeScopeKey, currentConversation.agentId) : null;
  const selectSession = useCallback((key: string) => {
    showWorkspaceChat();
    switchSession(key);
  }, [switchSession]);
  const startNewSession = useCallback((scope: AgentScope) => {
    showWorkspaceChat();
    void newSessionForScope(scope);
  }, [newSessionForScope]);
  const openDiagnosticDraft = async () => {
    if (!pane.matchaDiagnosticScope) return;
    setDiagnosticDraftFailed(false);
    try {
      const opened = await newSessionForScope(pane.matchaDiagnosticScope, t('switchboard.openClawDiagnosticPrompt'));
      if (!opened) { setDiagnosticDraftFailed(true); return; }
      showWorkspaceChat();
    } catch {
      setDiagnosticDraftFailed(true);
    }
  };
  const beginMutation = useCallback((kind: 'rename' | 'delete', session: AgentSessionsPaneSession, title: string, trigger: HTMLButtonElement | null) => {
    if (!isDeletableSession(session)) return;
    mutationReturnFocusRef.current = trigger;
    setMutationError(null);
    setMutation({ kind, draft: { key: session.key, title } });
  }, []);
  const startRename = useCallback((session: AgentSessionsPaneSession, title: string, trigger: HTMLButtonElement | null) => beginMutation('rename', session, title, trigger), [beginMutation]);
  const requestDelete = useCallback((session: AgentSessionsPaneSession, title: string, trigger: HTMLButtonElement | null) => beginMutation('delete', session, title, trigger), [beginMutation]);
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
  return (
    <Tabs asChild value={mode} onValueChange={(value) => setMode(value as SidebarMode)}>
    <aside data-testid="agent-sessions-pane" className="flex h-full min-h-0 w-full min-w-0 flex-col bg-transparent">
      <header className="flex h-12 shrink-0 items-center gap-1 px-3">
        <TabsList variant="line" aria-label={t('switchboard.tabs.sessions')} className="min-h-0 min-w-0 flex-1 gap-3 overflow-visible">
          {(['agents', 'teams'] as const).map((tab) => <TabsTrigger key={tab} value={tab} title={t(`switchboard.tabs.${tab}`)}
            ref={mode === tab ? modeRef : undefined}
            className="relative text-[13px] text-muted-foreground hover:text-foreground group-data-[variant=line]/tabs:border-b-0 group-data-[variant=line]/tabs:pb-2 after:absolute after:inset-x-0 after:bottom-1.5 after:h-0.5 after:rounded-full after:bg-transparent data-[state=active]:after:bg-foreground">
            {t(`switchboard.tabs.${tab}`)}
          </TabsTrigger>)}
        </TabsList>
        <button ref={searchButtonRef} type="button" className={cn(iconClass, searchOpen && 'bg-secondary text-foreground')} aria-label={t('switchboard.searchSessions')}
          aria-expanded={searchOpen} title={t('switchboard.searchSessions')} onClick={() => {
            if (searchOpen) { setSearchOpen(false); setQuery(''); } else { setSearchOpen(true); }
          }}><Search className="h-3.5 w-3.5" /></button>
        <button type="button" className={iconClass} aria-label={t(mode === 'agents' ? 'switchboard.addAgent' : 'sidebar.teams')}
          title={t(mode === 'agents' ? 'switchboard.addAgent' : 'sidebar.teams')} onClick={() => navigate(mode === 'agents' ? '/subagents' : '/teams')}>
          {mode === 'agents' ? <Plus className="h-4 w-4" /> : <Users className="h-4 w-4" />}
        </button>
      </header>
      {searchOpen && <div className="px-3 pb-2">
        <Input ref={searchRef} autoFocus type="search" value={query} className="h-8 rounded-md text-[13px]" aria-label={t('switchboard.searchSessions')}
          placeholder={t('switchboard.searchPlaceholder')} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); setQuery(''); setSearchOpen(false); searchButtonRef.current?.focus(); }
          }} />
      </div>}
      <div data-testid="session-list-scroll-area" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <TabsContent value="agents" className="mt-0">
          {pane.sessionErrorMessage && <p role="alert" className="px-2 py-2 text-xs text-destructive">{pane.sessionErrorMessage}</p>}
          {visibleRuntimes.length === 0 && normalizedQuery && <p className="px-2 py-4 text-xs text-muted-foreground">{t('switchboard.noSearchResults')}</p>}
          {visibleRuntimes.map((runtime) => {
            const endpoint = runtime.endpoint;
            const adapterId = endpoint.endpoint.kind === 'native-runtime' ? endpoint.endpoint.runtimeAdapterId : null;
            const runtimeStatus = runtime.runtimeStatus;
            const statusLabel = runtimeStatus && runtimeStatus !== 'loading' ? runtimeStatusLabels[runtimeStatus] : null;
            const loading = runtimeStatus === 'loading' || runtimeStatus === 'starting' || (!runtimeStatus && runtime.isLoading);
            const diagnosticAvailable = adapterId === 'openclaw' && endpoint.endpoint.kind === 'native-runtime'
              && endpoint.endpoint.runtimeInstanceId === 'local' && (runtimeStatus === 'failed' || runtimeStatus === 'stopped');
            const diagnosticKey = runtimeStatus === 'failed' ? 'switchboard.openClawRepair' : 'switchboard.openClawStart';
            return <section key={runtime.runtimeScopeKey} aria-label={runtime.runtimeLabel} className="[&+section]:mt-1.5 [&+section]:border-t [&+section]:border-border/50 [&+section]:pt-1.5">
              <div className="sticky top-0 z-10 flex min-h-8 min-w-0 items-center gap-2 bg-[hsl(var(--shell-surface-muted))] px-1">
                <h3 title={runtime.runtimeLabel} className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold leading-5 text-foreground">
                  <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center">{adapterId === 'matcha-agent' ? '🍵' : adapterId === 'openclaw' ? '🦞' : <Server className="h-4 w-4" />}</span>
                  <span className="truncate">{runtime.runtimeLabel}</span>
                </h3>
                {loading && <span role="status" aria-label={t(statusLabel ?? 'status.loading')} className="flex shrink-0"><Loader2 aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin" /></span>}
                {statusLabel && runtimeStatus !== 'starting' && !diagnosticAvailable && <span role="status" className={cn('max-w-[55%] shrink-0 truncate text-[11px] leading-4', runtimeStatus === 'failed' ? 'text-red-700 dark:text-destructive' : 'text-muted-foreground')}>{t(statusLabel)}</span>}
              </div>
              {diagnosticAvailable && <button type="button"
                className="block w-full rounded-md px-2 py-1 text-left text-xs leading-5 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!pane.matchaDiagnosticScope}
                title={pane.matchaDiagnosticScope ? undefined : t('switchboard.openClawMatchaUnavailable')}
                onClick={() => { void openDiagnosticDraft(); }}>
                <Trans i18nKey={diagnosticKey} components={{ status: <span className={runtimeStatus === 'failed' ? 'text-red-700 dark:text-destructive' : undefined} /> }} />
                {' '}<ArrowUpRight aria-hidden="true" className="inline h-3 w-3 align-[-2px]" />
              </button>}
              {runtimeStatus === 'starting' && <p role="status" className="px-2 pb-2 pt-1 text-xs leading-5 text-muted-foreground">{t('switchboard.runtimeStarting')}</p>}
              {diagnosticAvailable && diagnosticDraftFailed && <p role="alert" className="px-2 pb-2 text-xs text-destructive">{t('switchboard.openClawDraftFailed')}</p>}
              {!runtimeStatus && runtime.errorMessage && <p role="alert" className="px-2 py-2 text-xs text-destructive">{t('status.error')}: {runtime.errorMessage}</p>}
              {runtime.agents.length === 0 && !runtimeStatus && !runtime.isLoading && !runtime.errorMessage && <p className="px-2 py-4 text-xs text-muted-foreground">{t('sidebar.noSubagents')}</p>}
              <div className="space-y-0.5">
                {runtime.agents.map(({ agent, sessions }) => <AgentGroup key={agent.key}
                  agent={agent} sessions={sessions}
                  currentSessionKey={agent.key === currentAgentKey ? currentSessionKey : ''} active={agent.key === currentAgentKey}
                  endpoint={endpoint}
                  onSwitch={selectSession} onRename={startRename} onDelete={requestDelete}
                  onNewSession={startNewSession} onDeleteAgent={requestDeleteAgent} />)}
              </div>
            </section>;
          })}
        </TabsContent>
        <TabsContent value="teams" className="mt-0"><TeamSessionsSidebar query={query} /></TabsContent>
      </div>
      <Dialog.Root open={mutation !== null} onOpenChange={(open) => { if (!open && !pending) setMutation(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-elevated outline-none"
            aria-busy={pending} onOpenAutoFocus={(event) => { event.preventDefault(); (mutation?.kind === 'rename' ? renameInputRef.current : cancelRef.current)?.focus(); }}
            onCloseAutoFocus={(event) => { event.preventDefault(); const target = mutationReturnFocusRef.current; if (target?.isConnected) target.focus(); else modeRef.current?.focus(); }}
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
    </Tabs>
  );
});
