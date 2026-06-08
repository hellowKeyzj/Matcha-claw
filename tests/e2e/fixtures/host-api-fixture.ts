import { BrowserWindow } from 'electron';
import * as XLSX from 'xlsx';
import type { CapabilityTarget, RuntimeEndpointRef, RuntimeScope, SessionIdentity } from '../../../runtime-host/application/agent-runtime/contracts/runtime-address';
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

type MockSubagent = {
  id: string;
  name: string;
  workspace: string;
  model: string;
  skills: string[];
  isDefault: boolean;
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
  title: string;
  command: string;
  allowedDecisions: Array<'allow-once' | 'allow-always' | 'deny'>;
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
  activeTeamRunId: string;
  counter: number;
  subagents: MockSubagent[];
}

const isE2EMode = process.env.MATCHACLAW_E2E === '1';

const state: E2EChatMockState = {
  sessions: [],
  histories: {},
  approvals: [],
  runsById: {},
  mainSessionKey: 'agent:main:main',
  historySessionKey: '',
  artifactSessionKey: '',
  activeTeamRunId: 'team-run-main',
  counter: 0,
  subagents: [],
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
const OPENCLAW_ENDPOINT: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

function agentIdFromSessionKey(sessionKey: string): string {
  return sessionKey.split(':')[1] || 'main';
}

function sessionIdentityForSession(sessionKey: string): SessionIdentity {
  return {
    endpoint: OPENCLAW_ENDPOINT,
    agentId: agentIdFromSessionKey(sessionKey),
    sessionKey,
  };
}

function runtimeInstanceScope(): RuntimeScope {
  return {
    kind: 'runtime-instance',
    endpoint: OPENCLAW_ENDPOINT,
  };
}

function teamRunScope(runId: string, teamId?: string): RuntimeScope {
  return {
    kind: 'team-run',
    endpoint: OPENCLAW_ENDPOINT,
    ...(teamId ? { teamId } : {}),
    runId,
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function getSessionKeyFromScope(scope: unknown): string | null {
  return isRecord(scope)
    && scope.kind === 'session'
    && isRecord(scope.identity)
    && typeof scope.identity.sessionKey === 'string'
    ? scope.identity.sessionKey
    : null;
}

function getAgentIdFromScope(scope: unknown): string | null {
  if (!isRecord(scope)) {
    return null;
  }
  if (scope.kind === 'runtime-instance') {
    return 'main';
  }
  if (scope.kind === 'session' && isRecord(scope.identity) && typeof scope.identity.agentId === 'string') {
    return scope.identity.agentId;
  }
  return null;
}

function requireCapabilityExecutePayload(
  payload: Record<string, unknown>,
  capabilityId: string,
  operationId: string,
): { input: Record<string, unknown>; scope: RuntimeScope; target: CapabilityTarget | null } | HostApiProxyEnvelope {
  if (payload.id !== capabilityId || payload.operationId !== operationId) {
    return toSuccessEnvelope({ success: false, error: 'Capability operation not supported' }, 400, false);
  }
  if (!isRecord(payload.scope)) {
    return toSuccessEnvelope({ success: false, error: 'RuntimeScope is required' }, 400, false);
  }
  const input = payload.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toSuccessEnvelope({ success: false, error: 'Capability input is required' }, 400, false);
  }
  const domainInput = input as Record<string, unknown>;
  const target = isRecord(payload.target) ? payload.target as CapabilityTarget : null;
  if (target?.kind === 'workspace-file' && typeof target.path === 'string' && domainInput.path !== target.path) {
    return toSuccessEnvelope({ success: false, error: 'Workspace file target path must match input path' }, 400, false);
  }
  if (target?.kind === 'workspace-staging' && isRecord(target.identity) && isRecord(domainInput.sessionIdentity)) {
    const targetSessionKey = typeof target.identity.sessionKey === 'string' ? target.identity.sessionKey : '';
    const inputSessionKey = typeof domainInput.sessionIdentity.sessionKey === 'string' ? domainInput.sessionIdentity.sessionKey : '';
    if (targetSessionKey && inputSessionKey && targetSessionKey !== inputSessionKey) {
      return toSuccessEnvelope({ success: false, error: 'Workspace staging target identity must match input sessionIdentity' }, 400, false);
    }
  }
  if (target?.kind === 'session' && isRecord(target.identity)) {
    const targetSessionKey = typeof target.identity.sessionKey === 'string' ? target.identity.sessionKey : '';
    const inputSessionKey = typeof domainInput.sessionKey === 'string'
      ? domainInput.sessionKey
      : (isRecord(domainInput.sessionIdentity) && typeof domainInput.sessionIdentity.sessionKey === 'string' ? domainInput.sessionIdentity.sessionKey : '');
    if (targetSessionKey && inputSessionKey && targetSessionKey !== inputSessionKey) {
      return toSuccessEnvelope({ success: false, error: 'Session target identity must match input session' }, 400, false);
    }
  }
  if (target?.kind === 'runtime-job' && typeof target.jobId === 'string' && domainInput.jobId !== target.jobId) {
    return toSuccessEnvelope({ success: false, error: 'Runtime job target must match input jobId' }, 400, false);
  }
  return {
    input: domainInput,
    scope: payload.scope as RuntimeScope,
    target,
  };
}

function sessionKeyFromIdentityPayload(payload: Record<string, unknown>): string | null {
  return isRecord(payload.sessionIdentity) && typeof payload.sessionIdentity.sessionKey === 'string'
    ? payload.sessionIdentity.sessionKey
    : null;
}

function buildSessionOperationPayload(payload: Record<string, unknown>, fallbackSessionKey = state.mainSessionKey): { sessionKey: string; sessionIdentity: SessionIdentity } {
  const sessionKey = typeof payload.sessionKey === 'string'
    ? payload.sessionKey
    : (sessionKeyFromIdentityPayload(payload) ?? fallbackSessionKey);
  return {
    sessionKey,
    sessionIdentity: sessionIdentityForSession(sessionKey),
  };
}

function buildCapabilitySummary(
  id: string,
  scope: RuntimeScope,
  targetKinds: Array<CapabilityTarget['kind']>,
  operations: Array<{ id: string; targetKind: CapabilityTarget['kind']; targetRequired?: boolean }>,
) {
  return {
    id,
    scopeKind: scope.kind,
    scope,
    targetKinds,
    operations,
    availability: 'available' as const,
  };
}

function buildRuntimeEndpointCapabilitySummaries() {
  const runtimeScope = runtimeInstanceScope();
  const teamRuntimeScope = teamRunScope(state.activeTeamRunId ?? 'team-run-main');
  const workspaceScope: RuntimeScope = { kind: 'workspace', endpoint: OPENCLAW_ENDPOINT };
  return [
    buildCapabilitySummary('session.prompt', runtimeScope, ['agent', 'session'], [
      { id: 'sessions.create', targetKind: 'agent' },
      { id: 'sessions.prompt', targetKind: 'session' },
      { id: 'sessions.sendWithMedia', targetKind: 'session' },
      { id: 'sessions.abort', targetKind: 'session' },
      { id: 'sessions.load', targetKind: 'session' },
    ]),
    buildCapabilitySummary('session.management', runtimeScope, ['runtime-endpoint'], [
      { id: 'sessions.list', targetKind: 'runtime-endpoint' },
    ]),
    buildCapabilitySummary('session.management', { kind: 'session', identity: sessionIdentityForSession(state.mainSessionKey) }, ['session'], [
      { id: 'sessions.window', targetKind: 'session' },
      { id: 'sessions.switch', targetKind: 'session' },
      { id: 'sessions.resume', targetKind: 'session' },
      { id: 'sessions.state', targetKind: 'session' },
    ]),
    buildCapabilitySummary('session.approval', runtimeScope, ['session', 'approval'], [
      { id: 'approvals.list', targetKind: 'session' },
      { id: 'approvals.resolve', targetKind: 'approval' },
    ]),
    buildCapabilitySummary('team.runtime', runtimeScope, ['team', 'team-run', 'team-stage', 'team-dispatch', 'team-approval'], [
      { id: 'team.runCreate', targetKind: 'team' },
    ]),
    buildCapabilitySummary('team.runtime', teamRuntimeScope, ['team-run', 'team-stage', 'team-dispatch', 'team-approval'], [
      { id: 'team.runStart', targetKind: 'team-run' },
      { id: 'team.runSnapshot', targetKind: 'team-run' },
      { id: 'team.dispatchPrepare', targetKind: 'team-stage' },
      { id: 'team.dispatchExecute', targetKind: 'team-dispatch' },
      { id: 'team.approvalResolve', targetKind: 'team-approval' },
    ]),
    buildCapabilitySummary('workspace.file', workspaceScope, ['workspace-file', 'workspace-staging'], [
      { id: 'files.readText', targetKind: 'workspace-file' },
      { id: 'files.readBinary', targetKind: 'workspace-file' },
      { id: 'files.stat', targetKind: 'workspace-file' },
      { id: 'files.listDir', targetKind: 'workspace-file' },
      { id: 'files.thumbnail', targetKind: 'workspace-file' },
      { id: 'files.stagePaths', targetKind: 'workspace-staging' },
      { id: 'files.stageBuffer', targetKind: 'workspace-staging' },
    ]),
    buildCapabilitySummary('runtime.host', runtimeScope, ['runtime-endpoint', 'runtime-job', 'gateway-control'], [
      { id: 'runtimeHost.gatewayReady', targetKind: 'gateway-control' },
      { id: 'runtimeHost.gatewayControlUiAutoApprove', targetKind: 'gateway-control' },
      { id: 'runtimeHost.jobGet', targetKind: 'runtime-job', targetRequired: true },
      { id: 'diagnostics.collect', targetKind: 'runtime-endpoint' },
    ]),
  ];
}

function buildRuntimeEndpointSummary() {
  return {
    id: 'openclaw-local',
    protocolId: 'openclaw-v4',
    runtimeAdapterId: OPENCLAW_ENDPOINT.runtimeAdapterId,
    runtimeInstanceId: OPENCLAW_ENDPOINT.runtimeInstanceId,
    displayName: 'OpenClaw Local',
    agentIds: ['main'],
    acceptsDynamicAgents: true,
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      approvals: true,
      replay: true,
      modelSelection: false,
    },
    capabilitySummaries: buildRuntimeEndpointCapabilitySummaries(),
    controlState: {
      connection: {
        state: 'connected' as const,
        portReachable: true,
        gatewayReady: true,
        healthSummary: 'healthy' as const,
        transportEpoch: 1,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: Date.now(),
      },
      readiness: {
        ready: true,
        phase: 'ready' as const,
        requiredMethods: [],
        missingMethods: [],
        retryable: false,
      },
      capabilities: {
        methods: [],
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    },
  };
}

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
    run.approvalId = undefined;
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
  const sessionIdentity = sessionIdentityForSession(sessionKey);
  return {
    key: sessionKey,
    agentId: sessionIdentity.agentId,
    protocolId: 'openclaw-v4',
    runtimeEndpointId: 'openclaw-local',
    sessionIdentity,
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
    approvals: state.approvals
      .filter((approval) => approval.sessionKey === sessionKey)
      .map((approval) => ({
        id: approval.id,
        sessionKey: approval.sessionKey,
        sessionIdentity: sessionIdentityForSession(approval.sessionKey),
        runId: approval.runId,
        title: approval.title,
        command: approval.command,
        allowedDecisions: approval.allowedDecisions,
        createdAtMs: approval.createdAt,
      })),
    usage: [],
    artifacts: [],
    replayComplete: true,
    runtime: {
      activeRunId: activeRun?.runId ?? null,
      runPhase,
      activeTurnItemKey: streamingItem?.key ?? null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
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
    setTimeout(() => emitFinal(runId, sessionKey, `Mock reply: ${userText}`), 900);
  } else if (mode === 'approval') {
    setTimeout(() => emitRunStarted(runId, sessionKey), 10);
    setTimeout(() => emitDelta(runId, sessionKey, 'Waiting for approval...'), 40);
    const approvalId = `approval-${Date.now()}-${state.counter}`;
    state.runsById[runId].approvalId = approvalId;
    const approval: MockApproval = {
      id: approvalId,
      sessionKey,
      runId,
      title: 'gateway',
      command: 'Remove-Item demo.txt',
      allowedDecisions: ['allow-once', 'deny'],
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
            command: approval.command,
            host: approval.title,
            allowedDecisions: approval.allowedDecisions,
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
  state.activeTeamRunId = 'team-run-main';
  state.counter = 0;
  state.runsById = {};
  state.approvals = [];
  state.subagents = [
    {
      id: 'main',
      name: 'Agent',
      workspace: ARTIFACT_WORKSPACE_ROOT,
      model: 'mock/default',
      skills: [],
      isDefault: true,
    },
  ];
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

  if ((path === '/api/subagents/list' || path === '/api/subagents/config/get') && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy subagent read route is disabled; use /api/capabilities/execute with an agent target' }, 400, false);
  }

  if (path === '/api/provider-models/selectable' && method === 'GET') {
    return toSuccessEnvelope({
      models: [
        {
          credentialId: 'mock',
          providerKey: 'mock',
          runtimeModelRef: 'mock/default',
          label: 'Mock',
          modelId: 'default',
          capabilities: ['chat'],
        },
      ],
    });
  }

  if (path === '/api/openclaw/config-dir' && method === 'GET') {
    return toSuccessEnvelope('/tmp/openclaw-config');
  }

  if (path === '/api/runtime-adapters/list' && method === 'GET') {
    return toSuccessEnvelope({
      adapters: [{ runtimeAdapterId: 'openclaw', protocolId: 'openclaw-v4', endpointIds: ['openclaw-local'] }],
    });
  }

  if (path === '/api/runtime-adapters/instances/list' && method === 'GET') {
    return toSuccessEnvelope({
      instances: [{ runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local', endpointId: 'openclaw-local', agentIds: ['main'] }],
    });
  }

  if (path === '/api/runtime-connectors/list' && method === 'GET') {
    return toSuccessEnvelope({ connectors: [] });
  }

  if (path === '/api/runtime-endpoints/list' && method === 'GET') {
    return toSuccessEnvelope({ endpoints: [buildRuntimeEndpointSummary()] });
  }

  if (path === '/api/capabilities/list' && method === 'GET') {
    return toSuccessEnvelope({ capabilities: buildRuntimeEndpointCapabilitySummaries() });
  }

  if (path === '/api/sessions/list' && method === 'POST') {
    const payload = parseJsonBody(request.body);
    const agentId = getAgentIdFromScope(payload.scope) ?? 'main';
    return toSuccessEnvelope({
      sessions: state.sessions
        .map((session) => makeCatalog(session.key))
        .filter((session) => session.agentId === agentId),
      ready: true,
      refreshing: false,
      updatedAt: Date.now(),
      error: null,
    });
  }

  if (path === '/api/sessions/create' && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session mutation route is disabled; use /api/capabilities/execute with a session target' }, 400, false);
  }

  if (path === '/api/sessions/window' && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session hydration route is disabled; use /api/capabilities/execute with a session target' }, 400, false);
  }

  if (path === '/api/sessions/load' && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session mutation route is disabled; use /api/capabilities/execute with a session target' }, 400, false);
  }

  if ((path === '/api/sessions/switch' || path === '/api/sessions/resume') && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session mutation route is disabled; use /api/capabilities/execute with a session target' }, 400, false);
  }

  if (path === '/api/sessions/state' && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session hydration route is disabled; use /api/capabilities/execute with a session target' }, 400, false);
  }

  if (path === '/api/sessions/abort' && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session mutation route is disabled; use /api/capabilities/execute with a session target' }, 400, false);
  }

  if (path === '/api/sessions/approvals' && method === 'POST') {
    return toSuccessEnvelope({
      success: true,
      approvals: state.approvals.map((approval) => ({
        id: approval.id,
        sessionKey: approval.sessionKey,
        sessionIdentity: sessionIdentityForSession(approval.sessionKey),
        runId: approval.runId,
        title: approval.title,
        command: approval.command,
        allowedDecisions: approval.allowedDecisions,
        createdAtMs: approval.createdAt,
      })),
    });
  }

  if (path === '/api/sessions/approval/resolve' && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session mutation route is disabled; use /api/capabilities/execute with an approval target' }, 400, false);
  }

  if (path === '/api/sessions/prompt' && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy session mutation route is disabled; use /api/capabilities/execute with a session target' }, 400, false);
  }

  if (path === '/api/capabilities/execute' && method === 'POST') {
    const payload = parseJsonBody(request.body);

    if (payload.id === 'session.management' && payload.operationId === 'sessions.list') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.management', 'sessions.list');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({
        sessions: state.sessions.map((session) => makeCatalog(session.key)),
        ready: true,
        refreshing: false,
        updatedAt: Date.now(),
        error: null,
      });
    }

    if (payload.id === 'subagent.management' && payload.operationId === 'subagents.list') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'subagent.management', 'subagents.list');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({
        agents: state.subagents,
        defaultId: 'main',
        mainKey: 'agent:main',
        scope: 'e2e',
        ready: true,
        refreshing: false,
        updatedAt: Date.now(),
        error: null,
      });
    }

    if (payload.id === 'subagent.management' && payload.operationId === 'subagents.config.get') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'subagent.management', 'subagents.config.get');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({
        ready: true,
        config: {
          defaultModel: 'mock/default',
          defaultWorkspace: ARTIFACT_WORKSPACE_ROOT,
          agents: {
            list: state.subagents.map((agent) => ({
              id: agent.id,
              default: agent.isDefault,
              model: agent.model,
              workspace: agent.workspace,
              skills: agent.skills,
            })),
          },
        },
      });
    }

    if (payload.id === 'runtime.host' && payload.operationId === 'runtimeHost.gatewayReady') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'runtime.host', 'runtimeHost.gatewayReady');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({ success: true, phase: 'ready', retryable: false, requiredMethods: [], missingMethods: [] });
    }

    if (payload.id === 'runtime.host' && payload.operationId === 'runtimeHost.gatewayControlUiAutoApprove') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'runtime.host', 'runtimeHost.gatewayControlUiAutoApprove');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({ success: true, approvedRequestIds: [] });
    }

    if (payload.id === 'runtime.host' && payload.operationId === 'runtimeHost.jobGet') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'runtime.host', 'runtimeHost.jobGet');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const jobId = typeof requestPayload.input.jobId === 'string' ? requestPayload.input.jobId : '';
      return toSuccessEnvelope({
        success: true,
        job: jobId ? {
          id: jobId,
          type: 'mock.runtimeJob',
          status: 'succeeded',
          queuedAt: Date.now(),
          attempts: 1,
          maxAttempts: 1,
        } : null,
      });
    }

    if (payload.id === 'runtime.host' && payload.operationId === 'diagnostics.collect') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'runtime.host', 'diagnostics.collect');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({
        success: true,
        job: {
          id: `job-diagnostics-${Date.now()}`,
          type: 'diagnostics.collect',
          status: 'succeeded',
          queuedAt: Date.now(),
          attempts: 1,
          maxAttempts: 1,
          result: {
            zipPath: 'C:\\mock\\diagnostics.zip',
            generatedAt: new Date().toISOString(),
            fileCount: 3,
          },
        },
      }, 202);
    }

    if (payload.id === 'session.management' && payload.operationId === 'sessions.window') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.management', 'sessions.window');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const sessionKey = typeof requestPayload.input.sessionKey === 'string' ? requestPayload.input.sessionKey : (getSessionKeyFromScope(requestPayload.scope) ?? state.mainSessionKey);
      return toSuccessEnvelope({
        snapshot: buildSnapshotForSession(sessionKey),
      });
    }

    if (payload.id === 'session.prompt' && payload.operationId === 'sessions.create') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.prompt', 'sessions.create');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const scopedAgentId = getAgentIdFromScope(requestPayload.scope);
      const agentId = scopedAgentId && scopedAgentId.trim()
        ? scopedAgentId.trim()
        : 'main';
      const sessionKey = `agent:${agentId}:session-${Date.now()}-${++state.counter}`;
      ensureSession(sessionKey, sessionKey);
      return toSuccessEnvelope({
        success: true,
        sessionKey,
        snapshot: buildSnapshotForSession(sessionKey),
      });
    }

    if (payload.id === 'session.prompt' && payload.operationId === 'sessions.load') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.prompt', 'sessions.load');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const sessionKey = typeof requestPayload.input.sessionKey === 'string' ? requestPayload.input.sessionKey : (getSessionKeyFromScope(requestPayload.scope) ?? state.mainSessionKey);
      return toSuccessEnvelope({
        snapshot: buildSnapshotForSession(sessionKey),
      });
    }

    if (payload.id === 'session.management' && (payload.operationId === 'sessions.switch' || payload.operationId === 'sessions.resume' || payload.operationId === 'sessions.state')) {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.management', payload.operationId);
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const sessionKey = typeof requestPayload.input.sessionKey === 'string' ? requestPayload.input.sessionKey : (getSessionKeyFromScope(requestPayload.scope) ?? state.mainSessionKey);
      return toSuccessEnvelope({
        snapshot: buildSnapshotForSession(sessionKey),
      });
    }

    if (payload.id === 'session.prompt' && payload.operationId === 'sessions.abort') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.prompt', 'sessions.abort');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const sessionKey = typeof requestPayload.input.sessionKey === 'string' ? requestPayload.input.sessionKey : (getSessionKeyFromScope(requestPayload.scope) ?? state.mainSessionKey);
      const run = findLatestRunningRunBySession(sessionKey);
      if (run) {
        emitAborted(run.runId, sessionKey);
      }
      return toSuccessEnvelope({
        success: true,
        snapshot: buildSnapshotForSession(sessionKey),
      });
    }

    if (payload.id === 'session.approval' && payload.operationId === 'approvals.list') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.approval', 'approvals.list');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({
        success: true,
        approvals: state.approvals.map((approval) => ({
          id: approval.id,
          sessionKey: approval.sessionKey,
          sessionIdentity: sessionIdentityForSession(approval.sessionKey),
          runId: approval.runId,
          title: approval.title,
          command: approval.command,
          allowedDecisions: approval.allowedDecisions,
          createdAtMs: approval.createdAt,
        })),
      });
    }

    if (payload.id === 'session.approval' && payload.operationId === 'approvals.resolve') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.approval', 'approvals.resolve');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const approvalId = typeof requestPayload.input.id === 'string' ? requestPayload.input.id : '';
      const approval = state.approvals.find((item) => item.id === approvalId);
      if (!approval) {
        return toSuccessEnvelope({ success: false, error: 'approval_not_found' }, 404, false);
      }
      state.approvals = state.approvals.filter((item) => item.id !== approvalId);
      emitHostEvent('gateway:notification', {
        method: 'exec.approval.resolved',
        params: {
          approvalId,
          id: approvalId,
          sessionKey: approval.sessionKey,
          runId: approval.runId,
        },
      });
      setTimeout(() => emitFinal(approval.runId, approval.sessionKey, 'Approved result'), 40);
      return toSuccessEnvelope({ success: true });
    }

    if (payload.id === 'session.prompt' && payload.operationId === 'sessions.sendWithMedia') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.prompt', 'sessions.sendWithMedia');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const sessionKey = typeof requestPayload.input.sessionKey === 'string' ? requestPayload.input.sessionKey : (getSessionKeyFromScope(requestPayload.scope) ?? state.mainSessionKey);
      const message = typeof requestPayload.input.message === 'string' ? requestPayload.input.message : 'Process attachment';
      const result = createRun(sessionKey, message, 'default');
      return toSuccessEnvelope({
        success: true,
        result,
      });
    }

    if (payload.id === 'workspace.file' && ['files.readText', 'files.readBinary', 'files.stat', 'files.listDir', 'files.thumbnail'].includes(String(payload.operationId))) {
      const requestPayload = requireCapabilityExecutePayload(payload, 'workspace.file', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const targetPath = isRecord(requestPayload.target) && requestPayload.target.kind === 'workspace-file' && typeof requestPayload.target.path === 'string'
        ? requestPayload.target.path
        : '';
      const inputPath = typeof requestPayload.input.path === 'string' ? requestPayload.input.path : '';
      if (!targetPath || targetPath !== inputPath) {
        return toSuccessEnvelope({ success: false, error: 'Workspace file target path must match input path' }, 400, false);
      }
      const filePath = inputPath;
      if (payload.operationId === 'files.stat') {
        const stat = MOCK_FILE_STATS.get(filePath);
        return toSuccessEnvelope(stat ? {
          ok: true,
          entry: {
            name: filePath.split(/[\\/]/).pop() || filePath,
            path: filePath,
            isDir: stat.isDir,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          },
        } : { ok: false, error: 'notFound' });
      }
      if (payload.operationId === 'files.readText') {
        const content = MOCK_TEXT_FILES.get(filePath);
        return toSuccessEnvelope(typeof content === 'string' ? {
          ok: true,
          path: filePath,
          content,
          mimeType: filePath.endsWith('.md') ? 'text/markdown' : 'text/typescript',
          size: content.length,
          readOnly: true,
        } : { ok: false, error: 'notFound' });
      }
      if (payload.operationId === 'files.readBinary') {
        if (filePath === MOCK_REPORT_FILE) {
          return toSuccessEnvelope({ ok: true, path: filePath, data: buildMockPdfBase64(), mimeType: 'application/pdf', size: 128, readOnly: true });
        }
        if (filePath === MOCK_SHEET_FILE) {
          return toSuccessEnvelope({ ok: true, path: filePath, data: cachedWorkbookBase64 ?? '', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 256, readOnly: true });
        }
        return toSuccessEnvelope({ ok: false, error: 'notFound' });
      }
      if (payload.operationId === 'files.listDir') {
        if (filePath === ARTIFACT_WORKSPACE_ROOT) {
          return toSuccessEnvelope({
            ok: true,
            entries: [
              { name: 'demo.ts', path: MOCK_GENERATED_FILE, isDir: false, size: 24, mtimeMs: 1, hasChildren: false },
              { name: 'report.pdf', path: MOCK_REPORT_FILE, isDir: false, size: 128, mtimeMs: 1, hasChildren: false },
              { name: 'sales.xlsx', path: MOCK_SHEET_FILE, isDir: false, size: 256, mtimeMs: 1, hasChildren: false },
            ],
          });
        }
        if (filePath === MOCK_SKILL_DIR) {
          return toSuccessEnvelope({ ok: true, entries: [{ name: 'SKILL.md', path: MOCK_SKILL_FILE, isDir: false, size: 40, mtimeMs: 1, hasChildren: false }] });
        }
        return toSuccessEnvelope({ ok: false, error: 'notFound' });
      }
      return toSuccessEnvelope({ preview: null, fileSize: MOCK_FILE_STATS.get(filePath)?.size ?? 0 });
    }

    if (payload.id === 'workspace.file' && payload.operationId === 'files.stagePaths') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'workspace.file', 'files.stagePaths');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const filePaths = Array.isArray(requestPayload.input.filePaths) ? requestPayload.input.filePaths : [];
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

    if (payload.id === 'workspace.file' && payload.operationId === 'files.stageBuffer') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'workspace.file', 'files.stageBuffer');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const fileName = typeof requestPayload.input.fileName === 'string' ? requestPayload.input.fileName : 'buffer-file.txt';
      const mimeType = typeof requestPayload.input.mimeType === 'string' ? requestPayload.input.mimeType : 'application/octet-stream';
      return toSuccessEnvelope({
        id: `staged-buffer-${Date.now()}`,
        fileName,
        mimeType,
        fileSize: 16,
        stagedPath: `C:\\mock\\${fileName}`,
        preview: null,
      });
    }

    if (payload.id === 'session.prompt' && payload.operationId === 'sessions.prompt') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.prompt', 'sessions.prompt');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const sessionKey = typeof requestPayload.input.sessionKey === 'string' ? requestPayload.input.sessionKey : (getSessionKeyFromScope(requestPayload.scope) ?? state.mainSessionKey);
      const message = typeof requestPayload.input.message === 'string' ? requestPayload.input.message : '';
      const mode: MockRun['mode'] = message.includes('[approval]')
        ? 'approval'
        : (message.includes('[long]') ? 'long' : 'default');
      const result = createRun(sessionKey, message || '(empty)', mode);
      return toSuccessEnvelope({
        success: true,
        sessionKey,
        runId: result.runId,
        item: null,
        snapshot: buildSnapshotForSession(sessionKey),
      });
    }

    return toSuccessEnvelope({ success: false, error: 'Capability execution not supported' }, 400, false);
  }

  if (path.startsWith('/api/files/') && method === 'POST') {
    return toSuccessEnvelope({ success: false, error: 'Legacy file route is disabled; use /api/capabilities/execute with a workspace-file target' }, 400, false);
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
