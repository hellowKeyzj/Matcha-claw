import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@/types/cron';

const hostApiFetchMock = vi.fn();
const subscribeHostEventMock = vi.fn();
const cronEventUnsubscribeMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostApiFetchDecoded: async (path: string, decode: (value: unknown) => unknown, init: unknown) => decode(await hostApiFetchMock(path, init)),
  resolveSingleCapabilityScope: () => ({ kind: 'runtime-instance', endpoint: {
    kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local',
  } }),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
  subscribeBrowserRecovery: () => () => {},
}));

const receipt = { callId: 'a'.repeat(32), accepted: true };

function mockMutation(command: 'create' | 'update' | 'delete', result: CronJob | { removed: boolean }, jobId?: string): void {
  hostApiFetchMock.mockResolvedValueOnce(receipt).mockResolvedValueOnce({
    callId: receipt.callId, module: 'cron', command, status: 'succeeded', start: 1, end: 2, revision: 3,
    detail: { outcome: 'applied', ...(command === 'delete' ? { jobId, removed: (result as { removed: boolean }).removed }
      : { jobId: (result as CronJob).id }) },
  }).mockResolvedValueOnce(result);
}

function wireJob(id: string, updatedAtMs = 1): CronJob {
  return projectedJob(id, updatedAtMs);
}

