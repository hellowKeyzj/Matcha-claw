import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { useSubagentsStore } from '@/stores/subagents';
import {
  resolveTeamRoleChatTargetFromProbe,
  selectTeamRoleChatTargetIndex,
  useTeamsStore,
} from '@/stores/teams';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { selectAgentSessionsPaneState } from '@/stores/chat/selectors';
import { isOrdinarySessionCandidate, type ChatSessionRuntimeEndpointNode } from '@/stores/chat/types';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useShallow } from 'zustand/react/shallow';
import {
  inferUntitledSessionLabel,
  readSessionSuffix,
  resolveAgentScopeForRuntimeEndpoint,
  type SessionBucketId,
  useAgentSessionsPaneViewModel,
} from './useAgentSessionsPaneViewModel';
import {
  isAgentSessionSwitchboardAutomationSession,
  type AgentSessionSwitchboardAgentResult,
  type AgentSessionSwitchboardRuntimeResult,
  type AgentSessionSwitchboardSessionBucket,
  type AgentSessionSwitchboardSessionResult,
  type AgentSessionSwitchboardTeamInput,
  type AgentSessionSwitchboardTeamResult,
  type AgentSessionSwitchboardTeamRoleResult,
  type AgentSessionSwitchboardTeamRunResult,
} from './agent-session-switchboard-model';

const SESSION_BUCKET_COLLAPSE_STORAGE_KEY = 'layout:session-time-bucket-collapsed';

type SessionPaneTab = 'agent' | 'team' | 'session';
type SessionBucketScope = 'session' | 'automation';

const SESSION_BUCKET_SCOPES: readonly SessionBucketScope[] = ['session', 'automation'];

function countSessionsInBuckets(buckets: readonly AgentSessionSwitchboardSessionBucket[]): number {
  return buckets.reduce((count, bucket) => count + bucket.sessions.length, 0);
}

function hasSessionInBuckets(buckets: readonly AgentSessionSwitchboardSessionBucket[], sessionKey: string): boolean {
  return sessionKey !== '' && buckets.some((bucket) => bucket.sessions.some((entry) => entry.session.key === sessionKey));
}

function resolveSelectedRuntimeEndpoint(input: {
  endpoints: readonly ChatSessionRuntimeEndpointNode[];
  runtimeScopeKey: string | null;
}): ChatSessionRuntimeEndpointNode | null {
  if (input.runtimeScopeKey) {
    const endpoint = input.endpoints.find((candidate) => candidate.runtimeScopeKey === input.runtimeScopeKey);
    if (endpoint) {
      return endpoint;
    }
  }
  return input.endpoints[0] ?? null;
}

