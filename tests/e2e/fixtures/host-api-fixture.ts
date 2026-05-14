import { BrowserWindow } from 'electron';
import * as XLSX from 'xlsx';
import type {
  SessionRenderExecutionGraphItem,
  SessionRenderItem,
  SessionRenderToolCard,
  SessionStateSnapshot,
} from '../../../runtime-host/shared/session-adapter-types';

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

type MockGatewayStatus = {
  processState: 'running';
  port: number;
  gatewayReady: true;
  healthSummary: 'healthy';
  transportState: 'connected';
  portReachable: true;
  diagnostics: {
    consecutiveHeartbeatMisses: number;
    consecutiveRpcFailures: number;
  };
  updatedAt: number;
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
  partialText?: string;
};

interface E2EChatMockState {
  sessions: MockSession[];
  histories: Record<string, MockMessage[]>;
  approvals: MockApproval[];
  runsById: Record<string, MockRun>;
  mainSessionKey: string;
  historySessionKey: string;
  artifactSessionKey: string;
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
  artifactSessionKey: '',
  counter: 0,
};

const ARTIFACT_WORKSPACE_ROOT = '/workspace';
const MOCK_SKILL_DIR = '~/.openclaw/skills/open-baidu';
const MOCK_SKILL_FILE = `${MOCK_SKILL_DIR}/SKILL.md`;
const MOCK_REPORT_FILE = '/tmp/report.pdf';
const MOCK_SHEET_FILE = '/tmp/sales.xlsx';
const MOCK_GENERATED_FILE = `${ARTIFACT_WORKSPACE_ROOT}/demo.ts`;
const MOCK_TEXT_FILES = new Map<string, string>([
  [MOCK_GENERATED_FILE, 'export const value = 2;\n'],
  [MOCK_SKILL_FILE, '# open-baidu\n\nThis is a mocked skill preview.\n'],
]);
const MOCK_FILE_STATS = new Map<string, { isDir: boolean; size: number; mtimeMs: number }>([
  [ARTIFACT_WORKSPACE_ROOT, { isDir: true, size: 0, mtimeMs: 1 }],
  [MOCK_GENERATED_FILE, { isDir: false, size: 24, mtimeMs: 1 }],
  [MOCK_SKILL_DIR, { isDir: true, size: 0, mtimeMs: 1 }],
  [MOCK_SKILL_FILE, { isDir: false, size: 40, mtimeMs: 1 }],
  [MOCK_REPORT_FILE, { isDir: false, size: 128, mtimeMs: 1 }],
  [MOCK_SHEET_FILE, { isDir: false, size: 256, mtimeMs: 1 }],
]);

let cachedWorkbookBase64: string | null = null;

function buildMockPdfBase64(): string {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8').toString('base64');
}

function buildMockWorkbookBase64(): string {
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ['Name', 'Value'],
    ['Summary', '42'],
  ]);
  const rawSheet = XLSX.utils.aoa_to_sheet([
    ['Raw'],
    ['A'],
  ]);
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(workbook, rawSheet, 'Raw');
  return XLSX.write(workbook, {
    type: 'base64',
    bookType: 'xlsx',
  });
}

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

