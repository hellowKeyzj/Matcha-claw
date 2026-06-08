import { createRuntimeHostCapabilityPayload, resolveRuntimeHostEndpoint } from './runtime-host-capabilities';
import type { RuntimeHostManager } from './runtime-host-manager';

export type RuntimeHostJobSnapshot<TResult = unknown> = {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result?: TResult;
  error?: string;
};

type RuntimeHostJobEventPayload = {
  id?: string;
  type?: string;
  status?: string;
  result?: unknown;
  error?: string;
};

function isJobEventPayload(value: unknown): value is RuntimeHostJobEventPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asJobSnapshot<TResult = unknown>(payload: RuntimeHostJobEventPayload): RuntimeHostJobSnapshot<TResult> | null {
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
    ...(payload.result !== undefined ? { result: payload.result as TResult } : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  };
}

export async function waitForRuntimeHostJob<TResult = unknown>(
  runtimeHost: RuntimeHostManager,
  jobId: string,
  options: {
    timeoutMs: number;
  },
): Promise<RuntimeHostJobSnapshot<TResult>> {
  return await new Promise<RuntimeHostJobSnapshot<TResult>>((resolve, reject) => {
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

    const handleSnapshot = (snapshot: RuntimeHostJobSnapshot<TResult>) => {
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
      const snapshot = asJobSnapshot<TResult>(payload);
      if (snapshot) {
        handleSnapshot(snapshot);
      }
    });

    timeoutHandle = setTimeout(() => {
      finalize(() => reject(new Error(`Runtime Host job timed out: ${jobId}`)));
    }, options.timeoutMs);

    void (async () => {
      const endpoint = await resolveRuntimeHostEndpoint(runtimeHost);
      return await runtimeHost.request<{ success?: boolean; job?: RuntimeHostJobSnapshot | null }>(
        'POST',
        '/api/capabilities/execute',
        await createRuntimeHostCapabilityPayload(runtimeHost, 'runtimeHost.jobGet', { jobId }, { endpoint }),
        { timeoutMs: 8_000 },
      );
    })().then((response) => {
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
