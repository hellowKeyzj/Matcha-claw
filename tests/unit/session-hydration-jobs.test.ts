import { describe, expect, it } from 'vitest';
import { createSessionHydrationJobPort } from '../../runtime-host/application/sessions/session-hydration-jobs';
import { buildSessionIdentityKey, type SessionIdentity } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeLongTaskSubmissionPort } from '../../runtime-host/application/runtime-host/runtime-task-ports';

function createTasksRecorder() {
  const submissions: Array<{ type: string; payload: unknown; dedupeKey?: string }> = [];
  const tasks: RuntimeLongTaskSubmissionPort = {
    submit: (type, payload, options) => {
      submissions.push({ type, payload, dedupeKey: options?.dedupeKey });
      return {
        success: true,
        job: {
          id: `job-${submissions.length}`,
          type,
        },
      };
    },
  };
  return { tasks, submissions };
}

const claudeCodeSessionIdentity: SessionIdentity = {
  endpoint: {
    kind: 'protocol-connector',
    protocolId: 'acp',
    connectorId: 'acp',
    endpointId: 'claude-code',
  },
  agentId: 'default',
  sessionKey: 'shared-session',
};

const hermesSessionIdentity: SessionIdentity = {
  ...claudeCodeSessionIdentity,
  endpoint: {
    ...claudeCodeSessionIdentity.endpoint,
    endpointId: 'hermes',
  },
};

describe('session hydration jobs', () => {
  it('dedupe key includes SessionIdentity so equal session keys on different endpoints do not collide', () => {
    const { tasks, submissions } = createTasksRecorder();
    const jobs = createSessionHydrationJobPort(tasks);

    jobs.submitSessionHydration({
      sessionKey: 'shared-session',
      sessionIdentity: claudeCodeSessionIdentity,
      snapshot: { kind: 'state' },
    });
    jobs.submitSessionHydration({
      sessionKey: 'shared-session',
      sessionIdentity: hermesSessionIdentity,
      snapshot: { kind: 'state' },
    });

    expect(submissions.map((submission) => submission.dedupeKey)).toEqual([
      `sessions.hydrateTimeline:${buildSessionIdentityKey(claudeCodeSessionIdentity)}:state`,
      `sessions.hydrateTimeline:${buildSessionIdentityKey(hermesSessionIdentity)}:state`,
    ]);
  });
});