function createSessionBucketStateKey(bucketId: SessionBucketId, scope: SessionBucketScope = 'session'): string {
  return scope === 'session' ? bucketId : `${scope}:${bucketId}`;
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
  readOnly: boolean;
  onSwitchSession: (sessionKey: string) => void;
  onStartRename: (session: ChatSession, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (session: ChatSession) => void;
  onPick?: () => void;
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
  readOnly,
  onSwitchSession,
  onStartRename,
  onRenameTitleChange,
  onSubmitRename,
  onCancelRename,
  onRequestDelete,
  onPick,
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
        onClick={() => {
          onSwitchSession(session.key);
          onPick?.();
        }}
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
      {!readOnly && session.kind !== 'main' && !session.preferred && (
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

interface TeamListSectionProps {
  nodes: AgentSessionSwitchboardTeamResult[];
  expandedTeamIds: Record<string, boolean>;
  expandedTeamRunIds: Record<string, boolean>;
  emptyLabel: string;
  leaderLabel: string;
  newRunLabel: string;
  onToggleTeam: (teamId: string) => void;
  onToggleRun: (runId: string) => void;
  onSelectRun: (teamId: string, run: AgentSessionSwitchboardTeamRunResult) => void;
  onCreateRun: (teamId: string) => void;
  onSelectRole: (teamId: string, runId: string, role: AgentSessionSwitchboardTeamRoleResult) => void;
  onPick?: () => void;
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
  onPick,
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
                          onClick={() => {
                            onSelectRun(node.teamId, run);
                            onPick?.();
                          }}
                        >
                          <span className="block truncate">{run.runId}</span>
                        </button>
                      </div>
                      {runExpanded ? (
                        <div className="ml-3 border-l border-border/50 pl-2 space-y-0.5">
                          {run.leader ? (
                            <button
                              key={`${node.teamId}:${run.runId}:leader`}
                              type="button"
                              className="flex w-full items-center gap-1.5 rounded-[calc(var(--radius-interactive)+2px)] px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                              onClick={() => {
                                onSelectRole(node.teamId, run.runId, run.leader!);
                                onPick?.();
                              }}
                            >
                              <AgentAvatar agentId={run.leader.agentId} agentName={leaderLabel} className="h-4 w-4" />
                              <span className="min-w-0 flex-1 truncate">{leaderLabel}</span>
                            </button>
                          ) : null}
                          {run.roles.map((role) => (
                            <button
                              key={`${node.teamId}:${run.runId}:${role.roleId}`}
                              type="button"
                              className="flex w-full items-center gap-1.5 rounded-[calc(var(--radius-interactive)+2px)] px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                              onClick={() => {
                                onSelectRole(node.teamId, run.runId, role);
                                onPick?.();
                              }}
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

const AgentSwitchboardSection = memo(function AgentSwitchboardSection({
  runtimes,
  endpointByRuntimeScopeKey,
  newSessionLabel,
  state,
  errorMessage,
  emptyLabel,
  loadingLabel,
  fallbackErrorLabel,
  onOpenAgent,
  onCreateSessionForAgent,
  onPick,
}: {
  runtimes: AgentSessionSwitchboardRuntimeResult[];
  endpointByRuntimeScopeKey: ReadonlyMap<string, ChatSessionRuntimeEndpointNode>;
  newSessionLabel: string;
  state: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  emptyLabel: string;
  loadingLabel: string;
  fallbackErrorLabel: string;
  onOpenAgent: (agent: AgentSessionSwitchboardAgentResult) => void;
  onCreateSessionForAgent: (agent: AgentSessionSwitchboardAgentResult) => void;
  onPick: () => void;
}) {
  const visibleRuntimes = runtimes.map((runtime) => {
    const endpoint = endpointByRuntimeScopeKey.get(runtime.runtimeScopeKey);
    const runtimeState = endpoint?.target?.agentCatalog.source === 'subagent-management' ? state : 'ready';
    return {
      ...runtime,
      runtimeState,
      agents: runtimeState === 'ready' ? runtime.agents : [],
    };
  });
  const hasRuntimeContent = visibleRuntimes.some((runtime) => runtime.runtimeState !== 'ready' || runtime.agents.length > 0);
  if (!hasRuntimeContent) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-3">
      {visibleRuntimes.map((runtime) => (
        <section key={runtime.runtimeScopeKey} className="space-y-2">
          <h3 className="px-2 text-[11px] font-semibold text-muted-foreground">{runtime.runtimeLabel}</h3>
          {runtime.runtimeState === 'loading' ? (
            <p data-testid="agent-list-loading" className="px-2 py-1 text-xs text-muted-foreground">
              {loadingLabel}
            </p>
          ) : runtime.runtimeState === 'error' ? (
            <p data-testid="agent-list-error" className="px-2 py-1 text-xs text-destructive">
              {errorMessage || fallbackErrorLabel}
            </p>
          ) : null}
          <div className="space-y-1">
            {runtime.agents.map((agent) => {
              const active = agent.isCurrent;
              const canCreate = Boolean(endpointByRuntimeScopeKey.get(agent.runtimeScopeKey)?.target);
              return (
                <div
                  key={`${agent.runtimeScopeKey}:${agent.agentId}`}
                  className={cn(
                    'group flex items-center gap-1 rounded-[calc(var(--radius-interactive)+2px)] pr-1 transition-[background-color,color,box-shadow]',
                    active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    data-testid={`agent-item-${agent.agentId}`}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm font-medium"
                    onClick={() => {
                      onOpenAgent(agent);
                      onPick();
                    }}
                  >
                    <AgentAvatar
                      agentId={agent.agentId}
                      agentName={agent.agentName}
                      avatarSeed={agent.avatarSeed}
                      avatarStyle={agent.avatarStyle}
                      className="h-5 w-5"
                      dataTestId={`agent-session-avatar-${agent.agentId}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{agent.agentName}</span>
                    {agent.sessionCount > 0 ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                        {agent.sessionCount}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    data-testid={`agent-new-session-${agent.agentId}`}
                    className="shrink-0 rounded-full p-1 text-current/80 opacity-0 transition group-hover:opacity-100 hover:bg-card/15 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`${newSessionLabel} ${agent.agentName}`}
                    title={`${newSessionLabel} ${agent.agentName}`}
                    disabled={!canCreate}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onCreateSessionForAgent(agent);
                      onPick();
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
});

interface SessionListSectionProps {
  buckets: AgentSessionSwitchboardSessionBucket[];
  automationBuckets: AgentSessionSwitchboardSessionBucket[];
  currentSessionKey: string;
  deletingSessionKeys: Record<string, true>;
  renamingSessionKey: string | null;
  editingSession: { key: string; title: string } | null;
  collapsedSessionBuckets: Record<string, boolean>;
  state: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  emptyLabel: string;
  sessionLabel: string;
  automationLabel: string;
  loadingLabel: string;
  fallbackErrorLabel: string;
  fallbackDeleteLabel: (sessionKey: string) => string;
  fallbackRenameLabel: (sessionKey: string) => string;
  fallbackUntitledLabel: (session: ChatSession) => string;
  onToggleBucket: (bucketId: SessionBucketId, defaultCollapsed: boolean, scope: SessionBucketScope) => void;
  onSwitchSession: (sessionKey: string) => void;
  onStartRename: (session: ChatSession, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (session: ChatSession) => void;
  onPick?: () => void;
}

const SessionListSection = memo(function SessionListSection({
  buckets,
  automationBuckets,
  currentSessionKey,
  deletingSessionKeys,
  renamingSessionKey,
  editingSession,
  collapsedSessionBuckets,
  state,
  errorMessage,
  emptyLabel,
  sessionLabel,
  automationLabel,
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
  onPick,
}: SessionListSectionProps) {
  const [activeBucketScope, setActiveBucketScope] = useState<SessionBucketScope>(() => (
    hasSessionInBuckets(automationBuckets, currentSessionKey) ? 'automation' : 'session'
  ));
  const sessionCount = countSessionsInBuckets(buckets);
  const automationCount = countSessionsInBuckets(automationBuckets);
  const hasBothScopes = sessionCount > 0 && automationCount > 0;
  const visibleBucketScope = hasBothScopes
    ? activeBucketScope
    : automationCount > 0
      ? 'automation'
      : 'session';
  const visibleBuckets = visibleBucketScope === 'automation' ? automationBuckets : buckets;

  useEffect(() => {
    if (hasSessionInBuckets(automationBuckets, currentSessionKey)) {
      setActiveBucketScope('automation');
      return;
    }
    if (hasSessionInBuckets(buckets, currentSessionKey)) {
      setActiveBucketScope('session');
    }
  }, [automationBuckets, buckets, currentSessionKey]);

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
  if (sessionCount === 0 && automationCount === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  const renderBuckets = (bucketList: AgentSessionSwitchboardSessionBucket[], scope: SessionBucketScope) => bucketList.map((bucket) => {
    const bucketStateKey = createSessionBucketStateKey(bucket.id, scope);
    const bucketCollapsed = Object.prototype.hasOwnProperty.call(collapsedSessionBuckets, bucketStateKey)
      ? Boolean(collapsedSessionBuckets[bucketStateKey])
      : bucket.defaultCollapsed;
    return (
      <div key={bucket.id} className="space-y-1">
        <button
          type="button"
          onClick={() => onToggleBucket(bucket.id, bucket.defaultCollapsed, scope)}
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
              const result = entry as AgentSessionSwitchboardSessionResult;
              const session = result.session;
              const viewModel = result;
              const deleting = Boolean(deletingSessionKeys[session.key]);
              const editing = editingSession?.key === session.key;
              return (
                <SessionListItem
                  key={session.key}
                  session={session}
                  sessionTitle={viewModel?.title ?? fallbackUntitledLabel(session)}
                  sessionMeta={viewModel?.meta ?? readSessionSuffix(session)}
                  agentId={result.source.agentId}
                  agentName={result.source.kind === 'team' ? result.source.label : result.source.agentName}
                  avatarSeed={result.source.kind === 'agent' ? result.source.avatarSeed : undefined}
                  avatarStyle={result.source.kind === 'agent' ? result.source.avatarStyle : undefined}
                  isCurrent={currentSessionKey === session.key}
                  deleting={deleting}
                  renaming={renamingSessionKey === session.key}
                  editing={editing}
                  editingTitle={editing ? editingSession.title : ''}
                  deleteLabel={viewModel?.deleteLabel ?? fallbackDeleteLabel(session.key)}
                  renameLabel={viewModel?.renameLabel ?? fallbackRenameLabel(session.key)}
                  saveRenameLabel={viewModel?.saveRenameLabel ?? fallbackRenameLabel(session.key)}
                  cancelRenameLabel={viewModel?.cancelRenameLabel ?? fallbackRenameLabel(session.key)}
                  readOnly={result.readOnly}
                  onSwitchSession={onSwitchSession}
                  onStartRename={onStartRename}
                  onRenameTitleChange={onRenameTitleChange}
                  onSubmitRename={onSubmitRename}
                  onCancelRename={onCancelRename}
                  onRequestDelete={onRequestDelete}
                  onPick={onPick}
                />
              );
            })}
          </div>
        )}
      </div>
    );
  });
  return (
    <div className="space-y-2.5">
      {hasBothScopes ? (
        <div className="grid grid-cols-2 gap-1 rounded-[calc(var(--radius-interactive)+4px)] bg-secondary p-1" role="tablist">
          {SESSION_BUCKET_SCOPES.map((scope) => {
            const selected = visibleBucketScope === scope;
            const count = scope === 'automation' ? automationCount : sessionCount;
            const label = scope === 'automation' ? automationLabel : sessionLabel;
            return (
              <button
                key={scope}
                type="button"
                role="tab"
                aria-label={`${label} ${count}`}
                aria-selected={selected}
                className={cn(
                  'flex min-w-0 items-center justify-center gap-1.5 rounded-[var(--radius-interactive)] px-2 py-1.5 text-xs font-medium transition-colors',
                  selected
                    ? 'bg-card text-foreground shadow-whisper'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setActiveBucketScope(scope)}
              >
                <span className="truncate">{label}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {visibleBuckets.length > 0 ? (
        <div className="space-y-1">{renderBuckets(visibleBuckets, visibleBucketScope)}</div>
      ) : (
        <p className="px-2 py-1 text-xs text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
});

interface IdentityBeaconProps {
  activeAgentId: string;
  activeAgentName: string;
  activeAvatarSeed?: string;
  activeAvatarStyle?: AgentAvatarStyle;
  identityLabel: string;
  runtimeLabel: string;
  newSessionLabel: string;
  disabledNewSession: boolean;
  switchboardOpen: boolean;
  onNewSession: () => void;
  onOpenSwitchboard: () => void;
}

const IdentityBeacon = memo(function IdentityBeacon({
  activeAgentId,
  activeAgentName,
  activeAvatarSeed,
  activeAvatarStyle,
  identityLabel,
  runtimeLabel,
  newSessionLabel,
  disabledNewSession,
  switchboardOpen,
  onNewSession,
  onOpenSwitchboard,
}: IdentityBeaconProps) {
  return (
    <div
      className={cn(
        'group flex w-12 flex-col items-center gap-0.5 rounded-[21px] border border-border/25 bg-card/40 px-1 py-1 transition-[background-color,border-color] duration-150 hover:border-border/35 hover:bg-card/60',
        switchboardOpen && 'border-border/45 bg-card/70',
      )}
    >
      <button
        type="button"
        data-testid="agent-session-identity-beacon"
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground',
          switchboardOpen && 'text-foreground',
        )}
        onClick={onOpenSwitchboard}
        aria-label={identityLabel}
        title={`${identityLabel} · ${runtimeLabel}`}
      >
        <AgentAvatar
          agentId={activeAgentId}
          agentName={activeAgentName}
          avatarSeed={activeAvatarSeed}
          avatarStyle={activeAvatarStyle}
          className="h-9 w-9 border border-border/60 bg-background shadow-sm"
          dataTestId="agent-session-identity-avatar"
        />
      </button>
      <button
        type="button"
        data-testid="agent-session-new-current"
        className="flex h-6 w-6 items-center justify-center text-muted-foreground/80 transition-[color,opacity] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        onClick={onNewSession}
        disabled={disabledNewSession}
        aria-label={newSessionLabel}
        title={newSessionLabel}
      >
        <Plus className="h-[18px] w-[18px] stroke-[2.25]" />
      </button>
    </div>
  );
});

interface HoverPeekProps {
  open: boolean;
  currentIdentityLabel: string;
  agents: AgentSessionSwitchboardAgentResult[];
  sessions: AgentSessionSwitchboardSessionBucket[];
  onOpenAgent: (agent: AgentSessionSwitchboardAgentResult) => void;
  onSwitchSession: (sessionKey: string) => void;
}

function compactHoverPeekMeta(result: AgentSessionSwitchboardSessionResult): string {
  if (result.source.kind === 'team') {
    return result.source.label;
  }
  const prefix = `${result.source.agentName} / `;
  return result.meta.startsWith(prefix) ? result.meta.slice(prefix.length) : result.meta;
}

const HoverPeek = memo(function HoverPeek({
  open,
  currentIdentityLabel,
  agents,
  sessions,
  onOpenAgent,
  onSwitchSession,
}: HoverPeekProps) {
  if (!open) {
    return null;
  }
  const quickAgents = agents.filter((agent) => !agent.isCurrent).slice(0, 3);
  const quickSessions = sessions.flatMap((bucket) => bucket.sessions).slice(0, Math.max(0, 5 - quickAgents.length));
  const hasQuickItems = quickAgents.length > 0 || quickSessions.length > 0;
  return (
    <div
      data-testid="agent-sessions-hover-peek"
      className="absolute left-[52px] top-0 z-20 w-64 rounded-[22px] border border-border/75 bg-card/96 p-2 opacity-100 shadow-[0_18px_48px_rgba(0,0,0,0.26),0_5px_14px_rgba(0,0,0,0.18)] backdrop-blur-md transition-[opacity,transform] duration-150"
    >
      <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{currentIdentityLabel}</p>
      {hasQuickItems ? (
        <div className="mt-1 space-y-1">
          {quickAgents.map((agent) => (
          <button
            key={`agent:${agent.runtimeScopeKey}:${agent.agentId}`}
            type="button"
            className="flex w-full items-center gap-2 rounded-[calc(var(--radius-interactive)+2px)] px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={() => onOpenAgent(agent)}
          >
            <AgentAvatar
              agentId={agent.agentId}
              agentName={agent.agentName}
              avatarSeed={agent.avatarSeed}
              avatarStyle={agent.avatarStyle}
              className="h-5 w-5"
            />
            <span className="min-w-0 flex-1 truncate">{agent.agentName}</span>
          </button>
        ))}
        {quickSessions.map((result) => (
          <button
            key={`session:${result.session.key}`}
            type="button"
            className="flex w-full items-center gap-2 rounded-[calc(var(--radius-interactive)+2px)] px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={() => onSwitchSession(result.session.key)}
          >
            <AgentAvatar
              agentId={result.source.agentId}
              agentName={result.source.label}
              avatarSeed={result.source.kind === 'agent' ? result.source.avatarSeed : undefined}
              avatarStyle={result.source.kind === 'agent' ? result.source.avatarStyle : undefined}
              className="h-5 w-5"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{result.title}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">{compactHoverPeekMeta(result)}</span>
            </span>
          </button>
        ))}
        </div>
      ) : null}
    </div>
  );
});

export const AgentSessionsPane = memo(function AgentSessionsPane() {
  const { t, i18n } = useTranslation();
  const subagentManagementAgentsResource = useSubagentsStore((state) => state.agentsResource);
  const subagentManagementAgents = Array.isArray(subagentManagementAgentsResource.data) ? subagentManagementAgentsResource.data : [];
  const {
    sessionEntries,
    sessionsLoading,
    sessionsLoadedOnce,
    sessionsError,
    currentConversation,
    sessionRuntimeGraph,
    currentSessionKey,
    switchSession,
    openAgentConversation,
    openSessionIdentity,
    newSessionForScope,
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
  const [switchboardOpen, setSwitchboardOpen] = useState(false);
  const [hoverPeekOpen, setHoverPeekOpen] = useState(false);
  const hoverCloseTimerRef = useRef<number | null>(null);

  const runtimeEndpoints = useMemo(
    () => sessionRuntimeGraph.endpoints.filter((endpoint) => endpoint.target != null),
    [sessionRuntimeGraph],
  );
  const selectedRuntimeEndpoint = useMemo(
    () => resolveSelectedRuntimeEndpoint({
      endpoints: runtimeEndpoints,
      runtimeScopeKey: currentConversation?.runtimeScopeKey ?? null,
    }),
    [currentConversation?.runtimeScopeKey, runtimeEndpoints],
  );

  const filteredSessionEntries = useMemo(() => {
    const agentPaneSessionEntries: typeof sessionEntries = [];
    const switchboardSessionEntries: typeof sessionEntries = [];
    for (const entry of sessionEntries) {
      if (entry.session.ownership?.kind !== 'ordinary') {
        continue;
      }
      if (isOrdinarySessionCandidate(entry.session)) {
        agentPaneSessionEntries.push(entry);
      }
      switchboardSessionEntries.push(entry);
    }
    return { agentPaneSessionEntries, switchboardSessionEntries };
  }, [sessionEntries]);
  const switchboardTeams = useMemo<AgentSessionSwitchboardTeamInput[]>(() => teams.map((team) => ({
    teamId: team.id,
    teamName: team.name,
    activeRunId: team.activeRunId,
    runs: (runListByTeamId[team.id] ?? []).map((run) => {
      const sessions = run.sessions ?? [];
      const toRoleInput = (role: (typeof sessions)[number]) => ({
        roleId: role.roleId,
        agentId: role.agentId,
        sessionIdentity: role.sessionIdentity,
        localSessionId: role.localSessionId,
        endpointSessionId: resolveTeamRoleChatTargetFromProbe(teamRoleChatTargetIndex, {
          sessionIdentity: role.sessionIdentity,
          sessionKey: role.localSessionId,
          endpointSessionId: role.endpointSessionId,
        })?.endpointSessionId ?? role.endpointSessionId,
      });
      const leader = sessions.find((role) => role.roleId === 'leader');
      return {
        runId: run.runId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        leader: leader ? toRoleInput(leader) : null,
        roles: sessions
          .filter((role) => role.roleId !== 'leader')
          .map(toRoleInput),
      };
    }),
  })), [runListByTeamId, teamRoleChatTargetIndex, teams]);
  const endpointByRuntimeScopeKey = useMemo(
    () => new Map(runtimeEndpoints.map((endpoint) => [endpoint.runtimeScopeKey, endpoint] as const)),
    [runtimeEndpoints],
  );
  const paneViewModel = useAgentSessionsPaneViewModel({
    subagentManagementAgents,
    subagentManagementAgentsResource,
    sessionEntries: filteredSessionEntries.agentPaneSessionEntries,
    switchboardSessionEntries: filteredSessionEntries.switchboardSessionEntries,
    sessionsLoading,
    sessionsLoadedOnce,
    sessionsError,
    currentConversation,
    selectedRuntimeEndpoint,
    runtimeEndpoints,
    teams: switchboardTeams,
    locale: i18n.language,
    t,
  });
  const switchboard = paneViewModel.switchboard;
  const activeAgentNode = paneViewModel.agentNodes.find((node) => node.agentId === paneViewModel.activeAgentId);
  const defaultAgentId = subagentManagementAgents.length > 0 ? selectedRuntimeEndpoint?.defaultAgentId : null;
  const activeAgentId = switchboard.currentIdentity.agentId ?? activeAgentNode?.agentId ?? (paneViewModel.activeAgentId || defaultAgentId || '');
  const activeAgentName = switchboard.currentIdentityLabel || activeAgentNode?.agentName || (activeAgentId || t('sidebar.agentSessions'));
  const activeRuntimeLabel = selectedRuntimeEndpoint?.displayName ?? t('switchboard.runtime');
  const switchboardHeaderTitle = switchboard.currentIdentity.kind === 'team'
    ? activeAgentName
    : (activeAgentNode?.agentName || switchboard.currentIdentity.agentId || activeAgentName);
  const switchboardHeaderMeta = switchboard.currentIdentity.kind === 'team'
    ? t('switchboard.teamSession')
    : activeRuntimeLabel;
  const teamSyncKey = teams.map((team) => team.id).join('\n');

  useEffect(() => {
    if (activeTab !== 'team' || !switchboardOpen) {
      return;
    }
    const teamIds = teamSyncKey ? teamSyncKey.split('\n') : [];
    for (const teamId of teamIds) {
      void syncRunList(teamId);
    }
  }, [activeTab, switchboardOpen, syncRunList, teamSyncKey]);

  useEffect(() => {
    return () => {
      if (hoverCloseTimerRef.current != null) {
        window.clearTimeout(hoverCloseTimerRef.current);
      }
    };
  }, []);

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

  const closeSwitchboard = useCallback(() => {
    setSwitchboardOpen(false);
    setHoverPeekOpen(false);
  }, []);

  const openHoverPeek = useCallback(() => {
    if (hoverCloseTimerRef.current != null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (!switchboardOpen) {
      setHoverPeekOpen(true);
    }
  }, [switchboardOpen]);

  const scheduleCloseHoverPeek = useCallback(() => {
    if (hoverCloseTimerRef.current != null) {
      window.clearTimeout(hoverCloseTimerRef.current);
    }
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setHoverPeekOpen(false);
      hoverCloseTimerRef.current = null;
    }, 120);
  }, []);

  const handleSwitchSession = useCallback((sessionKey: string) => {
    switchSession(sessionKey);
  }, [switchSession]);

  const handleOpenRuntimeAgent = useCallback((agent: AgentSessionSwitchboardAgentResult) => {
    const endpoint = endpointByRuntimeScopeKey.get(agent.runtimeScopeKey);
    if (endpoint) {
      openAgentConversation(agent.agentId, endpoint.endpoint);
    }
  }, [endpointByRuntimeScopeKey, openAgentConversation]);

  const handleCreateSessionForDefaultScope = useCallback(() => {
    const target = selectedRuntimeEndpoint?.target;
    if (!target) {
      return;
    }
    void newSessionForScope(target.defaultSessionPromptScope);
  }, [newSessionForScope, selectedRuntimeEndpoint]);

  const handleCreateSessionForAgent = useCallback((agentId: string) => {
    const target = selectedRuntimeEndpoint?.target;
    if (!target) {
      return;
    }
    const scope = resolveAgentScopeForRuntimeEndpoint(target, agentId);
    if (!scope) {
      return;
    }
    void newSessionForScope(scope);
  }, [newSessionForScope, selectedRuntimeEndpoint]);

  const handleCreateSessionForRuntimeAgent = useCallback((agent: AgentSessionSwitchboardAgentResult) => {
    const target = endpointByRuntimeScopeKey.get(agent.runtimeScopeKey)?.target;
    if (!target) {
      return;
    }
    const scope = resolveAgentScopeForRuntimeEndpoint(target, agent.agentId);
    if (!scope) {
      return;
    }
    void newSessionForScope(scope);
  }, [endpointByRuntimeScopeKey, newSessionForScope]);

  const selectTeamRole = useCallback((teamId: string, runId: string, role: AgentSessionSwitchboardTeamRoleResult) => {
    setActiveRun(teamId, runId);
    openSessionIdentity({ sessionIdentity: role.sessionIdentity });
    void refreshSnapshot(teamId, { force: true });
  }, [openSessionIdentity, refreshSnapshot, setActiveRun]);

  const toggleTeam = useCallback((teamId: string) => {
    setExpandedTeamIds((current) => ({ ...current, [teamId]: current[teamId] !== true }));
  }, []);

  const toggleRun = useCallback((runId: string) => {
    setExpandedTeamRunIds((current) => ({ ...current, [runId]: current[runId] !== true }));
  }, []);

  const selectTeamRun = useCallback((teamId: string, run: AgentSessionSwitchboardTeamRunResult) => {
    setActiveRun(teamId, run.runId);
    if (run.leader) {
      openSessionIdentity({ sessionIdentity: run.leader.sessionIdentity });
    }
    void refreshSnapshot(teamId, { force: true });
  }, [openSessionIdentity, refreshSnapshot, setActiveRun]);

  const handleCreateRunForTeam = useCallback((teamId: string) => {
    void createRun(teamId);
  }, [createRun]);

  const toggleSessionBucket = useCallback((bucketId: SessionBucketId, defaultCollapsed: boolean, scope: SessionBucketScope) => {
    const stateKey = createSessionBucketStateKey(bucketId, scope);
    setCollapsedSessionBuckets((prev) => {
      const current = Object.prototype.hasOwnProperty.call(prev, stateKey)
        ? Boolean(prev[stateKey])
        : defaultCollapsed;
      return { ...prev, [stateKey]: !current };
    });
  }, []);

  const requestDeleteSession = useCallback((session: ChatSession) => {
    if (isAgentSessionSwitchboardAutomationSession(session) || session.kind === 'main' || session.preferred) {
      return;
    }
    const title = switchboard.sessionResults
      .flatMap((bucket) => bucket.sessions)
      .find((candidate) => candidate.session.key === session.key)?.title
      ?? paneViewModel.sessionViewModelByKey.get(session.key)?.title
      ?? inferUntitledSessionLabel(session, t);
    setPendingDeleteSession({
      key: session.key,
      title,
    });
  }, [paneViewModel.sessionViewModelByKey, switchboard.sessionResults, t]);

  const startRenameSession = useCallback((session: ChatSession, title: string) => {
    if (isAgentSessionSwitchboardAutomationSession(session) || session.kind === 'main' || session.preferred) {
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
      className="relative z-10 flex w-0 shrink-0 flex-col overflow-visible bg-transparent"
    >
      <div
        className="absolute left-2 top-5"
        onMouseEnter={openHoverPeek}
        onMouseLeave={scheduleCloseHoverPeek}
      >
        <IdentityBeacon
          activeAgentId={activeAgentId}
          activeAgentName={activeAgentName}
          activeAvatarSeed={switchboard.currentIdentity.kind === 'empty' ? undefined : activeAgentNode?.avatarSeed}
          activeAvatarStyle={switchboard.currentIdentity.kind === 'empty' ? undefined : activeAgentNode?.avatarStyle}
          identityLabel={activeAgentName}
          runtimeLabel={activeRuntimeLabel}
          newSessionLabel={t('sidebar.newSession')}
          disabledNewSession={!selectedRuntimeEndpoint?.target}
          switchboardOpen={switchboardOpen}
          onNewSession={() => {
            if (paneViewModel.activeAgentId) {
              handleCreateSessionForAgent(paneViewModel.activeAgentId);
              return;
            }
            handleCreateSessionForDefaultScope();
          }}
          onOpenSwitchboard={() => {
            setHoverPeekOpen(false);
            setSwitchboardOpen((open) => !open);
          }}
        />
        <HoverPeek
          open={hoverPeekOpen && !switchboardOpen}
          currentIdentityLabel={activeAgentName}
          agents={switchboard.agentResults.flatMap((runtime) => runtime.agents)}
          sessions={switchboard.sessionResults}
          onOpenAgent={(agent) => {
            handleOpenRuntimeAgent(agent);
            setHoverPeekOpen(false);
          }}
          onSwitchSession={(sessionKey) => {
            handleSwitchSession(sessionKey);
            setHoverPeekOpen(false);
          }}
        />
      </div>

      {switchboardOpen ? (
        <div
          className="fixed inset-0 z-20 bg-transparent"
          onMouseDown={closeSwitchboard}
        />
      ) : null}

      {switchboardOpen ? (
        <section
          data-testid="chat-switchboard"
          role="dialog"
          aria-label={t('switchboard.quickSwitch')}
          className="absolute left-[52px] top-5 z-30 flex max-h-[min(600px,calc(100vh-32px))] w-[280px] max-w-[calc(100vw-68px)] flex-col overflow-hidden rounded-[22px] border border-border/75 bg-card/96 shadow-[0_18px_48px_rgba(0,0,0,0.26),0_5px_14px_rgba(0,0,0,0.18)] backdrop-blur-md transition-[opacity,transform] duration-150"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border/70 px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{switchboardHeaderTitle}</p>
              <p className="truncate text-xs text-muted-foreground">{switchboardHeaderMeta}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-full"
              aria-label={t('actions.close')}
              onClick={closeSwitchboard}
            >
              <X className="h-4 w-4" />
            </Button>
          </header>
          <div className="grid grid-cols-3 gap-1 border-b border-border/70 p-2">
            {(['agent', 'team', 'session'] as const).map((tab) => (
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
                {tab === 'agent'
                  ? t('switchboard.tabs.agents')
                  : tab === 'team'
                    ? t('switchboard.tabs.teams')
                    : t('switchboard.tabs.sessions')}
              </button>
            ))}
          </div>
          <div
            data-testid={activeTab === 'agent'
              ? 'agent-list-scroll-area'
              : activeTab === 'team'
                ? 'team-list-scroll-area'
                : 'session-list-scroll-area'}
            className="min-h-0 flex-1 overflow-y-auto p-2.5 pr-2"
          >
            {activeTab === 'agent' ? (
              <AgentSwitchboardSection
                runtimes={switchboard.agentResults}
                endpointByRuntimeScopeKey={endpointByRuntimeScopeKey}
                newSessionLabel={t('sidebar.newSession')}
                state={paneViewModel.agentListState}
                errorMessage={paneViewModel.agentErrorMessage}
                emptyLabel={t('sidebar.noSubagents')}
                loadingLabel={t('status.loading')}
                fallbackErrorLabel={t('status.error')}
                onOpenAgent={handleOpenRuntimeAgent}
                onCreateSessionForAgent={handleCreateSessionForRuntimeAgent}
                onPick={closeSwitchboard}
              />
            ) : activeTab === 'team' ? (
              <TeamListSection
                nodes={switchboard.teamResults}
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
                onPick={closeSwitchboard}
              />
            ) : (
              <SessionListSection
                buckets={switchboard.sessionResults}
                automationBuckets={switchboard.automationSessionResults}
                currentSessionKey={currentSessionKey}
                deletingSessionKeys={deletingSessionKeys}
                renamingSessionKey={renamingSessionKey}
                editingSession={editingSession}
                collapsedSessionBuckets={collapsedSessionBuckets}
                state={paneViewModel.sessionListState}
                errorMessage={paneViewModel.sessionErrorMessage}
                emptyLabel={t('sidebar.noAgentSessions')}
                sessionLabel={t('switchboard.normalSessions', { defaultValue: 'Normal' })}
                automationLabel={t('switchboard.automationSessions', { defaultValue: 'Automation' })}
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
                onPick={closeSwitchboard}
              />
            )}
          </div>
        </section>
      ) : null}

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
