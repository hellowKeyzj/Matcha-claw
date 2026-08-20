import { describe, expect, it, vi } from 'vitest';
import { handleCronRoutes } from '../../electron/api/routes/cron';
import { createCronTransport } from '../../electron/main/runtime-host-delivery/transport/cron';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const createRequest = {
  id: 'scheduler.cron',
  operationId: 'cron.create',
  scope: { kind: 'runtime-instance', endpoint },
  target: { kind: 'cron-job' },
  input: {
    name: 'Morning reminder',
    agentId: 'main',
    message: 'Review the dashboard.',
    schedule: '0 9 * * *',
    delivery: { mode: 'none' },
    enabled: true,
  },
} as const;

const updateRequest = {
  id: 'scheduler.cron',
  operationId: 'cron.update',
  scope: { kind: 'runtime-instance', endpoint },
  target: { kind: 'cron-job', jobId: 'job-1' },
  input: { jobId: 'job-1', name: 'Updated reminder' },
} as const;

const job = {
  id: 'job-1',
  name: 'Morning reminder',
  agentId: 'main',
  message: 'Review the dashboard.',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  delivery: { mode: 'none' },
  enabled: true,
  createdAt: '1970-01-01T00:00:00.001Z',
  updatedAt: '1970-01-01T00:00:00.001Z',
};

const snapshot = {
  success: true,
  ready: true,
  refreshing: false,
  updatedAt: 1,
  error: null,
  jobs: [job],
};

