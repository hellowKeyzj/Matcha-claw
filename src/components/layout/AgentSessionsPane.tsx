import { memo, useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { useSubagentsStore } from '@/stores/subagents';
import {
  isKnownTeamRoleSession,
  resolveTeamRoleChatTargetFromProbe,
  selectTeamRoleChatTargetIndex,
  useTeamsStore,
} from '@/stores/teams';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { selectAgentSessionsPaneState } from '@/stores/chat/selectors';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useShallow } from 'zustand/react/shallow';
import {
  inferUntitledSessionLabel,
  readSessionSuffix,
  type AgentSessionNode,
  type SessionBucketId,
  type SessionBucketNode,
  type SessionViewModel,
  useAgentSessionsPaneViewModel,
} from './useAgentSessionsPaneViewModel';

interface AgentSessionsPaneProps {
  expandedWidth?: number;
  collapsed?: boolean;
  collapsedWidth?: number;
  onToggleCollapse?: () => void;
  showRightDivider?: boolean;
}

const SESSION_BUCKET_COLLAPSE_STORAGE_KEY = 'layout:session-time-bucket-collapsed';

type SessionPaneTab = 'agent' | 'team';

function createSessionBucketStateKey(bucketId: SessionBucketId): string {
  return bucketId;
}

function loadCollapsedSessionBucketMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(SESSION_BUCKET_COLLAPSE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.trim() || typeof value !== 'boolean') {
        continue;
      }
      next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

interface AgentListItemProps {
  node: AgentSessionNode;
  isAgentActive: boolean;
  newSessionLabel: string;
  onOpenAgent: (agentId: string) => void;
  onCreateSessionForAgent: (agentId: string) => void;
}

const AgentListItem = memo(function AgentListItem({
  node,
  isAgentActive,
  newSessionLabel,
  onOpenAgent,
  onCreateSessionForAgent,
}: AgentListItemProps) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-[calc(var(--radius-interactive)+2px)] pr-1 transition-[background-color,color,box-shadow]',
        isAgentActive
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <button
        type="button"
        data-testid={`agent-item-${node.agentId}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm font-medium"
        onClick={() => onOpenAgent(node.agentId)}
      >
        <AgentAvatar
          agentId={node.agentId}
          agentName={node.agentName}
          avatarSeed={node.avatarSeed}
          avatarStyle={node.avatarStyle}
          className="h-5 w-5"
          dataTestId={`agent-session-avatar-${node.agentId}`}
        />
        <span className="truncate">{node.agentName}</span>
      </button>
      <button
        type="button"
        data-testid={`agent-new-session-${node.agentId}`}
        className="shrink-0 rounded-full p-1 text-current/80 opacity-0 transition group-hover:opacity-100 hover:bg-card/15"
        aria-label={`${newSessionLabel} ${node.agentName}`}
        title={`${newSessionLabel} ${node.agentName}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCreateSessionForAgent(node.agentId);
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});

