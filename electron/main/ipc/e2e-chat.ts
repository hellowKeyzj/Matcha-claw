import { BrowserWindow } from 'electron';

type HostApiFetchRequest = {
  path?: string;
  method?: string;
  body?: unknown;
};

type HostApiProxyEnvelope =
  | {
    ok: true;
    data: {
      status: number;
      ok: boolean;
      json: unknown;
    };
  }
  | {
    ok: false;
    error: { message: string };
  };

type MockSession = {
  key: string;
  label: string;
  displayName: string;
  updatedAt: number;
};

type MockMessage = {
  role: 'user' | 'assistant';
  id: string;
  content: string;
  timestamp: number;
};

type MockApproval = {
  id: string;
  sessionKey: string;
  runId: string;
  toolName: string;
  createdAt: number;
};

type MockRun = {
  runId: string;
  sessionKey: string;
  userText: string;
  mode: 'default' | 'approval' | 'long';
  status: 'running' | 'done' | 'aborted';
  approvalId?: string;
};

interface E2EChatMockState {
  sessions: MockSession[];
  histories: Record<string, MockMessage[]>;
  approvals: MockApproval[];
  runsById: Record<string, MockRun>;
  mainSessionKey: string;
  historySessionKey: string;
  counter: number;
}

const isE2EMode = process.env.CLAWX_E2E === '1';

const state: E2EChatMockState = {
  sessions: [],
  histories: {},
  approvals: [],
  runsById: {},
  mainSessionKey: 'agent:main:main',
  historySessionKey: '',
  counter: 0,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function normalizePath(path?: string): string {
  if (!path || typeof path !== 'string') {
    return '/';
  }
  const value = path.startsWith('/') ? path : `/${path}`;
  const queryIndex = value.indexOf('?');
  return queryIndex >= 0 ? value.slice(0, queryIndex) : value;
}

function toSuccessEnvelope(json: unknown, status = 200, ok = true): HostApiProxyEnvelope {
  return {
    ok: true,
    data: {
      status,
      ok,
      json,
    },
  };
}

function emitHostEvent(eventName: string, payload: unknown): void {
  const envelope = { eventName, payload };
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send('host:event', envelope);
  }
}

function ensureSession(sessionKey: string, label?: string): void {
  const existing = state.sessions.find((item) => item.key === sessionKey);
  if (existing) {
    if (label) {
      existing.label = label;
      existing.displayName = label;
    }
    return;
  }
  const fallbackLabel = label || sessionKey;
  state.sessions.push({
    key: sessionKey,
    label: fallbackLabel,
    displayName: fallbackLabel,
    updatedAt: Date.now(),
  });
}

function touchSession(sessionKey: string): void {
  const target = state.sessions.find((item) => item.key === sessionKey);
  if (!target) {
    ensureSession(sessionKey);
  }
  const latest = state.sessions.find((item) => item.key === sessionKey);
  if (latest) {
    latest.updatedAt = Date.now();
  }
  state.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
}

function appendMessage(
  sessionKey: string,
  message: Pick<MockMessage, 'role' | 'content'>,
): MockMessage {
  ensureSession(sessionKey);
  const nextMessage: MockMessage = {
    role: message.role,
    content: message.content,
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: nowSeconds(),
  };
  const history = state.histories[sessionKey] ?? [];
  history.push(nextMessage);
  state.histories[sessionKey] = history;
  touchSession(sessionKey);
  return nextMessage;
}