describe('Electron Main cron transport', () => {
  it('signs and sends only the fixed Cron create DTO', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => job });
    const transport = createCronTransport({ verificationKey: 'public', signDecision }, 34_116, fetcher);

    await expect(transport.create(createRequest)).resolves.toEqual({ status: 200, body: job });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/cron/jobs/create',
      scope: 'cron:write',
      capability: 'scheduler.cron',
      subject: 'cron-crud',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34116/api/cron/jobs/create', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify(createRequest),
    }));
  });

  it('sends only a target-bound Cron update DTO', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => job });
    const transport = createCronTransport({ verificationKey: 'public', signDecision }, 34_116, fetcher);

    await expect(transport.update(updateRequest)).resolves.toEqual({ status: 200, body: job });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34116/api/cron/jobs/update', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(updateRequest),
    }));
  });

  it('fails closed before signing an update whose input job id differs from its target', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createCronTransport({ verificationKey: 'public', signDecision }, 34_116, fetcher);
    const mismatchedRequest = {
      ...updateRequest,
      input: { ...updateRequest.input, jobId: 'job-2' },
    };

    await expect(transport.update(mismatchedRequest)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Cron service is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends the list request as an exact empty object', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => snapshot });
    const transport = createCronTransport({ verificationKey: 'public', signDecision }, 34_116, fetcher);

    await expect(transport.list()).resolves.toEqual({ status: 200, body: snapshot });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/cron/jobs',
      scope: 'cron:write',
      capability: 'scheduler.cron',
      subject: 'cron-crud',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34116/api/cron/jobs', expect.objectContaining({
      body: '{}',
    }));
  });

  it.each([
    { ...createRequest, operationId: 'cron.update' },
    { ...createRequest, target: { kind: 'cron-job', jobId: 'unexpected' } },
    { ...createRequest, scope: { ...createRequest.scope, endpoint: { ...endpoint, runtimeInstanceId: 'remote' } } },
    { ...createRequest, privateToken: 'must-not-pass' },
  ])('fails closed before signing malformed create requests', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createCronTransport({ verificationKey: 'public', signDecision }, 34_116, fetcher);

    await expect(transport.create(invalid)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Cron service is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { ...snapshot, jobs: [{ ...job, private: 'secret' }] },
    { ...snapshot, jobs: [{ ...job, createdAt: '1970-01-01T00:00:00Z' }] },
    { ...snapshot, jobs: [{ ...job, updatedAt: 'not-a-timestamp' }] },
  ])('fails closed when a listed job violates the public DTO', async (invalidSnapshot) => {
    const transport = createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      vi.fn().mockResolvedValue({ status: 200, json: async () => invalidSnapshot }),
    );

    await expect(transport.list()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Cron service is unavailable' },
    });
  });

  it('preserves an ambiguous mutation outcome without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ success: false, error: 'Cron operation outcome is unknown' }),
    });
    const transport = createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      fetcher,
    );

    await expect(transport.create(createRequest)).resolves.toEqual({
      status: 409,
      body: { success: false, error: 'Cron operation outcome is unknown' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('redacts loopback failures as unavailable', async () => {
    const transport = createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      vi.fn().mockRejectedValue(new Error('private loopback detail')),
    );

    const response = await transport.create(createRequest);
    expect(response).toEqual({ status: 503, body: { success: false, error: 'Cron service is unavailable' } });
    expect(JSON.stringify(response)).not.toContain('private loopback detail');
  });

  it('signs and sends Cron session history through the fixed GET query contract', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-history-decision');
    const history = { messages: [{ role: 'assistant', content: 'Reply', timestamp: 1, id: 'message-1' }] };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => history });
    const transport = createCronTransport({ verificationKey: 'public', signDecision }, 34_116, fetcher);

    await expect(transport.history('agent:main:cron:job-1', 200)).resolves.toEqual({ status: 200, body: history });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/cron/session-history',
      scope: 'cron:history:read',
      capability: 'scheduler.cron.history',
      subject: 'cron-session-history',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34116/api/cron/session-history?sessionKey=agent%3Amain%3Acron%3Ajob-1&limit=200',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer signed-history-decision',
          'Content-Length': '0',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('fails closed for invalid history requests and malformed success bodies', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createCronTransport({ verificationKey: 'public', signDecision }, 34_116, fetcher);

    await expect(transport.history('agent:main:cron:job-1', 0)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Cron service is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    const malformed = createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ messages: [{ role: 'assistant', text: 'not Renderer DTO' }] }) }),
    );
    await expect(malformed.history('agent:main:cron:job-1', 200)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Cron service is unavailable' },
    });
  });

  it('preserves fixed Cron history failures without leaking loopback details', async () => {
    const failure = createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      vi.fn().mockResolvedValue({
        status: 422,
        json: async () => ({ success: false, error: 'Cron history was rejected' }),
      }),
    );
    await expect(failure.history('agent:main:cron:job-1', 200)).resolves.toEqual({
      status: 422,
      body: { success: false, error: 'Cron history was rejected' },
    });

    const unavailable = await createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      vi.fn().mockRejectedValue(new Error('private history detail')),
    ).history('agent:main:cron:job-1', 200);
    expect(unavailable).toEqual({ status: 503, body: { success: false, error: 'Cron service is unavailable' } });
    expect(JSON.stringify(unavailable)).not.toContain('private history detail');
  });

  it('passes through the Cron history deadline response without retrying or folding it', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 504,
      json: async () => ({ success: false, error: 'Cron service deadline exceeded' }),
    });
    const transport = createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      fetcher,
    );

    await expect(transport.history('agent:main:cron:job-1', 200)).resolves.toEqual({
      status: 504,
      body: { success: false, error: 'Cron service deadline exceeded' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('handles the legacy Cron session-history GET and clamps the limit', async () => {
    const history = vi.fn().mockResolvedValue({
      status: 200,
      body: { messages: [{ role: 'assistant', content: 'Reply' }] },
    });
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    const handled = await handleCronRoutes(
      { method: 'GET' } as never,
      response as never,
      new URL('http://127.0.0.1/api/cron/session-history?sessionKey=agent%3Amain%3Acron%3Ajob-1&limit=999'),
      { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(), history },
    );

    expect(handled).toBe(true);
    expect(history).toHaveBeenCalledWith('agent:main:cron:job-1', 200);
    expect(response.statusCode).toBe(200);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ messages: [{ role: 'assistant', content: 'Reply' }] }));
  });

  it('rejects an invalid legacy Cron session key before calling transport', async () => {
    const history = vi.fn();
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    const handled = await handleCronRoutes(
      { method: 'GET' } as never,
      response as never,
      new URL('http://127.0.0.1/api/cron/session-history?sessionKey=agent%3Amain%3Achat%3Ajob-1'),
      { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(), history },
    );

    expect(handled).toBe(true);
    expect(history).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(400);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({
      success: false,
      error: 'Invalid cron sessionKey: agent:main:chat:job-1',
    }));
  });

  it('keeps historical trigger, fire, and delivery-repair operations out of fixed Cron Delivery', () => {
    const transport = createCronTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_116,
      vi.fn(),
    );

    expect(Object.keys(transport)).toEqual(['list', 'create', 'update', 'remove', 'toggle', 'history']);
    expect('trigger' in transport).toBe(false);
    expect('fire' in transport).toBe(false);
    expect('repairDelivery' in transport).toBe(false);
  });
});
