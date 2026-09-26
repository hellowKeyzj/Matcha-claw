import { describe, expect, it } from 'vitest';
import { buildRuntimeEndpointKey, buildSessionIdentityKey, type RuntimeEndpointRef, type SessionIdentity } from '../../src/types/desktop/runtime-address';
import { buildAgentSessionSwitchboardModel } from '@/components/layout/agent-session-switchboard-model';
import type { AgentSessionsPaneSessionEntry } from '@/stores/chat/selectors';
import type { ChatSession, ChatSessionRuntimeEndpointNode } from '@/stores/chat/types';

const openClawEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'default',
};

const matchaAgentEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'default',
};

const openClawRuntimeScopeKey = buildRuntimeEndpointKey(openClawEndpoint);
const matchaAgentRuntimeScopeKey = buildRuntimeEndpointKey(matchaAgentEndpoint);

function createIdentity(endpoint: RuntimeEndpointRef, agentId: string, sessionKey: string): SessionIdentity {
  return { endpoint, agentId, sessionKey };
}

function createSession(identity: SessionIdentity, label: string): ChatSession {
  return {
    key: buildSessionIdentityKey(identity),
    endpointSessionId: identity.sessionKey.split(':').at(-1),
    agentId: identity.agentId,
    sessionIdentity: identity,
    kind: identity.sessionKey.endsWith(':main') ? 'main' : 'session',
    preferred: identity.sessionKey.endsWith(':main'),
    label,
  };
}

function createEntry(session: ChatSession, title: string): AgentSessionsPaneSessionEntry {
  return {
    session,
    title,
    lastActivityAt: 1,
    historyStatus: 'ready',
  };
}

function createEndpointNode(endpoint: RuntimeEndpointRef, label: string): ChatSessionRuntimeEndpointNode {
  return {
    runtimeScopeKey: buildRuntimeEndpointKey(endpoint),
    endpoint,
    target: null,
    displayName: label,
    defaultAgentId: null,
    agents: [],
  };
}

