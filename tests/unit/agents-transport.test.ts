import { describe, expect, it, vi } from 'vitest';
import { createAgentsTransport } from '../../electron/main/runtime-host-delivery/products/agents';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const createRequest = {
  id: 'subagent.management',
  operationId: 'subagents.create',
  scope: { kind: 'agent', endpoint, agentId: 'main' },
  target: { kind: 'subagent' },
  input: {
    kind: 'create',
    endpoint,
    name: 'Writer',
    workspace: 'E:/workspace/writer',
    model: null,
  },
} as const;

const created = {
  success: true,
  kind: 'created',
  agent: { id: 'writer', name: 'Writer', model: null },
};

describe('Electron Main agents transport', () => {
  it('signs and sends only the fixed agents create DTO', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => created });
    const transport = createAgentsTransport({ verificationKey: 'public', signDecision }, 34_225, fetcher);

    await expect(transport.execute(createRequest)).resolves.toEqual({ status: 200, body: created });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/subagents/agents',
      scope: 'subagents:manage',
      capability: 'subagent.management',
      subject: 'subagents',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34225/api/subagents/agents', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify(createRequest),
    }));
  });

  it.each([
    { ...createRequest, operationId: 'subagents.files.get' },
    { ...createRequest, input: { ...createRequest.input, workspaceInitialization: 'emptyWorkspace' } },
    { ...createRequest, input: { ...createRequest.input, endpoint: { ...endpoint, runtimeInstanceId: 'remote' } } },
    { ...createRequest, privateToken: 'must-not-pass' },
  ])('fails closed before signing malformed requests', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createAgentsTransport({ verificationKey: 'public', signDecision }, 34_225, fetcher);

    await expect(transport.execute(invalid)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when a public file DTO leaks its native path', async () => {
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          file: { name: 'AGENTS.md', missing: false, size: 5, updatedAtMs: 1, content: 'rules', path: '/private/path' },
        }),
      }),
    );
    const request = {
      ...createRequest,
      operationId: 'subagents.files.get' as const,
      target: { kind: 'subagent' as const, subagentId: 'writer' },
      input: { kind: 'filesGet' as const, endpoint, agentId: 'writer', name: 'AGENTS.md' },
    };

    await expect(transport.execute(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
  });

  it('delivers only the fixed draft wait receipt and rejects private native fields', async () => {
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.draft.wait',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: {
        kind: 'draftWait',
        endpoint,
        agentId: 'writer',
        runId: 'run-123',
        waitSliceMs: 30_000,
        rpcTimeoutBufferMs: 10_000,
      },
    } as const;
    const completed = { success: true, status: 'completed', startedAt: 1, endedAt: 2 };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => completed });
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      fetcher,
    );

    await expect(transport.execute(request)).resolves.toEqual({ status: 200, body: completed });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const leaking = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ ...completed, error: 'private native detail' }),
      }),
    );
    await expect(leaking.execute(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });

    const invalidTimestamps = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ ...completed, startedAt: 2, endedAt: 1 }),
      }),
    );
    await expect(invalidTimestamps.execute(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
  });

  it('rejects malformed draft wait identity and bounds before signing', async () => {
    const signDecision = vi.fn();
    const transport = createAgentsTransport({ verificationKey: 'public', signDecision }, 34_225, vi.fn());
    await expect(transport.execute({
      id: 'subagent.management',
      operationId: 'subagents.draft.wait',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: {
        kind: 'draftWait', endpoint, agentId: 'other', runId: 'run-123', waitSliceMs: 999, rpcTimeoutBufferMs: 10_001,
      },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
  });

  it('delivers the global configuration display without private workspace data', async () => {
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.displayConfig.get',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'agent', agentId: 'main' },
      input: { kind: 'displayConfiguration', endpoint },
    } as const;
    const body = {
      success: true,
      defaults: { model: null, skills: ['research'] },
      agents: [{ id: 'writer', description: 'Writes copy', model: { primary: 'provider/one', fallbacks: [] }, skills: ['research'] }],
    };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => body });
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      fetcher,
    );

    await expect(transport.execute(request)).resolves.toEqual({ status: 200, body });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects configuration responses that expose private workspace data', async () => {
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.displayConfig.get',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'agent', agentId: 'main' },
      input: { kind: 'displayConfiguration', endpoint },
    } as const;
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          defaults: { workspace: 'C:/private', model: null, skills: [] },
          agents: [],
        }),
      }),
    );

    await expect(transport.execute(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
  });

  it.each([
    ['subagents.description.set', { kind: 'setDescription', endpoint, agentId: 'writer', description: null }],
    ['subagents.model.set', { kind: 'setConfigurationModel', endpoint, agentId: 'writer', model: null }],
    ['subagents.skills.set', { kind: 'setSkills', endpoint, agentId: 'writer', skills: [] }],
  ] as const)('preserves rejection for %s', async (operationId, input) => {
    const request = {
      id: 'subagent.management',
      operationId,
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input,
    };
    const fetcher = vi.fn().mockResolvedValue({
      status: 422,
      json: async () => ({ success: false, error: 'Subagent request was rejected' }),
    });
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      fetcher,
    );

    await expect(transport.execute(request)).resolves.toEqual({
      status: 422,
      body: { success: false, error: 'Subagent request was rejected' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves OutcomeUnknown without retrying a configuration mutation', async () => {
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.model.set',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: { kind: 'setConfigurationModel', endpoint, agentId: 'writer', model: null },
    } as const;
    const fetcher = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ success: false, error: 'Subagent mutation outcome is unknown' }),
    });
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      fetcher,
    );

    await expect(transport.execute(request)).resolves.toEqual({
      status: 409,
      body: { success: false, error: 'Subagent mutation outcome is unknown' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('delivers bare typed skill configuration views and rejects wrapped read receipts', async () => {
    const request = {
      id: 'subagent.skills',
      operationId: 'subagentSkills.get',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: { agentId: 'writer' },
    } as const;
    const view = {
      agentId: 'writer', support: { supportType: 'supported' }, selectionMode: 'inheritsDefaultSkills',
      explicitSkillKeys: [], inheritedDefaultSkillKeys: [], effectiveSkillKeys: [], options: [], revision: 'revision-1', updatedAt: null,
    };
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({ status: 200, json: async () => view }),
    );
    await expect(transport.execute(request)).resolves.toEqual({ status: 200, body: view });

    const wrapped = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ success: true, resultType: 'view', view }) }),
    );
    await expect(wrapped.execute(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
  });

  it('delivers only bare typed tool configuration views and rejects catalog leaks', async () => {
    const request = {
      id: 'subagent.tools',
      operationId: 'subagentTools.get',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: { agentId: 'writer' },
    } as const;
    const view = {
      agentId: 'writer', support: { supportType: 'supported' }, selectionMode: 'inheritsDefaultTools', toolPolicy: null,
      toolProfiles: [], toolGroups: [], toolOptions: [], revision: 'revision-1', updatedAt: null,
    };
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({ status: 200, json: async () => view }),
    );
    await expect(transport.execute(request)).resolves.toEqual({ status: 200, body: view });

    const leaking = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ ...view, raw: 'private-config' }) }),
    );
    await expect(leaking.execute(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });

    const wrapped = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ success: true, resultType: 'view', view }) }),
    );
    await expect(wrapped.execute(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
  });

  it('binds typed configuration mutations to the target and preserves stale results', async () => {
    const request = {
      id: 'subagent.skills',
      operationId: 'subagentSkills.set',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: {
        agentId: 'writer', revision: 'revision-1',
        selection: { selectionType: 'inheritDefaultSkills' },
      },
    } as const;
    const view = {
      agentId: 'writer', support: { supportType: 'supported' }, selectionMode: 'inheritsDefaultSkills',
      explicitSkillKeys: [], inheritedDefaultSkillKeys: [], effectiveSkillKeys: [], options: [], revision: 'revision-2', updatedAt: null,
    };
    const body = { success: true, resultType: 'staleRevision', latestView: view };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => body });
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' }, 34_225, fetcher,
    );
    await expect(transport.execute(request)).resolves.toEqual({ status: 200, body });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await expect(transport.execute({ ...request, input: { ...request.input, agentId: 'other' } })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
  });

  it('preserves typed configuration rejection and outcome unknown HTTP status', async () => {
    const request = {
      id: 'subagent.skills',
      operationId: 'subagentSkills.set',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: {
        agentId: 'writer', revision: 'revision-1',
        selection: { selectionType: 'inheritDefaultSkills' },
      },
    } as const;
    for (const [status, error] of [
      [422, 'Subagent request was rejected'],
      [409, 'Subagent mutation outcome is unknown'],
    ] as const) {
      const transport = createAgentsTransport(
        { verificationKey: 'public', signDecision: () => 'signed-decision' },
        34_225,
        vi.fn().mockResolvedValue({ status, json: async () => ({ success: false, error }) }),
      );
      await expect(transport.execute(request)).resolves.toEqual({ status, body: { success: false, error } });
    }
  });

  it('accepts typed skill invalid keys and updated receipts only', async () => {
    const request = {
      id: 'subagent.skills',
      operationId: 'subagentSkills.set',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: {
        agentId: 'writer', revision: 'revision-1',
        selection: { selectionType: 'inheritDefaultSkills' },
      },
    } as const;
    const invalid = { success: true, resultType: 'invalidSkillKeys', unknownSkillKeys: ['missing'], nonCanonicalSkillKeys: [' Research '] };
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' }, 34_225,
      vi.fn().mockResolvedValue({ status: 200, json: async () => invalid }),
    );
    await expect(transport.execute(request)).resolves.toEqual({ status: 200, body: invalid });
  });

  it('redacts loopback failures as unavailable', async () => {
    const transport = createAgentsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_225,
      vi.fn().mockRejectedValue(new Error('private loopback detail')),
    );

    const response = await transport.execute(createRequest);
    expect(response).toEqual({ status: 503, body: { success: false, error: 'Subagent management is unavailable' } });
    expect(JSON.stringify(response)).not.toContain('private loopback detail');
  });
});
