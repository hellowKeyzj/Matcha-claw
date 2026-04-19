import { normalizeRoutePath } from '../common/http';

interface SyncExecutionStateMutations {
  setPluginExecutionEnabled: (enabled: boolean) => void;
  setEnabledPluginIds: (pluginIds: string[]) => void;
}

interface ExecutionSyncActionSuccess {
  ok: true;
  action: 'set_execution_enabled' | 'restart_runtime_host';
  payload?: unknown;
}

interface ExecutionSyncActionFailure {
  ok: false;
  status: number;
  error: {
    code: string;
    message: string;
  };
}

export type ExecutionSyncAction = ExecutionSyncActionSuccess | ExecutionSyncActionFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

export function isExecutionSyncRoute(method: string, route: string): boolean {
  const routePath = normalizeRoutePath(route);
  if (method === 'PUT' && routePath === '/api/plugins/runtime/execution') return true;
  if (method === 'POST' && routePath === '/api/plugins/runtime/restart') return true;
  return false;
}

export function buildExecutionSyncAction(
  method: string,
  route: string,
  payload: unknown,
): ExecutionSyncAction {
  const routePath = normalizeRoutePath(route);
  if (method === 'PUT' && routePath === '/api/plugins/runtime/execution') {
    if (!isRecord(payload) || typeof payload.enabled !== 'boolean') {
      return {
        ok: false,
        status: 400,
        error: { code: 'BAD_REQUEST', message: 'enabled 必须是 boolean' },
      };
    }
    return {
      ok: true,
      action: 'set_execution_enabled',
      payload: { enabled: payload.enabled },
    };
  }
  if (method === 'POST' && routePath === '/api/plugins/runtime/restart') {
    return {
      ok: true,
      action: 'restart_runtime_host',
    };
  }
  return {
    ok: false,
    status: 400,
    error: { code: 'BAD_REQUEST', message: `Unsupported execution sync route: ${method} ${routePath}` },
  };
}

export function syncExecutionStateFromPayload(
  payload: unknown,
  mutations: SyncExecutionStateMutations,
): void {
  if (!isRecord(payload)) {
    return;
  }
  const execution = payload.execution;
  if (!isRecord(execution)) {
    return;
  }
  if (typeof execution.pluginExecutionEnabled === 'boolean') {
    mutations.setPluginExecutionEnabled(execution.pluginExecutionEnabled);
  }
}
