import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { AgentSessionsPaneSessionEntry } from '@/stores/chat/selectors';
import type {
  ChatCurrentConversation,
  ChatSession,
  ChatSessionRuntimeEndpointNode,
} from '@/stores/chat/types';
import { buildSessionIdentityKey, type SessionIdentity } from '../../types/desktop/runtime-address';

export type AgentSessionSwitchboardSessionBucketId = 'today' | 'within_7_days' | 'within_30_days' | 'older';
export type AgentSessionSwitchboardIdentityKind = 'agent' | 'team' | 'empty';

type SwitchboardSessionKind = ChatSession['kind'] | 'automation';

export interface AgentSessionSwitchboardTeamRoleInput {
  roleId: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
  localSessionId?: string | null;
  endpointSessionId?: string | null;
}

export interface AgentSessionSwitchboardTeamRunInput {
  runId: string;
  label: string;
  createdAt?: number | null;
  updatedAt?: number | null;
  leader?: AgentSessionSwitchboardTeamRoleInput | null;
  roles: readonly AgentSessionSwitchboardTeamRoleInput[];
}

export interface AgentSessionSwitchboardTeamInput {
  teamId: string;
  teamName: string;
  activeRunId?: string | null;
  runs: readonly AgentSessionSwitchboardTeamRunInput[];
}

export interface AgentSessionSwitchboardAgentResult {
  kind: 'agent';
  runtimeScopeKey: string;
  runtimeLabel: string;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  sessionCount: number;
  isCurrent: boolean;
  identityLabel: string;
}

export interface AgentSessionSwitchboardRuntimeResult {
  runtimeScopeKey: string;
  runtimeLabel: string;
  agents: AgentSessionSwitchboardAgentResult[];
}

export interface AgentSessionSwitchboardTeamRoleResult {
  kind: 'team-role';
  teamId: string;
  teamName: string;
  runId: string;
  roleId: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
  endpointSessionId: string | null;
  identityLabel: string;
}

export interface AgentSessionSwitchboardTeamRunResult {
  runId: string;
  label: string;
  isActive: boolean;
  leader: AgentSessionSwitchboardTeamRoleResult | null;
  roles: AgentSessionSwitchboardTeamRoleResult[];
}

export interface AgentSessionSwitchboardTeamResult {
  kind: 'team';
  teamId: string;
  teamName: string;
  activeRunId: string | null;
  runs: AgentSessionSwitchboardTeamRunResult[];
  identityLabel: string;
}

export type AgentSessionSwitchboardSessionSource =
  | {
    kind: 'agent';
    runtimeScopeKey: string;
    runtimeLabel: string;
    agentId: string;
    agentName: string;
    avatarSeed?: string;
    avatarStyle?: AgentAvatarStyle;
    label: string;
  }
  | {
    kind: 'team';
    teamId: string;
    teamName: string;
    runId: string;
    roleId: string;
    agentId: string;
    label: string;
  };

export interface AgentSessionSwitchboardSessionResult {
  entry: AgentSessionsPaneSessionEntry;
  session: ChatSession;
  title: string;
  meta: string;
  source: AgentSessionSwitchboardSessionSource;
  identityLabel: string;
  deleteLabel: string;
  renameLabel: string;
  saveRenameLabel: string;
  cancelRenameLabel: string;
  readOnly: boolean;
}

export interface AgentSessionSwitchboardSessionBucket {
  id: AgentSessionSwitchboardSessionBucketId;
  label: string;
  defaultCollapsed: boolean;
  sessions: AgentSessionSwitchboardSessionResult[];
}

export interface AgentSessionSwitchboardCurrentIdentity {
  kind: AgentSessionSwitchboardIdentityKind;
  label: string;
  runtimeScopeKey: string | null;
  agentId: string | null;
  teamId: string | null;
  runId: string | null;
  roleId: string | null;
}

export interface AgentSessionSwitchboardModel {
  currentIdentity: AgentSessionSwitchboardCurrentIdentity;
  currentIdentityLabel: string;
  agentResults: AgentSessionSwitchboardRuntimeResult[];
  teamResults: AgentSessionSwitchboardTeamResult[];
  sessionResults: AgentSessionSwitchboardSessionBucket[];
  automationSessionResults: AgentSessionSwitchboardSessionBucket[];
  hideLegacyListsByDefault: true;
}

interface AgentSessionSwitchboardRuntimeAgentInput {
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  sessionCount: number;
}

export interface AgentSessionSwitchboardRuntimeInput {
  runtimeScopeKey: string;
  runtimeLabel: string;
  agents: readonly AgentSessionSwitchboardRuntimeAgentInput[];
}