function projectedJob(id: string, updatedAtMs = 1): CronJob {
  return {
    id,
    name: `job-${id}`,
    agentId: 'main',
    message: 'hello',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    delivery: { mode: 'none' },
    enabled: true,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

describe('cron session utils', () => {
  it('keeps cron session classification local and exposes no history route', async () => {
    const cronSessionUtils = await import('@/stores/chat/cron-session-utils');

    expect(cronSessionUtils.parseCronSessionKey('agent::cron:job-1')).toBeNull();
    expect(cronSessionUtils.isCronSessionKey('agent::cron:job-1')).toBe(false);
    expect(cronSessionUtils.parseCronSessionKey('agent:test:cron:job-1')).toEqual({ agentId: 'test', jobId: 'job-1' });
    expect(cronSessionUtils.parseCronSessionKey('agent:test:cron:job-1:run:run-1')).toEqual({ agentId: 'test', jobId: 'job-1', runSessionId: 'run-1' });
    expect(cronSessionUtils.getCronSessionBaseKey('agent:test:cron:job-1:run:run-1')).toBe('agent:test:cron:job-1');
    expect(cronSessionUtils.sessionKeysAreEquivalent(
      'agent:test:cron:job-1',
      'agent:test:cron:job-1:run:run-1',
    )).toBe(true);
    expect(cronSessionUtils.sessionKeysAreEquivalent(
      'agent:test:cron:job-1:run:run-1',
      'agent:test:cron:job-2:run:run-1',
    )).toBe(false);
    expect(cronSessionUtils.sessionKeysAreEquivalent(
      'agent:test:main',
      'agent:test:main:run:run-1',
    )).toBe(false);
  });
});

describe('cron store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    subscribeHostEventMock.mockReset();
    cronEventUnsubscribeMock.mockReset();
    subscribeHostEventMock.mockReturnValue(cronEventUnsubscribeMock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and projects the Rust-owned cron list response', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ jobs: [wireJob('job-1')] });

    const { useCronStore } = await import('@/stores/cron');
    await useCronStore.getState().fetchJobs();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/cron/jobs');
    expect(useCronStore.getState()).toMatchObject({
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      error: null,
      jobs: [projectedJob('job-1')],
    });
  });

  it('preserves an existing snapshot if the final list transport fails', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ jobs: [wireJob('job-2')] })
      .mockRejectedValueOnce(new Error('Cron service is unavailable'));

    const { useCronStore } = await import('@/stores/cron');
    await useCronStore.getState().fetchJobs();
    await useCronStore.getState().fetchJobs();

    expect(useCronStore.getState()).toMatchObject({
      snapshotReady: true,
      jobs: [projectedJob('job-2')],
      error: 'Cron service is unavailable',
    });
  });

  it('deduplicates concurrent list calls', async () => {
    let resolveFetch: ((value: { jobs: ReturnType<typeof wireJob>[] }) => void) | undefined;
    hostApiFetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    const { useCronStore } = await import('@/stores/cron');
    const first = useCronStore.getState().fetchJobs();
    const second = useCronStore.getState().fetchJobs();
    resolveFetch?.({ jobs: [wireJob('job-3')] });
    await Promise.all([first, second]);

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(useCronStore.getState().jobs).toEqual([projectedJob('job-3')]);
  });

  it('creates through the typed Cron route and stores the sealed Rust projection', async () => {
    const createdJob = {
      ...projectedJob('job-create', 8),
      agentId: 'agent-alpha',
      enabled: false,
    };
    mockMutation('create', createdJob);

    const { useCronStore } = await import('@/stores/cron');
    const result = await useCronStore.getState().createJob({
      name: createdJob.name,
      agentId: createdJob.agentId,
      message: createdJob.message,
      schedule: '0 9 * * *',
      enabled: createdJob.enabled,
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/cron/jobs/create', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        id: 'scheduler.cron',
        operationId: 'cron.create',
        scope: { kind: 'runtime-instance', endpoint: {
          kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local',
        } },
        target: { kind: 'cron-job' },
        input: {
          name: createdJob.name,
          agentId: createdJob.agentId,
          message: createdJob.message,
          schedule: '0 9 * * *',
          delivery: { mode: 'none' },
          enabled: false,
        },
      }),
    }));
    expect(hostApiFetchMock).toHaveBeenLastCalledWith('/api/cron/results', {
      method: 'POST', body: JSON.stringify({ callId: receipt.callId, command: 'create' }),
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/cron/jobs');
    expect(result).toEqual(createdJob);
    expect(useCronStore.getState().jobs).toEqual([createdJob]);
  });

  it('uses the delete response as the only source of local removal', async () => {
    const job = projectedJob('job-delete');
    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([job]);

    mockMutation('delete', { removed: false }, job.id);
    await useCronStore.getState().deleteJob(job.id);
    expect(useCronStore.getState().jobs).toEqual([job]);

    mockMutation('delete', { removed: true }, job.id);
    await useCronStore.getState().deleteJob(job.id);
    expect(useCronStore.getState().jobs).toEqual([]);
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/cron/jobs/delete', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"operationId":"cron.delete"'),
    }));
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(4, '/api/cron/jobs/delete', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"input":{"jobId":"job-delete"}'),
    }));
  });

  it('replaces a toggled job with the sealed Rust response', async () => {
    const job = projectedJob('job-toggle');
    const toggledJob = { ...job, enabled: false, updatedAt: new Date(9).toISOString() };
    mockMutation('update', toggledJob);

    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([job]);
    await useCronStore.getState().toggleJob(job.id, false);

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/cron/jobs/toggle', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"operationId":"cron.toggle"'),
    }));
    expect(hostApiFetchMock).toHaveBeenLastCalledWith('/api/cron/results', {
      method: 'POST', body: JSON.stringify({ callId: receipt.callId, command: 'update', jobId: job.id }),
    });
    expect(useCronStore.getState().jobs).toEqual([toggledJob]);
  });

  it('sends a closed update DTO and tracks the job mutation lifetime', async () => {
    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([projectedJob('job-4')]);
    let resolveUpdate: ((value: unknown) => void) | undefined;
    hostApiFetchMock.mockResolvedValueOnce(receipt)
      .mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }))
      .mockResolvedValueOnce({ ...wireJob('job-4'), name: 'updated' });

    const update = useCronStore.getState().updateJob('job-4', { name: 'updated' });
    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/calls/get', expect.anything()));
    expect(useCronStore.getState().mutatingByJobId['job-4']).toBe(1);
    resolveUpdate?.({ callId: receipt.callId, module: 'cron', command: 'update', status: 'succeeded',
      start: 1, end: 2, revision: 3, detail: { jobId: 'job-4', outcome: 'applied' } });
    await update;

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/cron/jobs/update', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        id: 'scheduler.cron',
        operationId: 'cron.update',
        scope: { kind: 'runtime-instance', endpoint: {
          kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local',
        } },
        target: { kind: 'cron-job', jobId: 'job-4' },
        input: { jobId: 'job-4', name: 'updated' },
      }),
    }));
    expect(useCronStore.getState()).toMatchObject({
      mutating: false,
      mutatingByJobId: {},
      jobs: [{ ...projectedJob('job-4'), name: 'updated' }],
    });
  });

  it('does not collapse an ambiguous mutation into a retry or local success', async () => {
    hostApiFetchMock.mockResolvedValueOnce(receipt).mockResolvedValueOnce({
      callId: receipt.callId, module: 'cron', command: 'update', status: 'unknown', start: 1, end: 2, revision: 3,
      detail: { jobId: 'job-5', outcome: 'outcome-unknown' },
    });
    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([projectedJob('job-5')]);

    await expect(useCronStore.getState().toggleJob('job-5', false)).rejects.toThrow('Cron operation outcome is unknown');

    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/cron/results', expect.anything());
    expect(useCronStore.getState()).toMatchObject({
      mutating: false,
      jobs: [projectedJob('job-5')],
    });
  });

  it('keeps admission separate from the terminal Cron event', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/capabilities/execute') return { success: true, result: { outcome: 'accepted' } };
      throw new Error(`unexpected path: ${path}`);
    });
    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([projectedJob('job-6')]);

    await expect(useCronStore.getState().triggerJob('job-6')).resolves.toEqual({ ran: true });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"operationId":"cron.trigger"'),
    }));
    expect(useCronStore.getState().jobs).toEqual([projectedJob('job-6')]);
  });

  it('maps skipped manual trigger reasons to callback result', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true, result: { outcome: 'skipped', reason: 'disabled' } });

    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([projectedJob('job-skipped')]);

    await expect(useCronStore.getState().triggerJob('job-skipped')).resolves.toEqual({
      ran: false,
      reason: 'disabled',
    });
    expect(useCronStore.getState()).toMatchObject({ mutating: false, mutatingByJobId: {} });
  });

  it('maps a skipped manual trigger without reason to the frozen already-running callback result', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true, result: { outcome: 'skipped' } });

    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([projectedJob('job-skipped')]);

    await expect(useCronStore.getState().triggerJob('job-skipped')).resolves.toEqual({
      ran: false,
      reason: 'already-running',
    });
  });

  it.each([
    ['failed', 'Cron trigger was rejected'],
    ['outcome-unknown', 'Cron trigger outcome is unknown'],
  ] as const)('rejects a %s manual trigger outcome without local success', async (outcome, message) => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true, result: { outcome } });

    const { useCronStore } = await import('@/stores/cron');
    const job = projectedJob(`job-${outcome}`);
    useCronStore.getState().setJobs([job]);

    await expect(useCronStore.getState().triggerJob(job.id)).rejects.toThrow(message);
    expect(useCronStore.getState()).toMatchObject({
      mutating: false,
      mutatingByJobId: {},
      jobs: [job],
    });
  });

  it('refreshes the Rust-owned snapshot for matching terminal Cron events', async () => {
    const { useCronStore, initCronEvents } = await import('@/stores/cron');
    const refreshedJobs = [
      { ...projectedJob('job-success'), lastRun: { time: new Date(3).toISOString(), success: true } },
      { ...projectedJob('job-failure'), lastRun: {
        time: new Date(4).toISOString(),
        success: false,
        error: 'Cron execution outcome is unknown',
      } },
    ];
    useCronStore.getState().setJobs([
      { ...projectedJob('job-success'), runningAt: new Date(2).toISOString() },
      { ...projectedJob('job-failure'), runningAt: new Date(2).toISOString() },
    ]);
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      ready: true,
      refreshing: false,
      updatedAt: 5,
      error: null,
      jobs: refreshedJobs,
    });
    const unsubscribe = initCronEvents();
    const handler = subscribeHostEventMock.mock.calls.at(-1)?.[1] as ((event: unknown) => void);
    expect(handler).toBeTypeOf('function');

    handler({ jobId: 'job-success', runId: 'job-success-run', status: 'succeeded' });
    await waitFor(() => expect(useCronStore.getState().jobs).toEqual(refreshedJobs));

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/cron/jobs');
    expect(useCronStore.getState().jobs).toEqual(refreshedJobs);
    unsubscribe();
    expect(cronEventUnsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed Renderer events without mutating the snapshot', async () => {
    const { useCronStore, initCronEvents } = await import('@/stores/cron');
    const job = { ...projectedJob('job-7'), runningAt: new Date(2).toISOString() };
    useCronStore.getState().setJobs([job]);
    initCronEvents();
    const handler = subscribeHostEventMock.mock.calls.at(-1)?.[1] as ((event: unknown) => void);

    for (const invalid of [
      { jobId: '', runId: 'foreign-run', status: 'failed' },
      { jobId: 'job-7', runId: 'foreign/run', status: 'failed' },
      { jobId: 'job-7', runId: 'foreign-run', status: 'success' },
      { jobId: 'job-7', runId: 'foreign-run', status: 'failed', payload: {} },
    ]) {
      handler(invalid);
    }

    expect(useCronStore.getState().jobs).toEqual([job]);
  });

  it('fences an old cleanup from disposing a replacement subscription', async () => {
    const { initCronEvents } = await import('@/stores/cron');
    const firstCleanup = initCronEvents();
    const secondCleanup = initCronEvents();

    firstCleanup();
    expect(cronEventUnsubscribeMock).toHaveBeenCalledTimes(1);
    secondCleanup();
    expect(cronEventUnsubscribeMock).toHaveBeenCalledTimes(2);
  });
});
