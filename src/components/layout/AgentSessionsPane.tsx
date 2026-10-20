import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { createSessionTraceId, isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity } from '@/lib/session-trace';
import { useTeamRunLabels } from '@/hooks/use-team-run-labels';
import { useSubagentsStore } from '@/stores/subagents';
import {
  resolveTeamRoleChatTargetFromProbe,
  selectTeamRoleChatTargetIndex,
  useTeamsStore,
} from '@/stores/teams';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { selectAgentSessionsPaneState } from '@/stores/chat/selectors';
import { buildRuntimeScopeKey } from '@/stores/chat/session-identity';
import type { ChatSessionRuntimeEndpointNode } from '@/stores/chat/types';
import type { AgentSessionsPaneSessionEntry } from '@/stores/chat/selectors';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useShallow } from 'zustand/react/shallow';
import {
  formatSessionMeta,
  resolveSessionTitle,
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
  buildAgentSessionSwitchboardModel,
  type AgentSessionSwitchboardTeamInput,
  type AgentSessionSwitchboardTeamResult,
  type AgentSessionSwitchboardTeamRoleResult,
  type AgentSessionSwitchboardTeamRunResult,
} from './agent-session-switchboard-model';

const SESSION_BUCKET_COLLAPSE_STORAGE_KEY = 'layout:session-time-bucket-collapsed';
const RUNTIME_SYMBOLS: Readonly<Record<string, string>> = {
  openclaw: '🦞',
  'matcha-agent': '🍵',
};

type SessionPaneTab = 'agent' | 'team' | 'session';
type SessionBucketScope = 'session' | 'automation';
type SessionRenameDraft = { key: string; title: string };

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
  return null;
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
  entry: AgentSessionsPaneSessionEntry;
  formatter: Intl.DateTimeFormat;
  teamMeta?: string;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  isCurrent: boolean;
  deleting: boolean;
  renaming: boolean;
  editing: boolean;
  editingTitle: string;
  readOnly: boolean;
  onSwitchSession: (sessionKey: string) => void;
  onStartRename: (session: ChatSession, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onSubmitRename?: () => void;
  onCancelRename?: () => void;
  onRequestDelete: (session: ChatSession, title: string) => void;
  onPick?: () => void;
}