export interface AgentSessionSwitchboardSessionBucketInput {
  id: AgentSessionSwitchboardSessionBucketId;
  label: string;
  defaultCollapsed: boolean;
  sessions: readonly AgentSessionsPaneSessionEntry[];
}

export interface AgentSessionSwitchboardAgentSessionSourceInput {
  runtimeScopeKey: string;
  runtimeLabel: string;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface AgentSessionSwitchboardSessionInput {
  buckets: readonly AgentSessionSwitchboardSessionBucketInput[];
  viewModelByKey: ReadonlyMap<string, {
    title: string;
    meta: string;
    agentId: string;
    agentName: string;
    avatarSeed?: string;
    avatarStyle?: AgentAvatarStyle;
    deleteLabel: string;
    renameLabel: string;
    saveRenameLabel: string;
    cancelRenameLabel: string;
  }>;
  agentSourceByKey: ReadonlyMap<string, AgentSessionSwitchboardAgentSessionSourceInput>;
}

export interface BuildAgentSessionSwitchboardModelInput {
  currentConversation: ChatCurrentConversation | null;
  selectedRuntimeEndpoint: ChatSessionRuntimeEndpointNode | null;
  runtimeResults: readonly AgentSessionSwitchboardRuntimeInput[];
  teamResults: readonly AgentSessionSwitchboardTeamInput[];
  sessionResults: AgentSessionSwitchboardSessionInput;
}

interface TeamRoleSource {
  teamId: string;
  teamName: string;
  runId: string;
  roleId: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
  endpointSessionId: string | null;
  localSessionId: string | null;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function formatIdentityLabel(parts: Array<string | null | undefined>): string {
  return parts.map((part) => normalizeText(part)).filter((part): part is string => part != null).join(' / ');
}

function isOpenClawNativeSession(identity: SessionIdentity): boolean {
  return identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw';
}

function resolveMaterializedTeamSessionKey(role: TeamRoleSource): string | null {
  if (!role.endpointSessionId || !isOpenClawNativeSession(role.sessionIdentity)) {
    return null;
  }
  return `agent:${role.agentId}:${role.endpointSessionId}`;
}

function addTeamRoleSourceIndexEntry(map: Map<string, TeamRoleSource>, key: string | null | undefined, source: TeamRoleSource): void {
  const normalized = normalizeText(key);
  if (normalized) {
    map.set(normalized, source);
  }
}

function buildTeamRoleSourceIndex(teams: readonly AgentSessionSwitchboardTeamInput[]): Map<string, TeamRoleSource> {
  const map = new Map<string, TeamRoleSource>();
  for (const team of teams) {
    for (const run of team.runs) {
      const roleInputs = [run.leader, ...run.roles].filter((role): role is AgentSessionSwitchboardTeamRoleInput => role != null);
      for (const role of roleInputs) {
        const source: TeamRoleSource = {
          teamId: team.teamId,
          teamName: team.teamName,
          runId: run.runId,
          roleId: role.roleId,
          agentId: role.agentId,
          sessionIdentity: role.sessionIdentity,
          endpointSessionId: normalizeText(role.endpointSessionId),
          localSessionId: normalizeText(role.localSessionId) ?? normalizeText(role.sessionIdentity.sessionKey),
        };
        addTeamRoleSourceIndexEntry(map, buildSessionIdentityKey(role.sessionIdentity), source);
        addTeamRoleSourceIndexEntry(map, source.localSessionId, source);
        addTeamRoleSourceIndexEntry(map, source.endpointSessionId, source);
        addTeamRoleSourceIndexEntry(map, role.sessionIdentity.sessionKey, source);
        addTeamRoleSourceIndexEntry(map, resolveMaterializedTeamSessionKey(source), source);
      }
    }
  }
  return map;
}

function resolveTeamRoleSource(
  index: ReadonlyMap<string, TeamRoleSource>,
  session: Pick<ChatSession, 'key' | 'sessionIdentity' | 'endpointSessionId'>,
): TeamRoleSource | null {
  const identityTarget = index.get(buildSessionIdentityKey(session.sessionIdentity));
  if (identityTarget) {
    return identityTarget;
  }
  const candidates = [
    session.endpointSessionId,
    session.sessionIdentity.sessionKey,
    session.key,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (!normalized) {
      continue;
    }
    const target = index.get(normalized);
    if (target) {
      return target;
    }
  }
  return null;
}

function buildTeamRoleResult(team: AgentSessionSwitchboardTeamInput, run: AgentSessionSwitchboardTeamRunInput, role: AgentSessionSwitchboardTeamRoleInput): AgentSessionSwitchboardTeamRoleResult {
  return {
    kind: 'team-role',
    teamId: team.teamId,
    teamName: team.teamName,
    runId: run.runId,
    roleId: role.roleId,
    agentId: role.agentId,
    sessionIdentity: role.sessionIdentity,
    endpointSessionId: normalizeText(role.endpointSessionId),
    identityLabel: formatIdentityLabel([team.teamName, run.runId, role.roleId]),
  };
}

function buildTeamResults(teams: readonly AgentSessionSwitchboardTeamInput[]): AgentSessionSwitchboardTeamResult[] {
  return teams.map((team) => ({
    kind: 'team',
    teamId: team.teamId,
    teamName: team.teamName,
    activeRunId: normalizeText(team.activeRunId),
    runs: team.runs.map((run) => ({
      runId: run.runId,
      label: run.label,
      isActive: team.activeRunId === run.runId,
      leader: run.leader ? buildTeamRoleResult(team, run, run.leader) : null,
      roles: run.roles.map((role) => buildTeamRoleResult(team, run, role)),
    })),
    identityLabel: team.teamName,
  }));
}

function buildAgentResults(
  runtimes: readonly AgentSessionSwitchboardRuntimeInput[],
  currentConversation: ChatCurrentConversation | null,
): AgentSessionSwitchboardRuntimeResult[] {
  return runtimes.map((runtime) => ({
    runtimeScopeKey: runtime.runtimeScopeKey,
    runtimeLabel: runtime.runtimeLabel,
    agents: runtime.agents.map((agent) => ({
      kind: 'agent',
      runtimeScopeKey: runtime.runtimeScopeKey,
      runtimeLabel: runtime.runtimeLabel,
      agentId: agent.agentId,
      agentName: agent.agentName,
      avatarSeed: agent.avatarSeed,
      avatarStyle: agent.avatarStyle,
      sessionCount: agent.sessionCount,
      isCurrent: currentConversation?.runtimeScopeKey === runtime.runtimeScopeKey
        && currentConversation.agentId === agent.agentId,
      identityLabel: formatIdentityLabel([runtime.runtimeLabel, agent.agentName]),
    })),
  }));
}

function buildAgentSessionSource(
  viewModel: AgentSessionSwitchboardSessionInput['viewModelByKey'] extends ReadonlyMap<string, infer TValue> ? TValue : never,
  agentSource: AgentSessionSwitchboardAgentSessionSourceInput | null,
  selectedRuntimeEndpoint: ChatSessionRuntimeEndpointNode | null,
  session: ChatSession,
): AgentSessionSwitchboardSessionSource {
  const runtimeScopeKey = agentSource?.runtimeScopeKey ?? selectedRuntimeEndpoint?.runtimeScopeKey ?? '';
  const runtimeLabel = agentSource?.runtimeLabel ?? selectedRuntimeEndpoint?.displayName ?? session.runtimeEndpointId ?? '';
  const agentId = agentSource?.agentId ?? viewModel.agentId;
  const agentName = agentSource?.agentName ?? viewModel.agentName;
  return {
    kind: 'agent',
    runtimeScopeKey,
    runtimeLabel,
    agentId,
    agentName,
    avatarSeed: agentSource?.avatarSeed ?? viewModel.avatarSeed,
    avatarStyle: agentSource?.avatarStyle ?? viewModel.avatarStyle,
    label: formatIdentityLabel([runtimeLabel, agentName]) || agentName,
  };
}

function buildTeamSessionSource(source: TeamRoleSource): AgentSessionSwitchboardSessionSource {
  return {
    kind: 'team',
    teamId: source.teamId,
    teamName: source.teamName,
    runId: source.runId,
    roleId: source.roleId,
    agentId: source.agentId,
    label: formatIdentityLabel([source.teamName, source.roleId]) || source.teamName,
  };
}

function readSwitchboardSessionKind(session: ChatSession): SwitchboardSessionKind {
  return session.kind;
}

export function isAgentSessionSwitchboardAutomationSession(session: ChatSession): boolean {
  return readSwitchboardSessionKind(session) === 'automation';
}

function buildSessionResults(
  input: AgentSessionSwitchboardSessionInput,
  selectedRuntimeEndpoint: ChatSessionRuntimeEndpointNode | null,
  teamSourceIndex: ReadonlyMap<string, TeamRoleSource>,
  predicate: (session: ChatSession) => boolean,
): AgentSessionSwitchboardSessionBucket[] {
  return input.buckets.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    defaultCollapsed: bucket.defaultCollapsed,
    sessions: bucket.sessions.filter((entry) => predicate(entry.session)).map((entry) => {
      const session = entry.session;
      const viewModel = input.viewModelByKey.get(session.key);
      const teamSource = resolveTeamRoleSource(teamSourceIndex, session);
      const agentSource = input.agentSourceByKey.get(session.key) ?? null;
      const source = teamSource
        ? buildTeamSessionSource(teamSource)
        : buildAgentSessionSource(viewModel ?? {
          title: session.displayName ?? session.label ?? session.key,
          meta: session.key,
          agentId: session.agentId,
          agentName: session.agentId,
          deleteLabel: session.key,
          renameLabel: session.key,
          saveRenameLabel: session.key,
          cancelRenameLabel: session.key,
        }, agentSource, selectedRuntimeEndpoint, session);
      const title = viewModel?.title ?? session.displayName ?? session.label ?? session.key;
      return {
        entry,
        session,
        title,
        meta: teamSource ? source.label : viewModel?.meta ?? session.key,
        source,
        identityLabel: source.label,
        deleteLabel: viewModel?.deleteLabel ?? title,
        renameLabel: viewModel?.renameLabel ?? title,
        saveRenameLabel: viewModel?.saveRenameLabel ?? title,
        cancelRenameLabel: viewModel?.cancelRenameLabel ?? title,
        readOnly: isAgentSessionSwitchboardAutomationSession(session),
      };
    }),
  })).filter((bucket) => bucket.sessions.length > 0);
}