function buildMockGatewayStatus(): MockGatewayStatus {
  return {
    processState: 'running',
    port: 18789,
    gatewayReady: true,
    healthSummary: 'healthy',
    transportState: 'connected',
    portReachable: true,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: Date.now(),
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
  emitHostEvent('session:update', {
    sessionUpdate: 'session_info_update',
    runId,
    sessionKey,
    phase: 'started',
    snapshot: buildSnapshotForSession(sessionKey),
    error: null,
  });
}

function emitDelta(runId: string, sessionKey: string, content: string): void {
  const run = state.runsById[runId];
  if (run) {
    run.partialText = content;
  }
  const snapshot = buildSnapshotForSession(sessionKey);
  const item = snapshot.items.find((entry) => (
    entry.kind === 'assistant-turn'
    && entry.key === `session:${sessionKey}|assistant:${runId}`
  )) ?? null;
  emitHostEvent('session:update', {
    sessionUpdate: 'session_item_chunk',
    runId,
    sessionKey,
    item,
    snapshot,
  });
}

function emitFinal(runId: string, sessionKey: string, content: string): void {
  const run = state.runsById[runId];
  if (run) {
    run.status = 'done';
    run.partialText = undefined;
  }
  appendMessage(sessionKey, {
    role: 'assistant',
    content,
  });
  const snapshot = buildSnapshotForSession(sessionKey);
  const item = snapshot.items[snapshot.items.length - 1] ?? null;
  emitHostEvent('session:update', {
    sessionUpdate: 'session_item',
    runId,
    sessionKey,
    item,
    snapshot,
  });
}

function emitAborted(runId: string, sessionKey: string): void {
  const run = state.runsById[runId];
  if (run) {
    run.status = 'aborted';
    run.partialText = undefined;
  }
  emitHostEvent('session:update', {
    sessionUpdate: 'session_info_update',
    runId,
    sessionKey,
    phase: 'aborted',
    snapshot: buildSnapshotForSession(sessionKey),
    error: null,
  });
}

function makeCatalog(sessionKey: string) {
  const session = state.sessions.find((item) => item.key === sessionKey);
  return {
    key: sessionKey,
    agentId: 'main',
    kind: 'main' as const,
    preferred: sessionKey === state.mainSessionKey,
    label: session?.label || 'Main',
    titleSource: 'assistant' as const,
    displayName: session?.displayName || session?.label || 'Main',
    updatedAt: session?.updatedAt ?? Date.now(),
  };
}

function makeWindow(totalItemCount: number) {
  return {
    totalItemCount,
    windowStartOffset: 0,
    windowEndOffset: totalItemCount,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  };
}

function buildArtifactSessionItems(sessionKey: string): SessionRenderItem[] {
  const userItem: SessionRenderItem = {
    key: `session:${sessionKey}|user:artifact-trigger`,
    kind: 'user-message',
    role: 'user',
    sessionKey,
    text: 'generate artifacts',
    images: [],
    attachedFiles: [],
    createdAt: nowSeconds(),
    messageId: 'artifact-user-1',
  };
  const editToolCard: SessionRenderToolCard = {
    id: 'edit-1',
    toolCallId: 'edit-1',
    name: 'edit',
    displayTitle: 'edit',
    displayDetail: 'edit /workspace/demo.ts',
    input: {
      file_path: MOCK_GENERATED_FILE,
      old_string: 'export const value = 1;\n',
      new_string: 'export const value = 2;\n',
    },
    inputText: JSON.stringify({
      file_path: MOCK_GENERATED_FILE,
      old_string: 'export const value = 1;\n',
      new_string: 'export const value = 2;\n',
    }, null, 2),
    status: 'completed',
    summary: 'Updated demo.ts',
    durationMs: 42,
    result: { kind: 'none', surface: 'tool-card' },
  };
  const pdfToolCard: SessionRenderToolCard = {
    id: 'write-1',
    toolCallId: 'write-1',
    name: 'write',
    displayTitle: 'write',
    displayDetail: `write ${MOCK_REPORT_FILE}`,
    input: {
      filePath: MOCK_REPORT_FILE,
      content: '',
    },
    inputText: JSON.stringify({
      filePath: MOCK_REPORT_FILE,
      content: '',
    }, null, 2),
    status: 'completed',
    summary: 'Generated report.pdf',
    durationMs: 37,
    result: { kind: 'none', surface: 'tool-card' },
  };
  const sheetToolCard: SessionRenderToolCard = {
    id: 'write-2',
    toolCallId: 'write-2',
    name: 'write',
    displayTitle: 'write',
    displayDetail: `write ${MOCK_SHEET_FILE}`,
    input: {
      filePath: MOCK_SHEET_FILE,
      content: '',
    },
    inputText: JSON.stringify({
      filePath: MOCK_SHEET_FILE,
      content: '',
    }, null, 2),
    status: 'completed',
    summary: 'Generated sales.xlsx',
    durationMs: 39,
    result: { kind: 'none', surface: 'tool-card' },
  };
  const assistantItem: SessionRenderItem = {
    key: `session:${sessionKey}|assistant:artifact-reply`,
    kind: 'assistant-turn',
    role: 'assistant',
    sessionKey,
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
    laneKey: 'main',
    turnKey: 'main:artifact-reply',
    agentId: 'main',
    identitySource: 'message',
    identityMode: 'message',
    identityConfidence: 'strong',
    status: 'final',
    segments: [
      {
        kind: 'tool',
        key: 'tool-segment:edit-1',
        tool: editToolCard,
      },
      {
        kind: 'tool',
        key: 'tool-segment:write-1',
        tool: pdfToolCard,
      },
      {
        kind: 'tool',
        key: 'tool-segment:write-2',
        tool: sheetToolCard,
      },
      {
        kind: 'message',
        key: 'message-segment:artifact-1',
        text: `Generated ${MOCK_REPORT_FILE}, ${MOCK_SHEET_FILE}\nSkill dir: ${MOCK_SKILL_DIR}\nMarkdown file: ${MOCK_SKILL_FILE}`,
      },
    ],
    thinking: null,
    tools: [editToolCard, pdfToolCard, sheetToolCard],
    text: `Generated ${MOCK_REPORT_FILE}, ${MOCK_SHEET_FILE}\nSkill dir: ${MOCK_SKILL_DIR}\nMarkdown file: ${MOCK_SKILL_FILE}`,
    images: [],
    attachedFiles: [],
    pendingState: null,
  };
  const graphItem: SessionRenderExecutionGraphItem = {
    key: `session:${sessionKey}|graph:artifact-graph-1`,
    kind: 'execution-graph',
    role: 'assistant',
    sessionKey,
    text: '',
    createdAt: nowSeconds(),
    status: 'final',
    entryId: 'graph:artifact-graph-1',
    graphId: 'artifact-graph-1',
    completionItemKey: assistantItem.key,
    anchorItemKey: assistantItem.key,
    childSessionKey: 'agent:main:child',
    childSessionId: 'child-artifact-session',
    childAgentId: 'main',
    agentLabel: 'main',
    sessionLabel: 'artifact worker',
    steps: [
      {
        id: 'tool-step-1',
        label: 'edit',
        status: 'completed',
        kind: 'tool',
        detail: 'Updated demo.ts',
        depth: 1,
      },
      {
        id: 'tool-step-2',
        label: 'write',
        status: 'completed',
        kind: 'tool',
        detail: `Generated ${MOCK_REPORT_FILE}`,
        depth: 1,
      },
      {
        id: 'tool-step-3',
        label: 'write',
        status: 'completed',
        kind: 'tool',
        detail: `Generated ${MOCK_SHEET_FILE}`,
        depth: 1,
      },
    ],
    active: false,
    triggerItemKey: userItem.key,
    replyItemKey: assistantItem.key,
    laneKey: 'main',
    turnKey: 'main:artifact-reply',
    agentId: 'main',
    assistantTurnKey: 'main:artifact-reply',
    assistantLaneKey: 'main',
    assistantLaneAgentId: 'main',
  };
  return [userItem, graphItem, assistantItem];
}

function buildStreamingAssistantItem(
  sessionKey: string,
  run: MockRun,
): SessionRenderItem | null {
  const content = typeof run.partialText === 'string' ? run.partialText : '';
  if (!content.trim()) {
    return null;
  }
  return {
    key: `session:${sessionKey}|assistant:${run.runId}`,
    kind: 'assistant-turn',
    role: 'assistant',
    sessionKey,
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
    laneKey: 'main',
    turnKey: `main:${run.runId}`,
    agentId: 'main',
    identitySource: 'run',
    identityMode: 'run',
    identityConfidence: 'strong',
    status: 'streaming',
    segments: [
      {
        kind: 'message',
        key: `message-segment:${run.runId}`,
        text: content,
      },
    ],
    thinking: null,
    tools: [],
    text: content,
    images: [],
    attachedFiles: [],
    pendingState: null,
  };
}

function buildSnapshotForSession(sessionKey: string): SessionStateSnapshot {
  const activeRun = findLatestRunningRunBySession(sessionKey);
  const baseItems = sessionKey === state.artifactSessionKey
    ? buildArtifactSessionItems(sessionKey)
    : (state.histories[sessionKey] ?? []).map<SessionRenderItem>((message) => {
        if (message.role === 'user') {
          return {
            key: `session:${sessionKey}|user:${message.id}`,
            kind: 'user-message',
            role: 'user',
            sessionKey,
            text: message.content,
            createdAt: message.timestamp,
            images: [],
            attachedFiles: [],
            messageId: message.id,
          };
        }
        return {
          key: `session:${sessionKey}|assistant:${message.id}`,
          kind: 'assistant-turn',
          role: 'assistant',
          sessionKey,
          text: message.content,
          createdAt: message.timestamp,
          updatedAt: message.timestamp,
          laneKey: 'main',
          turnKey: `main:${message.id}`,
          agentId: 'main',
          identitySource: 'message',
          identityMode: 'message',
          identityConfidence: 'strong',
          status: 'final',
          segments: [{ kind: 'message', key: `message-segment:${message.id}`, text: message.content }],
          thinking: null,
          tools: [],
          images: [],
          attachedFiles: [],
          pendingState: null,
        };
      });
  const streamingItem = activeRun ? buildStreamingAssistantItem(sessionKey, activeRun) : null;
  const items = streamingItem ? [...baseItems, streamingItem] : baseItems;
  const hasPendingApproval = Boolean(
    activeRun?.approvalId
    && state.approvals.some((approval) => approval.id === activeRun.approvalId),
  );
  const runPhase = hasPendingApproval
    ? 'waiting_tool'
    : (streamingItem ? 'streaming' : 'done');

  return {
    sessionKey,
    catalog: makeCatalog(sessionKey),
    items,
    replayComplete: true,
    runtime: {
      sending: Boolean(activeRun),
      activeRunId: activeRun?.runId ?? null,
      runPhase,
      activeTurnItemKey: streamingItem?.key ?? null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: hasPendingApproval,
      lastUserMessageAt: activeRun ? Date.now() : null,
      lastError: null,
      lastIssue: null,
      updatedAt: Date.now(),
    },
    window: makeWindow(items.length),
  };
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

function seedState(): void {
  const now = Date.now();
  state.mainSessionKey = 'agent:main:main';
  state.historySessionKey = `agent:main:session-${now - 3600_000}`;
  state.artifactSessionKey = 'agent:main:artifact';
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
    {
      key: state.artifactSessionKey,
      label: 'Artifact Session',
      displayName: 'Artifact Session',
      updatedAt: now - 30_000,
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
    [state.artifactSessionKey]: [],
  };
  cachedWorkbookBase64 = buildMockWorkbookBase64();
}

seedState();

export function handleE2EHostApiFetch(request: HostApiFetchRequest): HostApiProxyEnvelope | null {
  if (!isE2EMode) {
    return null;
  }

  const path = normalizePath(request.path);
  const method = (request.method || 'GET').toUpperCase();

  if (path === '/api/gateway/status') {
    return toSuccessEnvelope(buildMockGatewayStatus());
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

  if (path === '/api/sessions/list' && method === 'GET') {
    return toSuccessEnvelope({
      sessions: state.sessions.map((session) => makeCatalog(session.key)),
    });
  }

  if (path === '/api/sessions/window' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : state.mainSessionKey;
    return toSuccessEnvelope({
      snapshot: buildSnapshotForSession(sessionKey),
    });
  }

  if (path === '/api/session/new' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const agentId = typeof payload.agentId === 'string' && payload.agentId.trim()
      ? payload.agentId.trim()
      : 'main';
    const canonicalPrefix = typeof payload.canonicalPrefix === 'string' && payload.canonicalPrefix.trim()
      ? payload.canonicalPrefix.trim()
      : `agent:${agentId}`;
    const sessionKey = `${canonicalPrefix}:session-${Date.now()}-${++state.counter}`;
    ensureSession(sessionKey, sessionKey);
    return toSuccessEnvelope({
      success: true,
      sessionKey,
      snapshot: buildSnapshotForSession(sessionKey),
    });
  }

  if (path === '/api/session/load' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : state.mainSessionKey;
    return toSuccessEnvelope({
      snapshot: buildSnapshotForSession(sessionKey),
    });
  }

  if ((path === '/api/session/switch' || path === '/api/session/resume') && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : state.mainSessionKey;
    return toSuccessEnvelope({
      snapshot: buildSnapshotForSession(sessionKey),
    });
  }

  if (path === '/api/session/state' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : state.mainSessionKey;
    return toSuccessEnvelope({
      snapshot: buildSnapshotForSession(sessionKey),
    });
  }

  if (path === '/api/session/abort' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : state.mainSessionKey;
    const run = findLatestRunningRunBySession(sessionKey);
    if (run) {
      emitAborted(run.runId, sessionKey);
    }
    return toSuccessEnvelope({
      success: true,
      snapshot: buildSnapshotForSession(sessionKey),
    });
  }

  if (path === '/api/session/prompt' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : state.mainSessionKey;
    const message = typeof payload.message === 'string' ? payload.message : '';
    const mode: MockRun['mode'] = message.includes('[approval]')
      ? 'approval'
      : (message.includes('[long]') ? 'long' : 'default');
    const result = createRun(sessionKey, message || '(empty)', mode);
    return toSuccessEnvelope({
      success: true,
      sessionKey,
      runId: result.runId,
      promptId: typeof payload.promptId === 'string' ? payload.promptId : result.runId,
      item: null,
      snapshot: buildSnapshotForSession(sessionKey),
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

  if (path === '/api/files/stat' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const filePath = typeof payload.path === 'string' ? payload.path : '';
    const stat = MOCK_FILE_STATS.get(filePath);
    if (!stat) {
      return toSuccessEnvelope({ ok: false, error: 'notFound' });
    }
    return toSuccessEnvelope({
      ok: true,
      entry: {
        name: filePath.split(/[\\/]/).pop() || filePath,
        path: filePath,
        isDir: stat.isDir,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      },
    });
  }

  if (path === '/api/files/read-text' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const filePath = typeof payload.path === 'string' ? payload.path : '';
    const content = MOCK_TEXT_FILES.get(filePath);
    if (typeof content !== 'string') {
      return toSuccessEnvelope({ ok: false, error: 'notFound' });
    }
    return toSuccessEnvelope({
      ok: true,
      path: filePath,
      content,
      mimeType: filePath.endsWith('.md') ? 'text/markdown' : 'text/typescript',
      size: content.length,
      readOnly: true,
    });
  }

  if (path === '/api/files/read-binary' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const filePath = typeof payload.path === 'string' ? payload.path : '';
    if (filePath === MOCK_REPORT_FILE) {
      return toSuccessEnvelope({
        ok: true,
        path: filePath,
        data: buildMockPdfBase64(),
        mimeType: 'application/pdf',
        size: 128,
        readOnly: true,
      });
    }
    if (filePath === MOCK_SHEET_FILE) {
      return toSuccessEnvelope({
        ok: true,
        path: filePath,
        data: cachedWorkbookBase64 ?? '',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 256,
        readOnly: true,
      });
    }
    return toSuccessEnvelope({ ok: false, error: 'notFound' });
  }

  if (path === '/api/files/list-dir' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const filePath = typeof payload.path === 'string' ? payload.path : '';
    if (filePath === ARTIFACT_WORKSPACE_ROOT) {
      return toSuccessEnvelope({
        ok: true,
        entries: [
          {
            name: 'demo.ts',
            path: MOCK_GENERATED_FILE,
            isDir: false,
            size: 24,
            mtimeMs: 1,
            hasChildren: false,
          },
          {
            name: 'report.pdf',
            path: MOCK_REPORT_FILE,
            isDir: false,
            size: 128,
            mtimeMs: 1,
            hasChildren: false,
          },
          {
            name: 'sales.xlsx',
            path: MOCK_SHEET_FILE,
            isDir: false,
            size: 256,
            mtimeMs: 1,
            hasChildren: false,
          },
        ],
      });
    }
    if (filePath === MOCK_SKILL_DIR) {
      return toSuccessEnvelope({
        ok: true,
        entries: [
          {
            name: 'SKILL.md',
            path: MOCK_SKILL_FILE,
            isDir: false,
            size: 40,
            mtimeMs: 1,
            hasChildren: false,
          },
        ],
      });
    }
    return toSuccessEnvelope({ ok: false, error: 'notFound' });
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

export function getE2EGatewayStatus(): MockGatewayStatus | null {
  if (!isE2EMode) {
    return null;
  }
  return buildMockGatewayStatus();
}