const SessionListItem = memo(function SessionListItem({
  entry,
  formatter,
  teamMeta,
  agentId,
  agentName,
  avatarSeed,
  avatarStyle,
  isCurrent,
  deleting,
  renaming,
  editing,
  editingTitle,
  readOnly,
  onSwitchSession,
  onStartRename,
  onRenameTitleChange,
  onSubmitRename,
  onCancelRename,
  onRequestDelete,
  onPick,
}: SessionListItemProps) {
  const { t } = useTranslation();
  const session = entry.session;
  const sessionTitle = resolveSessionTitle(entry, t);
  const sessionMeta = teamMeta ?? `${agentName} / ${formatSessionMeta(entry, formatter)}`;
  const deleteLabel = t('sidebar.deleteSessionAria', { title: sessionTitle });
  const renameLabel = t('sidebar.renameSessionAria', { title: sessionTitle });
  const saveRenameLabel = t('sidebar.saveSessionRenameAria', { title: sessionTitle });
  const cancelRenameLabel = t('sidebar.cancelSessionRenameAria', { title: sessionTitle });
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
              onSubmitRename?.();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancelRename?.();
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
            onSubmitRename?.();
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
            onCancelRename?.();
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
              onRequestDelete(session, sessionTitle);
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
                          <span className="block truncate" title={run.runId}>{run.label}</span>
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
  managementRuntimeScopeKey,
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
  managementRuntimeScopeKey: string | null;
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
    const runtimeState = runtime.runtimeScopeKey === managementRuntimeScopeKey
      && endpoint?.target?.agentCatalog.source === 'subagent-management' ? state : 'ready';
    return {
      ...runtime,
      runtimeState,
      runtimeSymbol: endpoint?.endpoint.kind === 'native-runtime'
        ? RUNTIME_SYMBOLS[endpoint.endpoint.runtimeAdapterId] : undefined,
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
        <section key={runtime.runtimeScopeKey} className="space-y-1">
          <h3 className="flex h-7 items-center gap-2 px-2 text-[11px] font-medium text-muted-foreground">
            <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center text-sm leading-none">
              {runtime.runtimeSymbol}
            </span>
            <span className="min-w-0 truncate">{runtime.runtimeLabel}</span>
          </h3>
          {runtime.runtimeState === 'loading' ? (
            <p data-testid="agent-list-loading" className="px-2 py-1 text-xs text-muted-foreground">
              {loadingLabel}
            </p>
          ) : runtime.runtimeState === 'error' ? (
            <p data-testid="agent-list-error" className="px-2 py-1 text-xs text-destructive">
              {errorMessage || fallbackErrorLabel}
            </p>
          ) : null}
          <div>
            {runtime.agents.map((agent) => {
              const active = agent.isCurrent;
              const canCreate = Boolean(endpointByRuntimeScopeKey.get(agent.runtimeScopeKey)?.target);
              return (
                <div
                  key={`${agent.runtimeScopeKey}:${agent.agentId}`}
                  className={cn(
                    'group flex h-9 items-center gap-1 rounded-lg pr-1 transition-colors',
                    active ? 'bg-secondary/70 text-foreground' : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    data-testid={`agent-item-${agent.agentId}`}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-current={active ? 'true' : undefined}
                    title={agent.agentName}
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
                    <span className={cn('min-w-0 flex-1 truncate', active && 'font-medium')}>{agent.agentName}</span>
                    {agent.sessionCount > 0 ? (
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {agent.sessionCount}
                      </span>
                    ) : null}
                    {active ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                  <button
                    type="button"
                    data-testid={`agent-new-session-${agent.agentId}`}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed [@media(hover:none)]:opacity-100"
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
  renamingSessionKeys: Record<string, SessionRenameDraft>;
  editingSession: SessionRenameDraft | null;
  collapsedSessionBuckets: Record<string, boolean>;
  state: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  emptyLabel: string;
  sessionLabel: string;
  automationLabel: string;
  loadingLabel: string;
  fallbackErrorLabel: string;
  formatter: Intl.DateTimeFormat;
  onToggleBucket: (bucketId: SessionBucketId, defaultCollapsed: boolean, scope: SessionBucketScope) => void;
  onSwitchSession: (sessionKey: string) => void;
  onStartRename: (session: ChatSession, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (session: ChatSession, title: string) => void;
  onPick?: () => void;
}

const SessionListSection = memo(function SessionListSection({
  buckets,
  automationBuckets,
  currentSessionKey,
  deletingSessionKeys,
  renamingSessionKeys,
  editingSession,
  collapsedSessionBuckets,
  state,
  errorMessage,
  emptyLabel,
  sessionLabel,
  automationLabel,
  loadingLabel,
  fallbackErrorLabel,
  formatter,
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
            {bucket.sessions.map((result) => {
              const session = result.session;
              const editing = editingSession?.key === session.key;
              return (
                <SessionListItem
                  key={session.key}
                  entry={result.entry}
                  formatter={formatter}
                  teamMeta={result.source.kind === 'team' ? result.source.label : undefined}
                  agentId={result.source.agentId}
                  agentName={result.source.kind === 'team' ? result.source.label : result.source.agentName}
                  avatarSeed={result.source.kind === 'agent' ? result.source.avatarSeed : undefined}
                  avatarStyle={result.source.kind === 'agent' ? result.source.avatarStyle : undefined}
                  isCurrent={currentSessionKey === session.key}
                  deleting={Boolean(deletingSessionKeys[session.key])}
                  renaming={Boolean(renamingSessionKeys[session.key])}
                  editing={editing}
                  editingTitle={editing ? editingSession.title : ''}
                  readOnly={result.readOnly}
                  onSwitchSession={onSwitchSession}
                  onStartRename={onStartRename}
                  onRenameTitleChange={onRenameTitleChange}
                  onSubmitRename={editing ? onSubmitRename : undefined}
                  onCancelRename={editing ? onCancelRename : undefined}
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
  formatter: Intl.DateTimeFormat;
  onOpenAgent: (agent: AgentSessionSwitchboardAgentResult) => void;
  onSwitchSession: (sessionKey: string) => void;
}

const HoverSessionItem = memo(function HoverSessionItem({ result, formatter, onSwitchSession }: {
  result: AgentSessionSwitchboardSessionResult;
  formatter: Intl.DateTimeFormat;
  onSwitchSession: (sessionKey: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
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
        <span className="block truncate">{resolveSessionTitle(result.entry, t)}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
          {result.source.kind === 'team' ? result.source.label : formatSessionMeta(result.entry, formatter)}
        </span>
      </span>
    </button>
  );
});

const HoverPeek = memo(function HoverPeek({
  open,
  currentIdentityLabel,
  agents,
  sessions,
  formatter,
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
          <HoverSessionItem key={result.session.key} result={result} formatter={formatter} onSwitchSession={onSwitchSession} />
        ))}
        </div>
      ) : null}
    </div>
  );
});

type DirectoryContentsProps =
  | { mode: 'agent'; onPick: () => void }
  | { mode: 'hover'; currentIdentityLabel: string; onPick: () => void }
  | ({ mode: 'session' } & Pick<SessionListSectionProps,
    'deletingSessionKeys' | 'renamingSessionKeys' | 'editingSession' | 'collapsedSessionBuckets'
    | 'onToggleBucket' | 'onStartRename' | 'onRenameTitleChange' | 'onSubmitRename' | 'onCancelRename' | 'onRequestDelete' | 'onPick'>);

const DirectoryContents = memo(function DirectoryContents(props: DirectoryContentsProps) {
  const { t, i18n } = useTranslation();
  const { sessionEntries, sessionsLoadedOnce, sessionsError, currentConversation, sessionRuntimeGraph, currentSessionKey,
    switchSession, openAgentConversation, newSessionForScope } = useChatStore(useShallow(selectAgentSessionsPaneState));
  const selectedEndpoint = useChatStore((state) => state.sessionRuntimeCatalog.selectedEndpoint);
  const managementScope = useSubagentsStore((state) => state.managementScope);
  const resource = useSubagentsStore((state) => state.agentsResource);
  const managementRuntimeScopeKey = managementScope ? buildRuntimeScopeKey(managementScope.endpoint) : null;
  const runtimeEndpoints = sessionRuntimeGraph.endpoints;
  const availableEndpoints = useMemo(() => runtimeEndpoints.filter((endpoint) => endpoint.target != null), [runtimeEndpoints]);
  const selectedRuntimeEndpoint = resolveSelectedRuntimeEndpoint({
    endpoints: availableEndpoints,
    runtimeScopeKey: currentConversation?.runtimeScopeKey ?? (selectedEndpoint ? buildRuntimeScopeKey(selectedEndpoint) : null),
  });
  const pane = useAgentSessionsPaneViewModel({
    subagentManagementAgents: Array.isArray(resource.data) ? resource.data : EMPTY_AGENTS,
    subagentManagementAgentsResource: resource,
    subagentManagementRuntimeScopeKey: managementRuntimeScopeKey,
    sessionEntries, sessionsLoadedOnce, sessionsError, currentConversation, selectedRuntimeEndpoint, runtimeEndpoints, t,
  });
  const formatter = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }), [i18n.language]);
  const endpointByRuntimeScopeKey = useMemo(() => new Map(availableEndpoints.map((endpoint) => [endpoint.runtimeScopeKey, endpoint])), [availableEndpoints]);
  const agentResults = pane.switchboard.agentResults.filter((runtime) => endpointByRuntimeScopeKey.has(runtime.runtimeScopeKey));
  const onPick = props.onPick;
  const openAgent = useCallback((agent: AgentSessionSwitchboardAgentResult) => {
    const endpoint = endpointByRuntimeScopeKey.get(agent.runtimeScopeKey);
    if (endpoint) openAgentConversation(agent.agentId, endpoint.endpoint);
  }, [endpointByRuntimeScopeKey, openAgentConversation]);
  const createSession = useCallback((agent: AgentSessionSwitchboardAgentResult) => {
    const target = endpointByRuntimeScopeKey.get(agent.runtimeScopeKey)?.target;
    if (!target) return;
    const scope = resolveAgentScopeForRuntimeEndpoint(target, agent.agentId);
    if (scope) void newSessionForScope(scope);
  }, [endpointByRuntimeScopeKey, newSessionForScope]);
  const hoverOpenAgent = useCallback((agent: AgentSessionSwitchboardAgentResult) => {
    openAgent(agent);
    onPick?.();
  }, [onPick, openAgent]);
  const hoverSwitchSession = useCallback((sessionKey: string) => {
    switchSession(sessionKey);
    onPick?.();
  }, [onPick, switchSession]);
  if (props.mode === 'hover') return (
    <HoverPeek open currentIdentityLabel={props.currentIdentityLabel} agents={agentResults.flatMap((runtime) => runtime.agents)}
      sessions={pane.switchboard.sessionResults} formatter={formatter} onOpenAgent={hoverOpenAgent} onSwitchSession={hoverSwitchSession} />
  );
  if (props.mode === 'agent') return (
    <AgentSwitchboardSection runtimes={agentResults} endpointByRuntimeScopeKey={endpointByRuntimeScopeKey}
      managementRuntimeScopeKey={managementRuntimeScopeKey} newSessionLabel={t('sidebar.newSession')}
      state={pane.agentListState} errorMessage={pane.agentErrorMessage} emptyLabel={t('sidebar.noSubagents')}
      loadingLabel={t('status.loading')} fallbackErrorLabel={t('status.error')} onOpenAgent={openAgent}
      onCreateSessionForAgent={createSession} onPick={props.onPick} />
  );
  return (
    <SessionListSection {...props} buckets={pane.switchboard.sessionResults} automationBuckets={pane.switchboard.automationSessionResults}
      currentSessionKey={currentSessionKey} formatter={formatter} state={pane.sessionListState} errorMessage={pane.sessionErrorMessage}
      emptyLabel={t('sidebar.noAgentSessions')} sessionLabel={t('switchboard.normalSessions', { defaultValue: 'Normal' })}
      automationLabel={t('switchboard.automationSessions', { defaultValue: 'Automation' })} loadingLabel={t('status.loading')}
      fallbackErrorLabel={t('status.error')} onSwitchSession={switchSession} />
  );
});

const EMPTY_AGENTS: [] = [];

const TeamContents = memo(function TeamContents(props: Pick<TeamListSectionProps,
  'expandedTeamIds' | 'expandedTeamRunIds' | 'onToggleTeam' | 'onToggleRun' | 'onPick'>) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const teams = useTeamsStore((state) => state.teams);
  const runListByTeamId = useTeamsStore((state) => state.runListByTeamId);
  const runLabels = useTeamRunLabels();
  const index = useTeamsStore(selectTeamRoleChatTargetIndex);
  const createRun = useTeamsStore((state) => state.createRun);
  const setActiveRun = useTeamsStore((state) => state.setActiveRun);
  const syncRunList = useTeamsStore((state) => state.syncRunList);
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const openSessionIdentity = useChatStore((state) => state.openSessionIdentity);
  const teamInputs = useMemo<AgentSessionSwitchboardTeamInput[]>(() => teams.map((team) => ({
    teamId: team.id, teamName: team.name, activeRunId: team.activeRunId,
    runs: (runListByTeamId[team.id] ?? []).map((run) => {
      const sessions = run.sessions ?? [];
      const toRole = (role: (typeof sessions)[number]) => ({
        roleId: role.roleId, agentId: role.agentId, sessionIdentity: role.sessionIdentity, localSessionId: role.localSessionId,
        endpointSessionId: resolveTeamRoleChatTargetFromProbe(index, {
          sessionIdentity: role.sessionIdentity, sessionKey: role.localSessionId, endpointSessionId: role.endpointSessionId,
        })?.endpointSessionId ?? role.endpointSessionId,
      });
      const leader = sessions.find((role) => role.roleId === 'leader');
      return { runId: run.runId, label: runLabels[run.runId] ?? t('teams:run.unnamed'), createdAt: run.createdAt, updatedAt: run.updatedAt,
        leader: leader ? toRole(leader) : null, roles: sessions.filter((role) => role.roleId !== 'leader').map(toRole) };
    }),
  })), [index, runLabels, runListByTeamId, t, teams]);
  const nodes = useMemo(() => buildAgentSessionSwitchboardModel({
    currentConversation: null, selectedRuntimeEndpoint: null, runtimeResults: [], teamResults: teamInputs, sessionResults: { buckets: [] },
  }).teamResults, [teamInputs]);
  const teamSyncKey = teams.map((team) => team.id).join('\n');
  useEffect(() => {
    for (const teamId of teamSyncKey ? teamSyncKey.split('\n') : []) void syncRunList(teamId);
  }, [syncRunList, teamSyncKey]);
  const selectRole = useCallback((teamId: string, runId: string, role: AgentSessionSwitchboardTeamRoleResult) => {
    setActiveRun(teamId, runId);
    openSessionIdentity({ sessionIdentity: role.sessionIdentity });
    navigate('/', { state: { teamDesignSurface: { kind: 'team-graph', sourceSessionIdentity: role.sessionIdentity, teamId, runId } } });
    void refreshSnapshot(teamId, { force: true });
  }, [navigate, openSessionIdentity, refreshSnapshot, setActiveRun]);
  const selectRun = useCallback((teamId: string, run: AgentSessionSwitchboardTeamRunResult) => {
    setActiveRun(teamId, run.runId);
    if (run.leader) {
      openSessionIdentity({ sessionIdentity: run.leader.sessionIdentity });
      navigate('/', { state: { teamDesignSurface: { kind: 'team-graph', sourceSessionIdentity: run.leader.sessionIdentity, teamId, runId: run.runId } } });
    }
    void refreshSnapshot(teamId, { force: true });
  }, [navigate, openSessionIdentity, refreshSnapshot, setActiveRun]);
  const newRun = useCallback((teamId: string) => { void createRun(teamId); }, [createRun]);
  return <TeamListSection {...props} nodes={nodes} emptyLabel={t('sidebar.noTeams')} leaderLabel={t('sidebar.teamLeader')}
    newRunLabel={t('teams:run.create')} onSelectRun={selectRun} onCreateRun={newRun} onSelectRole={selectRole} />;
});

export const AgentSessionsPane = memo(function AgentSessionsPane() {
  const { t } = useTranslation();
  const currentConversation = useChatStore((state) => state.currentConversation);
  const currentSessionKey = currentConversation?.kind === 'session' ? currentConversation.sessionRecordKey : '';
  const beacon = useChatStore(useShallow((state) => {
    const candidate = resolveSelectedRuntimeEndpoint({
      endpoints: state.sessionRuntimeGraph.endpoints,
      runtimeScopeKey: state.currentConversation?.runtimeScopeKey
        ?? (state.sessionRuntimeCatalog.selectedEndpoint ? buildRuntimeScopeKey(state.sessionRuntimeCatalog.selectedEndpoint) : null),
    });
    const endpoint = candidate?.target ? candidate : null;
    const agentId = state.currentConversation?.agentId ?? endpoint?.defaultAgentId ?? '';
    return {
      runtimeScopeKey: endpoint?.runtimeScopeKey,
      runtimeLabel: endpoint?.displayName,
      target: endpoint?.target,
      agentId,
      catalogName: endpoint?.agents.find((agent) => agent.agentId === agentId)?.catalogEntry?.name,
    };
  }));
  const activeAgent = useSubagentsStore(useShallow((state) => {
    const agents = Array.isArray(state.agentsResource.data) ? state.agentsResource.data : EMPTY_AGENTS;
    const agentId = currentConversation || agents.length > 0 ? beacon.agentId : '';
    const managementRuntimeScopeKey = state.managementScope ? buildRuntimeScopeKey(state.managementScope.endpoint) : null;
    const metadata = beacon.runtimeScopeKey === managementRuntimeScopeKey ? agents.find((agent) => agent.id === agentId) : undefined;
    const seed = beacon.target?.agentCatalog.source === 'subagent-management'
      ? beacon.target.agentCatalog.seedAgents.find((agent) => agent.id === agentId) : undefined;
    const managementCatalog = beacon.target?.agentCatalog.source === 'subagent-management';
    return {
      id: agentId,
      name: managementCatalog ? metadata?.name?.trim() || seed?.name?.trim() || agentId : beacon.catalogName?.trim() || agentId,
      avatarSeed: managementCatalog ? metadata?.avatarSeed : undefined,
      avatarStyle: managementCatalog ? metadata?.avatarStyle : undefined,
    };
  }));
  const teamIdentityLabel = useTeamsStore((state) => {
    if (currentConversation?.kind !== 'session') return '';
    const target = resolveTeamRoleChatTargetFromProbe(selectTeamRoleChatTargetIndex(state), {
      sessionIdentity: currentConversation.sessionIdentity, sessionKey: currentSessionKey,
      endpointSessionId: currentConversation.endpointSessionId,
    });
    if (!target) return '';
    const team = state.teams.find((candidate) => candidate.id === target.teamId);
    return team ? [team.name, target.roleId].map((part) => part.trim()).filter(Boolean).join(' / ') : '';
  });
  const newSessionForScope = useChatStore((state) => state.newSessionForScope);
  const deleteSession = useChatStore((state) => state.deleteSession);
  const renameSession = useChatStore((state) => state.renameSession);
  const [activeTab, setActiveTab] = useState<SessionPaneTab>('agent');
  const [expandedTeamIds, setExpandedTeamIds] = useState<Record<string, boolean>>({});
  const [expandedTeamRunIds, setExpandedTeamRunIds] = useState<Record<string, boolean>>({});
  const [collapsedSessionBuckets, setCollapsedSessionBuckets] = useState<Record<string, boolean>>(
    () => loadCollapsedSessionBucketMap(),
  );
  const [deletingSessionKeys, setDeletingSessionKeys] = useState<Record<string, true>>({});
  const [renamingSessionKeys, setRenamingSessionKeys] = useState<Record<string, SessionRenameDraft>>({});
  const [editingSession, setEditingSession] = useState<SessionRenameDraft | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    key: string;
    title: string;
  } | null>(null);
  const [switchboardOpen, setSwitchboardOpen] = useState(false);
  const [hoverPeekOpen, setHoverPeekOpen] = useState(false);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const switchboardTraceStateRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    const detail = {
      state: switchboardOpen ? 'open' : 'closed', activeTab, hoverPeekOpen,
      conversationKind: currentConversation?.kind ?? 'none',
      recordKey: summarizeIdentifier(currentSessionKey),
      identity: summarizeSessionIdentity(currentConversation?.kind === 'session' ? currentConversation.sessionIdentity : null),
    };
    const stateKey = JSON.stringify(detail);
    if (switchboardTraceStateRef.current === stateKey) return;
    switchboardTraceStateRef.current = stateKey;
    logSessionTrace('switchboard.state', createSessionTraceId('switchboard'), () => detail);
  }, [activeTab, currentConversation, currentSessionKey, hoverPeekOpen, switchboardOpen]);

  const activeAgentId = activeAgent.id;
  const activeRuntimeLabel = beacon.runtimeLabel ?? t('switchboard.runtime');
  const activeAgentName = currentConversation
    ? teamIdentityLabel || `${beacon.runtimeLabel ?? currentConversation.runtimeScopeKey} / ${activeAgent.name || activeAgentId}`
    : activeAgentId || t('sidebar.agentSessions');

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

  const handleNewSession = useCallback(() => {
    const target = beacon.target;
    if (!target) return;
    const scope = currentConversation ? resolveAgentScopeForRuntimeEndpoint(target, currentConversation.agentId) : target.defaultSessionPromptScope;
    if (scope) void newSessionForScope(scope);
  }, [beacon.target, currentConversation, newSessionForScope]);
  const toggleSwitchboard = useCallback(() => {
    setHoverPeekOpen(false);
    setSwitchboardOpen((open) => !open);
  }, []);
  const closeHoverPeek = useCallback(() => setHoverPeekOpen(false), []);

  const toggleTeam = useCallback((teamId: string) => {
    setExpandedTeamIds((current) => ({ ...current, [teamId]: current[teamId] !== true }));
  }, []);

  const toggleRun = useCallback((runId: string) => {
    setExpandedTeamRunIds((current) => ({ ...current, [runId]: current[runId] !== true }));
  }, []);

  const toggleSessionBucket = useCallback((bucketId: SessionBucketId, defaultCollapsed: boolean, scope: SessionBucketScope) => {
    const stateKey = createSessionBucketStateKey(bucketId, scope);
    setCollapsedSessionBuckets((prev) => {
      const current = Object.prototype.hasOwnProperty.call(prev, stateKey)
        ? Boolean(prev[stateKey])
        : defaultCollapsed;
      return { ...prev, [stateKey]: !current };
    });
  }, []);

  const requestDeleteSession = useCallback((session: ChatSession, title: string) => {
    if (isAgentSessionSwitchboardAutomationSession(session) || session.kind === 'main' || session.preferred) {
      return;
    }
    setPendingDeleteSession({ key: session.key, title });
  }, []);

  const changeRenameTitle = useCallback((title: string) => {
    setEditingSession((current) => current ? { ...current, title } : current);
  }, []);

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
    const submittedDraft = editingSession;
    setRenamingSessionKeys((current) => ({ ...current, [submittedDraft.key]: submittedDraft }));
    try {
      await renameSession(submittedDraft.key, normalizedTitle);
      setEditingSession((current) => current === submittedDraft ? null : current);
    } finally {
      setRenamingSessionKeys((current) => {
        if (current[submittedDraft.key] !== submittedDraft) {
          return current;
        }
        const next = { ...current };
        delete next[submittedDraft.key];
        return next;
      });
    }
  }, [editingSession, renameSession]);

  const cancelRenameSession = useCallback(() => {
    if (editingSession && renamingSessionKeys[editingSession.key]) {
      return;
    }
    setEditingSession(null);
  }, [editingSession, renamingSessionKeys]);

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
          activeAvatarSeed={currentConversation ? activeAgent.avatarSeed : undefined}
          activeAvatarStyle={currentConversation ? activeAgent.avatarStyle : undefined}
          identityLabel={activeAgentName}
          runtimeLabel={activeRuntimeLabel}
          newSessionLabel={t('sidebar.newSession')}
          disabledNewSession={!beacon.target}
          switchboardOpen={switchboardOpen}
          onNewSession={handleNewSession}
          onOpenSwitchboard={toggleSwitchboard}
        />
        {hoverPeekOpen && !switchboardOpen ? (
          <DirectoryContents mode="hover" currentIdentityLabel={activeAgentName} onPick={closeHoverPeek} />
        ) : null}
      </div>

      {switchboardOpen ? (
        <div
          data-testid="chat-switchboard-backdrop"
          className="fixed inset-0 z-20 bg-transparent"
          onMouseDown={(event) => {
            closeSwitchboard();
            logSessionTrace('switchboard.backdrop.intercept', createSessionTraceId('switchboard-backdrop'), () => ({
              intercept: true, button: event.button,
              overComposer: document.elementsFromPoint(event.clientX, event.clientY)
                .some((element) => element.closest('[data-testid="chat-composer"]') !== null),
              recordKey: summarizeIdentifier(currentSessionKey),
              identity: summarizeSessionIdentity(currentConversation?.kind === 'session' ? currentConversation.sessionIdentity : null),
            }));
          }}
        />
      ) : null}

      {switchboardOpen ? (
        <section
          data-testid="chat-switchboard"
          role="dialog"
          aria-label={t('switchboard.quickSwitch')}
          className="absolute left-[52px] top-5 z-30 flex max-h-[min(420px,calc(100vh-32px))] w-[280px] max-w-[calc(100vw-68px)] flex-col overflow-hidden rounded-[22px] border border-border/75 bg-card/96 shadow-[0_18px_48px_rgba(0,0,0,0.26),0_5px_14px_rgba(0,0,0,0.18)] backdrop-blur-md transition-[opacity,transform] duration-150"
        >
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
              <DirectoryContents mode="agent" onPick={closeSwitchboard} />
            ) : activeTab === 'team' ? (
              <TeamContents
                expandedTeamIds={expandedTeamIds}
                expandedTeamRunIds={expandedTeamRunIds}
                onToggleTeam={toggleTeam}
                onToggleRun={toggleRun}
                onPick={closeSwitchboard}
              />
            ) : (
              <DirectoryContents
                mode="session"
                deletingSessionKeys={deletingSessionKeys}
                renamingSessionKeys={renamingSessionKeys}
                editingSession={editingSession}
                collapsedSessionBuckets={collapsedSessionBuckets}
                onToggleBucket={toggleSessionBucket}
                onStartRename={startRenameSession}
                onRenameTitleChange={changeRenameTitle}
                onSubmitRename={submitRenameSession}
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