describe('chat switchboard model', () => {
  it('keeps Agent, Team and Session separated with runtime only under Agents', () => {
    const agentIdentity = createIdentity(openClawEndpoint, 'main', 'agent:main:session-1');
    const teamIdentity = createIdentity(openClawEndpoint, 'leader', 'agent:leader:main');
    const agentSession = createSession(agentIdentity, 'Agent notes');
    const teamSession = createSession(teamIdentity, 'Team notes');

    const model = buildAgentSessionSwitchboardModel({
      currentConversation: null,
      selectedRuntimeEndpoint: createEndpointNode(openClawEndpoint, 'OpenClaw'),
      runtimeResults: [
        {
          runtimeScopeKey: openClawRuntimeScopeKey,
          runtimeLabel: 'OpenClaw',
          agents: [{ agentId: 'main', agentName: 'Main', preferredSessionKey: agentSession.key, sessionCount: 1 }],
        },
        {
          runtimeScopeKey: matchaAgentRuntimeScopeKey,
          runtimeLabel: 'Matcha Agent',
          agents: [{ agentId: 'matcha', agentName: 'Matcha', preferredSessionKey: null, sessionCount: 0 }],
        },
      ],
      teamResults: [{
        teamId: 'team-1',
        teamName: 'Team One',
        activeRunId: 'run-1',
        runs: [{
          runId: 'run-1',
          leader: { roleId: 'leader', agentId: 'leader', sessionIdentity: teamIdentity, endpointSessionId: 'main' },
          roles: [],
        }],
      }],
      sessionResults: {
        buckets: [{
          id: 'today',
          label: 'Today',
          defaultCollapsed: false,
          sessions: [createEntry(agentSession, 'Agent notes'), createEntry(teamSession, 'Team notes')],
        }],
        viewModelByKey: new Map([
          [agentSession.key, {
            title: 'Agent notes',
            meta: 'Main / 09/04 19:00',
            agentId: 'main',
            agentName: 'Main',
            deleteLabel: 'Delete Agent notes',
            renameLabel: 'Rename Agent notes',
            saveRenameLabel: 'Save Agent notes',
            cancelRenameLabel: 'Cancel Agent notes',
          }],
          [teamSession.key, {
            title: 'Team notes',
            meta: 'Leader / 09/04 19:00',
            agentId: 'leader',
            agentName: 'Leader',
            deleteLabel: 'Delete Team notes',
            renameLabel: 'Rename Team notes',
            saveRenameLabel: 'Save Team notes',
            cancelRenameLabel: 'Cancel Team notes',
          }],
        ]),
        agentSourceByKey: new Map([[agentSession.key, {
          runtimeScopeKey: openClawRuntimeScopeKey,
          runtimeLabel: 'OpenClaw',
          agentId: 'main',
          agentName: 'Main',
        }]]),
      },
    });

    expect(model.agentResults.map((runtime) => [runtime.runtimeLabel, runtime.agents.map((agent) => agent.agentId)])).toEqual([
      ['OpenClaw', ['main']],
      ['Matcha Agent', ['matcha']],
    ]);
    expect(model.teamResults.map((team) => team.teamName)).toEqual(['Team One']);
    expect(model.sessionResults[0]!.sessions.map((session) => session.source.kind)).toEqual(['agent', 'team']);
    expect(model.sessionResults[0]!.sessions[1]!.meta).toBe('Team One / leader');
  });

  it('keeps automation sessions in a separate read-only partition', () => {
    const agentIdentity = createIdentity(openClawEndpoint, 'main', 'agent:main:session-1');
    const automationIdentity = createIdentity(openClawEndpoint, 'main', 'agent:main:automation-1');
    const agentSession = createSession(agentIdentity, 'Agent notes');
    const automationSession: ChatSession = {
      ...createSession(automationIdentity, 'Automation result'),
      kind: 'automation' as never,
    };

    const model = buildAgentSessionSwitchboardModel({
      currentConversation: null,
      selectedRuntimeEndpoint: createEndpointNode(openClawEndpoint, 'OpenClaw'),
      runtimeResults: [{
        runtimeScopeKey: openClawRuntimeScopeKey,
        runtimeLabel: 'OpenClaw',
        agents: [{ agentId: 'main', agentName: 'Main', preferredSessionKey: agentSession.key, sessionCount: 1 }],
      }],
      teamResults: [],
      sessionResults: {
        buckets: [{
          id: 'today',
          label: 'Today',
          defaultCollapsed: false,
          sessions: [createEntry(agentSession, 'Agent notes'), createEntry(automationSession, 'Automation result')],
        }],
        viewModelByKey: new Map([
          [agentSession.key, {
            title: 'Agent notes',
            meta: 'Main / 09/04 19:00',
            agentId: 'main',
            agentName: 'Main',
            deleteLabel: 'Delete Agent notes',
            renameLabel: 'Rename Agent notes',
            saveRenameLabel: 'Save Agent notes',
            cancelRenameLabel: 'Cancel Agent notes',
          }],
          [automationSession.key, {
            title: 'Automation result',
            meta: 'Main / 09/04 19:01',
            agentId: 'main',
            agentName: 'Main',
            deleteLabel: 'Delete Automation result',
            renameLabel: 'Rename Automation result',
            saveRenameLabel: 'Save Automation result',
            cancelRenameLabel: 'Cancel Automation result',
          }],
        ]),
        agentSourceByKey: new Map(),
      },
    });

    expect(model.sessionResults[0]!.sessions.map((session) => session.session.key)).toEqual([agentSession.key]);
    expect(model.automationSessionResults[0]!.sessions.map((session) => session.session.key)).toEqual([automationSession.key]);
    expect(model.automationSessionResults[0]!.sessions[0]!.readOnly).toBe(true);
  });

  it('resolves current identity from a team role session', () => {
    const teamIdentity = createIdentity(openClawEndpoint, 'designer', 'agent:designer:main');

    const model = buildAgentSessionSwitchboardModel({
      currentConversation: {
        kind: 'session',
        runtimeScopeKey: openClawRuntimeScopeKey,
        endpoint: openClawEndpoint,
        agentId: 'designer',
        sessionRecordKey: buildSessionIdentityKey(teamIdentity),
        endpointSessionId: 'main',
        sessionIdentity: teamIdentity,
      },
      selectedRuntimeEndpoint: createEndpointNode(openClawEndpoint, 'OpenClaw'),
      runtimeResults: [{
        runtimeScopeKey: openClawRuntimeScopeKey,
        runtimeLabel: 'OpenClaw',
        agents: [{ agentId: 'designer', agentName: 'Designer', preferredSessionKey: null, sessionCount: 1 }],
      }],
      teamResults: [{
        teamId: 'team-1',
        teamName: 'Team One',
        activeRunId: 'run-1',
        runs: [{
          runId: 'run-1',
          leader: null,
          roles: [{ roleId: 'designer', agentId: 'designer', sessionIdentity: teamIdentity, endpointSessionId: 'main' }],
        }],
      }],
      sessionResults: {
        buckets: [],
        viewModelByKey: new Map(),
        agentSourceByKey: new Map(),
      },
    });

    expect(model.currentIdentity).toMatchObject({
      kind: 'team',
      teamId: 'team-1',
      runId: 'run-1',
      roleId: 'designer',
      agentId: 'designer',
    });
    expect(model.currentIdentityLabel).toBe('Team One / designer');
  });
});