function resolveCurrentIdentity(input: {
  currentConversation: ChatCurrentConversation | null;
  selectedRuntimeEndpoint: ChatSessionRuntimeEndpointNode | null;
  agentResults: readonly AgentSessionSwitchboardRuntimeResult[];
  teamSourceIndex: ReadonlyMap<string, TeamRoleSource>;
}): AgentSessionSwitchboardCurrentIdentity {
  const conversation = input.currentConversation;
  if (!conversation) {
    return {
      kind: 'empty',
      label: '',
      runtimeScopeKey: null,
      agentId: null,
      teamId: null,
      runId: null,
      roleId: null,
    };
  }
  if (conversation.kind === 'session') {
    const teamSource = resolveTeamRoleSource(input.teamSourceIndex, {
      key: conversation.sessionRecordKey,
      endpointSessionId: conversation.endpointSessionId ?? undefined,
      sessionIdentity: conversation.sessionIdentity,
    });
    if (teamSource) {
      return {
        kind: 'team',
        label: formatIdentityLabel([teamSource.teamName, teamSource.roleId]) || teamSource.teamName,
        runtimeScopeKey: conversation.runtimeScopeKey,
        agentId: teamSource.agentId,
        teamId: teamSource.teamId,
        runId: teamSource.runId,
        roleId: teamSource.roleId,
      };
    }
  }
  const runtime = input.agentResults.find((candidate) => candidate.runtimeScopeKey === conversation.runtimeScopeKey);
  const agent = runtime?.agents.find((candidate) => candidate.agentId === conversation.agentId);
  const runtimeLabel = runtime?.runtimeLabel ?? input.selectedRuntimeEndpoint?.displayName ?? conversation.runtimeScopeKey;
  const agentName = agent?.agentName ?? conversation.agentId;
  return {
    kind: 'agent',
    label: formatIdentityLabel([runtimeLabel, agentName]) || agentName,
    runtimeScopeKey: conversation.runtimeScopeKey,
    agentId: conversation.agentId,
    teamId: null,
    runId: null,
    roleId: null,
  };
}

export function buildAgentSessionSwitchboardModel(input: BuildAgentSessionSwitchboardModelInput): AgentSessionSwitchboardModel {
  const teamSourceIndex = buildTeamRoleSourceIndex(input.teamResults);
  const agentResults = buildAgentResults(input.runtimeResults, input.currentConversation);
  const teamResults = buildTeamResults(input.teamResults);
  const currentIdentity = resolveCurrentIdentity({
    currentConversation: input.currentConversation,
    selectedRuntimeEndpoint: input.selectedRuntimeEndpoint,
    agentResults,
    teamSourceIndex,
  });
  return {
    currentIdentity,
    currentIdentityLabel: currentIdentity.label,
    agentResults,
    teamResults,
    sessionResults: buildSessionResults(
      input.sessionResults,
      input.selectedRuntimeEndpoint,
      teamSourceIndex,
      (session) => !isAgentSessionSwitchboardAutomationSession(session),
    ),
    automationSessionResults: buildSessionResults(
      input.sessionResults,
      input.selectedRuntimeEndpoint,
      teamSourceIndex,
      isAgentSessionSwitchboardAutomationSession,
    ),
    hideLegacyListsByDefault: true,
  };
}
