import { describe, expect, it } from 'vitest';
import { createSessionHydrationJobPort } from '../../runtime-host/application/sessions/session-hydration-jobs';
import type { RuntimeAddress } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
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

const claudeCodeAddress: RuntimeAddress = {
  kind: 'protocol-connector',
  capabilityId: 'session.prompt',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
  agentId: 'default',
  sessionKey: 'shared-session',
};

const hermesAddress: RuntimeAddress = {
  ...claudeCodeAddress,
  endpointId: 'hermes',
};

describe('session hydration jobs', () => {
  it('dedupe key includes RuntimeAddress so equal session keys on different endpoints do not collide', () => {
    const { tasks, submissions } = createTasksRecorder();
    const jobs = createSessionHydrationJobPort(tasks);

    jobs.submitSessionHydration({
      sessionKey: 'shared-session',
      runtimeAddress: claudeCodeAddress,
      snapshot: { kind: 'state' },
    });
    jobs.submitSessionHydration({
      sessionKey: 'shared-session',
      runtimeAddress: hermesAddress,
      snapshot: { kind: 'state' },
    });

    expect(submissions.map((submission) => submission.dedupeKey)).toEqual([
      'sessions.hydrateTimeline:session.prompt:protocol-connector:acp:acp:claude-code:default:model-provider::shared-session:state',
      'sessions.hydrateTimeline:session.prompt:protocol-connector:acp:acp:hermes:default:model-provider::shared-session:state',
    ]);
  });
});