interface SessionListItemProps {
  session: ChatSession;
  sessionTitle: string;
  sessionMeta: string;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  isCurrent: boolean;
  deleting: boolean;
  renaming: boolean;
  editing: boolean;
  editingTitle: string;
  deleteLabel: string;
  renameLabel: string;
  saveRenameLabel: string;
  cancelRenameLabel: string;
  onSwitchSession: (sessionKey: string) => void;
  onStartRename: (session: ChatSession, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (session: ChatSession) => void;
}

const SessionListItem = memo(function SessionListItem({
  session,
  sessionTitle,
  sessionMeta,
  agentId,
  agentName,
  avatarSeed,
  avatarStyle,
  isCurrent,
  deleting,
  renaming,
  editing,
  editingTitle,
  deleteLabel,
  renameLabel,
  saveRenameLabel,
  cancelRenameLabel,
  onSwitchSession,
  onStartRename,
  onRenameTitleChange,
  onSubmitRename,
  onCancelRename,
  onRequestDelete,
}: SessionListItemProps) {
  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-[calc(var(--radius-interactive)+2px)] bg-secondary px-1.5 py-1">
        <Input
          value={editingTitle}
          autoFocus
          disabled={renaming}
          aria-label={renameLabel}
          className="h-8 min-w-0 flex-1 text-sm"
          onChange={(event) => onRenameTitleChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmitRename();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancelRename();
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded-full p-1 text-current/70 transition hover:bg-card/15 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={saveRenameLabel}
          title={saveRenameLabel}
          disabled={renaming}
          onMouseDown={(event) => {
            event.preventDefault();
            onSubmitRename();
          }}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="shrink-0 rounded-full p-1 text-current/70 transition hover:bg-card/15 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={cancelRenameLabel}
          title={cancelRenameLabel}
          disabled={renaming}
          onMouseDown={(event) => {
            event.preventDefault();
            onCancelRename();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-[calc(var(--radius-interactive)+2px)] transition-[background-color,color,box-shadow]',
        isCurrent
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        onClick={() => onSwitchSession(session.key)}
      >
        <AgentAvatar
          agentId={agentId}
          agentName={agentName}
          avatarSeed={avatarSeed}
          avatarStyle={avatarStyle}
          className="h-4 w-4"
          dataTestId={`session-avatar-${session.key}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{sessionTitle}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">{sessionMeta}</span>
        </span>
      </button>
      {session.kind !== 'main' && !session.preferred && (
        <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            className="rounded-full p-1 text-current/70 transition hover:bg-card/15 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={renameLabel}
            title={renameLabel}
            disabled={deleting || renaming}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onStartRename(session, sessionTitle);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-full p-1 text-current/70 transition hover:bg-destructive/15 hover:text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={deleteLabel}
            title={deleteLabel}
            disabled={deleting || renaming}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRequestDelete(session);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
});

interface AgentListSectionProps {
  nodes: AgentSessionNode[];
  activeAgentId: string;
  newSessionLabel: string;
  state: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  emptyLabel: string;
  loadingLabel: string;
  fallbackErrorLabel: string;
  onOpenAgent: (agentId: string) => void;
  onCreateSessionForAgent: (agentId: string) => void;
}

interface TeamRoleSessionNode {
  roleId: string;
  agentId: string;
  sessionIdentity: ChatSession['sessionIdentity'];
  endpointSessionId: string;
}

interface TeamRunSessionNode {
  runId: string;
  leader?: TeamRoleSessionNode;
  roles: TeamRoleSessionNode[];
}

interface TeamSessionNode {
  teamId: string;
  teamName: string;
  activeRunId?: string;
  runs: TeamRunSessionNode[];
}

interface TeamListSectionProps {
  nodes: TeamSessionNode[];
  expandedTeamIds: Record<string, boolean>;
  expandedTeamRunIds: Record<string, boolean>;
  emptyLabel: string;
  leaderLabel: string;
  newRunLabel: string;
  onToggleTeam: (teamId: string) => void;
  onToggleRun: (runId: string) => void;
  onSelectRun: (teamId: string, run: TeamRunSessionNode) => void;
  onCreateRun: (teamId: string) => void;
  onSelectRole: (teamId: string, runId: string, role: TeamRoleSessionNode) => void;
}

const TeamListSection = memo(function TeamListSection({
  nodes,
  expandedTeamIds,
  expandedTeamRunIds,
  emptyLabel,
  leaderLabel,
  newRunLabel,
  onToggleTeam,
  onToggleRun,
  onSelectRun,
  onCreateRun,
  onSelectRole,
}: TeamListSectionProps) {
  if (nodes.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-1">
      {nodes.map((node) => {
        const expanded = expandedTeamIds[node.teamId] === true;
        const previewAgents = node.runs[0]
          ? [
            ...(node.runs[0].leader ? [{ key: 'leader', agentId: node.runs[0].leader.agentId, agentName: leaderLabel }] : []),
            ...node.runs[0].roles.map((role) => ({ key: role.roleId, agentId: role.agentId, agentName: role.roleId })),
          ]
          : [];
        const visiblePreviewAgents = previewAgents.slice(0, 4);
        const hiddenPreviewAgentCount = previewAgents.length - visiblePreviewAgents.length;
        return (
          <div key={node.teamId} className="space-y-1">
            <div
              className={cn(
                'group flex items-center gap-1 rounded-[calc(var(--radius-interactive)+2px)] pr-1 transition-[background-color,color,box-shadow]',
                expanded
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <button
                type="button"
                className="flex h-8 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-interactive)+2px)] text-current/80 transition hover:bg-card/15 hover:text-foreground"
                aria-expanded={expanded}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleTeam(node.teamId);
                }}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 px-1 py-2 text-left text-sm font-medium"
                onClick={() => onToggleTeam(node.teamId)}
              >
                <span className="flex h-5 shrink-0 items-center -space-x-1">
                  {visiblePreviewAgents.map((agent) => (
                    <AgentAvatar
                      key={`${node.teamId}:${agent.key}`}
                      agentId={agent.agentId}
                      agentName={agent.agentName}
                      className="h-5 w-5 border border-card bg-background"
                    />
                  ))}
                  {hiddenPreviewAgentCount > 0 ? (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-card bg-muted px-1 text-[9px] font-semibold text-muted-foreground">
                      +{hiddenPreviewAgentCount}
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{node.teamName}</span>
              </button>
              <button
                type="button"
                className="shrink-0 rounded-full p-1 text-current/80 transition hover:bg-card/15 hover:text-foreground"
                aria-label={`${newRunLabel} ${node.teamName}`}
                title={`${newRunLabel} ${node.teamName}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onCreateRun(node.teamId);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {expanded && node.runs.length > 0 ? (
              <div className="ml-3 border-l border-border/60 pl-2 space-y-0.5">
                {node.runs.map((run) => {
                  const runExpanded = expandedTeamRunIds[run.runId] === true;
                  const isActiveRun = node.activeRunId === run.runId;
                  return (
                    <div key={`${node.teamId}:${run.runId}`} className="space-y-0.5">
                      <div className={cn(
                        'flex items-center gap-0.5 transition-colors',
                        isActiveRun ? 'text-foreground' : 'text-muted-foreground',
                      )}
                      >
                        <button
                          type="button"
                          className="flex h-6 w-5 shrink-0 items-center justify-center rounded-[calc(var(--radius-interactive)+2px)] text-current/80 transition hover:bg-card/15 hover:text-foreground"
                          aria-expanded={runExpanded}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onToggleRun(run.runId);
                          }}
                        >
                          {runExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </button>
                        <button
                          type="button"
                          className={cn(
                            'min-w-0 flex-1 rounded-[calc(var(--radius-interactive)+2px)] px-1 py-1 text-left text-xs transition-colors',
                            isActiveRun ? 'bg-secondary text-foreground' : 'hover:bg-secondary hover:text-foreground',
                          )}
                          onClick={() => onSelectRun(node.teamId, run)}
                        >
                          <span className="block truncate">{run.runId}</span>
                        </button>
                      </div>
                      {runExpanded ? (
                        <div className="ml-3 border-l border-border/50 pl-2 space-y-0.5">
                          {run.roles.map((role) => (
                            <button
                              key={`${node.teamId}:${run.runId}:${role.roleId}`}
                              type="button"
                              className="flex w-full items-center gap-1.5 rounded-[calc(var(--radius-interactive)+2px)] px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                              onClick={() => onSelectRole(node.teamId, run.runId, role)}
                            >
                              <AgentAvatar agentId={role.agentId} agentName={role.roleId} className="h-4 w-4" />
                              <span className="min-w-0 flex-1 truncate">{role.roleId}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

const AgentListSection = memo(function AgentListSection({
  nodes,
  activeAgentId,
  newSessionLabel,
  state,
  errorMessage,
  emptyLabel,
  loadingLabel,
  fallbackErrorLabel,
  onOpenAgent,
  onCreateSessionForAgent,
}: AgentListSectionProps) {
  if (state === 'loading') {
    return (
      <p data-testid="agent-list-loading" className="px-2 py-1 text-xs text-muted-foreground">
        {loadingLabel}
      </p>
    );
  }
  if (state === 'error') {
    return (
      <p data-testid="agent-list-error" className="px-2 py-1 text-xs text-destructive">
        {errorMessage || fallbackErrorLabel}
      </p>
    );
  }
  if (nodes.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <AgentListItem
          key={node.agentId}
          node={node}
          isAgentActive={activeAgentId === node.agentId}
          newSessionLabel={newSessionLabel}
          onOpenAgent={onOpenAgent}
          onCreateSessionForAgent={onCreateSessionForAgent}
        />
      ))}
    </div>
  );
});

interface SessionListSectionProps {
  buckets: SessionBucketNode[];
  sessionViewModelByKey: Map<string, SessionViewModel>;
  currentSessionKey: string;
  deletingSessionKeys: Record<string, true>;
  renamingSessionKey: string | null;
  editingSession: { key: string; title: string } | null;
  collapsedSessionBuckets: Record<string, boolean>;
  state: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  emptyLabel: string;
  loadingLabel: string;
  fallbackErrorLabel: string;
  fallbackDeleteLabel: (sessionKey: string) => string;
  fallbackRenameLabel: (sessionKey: string) => string;
  fallbackUntitledLabel: (session: ChatSession) => string;
  onToggleBucket: (bucketId: SessionBucketId, defaultCollapsed: boolean) => void;
  onSwitchSession: (sessionKey: string) => void;
  onStartRename: (session: ChatSession, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (session: ChatSession) => void;
}

const SessionListSection = memo(function SessionListSection({
  buckets,
  sessionViewModelByKey,
  currentSessionKey,
  deletingSessionKeys,
  renamingSessionKey,
  editingSession,
  collapsedSessionBuckets,
  state,
  errorMessage,
  emptyLabel,
  loadingLabel,
  fallbackErrorLabel,
  fallbackDeleteLabel,
  fallbackRenameLabel,
  fallbackUntitledLabel,
  onToggleBucket,
  onSwitchSession,
  onStartRename,
  onRenameTitleChange,
  onSubmitRename,
  onCancelRename,
  onRequestDelete,
}: SessionListSectionProps) {
  if (state === 'loading') {
    return (
      <p data-testid="session-list-loading" className="px-2 py-1 text-xs text-muted-foreground">
        {loadingLabel}
      </p>
    );
  }
  if (state === 'error') {
    return (
      <p data-testid="session-list-error" className="px-2 py-1 text-xs text-destructive">
        {errorMessage || fallbackErrorLabel}
      </p>
    );
  }
  if (buckets.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-1">
      {buckets.map((bucket) => {
        const bucketStateKey = createSessionBucketStateKey(bucket.id);
        const bucketCollapsed = Object.prototype.hasOwnProperty.call(collapsedSessionBuckets, bucketStateKey)
          ? Boolean(collapsedSessionBuckets[bucketStateKey])
          : bucket.defaultCollapsed;
        return (
          <div key={bucket.id} className="space-y-1">
            <button
              type="button"
              onClick={() => onToggleBucket(bucket.id, bucket.defaultCollapsed)}
              className="flex w-full items-center gap-2 rounded-[calc(var(--radius-interactive)+2px)] px-2.5 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {bucketCollapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{bucket.label}</span>
              <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                {bucket.sessions.length}
              </span>
            </button>

            {!bucketCollapsed && (
              <div className="space-y-1">
                {bucket.sessions.map((entry) => {
                  const session = entry.session;
                  const viewModel = sessionViewModelByKey.get(session.key);
                  const deleting = Boolean(deletingSessionKeys[session.key]);
                  const editing = editingSession?.key === session.key;
                  return (
                    <SessionListItem
                      key={session.key}
                      session={session}
                      sessionTitle={viewModel?.title ?? fallbackUntitledLabel(session)}
                      sessionMeta={viewModel?.meta ?? readSessionSuffix(session)}
                      agentId={viewModel?.agentId ?? session.agentId}
                      agentName={viewModel?.agentName ?? session.agentId}
                      avatarSeed={viewModel?.avatarSeed}
                      avatarStyle={viewModel?.avatarStyle}
                      isCurrent={currentSessionKey === session.key}
                      deleting={deleting}
                      renaming={renamingSessionKey === session.key}
                      editing={editing}
                      editingTitle={editing ? editingSession.title : ''}
                      deleteLabel={viewModel?.deleteLabel ?? fallbackDeleteLabel(session.key)}
                      renameLabel={viewModel?.renameLabel ?? fallbackRenameLabel(session.key)}
                      saveRenameLabel={viewModel?.saveRenameLabel ?? fallbackRenameLabel(session.key)}
                      cancelRenameLabel={viewModel?.cancelRenameLabel ?? fallbackRenameLabel(session.key)}
                      onSwitchSession={onSwitchSession}
                      onStartRename={onStartRename}
                      onRenameTitleChange={onRenameTitleChange}
                      onSubmitRename={onSubmitRename}
                      onCancelRename={onCancelRename}
                      onRequestDelete={onRequestDelete}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export const AgentSessionsPane = memo(function AgentSessionsPane({
  expandedWidth = 300,
  collapsed = false,
  collapsedWidth = 52,
  onToggleCollapse,
  showRightDivider = true,
}: AgentSessionsPaneProps) {
  const { t, i18n } = useTranslation();
  const agentsResource = useSubagentsStore((state) => state.agentsResource);
  const agents = Array.isArray(agentsResource.data) ? agentsResource.data : [];
  const {
    sessionEntries,
    sessionsLoading,
    sessionsLoadedOnce,
    sessionsError,
    currentSessionKey,
    currentAgentId,
    switchSession,
    openAgentConversation,
    openSessionIdentity,
    newSession,
    deleteSession,
    renameSession,
  } = useChatStore(useShallow(selectAgentSessionsPaneState));
  const teams = useTeamsStore((state) => state.teams);
  const runListByTeamId = useTeamsStore((state) => state.runListByTeamId);
  const teamRoleChatTargetIndex = useTeamsStore(selectTeamRoleChatTargetIndex);
  const createRun = useTeamsStore((state) => state.createRun);
  const setActiveRun = useTeamsStore((state) => state.setActiveRun);
  const syncRunList = useTeamsStore((state) => state.syncRunList);
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const [activeTab, setActiveTab] = useState<SessionPaneTab>('agent');
  const [expandedTeamIds, setExpandedTeamIds] = useState<Record<string, boolean>>({});
  const [expandedTeamRunIds, setExpandedTeamRunIds] = useState<Record<string, boolean>>({});
  const [collapsedSessionBuckets, setCollapsedSessionBuckets] = useState<Record<string, boolean>>(
    () => loadCollapsedSessionBucketMap(),
  );
  const [deletingSessionKeys, setDeletingSessionKeys] = useState<Record<string, true>>({});
  const [renamingSessionKey, setRenamingSessionKey] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<{ key: string; title: string } | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    key: string;
    title: string;
  } | null>(null);

  const agentPaneSessionEntries = sessionEntries.filter((entry) => !isKnownTeamRoleSession(teamRoleChatTargetIndex, {
    sessionIdentity: entry.session.sessionIdentity,
    sessionKey: entry.session.key,
    backendSessionKey: entry.session.backendSessionKey,
    endpointSessionId: entry.session.endpointSessionId,
  }));
  const paneViewModel = useAgentSessionsPaneViewModel({
    agents,
    agentsResource,
    sessionEntries: agentPaneSessionEntries,
    sessionsLoading,
    sessionsLoadedOnce,
    sessionsError,
    currentAgentId,
    locale: i18n.language,
    t,
  });
  const activeAgentNode = paneViewModel.agentNodes.find((node) => node.agentId === paneViewModel.activeAgentId);
  const teamSyncKey = teams.map((team) => team.id).join('\n');
  const teamNodes: TeamSessionNode[] = teams.map((team) => ({
    teamId: team.id,
    teamName: team.name,
    activeRunId: team.activeRunId,
    runs: (runListByTeamId[team.id] ?? []).map((run) => {
      const toRoleNode = (role: (typeof run.sessions)[number]): TeamRoleSessionNode => ({
        roleId: role.roleId,
        agentId: role.agentId,
        sessionIdentity: role.sessionIdentity,
        endpointSessionId: resolveTeamRoleChatTargetFromProbe(teamRoleChatTargetIndex, {
          sessionIdentity: role.sessionIdentity,
          sessionKey: role.localSessionId,
          endpointSessionId: role.endpointSessionId,
        })?.endpointSessionId ?? role.endpointSessionId,
      });
      const leader = run.sessions.find((role) => role.roleId === 'leader');
      return {
        runId: run.runId,
        ...(leader ? { leader: toRoleNode(leader) } : {}),
        roles: run.sessions
          .filter((role) => role.roleId !== 'leader')
          .map(toRoleNode),
      };
    }),
  }));

  useEffect(() => {
    if (activeTab !== 'team') {
      return;
    }
    const teamIds = teamSyncKey ? teamSyncKey.split('\n') : [];
    for (const teamId of teamIds) {
      void syncRunList(teamId);
    }
  }, [activeTab, syncRunList, teamSyncKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SESSION_BUCKET_COLLAPSE_STORAGE_KEY,
        JSON.stringify(collapsedSessionBuckets),
      );
    } catch {
      // ignore localStorage failures
    }
  }, [collapsedSessionBuckets]);

  const handleSwitchSession = useCallback((sessionKey: string) => {
    switchSession(sessionKey);
  }, [switchSession]);

  const handleOpenAgent = useCallback((agentId: string) => {
    openAgentConversation(agentId);
  }, [openAgentConversation]);

  const handleCreateSessionForAgent = useCallback((agentId: string) => {
    if (!agentId.trim()) {
      return;
    }
    newSession(agentId);
  }, [newSession]);

  const selectTeamRole = useCallback((teamId: string, runId: string, role: TeamRoleSessionNode) => {
    setActiveRun(teamId, runId);
    openSessionIdentity({ sessionIdentity: role.sessionIdentity, endpointSessionId: role.endpointSessionId });
    void refreshSnapshot(teamId, { force: true });
  }, [openSessionIdentity, refreshSnapshot, setActiveRun]);

  const toggleTeam = useCallback((teamId: string) => {
    setExpandedTeamIds((current) => ({ ...current, [teamId]: current[teamId] !== true }));
  }, []);

  const toggleRun = useCallback((runId: string) => {
    setExpandedTeamRunIds((current) => ({ ...current, [runId]: current[runId] !== true }));
  }, []);

  const selectTeamRun = useCallback((teamId: string, run: TeamRunSessionNode) => {
    setActiveRun(teamId, run.runId);
    if (run.leader) {
      openSessionIdentity({ sessionIdentity: run.leader.sessionIdentity, endpointSessionId: run.leader.endpointSessionId });
    }
    void refreshSnapshot(teamId, { force: true });
  }, [openSessionIdentity, refreshSnapshot, setActiveRun]);

  const handleCreateRunForTeam = useCallback((teamId: string) => {
    void createRun(teamId);
  }, [createRun]);

  const toggleSessionBucket = useCallback((bucketId: SessionBucketId, defaultCollapsed: boolean) => {
    const stateKey = createSessionBucketStateKey(bucketId);
    setCollapsedSessionBuckets((prev) => {
      const current = Object.prototype.hasOwnProperty.call(prev, stateKey)
        ? Boolean(prev[stateKey])
        : defaultCollapsed;
      return { ...prev, [stateKey]: !current };
    });
  }, []);

  const requestDeleteSession = useCallback((session: ChatSession) => {
    if (session.kind === 'main' || session.preferred) {
      return;
    }
    const title = paneViewModel.sessionViewModelByKey.get(session.key)?.title
      ?? inferUntitledSessionLabel(session, t);
    setPendingDeleteSession({
      key: session.key,
      title,
    });
  }, [paneViewModel.sessionViewModelByKey, t]);

  const startRenameSession = useCallback((session: ChatSession, title: string) => {
    if (session.kind === 'main' || session.preferred) {
      return;
    }
    setEditingSession({
      key: session.key,
      title,
    });
  }, []);

  const submitRenameSession = useCallback(async () => {
    if (!editingSession) {
      return;
    }
    const normalizedTitle = editingSession.title.trim();
    if (!normalizedTitle) {
      setEditingSession(null);
      return;
    }
    setRenamingSessionKey(editingSession.key);
    try {
      await renameSession(editingSession.key, normalizedTitle);
      setEditingSession(null);
    } finally {
      setRenamingSessionKey(null);
    }
  }, [editingSession, renameSession]);

  const cancelRenameSession = useCallback(() => {
    if (renamingSessionKey) {
      return;
    }
    setEditingSession(null);
  }, [renamingSessionKey]);

  const closeDeleteDialog = useCallback(() => {
    if (!pendingDeleteSession) {
      return;
    }
    if (deletingSessionKeys[pendingDeleteSession.key]) {
      return;
    }
    setPendingDeleteSession(null);
  }, [deletingSessionKeys, pendingDeleteSession]);

  const confirmDeleteSession = useCallback(async () => {
    if (!pendingDeleteSession) {
      return;
    }
    const sessionKey = pendingDeleteSession.key;
    setDeletingSessionKeys((prev) => ({ ...prev, [sessionKey]: true }));
    try {
      await deleteSession(sessionKey);
      setPendingDeleteSession(null);
    } finally {
      setDeletingSessionKeys((prev) => {
        const next = { ...prev };
        delete next[sessionKey];
        return next;
      });
    }
  }, [deleteSession, pendingDeleteSession]);

  return (
    <aside
      data-testid="agent-sessions-pane"
      className={cn(
        'relative flex shrink-0 flex-col',
        collapsed ? 'z-10 overflow-visible' : 'overflow-hidden',
        collapsed ? 'bg-transparent' : 'bg-card',
        showRightDivider && !collapsed && 'border-r [border-right-color:var(--divider-line)]',
      )}
      style={{ width: collapsed ? collapsedWidth : expandedWidth }}
    >
      {collapsed ? (
        <div className="absolute left-2 top-3">
          <div
            data-testid="agent-sessions-collapsed-note"
            className="overflow-hidden rounded-[18px] border border-border/70 bg-[linear-gradient(180deg,rgba(248,250,252,0.98),rgba(244,245,247,0.9))] shadow-[0_10px_26px_rgba(15,23,42,0.14)] dark:bg-[linear-gradient(180deg,rgba(39,39,42,0.98),rgba(24,24,27,0.94))]"
          >
            <button
              type="button"
              data-testid="agent-sessions-collapsed-expand"
              className="group flex h-11 w-10 items-center justify-center bg-[linear-gradient(180deg,rgba(255,255,255,0.72),rgba(255,255,255,0))] text-muted-foreground transition-[transform,color] hover:-translate-y-0.5 hover:text-foreground dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0))]"
              onClick={onToggleCollapse}
              aria-label={t('sidebar.expandAgentSessions')}
              title={t('sidebar.expandAgentSessions')}
            >
              <AgentAvatar
                agentId={activeAgentNode?.agentId ?? paneViewModel.activeAgentId}
                agentName={activeAgentNode?.agentName ?? paneViewModel.activeAgentId}
                avatarSeed={activeAgentNode?.avatarSeed}
                avatarStyle={activeAgentNode?.avatarStyle}
                className="h-7 w-7 border border-border/60 bg-background shadow-sm"
                dataTestId="agent-sessions-collapsed-avatar"
              />
            </button>
            <button
              type="button"
              data-testid="agent-sessions-collapsed-new-session"
              className="flex min-h-[70px] w-10 flex-col items-center justify-start gap-1.5 border-t border-border/65 bg-[linear-gradient(180deg,rgba(255,255,255,0),rgba(226,232,240,0.58))] px-1 pt-2 text-muted-foreground transition-colors hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(226,232,240,0.82))] hover:text-foreground dark:bg-[linear-gradient(180deg,rgba(255,255,255,0),rgba(63,63,70,0.64))] dark:hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(82,82,91,0.82))]"
              onClick={() => handleCreateSessionForAgent(paneViewModel.activeAgentId)}
              aria-label={t('sidebar.newSession')}
              title={t('sidebar.newSession')}
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border/60 bg-background/85 shadow-sm">
                <Plus className="h-2.5 w-2.5" />
              </span>
              <span className="text-[9px] font-semibold tracking-[0.08em] text-current [writing-mode:vertical-rl]">
                {t('sidebar.newSession')}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('sidebar.agentSessions')}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => handleCreateSessionForAgent(paneViewModel.activeAgentId)}
                aria-label={t('sidebar.newSession')}
                title={t('sidebar.newSession')}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                data-testid="agent-sessions-collapse-trigger"
                className="h-8 w-8 shrink-0"
                onClick={onToggleCollapse}
                aria-label={t('sidebar.collapseAgentSessions')}
                title={t('sidebar.collapseAgentSessions')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-3">
            <section className="flex min-h-0 basis-[42%] shrink-0 flex-col space-y-2">
              <div className="grid grid-cols-2 gap-1">
                {(['agent', 'team'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={cn(
                      'rounded-[calc(var(--radius-interactive)+2px)] px-2 py-1.5 text-xs font-medium transition-colors',
                      activeTab === tab
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === 'agent' ? t('sidebar.subagents') : t('sidebar.teams')}
                  </button>
                ))}
              </div>
              <div
                data-testid={activeTab === 'agent' ? 'agent-list-scroll-area' : 'team-list-scroll-area'}
                className="min-h-0 flex-1 overflow-y-auto pr-1"
              >
                {activeTab === 'agent' ? (
                  <AgentListSection
                    nodes={paneViewModel.agentNodes}
                    activeAgentId={paneViewModel.activeAgentId}
                    newSessionLabel={t('sidebar.newSession')}
                    state={paneViewModel.agentListState}
                    errorMessage={paneViewModel.agentErrorMessage}
                    emptyLabel={t('sidebar.noSubagents')}
                    loadingLabel={t('status.loading')}
                    fallbackErrorLabel={t('status.error')}
                    onOpenAgent={handleOpenAgent}
                    onCreateSessionForAgent={handleCreateSessionForAgent}
                  />
                ) : (
                  <TeamListSection
                    nodes={teamNodes}
                    expandedTeamIds={expandedTeamIds}
                    expandedTeamRunIds={expandedTeamRunIds}
                    emptyLabel={t('sidebar.noTeams')}
                    leaderLabel={t('sidebar.teamLeader')}
                    newRunLabel={t('teams:run.create')}
                    onToggleTeam={toggleTeam}
                    onToggleRun={toggleRun}
                    onSelectRun={selectTeamRun}
                    onCreateRun={handleCreateRunForTeam}
                    onSelectRole={selectTeamRole}
                  />
                )}
              </div>
            </section>

            <section className="flex min-h-0 flex-1 flex-col space-y-1 border-t border-border/70 pt-4">
              <p className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {t('sidebar.agentSessions')}
              </p>
              <div
                data-testid="session-list-scroll-area"
                className="min-h-0 flex-1 overflow-y-auto pr-1"
              >
                <SessionListSection
                  buckets={paneViewModel.sessionBuckets}
                  sessionViewModelByKey={paneViewModel.sessionViewModelByKey}
                  currentSessionKey={currentSessionKey}
                  deletingSessionKeys={deletingSessionKeys}
                  renamingSessionKey={renamingSessionKey}
                  editingSession={editingSession}
                  collapsedSessionBuckets={collapsedSessionBuckets}
                  state={paneViewModel.sessionListState}
                  errorMessage={paneViewModel.sessionErrorMessage}
                  emptyLabel={t('sidebar.noAgentSessions')}
                  loadingLabel={t('status.loading')}
                  fallbackErrorLabel={t('status.error')}
                  fallbackDeleteLabel={(sessionKey) => t('sidebar.deleteSessionAria', { title: sessionKey })}
                  fallbackRenameLabel={(sessionKey) => t('sidebar.renameSessionAria', { title: sessionKey })}
                  fallbackUntitledLabel={(session) => inferUntitledSessionLabel(session, t)}
                  onToggleBucket={toggleSessionBucket}
                  onSwitchSession={handleSwitchSession}
                  onStartRename={startRenameSession}
                  onRenameTitleChange={(title) => {
                    setEditingSession((current) => current ? { ...current, title } : current);
                  }}
                  onSubmitRename={() => void submitRenameSession()}
                  onCancelRename={cancelRenameSession}
                  onRequestDelete={requestDeleteSession}
                />
              </div>
            </section>
          </div>
        </>
      )}

      {pendingDeleteSession && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeDeleteDialog();
            }
          }}
        >
          <section
            role="dialog"
            aria-label={t('sidebar.deleteSessionDialogTitle', { title: pendingDeleteSession.title })}
            className="w-full max-w-md rounded-[1.25rem] border border-border bg-card p-5 shadow-elevated"
          >
            <header className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {t('sidebar.deleteSessionDialogTitle', { title: pendingDeleteSession.title })}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('actions.close')}
                onClick={closeDeleteDialog}
                disabled={Boolean(deletingSessionKeys[pendingDeleteSession.key])}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('sidebar.deleteSessionDialogDescription', { title: pendingDeleteSession.title })}
            </p>
            <div className="mt-4 flex justify-end">
              <Button
                variant="destructive"
                type="button"
                onClick={() => void confirmDeleteSession()}
                disabled={Boolean(deletingSessionKeys[pendingDeleteSession.key])}
              >
                {deletingSessionKeys[pendingDeleteSession.key]
                  ? t('sidebar.deleteSessionDialogDeleting')
                  : t('sidebar.deleteSessionDialogConfirm')}
              </Button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
});
