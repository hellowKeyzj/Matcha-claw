import { describe, expect, it } from 'vitest';
import { buildExecutionGraphItemsFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import type { CanonicalSessionEvent } from '../../runtime-host/application/sessions/canonical/canonical-events';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity';
import { createOpenClawTestRuntimeContext } from './helpers/runtime-address-fixtures';

function base(eventId: string): Pick<CanonicalSessionEvent, 'eventId' | 'protocolId' | 'runtimeEndpointId' | 'source' | 'sessionId' | 'runId' | 'laneKey' | 'origin'> {
  return {
    eventId,
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    source: 'live',
    sessionId: 'agent:main:main',
    runId: 'run-1',
    laneKey: 'main',
    origin: {
      runtimeEventType: 'test',
      runtimeIds: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
      },
    },
  };
}

describe('ACP execution graph projection', () => {
  it('projects team completion events with completed and running tool steps', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('tool-read-start'),
      type: 'tool_call',
      toolCallId: 'tool-read',
      name: 'read',
      input: { filePath: '/tmp/a.md' },
    }, {
      ...base('tool-read-result'),
      type: 'tool_result',
      toolCallId: 'tool-read',
      name: 'read',
      output: 'done',
      isError: false,
    }, {
      ...base('tool-grep-start'),
      type: 'tool_call',
      toolCallId: 'tool-grep',
      name: 'grep',
      input: { pattern: 'TODO' },
    }, {
      ...base('team-1'),
      source: 'replay',
      type: 'team',
      event: {
        kind: 'task_completion',
        source: 'subagent',
        childSessionKey: 'agent:coder:main',
        childAgentId: 'coder',
      },
    }]);

    const [graph] = buildExecutionGraphItemsFromCanonicalState(state);

    expect(graph).toMatchObject({
      kind: 'execution-graph',
      childSessionKey: 'agent:coder:main',
      childAgentId: 'coder',
      steps: [
        expect.objectContaining({ id: 'tool-read', label: 'read', status: 'completed' }),
        expect.objectContaining({ id: 'tool-grep', label: 'grep', status: 'running' }),
      ],
    });
  });

  it('projects tool result errors into graph steps', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('tool-read-start'),
      type: 'tool_call',
      toolCallId: 'tool-read',
      name: 'read',
      input: { filePath: '/tmp/a.md' },
    }, {
      ...base('tool-read-result'),
      type: 'tool_result',
      toolCallId: 'tool-read',
      name: 'read',
      output: 'Permission denied',
      outputText: 'Permission denied',
      isError: true,
    }, {
      ...base('team-1'),
      source: 'replay',
      type: 'team',
      event: {
        kind: 'task_completion',
        source: 'subagent',
        childSessionKey: 'agent:coder:main',
      },
    }]);

    const [graph] = buildExecutionGraphItemsFromCanonicalState(state);

    expect(graph?.steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        status: 'error',
        detail: 'Permission denied',
      }),
    ]);
  });

  it('uses task completion turnKey to collect graph steps when the team event has no runId', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('tool-read-start'),
      type: 'tool_call',
      toolCallId: 'tool-read',
      name: 'read',
      input: { filePath: '/tmp/a.md' },
    }, {
      ...base('tool-read-result'),
      type: 'tool_result',
      toolCallId: 'tool-read',
      name: 'read',
      output: 'done',
      isError: false,
    }, {
      ...base('team-1'),
      runId: undefined,
      source: 'replay',
      type: 'team',
      event: {
        kind: 'task_completion',
        source: 'subagent',
        childSessionKey: 'agent:coder:main',
        turnKey: 'run-1',
      },
    }]);

    const [graph] = buildExecutionGraphItemsFromCanonicalState(state);

    expect(graph).toMatchObject({
      runId: 'run-1',
      turnKey: 'run-1',
      steps: [
        expect.objectContaining({ id: 'tool-read', label: 'read', status: 'completed' }),
      ],
    });
  });
});
