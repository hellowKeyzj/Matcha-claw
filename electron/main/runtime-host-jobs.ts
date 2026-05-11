import type { RuntimeHostHttpClient } from './runtime-host-client';

export type RuntimeHostJobSnapshot = {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: string;
};

export async function waitForRuntimeHostJob(
  runtimeHostClient: Pick<RuntimeHostHttpClient, 'request'>,
  jobId: string,
  options: {
    timeoutMs: number;
    intervalMs: number;
  },
): Promise<RuntimeHostJobSnapshot> {
  const startedAt = Date.now();
  let lastJob: RuntimeHostJobSnapshot | null = null;
  while (Date.now() - startedAt < options.timeoutMs) {
    const response = await runtimeHostClient.request<{
      success?: boolean;
      job?: RuntimeHostJobSnapshot | null;
    }>('POST', '/api/runtime-host/jobs/get', { jobId }, {
      timeoutMs: 8_000,
    });
    const job = response.data?.job ?? null;
    if (!job) {
      throw new Error(`Runtime Host job not found: ${jobId}`);
    }
    lastJob = job;
    if (job.status === 'succeeded') {
      return job;
    }
    if (job.status === 'failed') {
      throw new Error(`Runtime Host job failed: ${job.type} (${job.error ?? 'unknown error'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  throw new Error(`Runtime Host job timed out: ${jobId} (${lastJob?.status ?? 'unknown'})`);
}