function findLatestRunningRunBySession(sessionKey: string): MockRun | null {
  const candidates = Object.values(state.runsById).filter(
    (run) => run.sessionKey === sessionKey && run.status === 'running',
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates[candidates.length - 1];
}

function emitRunStarted(runId: string, sessionKey: string): void {
  emitHostEvent('gateway:conversation-event', {
    type: 'run.phase',
    phase: 'started',
    runId,
    sessionKey,
  });
}

function emitDelta(runId: string, sessionKey: string, content: string): void {
  emitHostEvent('gateway:conversation-event', {
    type: 'chat.message',
    event: {
      state: 'delta',
      runId,
      sessionKey,
      message: {
        role: 'assistant',
        content,
      },
    },
  });
}

function emitFinal(runId: string, sessionKey: string, content: string): void {
  appendMessage(sessionKey, {
    role: 'assistant',
    content,
  });
  emitHostEvent('gateway:conversation-event', {
    type: 'chat.message',
    event: {
      state: 'final',
      runId,
      sessionKey,
      message: {
        role: 'assistant',
        content,
      },
    },
  });
  const run = state.runsById[runId];
  if (run) {
    run.status = 'done';
  }
}

function emitAborted(runId: string, sessionKey: string): void {
  emitHostEvent('gateway:conversation-event', {
    type: 'run.phase',
    phase: 'aborted',
    runId,
    sessionKey,
  });
  const run = state.runsById[runId];
  if (run) {
    run.status = 'aborted';
  }
}

function createRun(sessionKey: string, userText: string, mode: MockRun['mode']): { runId: string } {
  appendMessage(sessionKey, { role: 'user', content: userText });
  const runId = `run-${Date.now()}-${++state.counter}`;
  state.runsById[runId] = {
    runId,
    sessionKey,
    userText,
    mode,
    status: 'running',
  };

  if (mode === 'default') {
    setTimeout(() => emitRunStarted(runId, sessionKey), 10);
    setTimeout(() => emitDelta(runId, sessionKey, 'Mock streaming...'), 40);
    setTimeout(() => emitFinal(runId, sessionKey, `Mock reply: ${userText}`), 100);
  } else if (mode === 'approval') {
    setTimeout(() => emitRunStarted(runId, sessionKey), 10);
    setTimeout(() => emitDelta(runId, sessionKey, 'Waiting for approval...'), 40);
    const approvalId = `approval-${Date.now()}-${state.counter}`;
    state.runsById[runId].approvalId = approvalId;
    const approval: MockApproval = {
      id: approvalId,
      sessionKey,
      runId,
      toolName: 'shell.exec',
      createdAt: Date.now(),
    };
    state.approvals.push(approval);
    setTimeout(() => {
      emitHostEvent('gateway:notification', {
        method: 'exec.approval.requested',
        params: {
          ...approval,
          request: {
            sessionKey,
            runId,
            toolName: approval.toolName,
          },
        },
      });
    }, 80);
  } else {
    setTimeout(() => emitRunStarted(runId, sessionKey), 10);
    setTimeout(() => emitDelta(runId, sessionKey, 'Long-running task...'), 40);
  }

  return { runId };
}

function handleGatewayRpc(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (method === 'sessions.list') {
    return {
      sessions: clone(state.sessions),
    };
  }

  if (method === 'sessions.get') {
    const key = typeof params.key === 'string' ? params.key : state.mainSessionKey;
    const limitRaw = Number(params.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
    const history = state.histories[key] ?? [];
    return {
      messages: clone(history.slice(-limit)),
      thinkingLevel: null,
    };
  }

  if (method === 'chat.history') {
    const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : state.mainSessionKey;
    const limitRaw = Number(params.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
    const history = state.histories[sessionKey] ?? [];
    return {
      messages: clone(history.slice(-limit)),
      thinkingLevel: null,
    };
  }

  if (method === 'chat.send') {
    const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : state.mainSessionKey;
    const message = typeof params.message === 'string' ? params.message.trim() : '';
    const mode: MockRun['mode'] = message.includes('[approval]')
      ? 'approval'
      : (message.includes('[long]') ? 'long' : 'default');
    return createRun(sessionKey, message || '(empty)', mode);
  }

  if (method === 'chat.abort') {
    const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : state.mainSessionKey;
    const run = findLatestRunningRunBySession(sessionKey);
    if (run) {
      emitAborted(run.runId, run.sessionKey);
    }
    return { success: true };
  }

  if (method === 'exec.approvals.get') {
    return {
      items: clone(state.approvals),
    };
  }

  if (method === 'exec.approval.resolve') {
    const approvalId = typeof params.id === 'string' ? params.id : '';
    const decision = typeof params.decision === 'string' ? params.decision : 'deny';
    const approval = state.approvals.find((item) => item.id === approvalId);
    state.approvals = state.approvals.filter((item) => item.id !== approvalId);
    if (approval) {
      emitHostEvent('gateway:notification', {
        method: 'exec.approval.resolved',
        params: {
          id: approval.id,
          sessionKey: approval.sessionKey,
          runId: approval.runId,
          decision,
        },
      });

      if (decision === 'allow-once' || decision === 'allow-always') {
        setTimeout(() => emitFinal(approval.runId, approval.sessionKey, 'Approved result'), 50);
      } else {
        setTimeout(() => emitAborted(approval.runId, approval.sessionKey), 40);
      }
    }
    return { success: true };
  }

  if (method === 'agents.list') {
    return {
      defaultId: 'main',
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '',
          model: { primary: 'openai/gpt-4o-mini' },
        },
      ],
    };
  }

  if (method === 'config.get') {
    return {
      config: {
        agents: {
          defaults: {
            workspace: '',
            model: { primary: 'openai/gpt-4o-mini' },
          },
          list: [
            {
              id: 'main',
              workspace: '',
              model: { primary: 'openai/gpt-4o-mini' },
            },
          ],
        },
        models: {
          providers: {
            openai: {
              models: [{ id: 'gpt-4o-mini' }],
            },
          },
        },
      },
    };
  }

  if (method === 'models.list') {
    return {
      models: [
        {
          id: 'openai/gpt-4o-mini',
          name: 'gpt-4o-mini',
          provider: 'openai',
          contextWindow: 128000,
        },
      ],
    };
  }

  if (method === 'skills.status') {
    return { skills: [] };
  }

  return {};
}

function seedState(): void {
  const now = Date.now();
  state.mainSessionKey = 'agent:main:main';
  state.historySessionKey = `agent:main:session-${now - 3600_000}`;
  state.counter = 0;
  state.runsById = {};
  state.approvals = [];
  state.sessions = [
    {
      key: state.mainSessionKey,
      label: 'Main',
      displayName: 'Main',
      updatedAt: now,
    },
    {
      key: state.historySessionKey,
      label: 'History Session',
      displayName: 'History Session',
      updatedAt: now - 60_000,
    },
  ];
  state.histories = {
    [state.mainSessionKey]: [],
    [state.historySessionKey]: [
      {
        id: 'seed-history-1',
        role: 'assistant',
        content: 'History session seed message',
        timestamp: nowSeconds() - 90,
      },
    ],
  };
}

seedState();

export function handleE2EChatHostApiFetch(request: HostApiFetchRequest): HostApiProxyEnvelope | null {
  if (!isE2EMode) {
    return null;
  }

  const path = normalizePath(request.path);
  const method = (request.method || 'GET').toUpperCase();

  if (path === '/api/gateway/status') {
    return toSuccessEnvelope({
      state: 'running',
      port: 18789,
    });
  }

  if (path === '/api/settings/setupComplete') {
    if (method === 'GET') {
      return toSuccessEnvelope({ value: true });
    }
    if (method === 'PUT') {
      return toSuccessEnvelope({ success: true });
    }
  }

  if (path === '/api/license/gate' && method === 'GET') {
    return toSuccessEnvelope({
      state: 'granted',
      reason: 'e2e',
      checkedAtMs: Date.now(),
      hasStoredKey: true,
      hasUsableCache: true,
      nextRevalidateAtMs: null,
    });
  }

  if (path === '/api/gateway/rpc' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const rpcMethod = typeof payload.method === 'string' ? payload.method : '';
    const rpcParams = (payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params))
      ? payload.params as Record<string, unknown>
      : {};
    const result = handleGatewayRpc(rpcMethod, rpcParams);
    return toSuccessEnvelope({
      success: true,
      result,
    });
  }

  if (path === '/api/chat/send-with-media' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : state.mainSessionKey;
    const message = typeof payload.message === 'string' ? payload.message : 'Process attachment';
    const result = createRun(sessionKey, message, 'default');
    return toSuccessEnvelope({
      success: true,
      result,
    });
  }

  if (path === '/api/files/stage-paths' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const filePaths = Array.isArray(payload.filePaths) ? payload.filePaths : [];
    const staged = filePaths.map((rawFilePath, index) => {
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : `C:\\mock\\file-${index}.txt`;
      const nameParts = filePath.split(/[\\/]/);
      const fileName = nameParts[nameParts.length - 1] || `file-${index}.txt`;
      return {
        id: `staged-path-${index}-${Date.now()}`,
        fileName,
        mimeType: 'text/plain',
        fileSize: 12,
        stagedPath: filePath,
        preview: null,
      };
    });
    return toSuccessEnvelope(staged);
  }

  if (path === '/api/files/stage-buffer' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : 'buffer-file.txt';
    const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : 'application/octet-stream';
    return toSuccessEnvelope({
      id: `staged-buffer-${Date.now()}`,
      fileName,
      mimeType,
      fileSize: 16,
      stagedPath: `C:\\mock\\${fileName}`,
      preview: null,
    });
  }

  return null;
}

export function getE2EDialogOpenResult(): { canceled: boolean; filePaths: string[] } | null {
  if (!isE2EMode) {
    return null;
  }
  return {
    canceled: false,
    filePaths: ['C:\\mock\\notes.txt'],
  };
}
