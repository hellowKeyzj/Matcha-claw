import type { RuntimeHostManager } from './runtime-host-manager';

export type RuntimeHostJobSnapshot = {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: string;
};

type RuntimeHostJobEventPayload = {
  id?: string;
  type?: string;
  status?: string;
  error?: string;
};

function isJobEventPayload(value: unknown): value is RuntimeHostJobEventPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asJobSnapshot(payload: RuntimeHostJobEventPayload): RuntimeHostJobSnapshot | null {
  if (typeof payload.id !== 'string' || typeof payload.type !== 'string') {
    return null;
  }
  if (payload.status !== 'queued'
    && payload.status !== 'running'
    && payload.status !== 'succeeded'
    && payload.status !== 'failed') {
    return null;
  }
  return {
    id: payload.id,
    type: payload.type,
    status: payload.status,
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  };
}

export async function waitForRuntimeHostJob(
  runtimeHost: RuntimeHostManager,
  jobId: string,
  options: {
    timeoutMs: number;
  },
): Promise<RuntimeHostJobSnapshot> {
  return await new Promise<RuntimeHostJobSnapshot>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalize = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      action();
    };

    const handleSnapshot = (snapshot: RuntimeHostJobSnapshot) => {
      if (snapshot.id !== jobId) {
        return;
      }
      if (snapshot.status === 'succeeded') {
        finalize(() => resolve(snapshot));
        return;
      }
      if (snapshot.status === 'failed') {
        finalize(() => reject(new Error(
          `Runtime Host job failed: ${snapshot.type} (${snapshot.error ?? 'unknown error'})`,
        )));
      }
    };

    unsubscribe = runtimeHost.onRuntimeJobEvent((eventName, payload) => {
      if (eventName !== 'runtime-job:done') {
        return;
      }
      if (!isJobEventPayload(payload)) {
        return;
      }
      const snapshot = asJobSnapshot(payload);
      if (snapshot) {
        handleSnapshot(snapshot);
      }
    });

    timeoutHandle = setTimeout(() => {
      finalize(() => reject(new Error(`Runtime Host job timed out: ${jobId}`)));
    }, options.timeoutMs);

    void runtimeHost.request<{ success?: boolean; job?: RuntimeHostJobSnapshot | null }>(
      'POST',
      '/api/runtime-host/jobs/get',
      { jobId },
      { timeoutMs: 8_000 },
    ).then((response) => {
      const job = response.data?.job ?? null;
      if (!job) {
        finalize(() => reject(new Error(`Runtime Host job not found: ${jobId}`)));
        return;
      }
      handleSnapshot(job);
    }).catch((error) => {
      finalize(() => reject(error));
    });
  });
}
