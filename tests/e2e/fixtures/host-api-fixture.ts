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
  description?: string;
  workspace: string;
  model?: string;
  skills?: string[];
  isDefault: boolean;
};

type MockMessage = {
  role: 'user' | 'assistant';
  id: string;
  content: string;
  timestamp: number;
  attachedFiles?: Array<{
    fileName: string;
    mimeType: string;
    fileSize: number;
    preview: string | null;
  }>;
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

type MockRuntimeJob = {
  id: string;
  type: string;
  status: 'succeeded' | 'failed';
  queuedAt: number;
  attempts: number;
  maxAttempts: number;
  result?: unknown;
  error?: string;
};

interface E2EChatMockState {
  sessions: MockSession[];
  histories: Record<string, MockMessage[]>;
  approvals: MockApproval[];
  runsById: Record<string, MockRun>;
  runtimeJobs: Record<string, MockRuntimeJob>;
  mainSessionKey: string;
  historySessionKey: string;
  artifactSessionKey: string;
  activeTeamRunId: string;
  counter: number;
  subagents: MockSubagent[];
  subagentConfigRevision: number;
  subagentConfigUpdatedAt: number | null;
}

const isE2EMode = process.env.MATCHACLAW_E2E === '1';

const state: E2EChatMockState = {
  sessions: [],
  histories: {},
  approvals: [],
  runsById: {},
  runtimeJobs: {},
  mainSessionKey: 'agent:main:main',
  historySessionKey: '',
  artifactSessionKey: '',
  activeTeamRunId: 'team-run-main',
  counter: 0,
  subagents: [],
  subagentConfigRevision: 0,
  subagentConfigUpdatedAt: null,
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
  if (scope.kind === 'agent' && typeof scope.agentId === 'string') {
    return scope.agentId;
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
  const subagentScope: RuntimeScope = { kind: 'agent', endpoint: OPENCLAW_ENDPOINT, agentId: 'main' };
  const teamRuntimeScope = teamRunScope(state.activeTeamRunId ?? 'team-run-main');
  const workspaceScope: RuntimeScope = { kind: 'workspace', endpoint: OPENCLAW_ENDPOINT };
  return [
    buildCapabilitySummary('session.prompt', subagentScope, ['agent', 'session'], [
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
    buildCapabilitySummary('subagent.management', subagentScope, ['agent', 'subagent'], [
      { id: 'subagents.list', targetKind: 'agent' },
      { id: 'subagents.displayConfig.get', targetKind: 'agent' },
      { id: 'subagents.description.set', targetKind: 'subagent' },
      { id: 'subagents.model.set', targetKind: 'subagent' },
      { id: 'subagents.skills.set', targetKind: 'subagent' },
      { id: 'subagents.create', targetKind: 'subagent' },
      { id: 'subagents.update', targetKind: 'subagent' },
      { id: 'subagents.delete', targetKind: 'subagent' },
      { id: 'subagents.files.get', targetKind: 'subagent' },
      { id: 'subagents.files.set', targetKind: 'subagent' },
      { id: 'subagents.files.list', targetKind: 'subagent' },
    ]),
    buildCapabilitySummary('agent.skill-config', subagentScope, ['subagent'], [
      { id: 'agentSkillConfig.get', targetKind: 'subagent' },
      { id: 'agentSkillConfig.set', targetKind: 'subagent' },
    ]),
    buildCapabilitySummary('agent.tool-config', subagentScope, ['subagent'], [
      { id: 'agentToolConfig.get', targetKind: 'subagent' },
      { id: 'agentToolConfig.set', targetKind: 'subagent' },
    ]),
    buildCapabilitySummary('team.runtime', runtimeScope, ['team', 'team-run', 'team-approval'], [
      { id: 'team.runCreate', targetKind: 'team' },
    ]),
    buildCapabilitySummary('team.runtime', teamRuntimeScope, ['team-run', 'team-approval'], [
      { id: 'team.runSnapshot', targetKind: 'team-run' },
      { id: 'team.graphPatch', targetKind: 'team-run' },
      { id: 'team.approvalResolve', targetKind: 'team-approval' },
      { id: 'team.runDelete', targetKind: 'team-run' },
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
    buildCapabilitySummary('model.provider', runtimeScope, ['none', 'provider-account', 'provider-credential', 'provider-oauth', 'capability-route'], [
      { id: 'providers.listAccounts', targetKind: 'none' },
      { id: 'providers.getAccount', targetKind: 'provider-account' },
      { id: 'providers.getApiKey', targetKind: 'provider-credential' },
      { id: 'providers.validate', targetKind: 'provider-credential' },
      { id: 'providers.createAccount', targetKind: 'provider-account' },
      { id: 'providers.updateAccount', targetKind: 'provider-account' },
      { id: 'providers.deleteAccount', targetKind: 'provider-account' },
      { id: 'providers.oauthStart', targetKind: 'provider-oauth' },
      { id: 'providers.oauthCancel', targetKind: 'provider-oauth' },
      { id: 'providers.oauthSubmit', targetKind: 'provider-oauth' },
      { id: 'providerModels.list', targetKind: 'none' },
      { id: 'providerModels.listSelectable', targetKind: 'none' },
      { id: 'providerModels.get', targetKind: 'provider-credential' },
      { id: 'providerModels.replace', targetKind: 'provider-credential' },
      { id: 'capabilityRouting.read', targetKind: 'none' },
      { id: 'capabilityRouting.write', targetKind: 'capability-route' },
    ]),
    buildCapabilitySummary('skill.management', runtimeScope, ['none', 'skill', 'skill-bundle'], [
      { id: 'skills.refreshStatus', targetKind: 'none' },
      { id: 'skills.updateState', targetKind: 'skill' },
      { id: 'skills.updateBatchState', targetKind: 'skill' },
      { id: 'skills.importLocal', targetKind: 'skill' },
      { id: 'clawhub.install', targetKind: 'skill' },
      { id: 'clawhub.uninstall', targetKind: 'skill' },
    ]),
    buildCapabilitySummary('scheduler.cron', runtimeScope, ['cron-job'], [
      { id: 'cron.create', targetKind: 'cron-job' },
      { id: 'cron.update', targetKind: 'cron-job' },
      { id: 'cron.delete', targetKind: 'cron-job' },
      { id: 'cron.toggle', targetKind: 'cron-job' },
      { id: 'cron.trigger', targetKind: 'cron-job' },
    ]),
    buildCapabilitySummary('integration.channel', runtimeScope, ['none', 'channel', 'channel-pairing'], [
      { id: 'channels.probe', targetKind: 'none' },
      { id: 'channels.activate', targetKind: 'channel' },
      { id: 'channels.connect', targetKind: 'channel' },
      { id: 'channels.disconnect', targetKind: 'channel' },
      { id: 'channels.requestQr', targetKind: 'channel-pairing' },
      { id: 'channels.cancelSession', targetKind: 'channel-pairing' },
      { id: 'channels.approvePairing', targetKind: 'channel-pairing' },
      { id: 'channels.deleteConfig', targetKind: 'channel' },
    ]),
    buildCapabilitySummary('session.modelSelection', { kind: 'session', identity: sessionIdentityForSession(state.mainSessionKey) }, ['model-selection'], [
      { id: 'sessions.patchModel', targetKind: 'model-selection' },
    ]),
    buildCapabilitySummary('tool.invoke', { kind: 'session', identity: sessionIdentityForSession(state.mainSessionKey) }, ['tool'], [
      { id: 'tools.invoke', targetKind: 'tool' },
    ]),
    buildCapabilitySummary('task.control', { kind: 'session', identity: sessionIdentityForSession(state.mainSessionKey) }, ['task'], [
      { id: 'tasks.output', targetKind: 'task' },
      { id: 'tasks.stop', targetKind: 'task' },
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

function subagentConfigRevision(): string {
  return `e2e-subagent-config-${state.subagentConfigRevision}`;
}

function buildSubagentDisplayConfigSnapshot() {
  return {
    agents: state.subagents.map((agent) => ({
      id: agent.id,
      ...(agent.description ? { description: agent.description } : {}),
      workspace: agent.workspace,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.skills ? { skills: agent.skills } : {}),
    })),
    defaults: {
      workspace: ARTIFACT_WORKSPACE_ROOT,
      model: 'mock/default',
      skills: [],
    },
    revision: subagentConfigRevision(),
    ready: true,
    refreshing: false,
    updatedAt: state.subagentConfigUpdatedAt,
    error: null,
  };
}

function buildSubagentConfigMutationSnapshot() {
  return {
    config: {
      agents: clone(state.subagents),
      defaults: {
        workspace: ARTIFACT_WORKSPACE_ROOT,
        model: 'mock/default',
        skills: [],
      },
    },
    revision: subagentConfigRevision(),
    updatedAt: state.subagentConfigUpdatedAt,
  };
}

function touchSubagentConfigState(): void {
  state.subagentConfigRevision += 1;
  state.subagentConfigUpdatedAt = Date.now();
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

const MOCK_CREATED_AT = '2026-07-01T09:00:00.000Z';
const MOCK_UPDATED_AT = '2026-07-05T18:00:00.000Z';

function createMockRuntimeJob(type: string, result: unknown): MockRuntimeJob {
  const job: MockRuntimeJob = {
    id: `job-${type.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}-${++state.counter}`,
    type,
    status: 'succeeded',
    queuedAt: Date.now(),
    attempts: 1,
    maxAttempts: 1,
    result,
  };
  state.runtimeJobs[job.id] = job;
  return job;
}

function buildMockRuntimeJobSubmission(type: string, result: unknown) {
  return {
    success: true,
    job: createMockRuntimeJob(type, result),
  };
}

function buildMockProviderCredentials() {
  return [
    {
      id: 'anthropic-work',
      vendorId: 'anthropic',
      label: 'Anthropic 工作账号',
      authMode: 'api_key',
      enabled: true,
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
    },
    {
      id: 'ollama-local',
      vendorId: 'ollama',
      label: 'Ollama 本地模型',
      authMode: 'local',
      baseUrl: 'http://localhost:11434/v1',
      enabled: true,
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
    },
    {
      id: 'custom-media',
      vendorId: 'custom',
      providerKind: 'media',
      label: '自定义多模态接口',
      authMode: 'api_key',
      baseUrl: 'https://mock.local/v1',
      mediaApiProtocol: 'openai',
      enabled: true,
      metadata: { customModels: ['image-e2e', 'tts-e2e'] },
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
    },
  ];
}

function buildMockProviderStatuses() {
  return [
    {
      id: 'anthropic-work',
      name: 'Anthropic 工作账号',
      type: 'anthropic',
      enabled: true,
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
      hasKey: true,
      keyMasked: 'sk-ant-****-E2E1',
    },
    {
      id: 'ollama-local',
      name: 'Ollama 本地模型',
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      enabled: true,
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
      hasKey: true,
      keyMasked: 'local',
    },
    {
      id: 'custom-media',
      name: '自定义多模态接口',
      type: 'custom',
      baseUrl: 'https://mock.local/v1',
      enabled: true,
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
      hasKey: true,
      keyMasked: 'mock-****-E2E2',
    },
  ];
}

function buildMockProviderVendors() {
  return [
    {
      id: 'anthropic',
      name: 'Anthropic',
      icon: '🤖',
      placeholder: 'sk-ant-api03-...',
      model: 'Claude',
      modelCapabilities: ['chat', 'imageUnderstand'],
      requiresApiKey: true,
      category: 'official',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: true,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      icon: '💚',
      placeholder: 'sk-proj-...',
      model: 'GPT',
      modelCapabilities: ['chat', 'imageUnderstand', 'imageGenerate', 'tts', 'transcribe'],
      requiresApiKey: true,
      category: 'official',
      supportedAuthModes: ['api_key', 'oauth_browser'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: true,
    },
    {
      id: 'ollama',
      name: 'Ollama',
      icon: '🦙',
      placeholder: 'Not required',
      model: 'Local',
      modelCapabilities: ['chat'],
      requiresApiKey: false,
      defaultBaseUrl: 'http://localhost:11434/v1',
      showBaseUrl: true,
      category: 'local',
      supportedAuthModes: ['local'],
      defaultAuthMode: 'local',
      supportsMultipleAccounts: false,
    },
    {
      id: 'custom',
      name: 'Custom',
      icon: '⚙️',
      placeholder: 'API key...',
      model: 'Custom',
      modelCapabilities: ['chat', 'imageGenerate', 'videoGenerate', 'musicGenerate', 'tts'],
      requiresApiKey: true,
      showBaseUrl: true,
      category: 'custom',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: true,
    },
  ];
}

function buildMockProviderSnapshot() {
  return {
    credentials: buildMockProviderCredentials(),
    statuses: buildMockProviderStatuses(),
    vendors: buildMockProviderVendors(),
  };
}

function buildMockProviderModels() {
  return [
    {
      credentialId: 'anthropic-work',
      label: 'Anthropic',
      modelId: 'claude-opus-4-8',
      capabilities: ['chat', 'imageUnderstand'],
      contextWindow: 200000,
      maxTokens: 32000,
      timeoutMs: 120000,
    },
    {
      credentialId: 'anthropic-work',
      label: 'Anthropic',
      modelId: 'claude-sonnet-4-6',
      capabilities: ['chat', 'imageUnderstand'],
      contextWindow: 200000,
      maxTokens: 16000,
      timeoutMs: 90000,
    },
    {
      credentialId: 'ollama-local',
      label: 'Ollama',
      modelId: 'qwen2.5-coder:7b',
      capabilities: ['chat'],
      contextWindow: 32768,
      maxTokens: 4096,
      timeoutMs: 60000,
    },
    {
      credentialId: 'custom-media',
      label: '自定义多模态接口',
      modelId: 'image-e2e',
      capabilities: ['imageGenerate'],
      timeoutMs: 120000,
      aspectRatio: '16:9',
      resolution: '1024x1024',
      quality: 'standard',
    },
    {
      credentialId: 'custom-media',
      label: '自定义多模态接口',
      modelId: 'tts-e2e',
      capabilities: ['tts'],
      timeoutMs: 60000,
    },
  ];
}

function buildMockSelectableProviderModels() {
  return buildMockProviderModels().map((model) => {
    const credential = buildMockProviderCredentials().find((item) => item.id === model.credentialId);
    const providerKey = typeof credential?.vendorId === 'string' ? credential.vendorId : model.credentialId;
    return {
      ...model,
      providerKey,
      runtimeModelRef: `${providerKey}/${model.modelId}`,
    };
  });
}

function buildMockCapabilityRouting() {
  return {
    chat: {
      primary: { credentialId: 'anthropic-work', modelId: 'claude-opus-4-8' },
      fallbacks: [{ credentialId: 'ollama-local', modelId: 'qwen2.5-coder:7b' }],
      timeoutMs: 120000,
    },
    imageUnderstand: {
      primary: { credentialId: 'anthropic-work', modelId: 'claude-sonnet-4-6' },
      fallbacks: [],
      timeoutMs: 90000,
    },
    imageGenerate: {
      primary: { credentialId: 'custom-media', modelId: 'image-e2e' },
      fallbacks: [],
      timeoutMs: 120000,
    },
    videoGenerate: {
      primary: { credentialId: 'custom-media', modelId: 'image-e2e' },
      fallbacks: [],
      timeoutMs: 120000,
    },
    musicGenerate: {
      primary: { credentialId: 'custom-media', modelId: 'image-e2e' },
      fallbacks: [],
      timeoutMs: 120000,
    },
    tts: {
      primary: { credentialId: 'custom-media', modelId: 'tts-e2e' },
      fallbacks: [],
      timeoutMs: 60000,
    },
  };
}

function buildMockSkillsStatus() {
  return {
    skills: [
      {
        skillKey: 'browser-flow-create',
        slug: 'browser-flow-create',
        name: 'Browser Flow Create',
        description: '生成浏览器自动化流程并沉淀页面能力。',
        disabled: false,
        emoji: '🧭',
        version: '1.0.0',
        author: 'MatchaClaw',
        bundled: true,
        installed: true,
        eligible: true,
        source: 'bundled',
        baseDir: '~/.claude/skills/browser-flow-create',
        filePath: '~/.claude/skills/browser-flow-create/SKILL.md',
      },
      {
        skillKey: 'software-copyright-materials',
        slug: 'software-copyright-materials',
        name: '软件著作权资料整理',
        description: '整理申请表、代码材料和操作手册草稿。',
        disabled: false,
        emoji: '📄',
        version: '1.0.0',
        author: 'MatchaClaw',
        bundled: false,
        installed: true,
        eligible: true,
        source: 'user',
        baseDir: '~/.claude/skills/software-copyright-materials',
        filePath: '~/.claude/skills/software-copyright-materials/SKILL.md',
      },
      {
        skillKey: 'code-review-checklist',
        slug: 'code-review-checklist',
        name: '代码审核清单',
        description: '按安全、可维护性和测试覆盖检查变更。',
        disabled: true,
        emoji: '✅',
        version: '0.3.0',
        author: 'OpenClaw',
        bundled: false,
        installed: true,
        eligible: true,
        source: 'marketplace',
      },
    ],
    ready: true,
    refreshing: false,
    updatedAt: Date.now(),
    error: null,
  };
}

function buildMockMarketplaceSearchResult() {
  return {
    success: true,
    results: [
      {
        slug: 'browser-automation-atlas',
        name: 'Browser Automation Atlas',
        description: '沉淀网页能力图谱并生成自动化脚本。',
        version: '1.2.0',
        author: 'OpenClaw',
        downloads: 1280,
        stars: 96,
      },
      {
        slug: 'desktop-e2e-recorder',
        name: 'Desktop E2E Recorder',
        description: '为桌面应用采集可复现的端到端测试动作。',
        version: '0.8.1',
        author: 'MatchaClaw',
        downloads: 842,
        stars: 58,
      },
    ],
  };
}

function buildMockCronJobs() {
  return [
    {
      id: 'cron-daily-material-check',
      name: '每日软著材料巡检',
      agentId: 'main',
      message: '检查代码材料、截图清单和操作手册草稿是否齐备。',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      delivery: { mode: 'announce', channel: 'feishu', to: '软著资料群', accountId: 'feishu-main' },
      enabled: true,
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
      lastRun: { time: '2026-07-05T09:00:00.000Z', success: true, duration: 18 },
      nextRun: '2026-07-06T09:00:00.000Z',
    },
    {
      id: 'cron-weekly-session-summary',
      name: '每周会话摘要',
      agentId: 'main',
      message: '汇总本周关键会话和待办任务。',
      schedule: { kind: 'cron', expr: '0 18 * * 5', tz: 'Asia/Shanghai' },
      delivery: { mode: 'none' },
      enabled: false,
      createdAt: MOCK_CREATED_AT,
      updatedAt: MOCK_UPDATED_AT,
      nextRun: '2026-07-10T18:00:00.000Z',
    },
  ];
}

function buildMockChannelSnapshot() {
  const now = Date.now();
  return {
    channelOrder: ['dingtalk', 'feishu', 'qqbot', 'openclaw-weixin'],
    channels: {
      dingtalk: { configured: true, running: true, connected: true, lastProbeAt: now, probe: { ok: true } },
      feishu: { configured: true, running: true, connected: true, lastProbeAt: now, probe: { ok: true } },
      qqbot: { configured: true, running: false, connected: false, lastProbeAt: now, probe: { ok: true } },
      'openclaw-weixin': { configured: true, running: true, connected: true, linked: true, lastProbeAt: now, probe: { ok: true } },
    },
    channelAccounts: {
      dingtalk: [
        { accountId: 'dingtalk-main', name: '钉钉通知机器人', configured: true, connected: true, running: true, lastConnectedAt: now, lastInboundAt: now - 60_000, lastOutboundAt: now - 30_000, probe: { ok: true } },
      ],
      feishu: [
        { accountId: 'feishu-main', name: '飞书软著资料群', configured: true, connected: true, running: true, linked: true, lastConnectedAt: now, lastInboundAt: now - 90_000, lastOutboundAt: now - 45_000, probe: { ok: true } },
      ],
      qqbot: [
        { accountId: 'qqbot-main', name: 'QQ Bot 备用通道', configured: true, connected: false, running: false, lastProbeAt: now, probe: { ok: true } },
      ],
      'openclaw-weixin': [
        { accountId: 'wechat-main', name: '微信扫码通道', configured: true, connected: true, running: true, linked: true, lastConnectedAt: now, probe: { ok: true } },
      ],
    },
    channelDefaultAccountId: {
      dingtalk: 'dingtalk-main',
      feishu: 'feishu-main',
      qqbot: 'qqbot-main',
      'openclaw-weixin': 'wechat-main',
    },
  };
}

function buildMockAgentSkillConfigView(agentId: string) {
  const skillOptions = buildMockSkillsStatus().skills.map((skill) => ({
    skillKey: skill.skillKey,
    displayName: skill.name,
    description: skill.description,
    installed: skill.installed !== false,
    selectable: skill.eligible !== false && skill.disabled !== true,
  }));
  const defaultSkillKeys = skillOptions.filter((skill) => skill.selectable).slice(0, 2).map((skill) => skill.skillKey);
  return {
    agentId,
    support: { supportType: 'supported' },
    selectionMode: 'inheritsDefaultSkills',
    explicitSkillKeys: [],
    inheritedDefaultSkillKeys: defaultSkillKeys,
    effectiveSkillKeys: defaultSkillKeys,
    options: skillOptions,
    revision: `e2e-agent-skill-${agentId}-1`,
    updatedAt: Date.now(),
  };
}

function buildMockAgentToolConfigView(agentId: string) {
  const toolOptions = [
    {
      toolKey: 'Read',
      displayName: 'Read',
      optionType: 'tool',
      description: '读取工作区文件。',
      source: 'core',
      risk: 'low',
      tags: ['filesystem'],
      defaultProfiles: ['fullAccess', 'review'],
    },
    {
      toolKey: 'Edit',
      displayName: 'Edit',
      optionType: 'tool',
      description: '修改工作区文件。',
      source: 'core',
      risk: 'medium',
      tags: ['filesystem'],
      defaultProfiles: ['fullAccess'],
    },
    {
      toolKey: 'Bash',
      displayName: 'Bash',
      optionType: 'tool',
      description: '执行本地命令。',
      source: 'core',
      risk: 'high',
      tags: ['terminal'],
      defaultProfiles: ['fullAccess'],
    },
  ];
  return {
    agentId,
    support: { supportType: 'supported' },
    selectionMode: 'inheritsDefaultTools',
    toolPolicy: null,
    toolProfiles: [
      { profileKey: 'fullAccess', displayName: 'Full Access' },
      { profileKey: 'review', displayName: 'Review Only' },
    ],
    toolGroups: [
      {
        groupKey: 'core-tools',
        displayName: '核心工具',
        source: 'core',
        toolOptions,
      },
    ],
    toolOptions,
    revision: `e2e-agent-tool-${agentId}-1`,
    updatedAt: Date.now(),
  };
}

function buildMockTaskListSnapshot(sessionKey: string) {
  const now = Date.now();
  return {
    scope: {
      type: 'session',
      key: sessionKey,
      label: 'Main',
      sessionKey,
      agentId: agentIdFromSessionKey(sessionKey),
    },
    tasks: [
      {
        id: 'task-code-material',
        subject: '整理前后端逻辑代码',
        description: '抽取前后端各 1750 行核心逻辑片段。',
        status: 'in_progress',
        owner: 'Agent',
        activeForm: '正在整理代码材料',
        blockedBy: [],
        blocks: ['task-screenshot-audit'],
        createdAt: now - 3_600_000,
        updatedAt: now - 120_000,
      },
      {
        id: 'task-screenshot-audit',
        subject: '审核桌面 E2E 截图',
        description: '确认截图无调试窗口、无错误态并对应代码模块。',
        status: 'pending',
        owner: 'Reviewer',
        blockedBy: ['task-code-material'],
        blocks: [],
        createdAt: now - 2_400_000,
        updatedAt: now - 300_000,
      },
    ],
    todos: [
      { id: 'todo-code', content: '代码片段来源清单已生成', status: 'completed', owner: 'Agent' },
      { id: 'todo-screenshot', content: '复核截图质量并补入操作手册', status: 'in_progress', activeForm: '正在复核截图', owner: 'Reviewer' },
    ],
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
  message: Pick<MockMessage, 'role' | 'content' | 'attachedFiles'>,
): MockMessage {
  ensureSession(sessionKey);
  const nextMessage: MockMessage = {
    role: message.role,
    content: message.content,
    ...(message.attachedFiles ? { attachedFiles: message.attachedFiles } : {}),
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
            attachedFiles: message.attachedFiles ?? [],
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
  state.subagentConfigRevision = 0;
  state.subagentConfigUpdatedAt = null;
  state.runsById = {};
  state.runtimeJobs = {};
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
  const forceSetupIncomplete = process.env.MATCHACLAW_E2E_SETUP_INCOMPLETE === '1';

  if (path === '/api/gateway/status') {
    return toSuccessEnvelope(buildMockGatewayStatus());
  }

  if (path === '/api/settings' && method === 'GET') {
    return toSuccessEnvelope({
      setupComplete: !forceSetupIncomplete,
      theme: 'light',
      language: 'zh-CN',
      gatewayAutoStart: true,
      browserMode: 'relay',
      proxyEnabled: false,
    });
  }

  if (path === '/api/settings/setupComplete') {
    if (method === 'GET') {
      return toSuccessEnvelope({ value: !forceSetupIncomplete });
    }
    if (method === 'PUT') {
      return toSuccessEnvelope({ success: true });
    }
  }

  if (path === '/api/license/stored-key' && method === 'GET') {
    return toSuccessEnvelope({ masked: forceSetupIncomplete ? null : 'MATC******-****-****-****-EP86' });
  }

  if (path === '/api/license/gate' && method === 'GET') {
    if (forceSetupIncomplete) {
      return toSuccessEnvelope({
        state: 'blocked',
        reason: 'e2e-setup',
        checkedAtMs: Date.now(),
        hasStoredKey: false,
        hasUsableCache: false,
        nextRevalidateAtMs: null,
      });
    }
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
    return toSuccessEnvelope({ models: buildMockSelectableProviderModels() });
  }

  if (path === '/api/skills/status' && method === 'GET') {
    return toSuccessEnvelope(buildMockSkillsStatus());
  }

  if (path === '/api/clawhub/search' && method === 'POST') {
    return toSuccessEnvelope(buildMockMarketplaceSearchResult());
  }

  if (path === '/api/cron/jobs' && method === 'GET') {
    return toSuccessEnvelope({
      success: true,
      jobs: buildMockCronJobs(),
      ready: true,
      refreshing: false,
      updatedAt: Date.now(),
      error: null,
    });
  }

  if (path === '/api/channels/snapshot' && method === 'GET') {
    return toSuccessEnvelope({
      success: true,
      snapshot: buildMockChannelSnapshot(),
      ready: true,
      refreshing: false,
      updatedAt: Date.now(),
      error: null,
    });
  }

  if (path.startsWith('/api/channels/config/') && method === 'GET') {
    const channelType = decodeURIComponent(path.replace('/api/channels/config/', '').split('/')[0] || 'feishu');
    return toSuccessEnvelope({
      success: true,
      values: {
        channelType,
        clientId: 'mock-client-id',
        appId: 'mock-app-id',
        webhookUrl: 'https://mock.local/webhook',
      },
    });
  }

  if (path.startsWith('/api/channels/pairing/') && method === 'GET') {
    return toSuccessEnvelope({
      success: true,
      requests: [
        {
          id: 'pairing-request-1',
          code: 'E2E123',
          createdAt: MOCK_CREATED_AT,
          lastSeenAt: MOCK_UPDATED_AT,
          meta: { source: 'desktop-e2e' },
        },
      ],
    });
  }

  if (path === '/api/channels/credentials/validate' && method === 'POST') {
    return toSuccessEnvelope({ success: true, valid: true, errors: [], warnings: [] });
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

    if (payload.id === 'subagent.management' && payload.operationId === 'subagents.displayConfig.get') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'subagent.management', 'subagents.displayConfig.get');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope(buildSubagentDisplayConfigSnapshot());
    }

    if (payload.id === 'subagent.management' && payload.operationId === 'subagents.description.set') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'subagent.management', 'subagents.description.set');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const agentId = typeof requestPayload.input.agentId === 'string' ? requestPayload.input.agentId : '';
      const description = typeof requestPayload.input.description === 'string' && requestPayload.input.description.trim()
        ? requestPayload.input.description.trim()
        : undefined;
      state.subagents = state.subagents.map((agent) => {
        if (agent.id !== agentId) {
          return agent;
        }
        const nextAgent = { ...agent };
        if (description === undefined) {
          delete nextAgent.description;
        } else {
          nextAgent.description = description;
        }
        return nextAgent;
      });
      touchSubagentConfigState();
      return toSuccessEnvelope(buildSubagentConfigMutationSnapshot());
    }

    if (payload.id === 'subagent.management' && payload.operationId === 'subagents.model.set') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'subagent.management', 'subagents.model.set');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const agentId = typeof requestPayload.input.agentId === 'string' ? requestPayload.input.agentId : '';
      const model = typeof requestPayload.input.model === 'string' && requestPayload.input.model.trim()
        ? requestPayload.input.model.trim()
        : undefined;
      state.subagents = state.subagents.map((agent) => {
        if (agent.id !== agentId) {
          return agent;
        }
        const nextAgent = { ...agent };
        if (model === undefined) {
          delete nextAgent.model;
        } else {
          nextAgent.model = model;
        }
        return nextAgent;
      });
      touchSubagentConfigState();
      return toSuccessEnvelope(buildSubagentConfigMutationSnapshot());
    }

    if (payload.id === 'subagent.management' && payload.operationId === 'subagents.skills.set') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'subagent.management', 'subagents.skills.set');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const agentId = typeof requestPayload.input.agentId === 'string' ? requestPayload.input.agentId : '';
      const skills = Array.isArray(requestPayload.input.skills)
        ? requestPayload.input.skills.filter((skill): skill is string => typeof skill === 'string' && skill.trim()).map((skill) => skill.trim())
        : undefined;
      state.subagents = state.subagents.map((agent) => {
        if (agent.id !== agentId) {
          return agent;
        }
        const nextAgent = { ...agent };
        if (skills === undefined) {
          delete nextAgent.skills;
        } else {
          nextAgent.skills = skills;
        }
        return nextAgent;
      });
      touchSubagentConfigState();
      return toSuccessEnvelope(buildSubagentConfigMutationSnapshot());
    }

    if (payload.id === 'agent.skill-config') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'agent.skill-config', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const agentId = typeof requestPayload.input.agentId === 'string'
        ? requestPayload.input.agentId
        : (isRecord(requestPayload.target) && typeof requestPayload.target.subagentId === 'string' ? requestPayload.target.subagentId : 'main');
      const view = buildMockAgentSkillConfigView(agentId);
      if (payload.operationId === 'agentSkillConfig.get') {
        return toSuccessEnvelope(view);
      }
      if (payload.operationId === 'agentSkillConfig.set') {
        return toSuccessEnvelope({ resultType: 'updated', view });
      }
    }

    if (payload.id === 'agent.tool-config') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'agent.tool-config', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const agentId = typeof requestPayload.input.agentId === 'string'
        ? requestPayload.input.agentId
        : (isRecord(requestPayload.target) && typeof requestPayload.target.subagentId === 'string' ? requestPayload.target.subagentId : 'main');
      const view = buildMockAgentToolConfigView(agentId);
      if (payload.operationId === 'agentToolConfig.get') {
        return toSuccessEnvelope(view);
      }
      if (payload.operationId === 'agentToolConfig.set') {
        return toSuccessEnvelope({ resultType: 'updated', view });
      }
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
      const storedJob = jobId ? state.runtimeJobs[jobId] : null;
      return toSuccessEnvelope({
        success: true,
        job: storedJob ?? (jobId ? {
          id: jobId,
          type: 'mock.runtimeJob',
          status: 'succeeded',
          queuedAt: Date.now(),
          attempts: 1,
          maxAttempts: 1,
        } : null),
      });
    }

    if (payload.id === 'runtime.host' && payload.operationId === 'diagnostics.collect') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'runtime.host', 'diagnostics.collect');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope(buildMockRuntimeJobSubmission('diagnostics.collect', {
        zipPath: 'C:\\mock\\diagnostics.zip',
        generatedAt: new Date().toISOString(),
        fileCount: 3,
      }), 202);
    }

    if (payload.id === 'model.provider') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'model.provider', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      if (payload.operationId === 'providers.listAccounts') {
        return toSuccessEnvelope(buildMockProviderSnapshot());
      }
      if (payload.operationId === 'providers.getAccount') {
        const accountId = typeof requestPayload.input.accountId === 'string' ? requestPayload.input.accountId : '';
        const account = buildMockProviderCredentials().find((item) => item.id === accountId);
        return toSuccessEnvelope(account ? {
          baseUrl: account.baseUrl,
          apiProtocol: account.apiProtocol,
          headers: account.headers,
        } : null);
      }
      if (payload.operationId === 'providers.getApiKey') {
        return toSuccessEnvelope({ hasKey: true, keyMasked: 'mock-****-E2E', last4: 'E2E' });
      }
      if (payload.operationId === 'providers.validate') {
        return toSuccessEnvelope({ valid: true });
      }
      if (['providers.createAccount', 'providers.updateAccount', 'providers.deleteAccount'].includes(String(payload.operationId))) {
        return toSuccessEnvelope(buildMockRuntimeJobSubmission(String(payload.operationId), { success: true }));
      }
      if (['providers.oauthStart', 'providers.oauthCancel', 'providers.oauthSubmit'].includes(String(payload.operationId))) {
        return toSuccessEnvelope({ success: true });
      }
      if (payload.operationId === 'providerModels.list') {
        return toSuccessEnvelope({ models: buildMockProviderModels() });
      }
      if (payload.operationId === 'providerModels.listSelectable') {
        return toSuccessEnvelope({ models: buildMockSelectableProviderModels() });
      }
      if (payload.operationId === 'providerModels.get') {
        const accountId = isRecord(requestPayload.target) && typeof requestPayload.target.accountId === 'string'
          ? requestPayload.target.accountId
          : '';
        return toSuccessEnvelope({ models: buildMockProviderModels().filter((model) => model.credentialId === accountId) });
      }
      if (payload.operationId === 'providerModels.replace') {
        return toSuccessEnvelope({
          success: true,
          credentialId: typeof requestPayload.input.credentialId === 'string' ? requestPayload.input.credentialId : '',
          models: Array.isArray(requestPayload.input.models) ? requestPayload.input.models : [],
        });
      }
      if (payload.operationId === 'capabilityRouting.read') {
        return toSuccessEnvelope(buildMockCapabilityRouting());
      }
      if (payload.operationId === 'capabilityRouting.write') {
        return toSuccessEnvelope({ success: true, routing: requestPayload.input });
      }
    }

    if (payload.id === 'skill.management') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'skill.management', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      if (payload.operationId === 'skills.refreshStatus') {
        return toSuccessEnvelope(buildMockSkillsStatus());
      }
      if (payload.operationId === 'skills.updateBatchState') {
        const updated = Array.isArray(requestPayload.input.skillKeys)
          ? requestPayload.input.skillKeys.filter((item): item is string => typeof item === 'string')
          : [];
        return toSuccessEnvelope({ success: true, updated });
      }
      if (payload.operationId === 'skills.updateState') {
        return toSuccessEnvelope(buildMockRuntimeJobSubmission('skills.updateState', { success: true }));
      }
      if (payload.operationId === 'skills.importLocal') {
        const sourcePath = typeof requestPayload.input.sourcePath === 'string' ? requestPayload.input.sourcePath : 'local-skill';
        const skillKey = sourcePath.split(/[\\/]/).pop()?.trim() || 'local-skill';
        return toSuccessEnvelope(buildMockRuntimeJobSubmission('skills.importLocal', { success: true, skillKey }));
      }
      if (['clawhub.install', 'clawhub.uninstall'].includes(String(payload.operationId))) {
        return toSuccessEnvelope(buildMockRuntimeJobSubmission(String(payload.operationId), { success: true }));
      }
    }

    if (payload.id === 'scheduler.cron') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'scheduler.cron', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      if (payload.operationId === 'cron.create') {
        const job = {
          id: `cron-e2e-${Date.now()}`,
          name: typeof requestPayload.input.name === 'string' ? requestPayload.input.name : 'E2E 定时任务',
          agentId: typeof requestPayload.input.agentId === 'string' ? requestPayload.input.agentId : 'main',
          message: typeof requestPayload.input.message === 'string' ? requestPayload.input.message : '执行 E2E 定时任务',
          schedule: typeof requestPayload.input.schedule === 'string' ? requestPayload.input.schedule : '0 9 * * *',
          delivery: isRecord(requestPayload.input.delivery) ? requestPayload.input.delivery : { mode: 'none' },
          enabled: requestPayload.input.enabled !== false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          nextRun: '2026-07-06T09:00:00.000Z',
        };
        return toSuccessEnvelope(buildMockRuntimeJobSubmission('cron.create', job));
      }
      if (payload.operationId === 'cron.trigger') {
        return toSuccessEnvelope(buildMockRuntimeJobSubmission('cron.trigger', { ok: true, ran: true }));
      }
      if (['cron.update', 'cron.delete', 'cron.toggle'].includes(String(payload.operationId))) {
        return toSuccessEnvelope(buildMockRuntimeJobSubmission(String(payload.operationId), { success: true }));
      }
    }

    if (payload.id === 'integration.channel') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'integration.channel', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      if (payload.operationId === 'channels.requestQr') {
        return toSuccessEnvelope({
          success: true,
          qrCode: 'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22180%22 height=%22180%22%3E%3Crect width=%22180%22 height=%22180%22 fill=%22white%22/%3E%3Crect x=%2230%22 y=%2230%22 width=%2240%22 height=%2240%22 fill=%22black%22/%3E%3Crect x=%22110%22 y=%2230%22 width=%2240%22 height=%2240%22 fill=%22black%22/%3E%3Crect x=%2230%22 y=%22110%22 width=%2240%22 height=%2240%22 fill=%22black%22/%3E%3Ctext x=%2290%22 y=%2298%22 text-anchor=%22middle%22 font-size=%2218%22%3EE2E%3C/text%3E%3C/svg%3E',
          sessionId: 'channel-session-e2e',
        });
      }
      if (['channels.connect', 'channels.disconnect', 'channels.approvePairing'].includes(String(payload.operationId))) {
        return toSuccessEnvelope({ success: true, approved: { id: 'pairing-request-1' } });
      }
      if (['channels.probe', 'channels.activate', 'channels.deleteConfig', 'channels.cancelSession'].includes(String(payload.operationId))) {
        return toSuccessEnvelope(buildMockRuntimeJobSubmission(String(payload.operationId), { success: true }));
      }
    }

    if (payload.id === 'session.modelSelection' && payload.operationId === 'sessions.patchModel') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'session.modelSelection', 'sessions.patchModel');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const sessionKey = typeof requestPayload.input.sessionKey === 'string'
        ? requestPayload.input.sessionKey
        : (getSessionKeyFromScope(requestPayload.scope) ?? state.mainSessionKey);
      const runtimeModelRef = typeof requestPayload.input.runtimeModelRef === 'string' ? requestPayload.input.runtimeModelRef : 'mock/default';
      return toSuccessEnvelope({
        success: true,
        sessionKey,
        model: runtimeModelRef,
        snapshot: buildSnapshotForSession(sessionKey),
      });
    }

    if (payload.id === 'tool.invoke' && payload.operationId === 'tools.invoke') {
      const requestPayload = requireCapabilityExecutePayload(payload, 'tool.invoke', 'tools.invoke');
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      const methodName = typeof requestPayload.input.method === 'string' ? requestPayload.input.method : '';
      const params = isRecord(requestPayload.input.params) ? requestPayload.input.params : {};
      const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : state.mainSessionKey;
      const taskSnapshot = buildMockTaskListSnapshot(sessionKey);
      if (methodName === 'TaskList') {
        return toSuccessEnvelope(taskSnapshot);
      }
      if (methodName === 'TaskGet') {
        const taskId = typeof params.taskId === 'string' ? params.taskId : '';
        return toSuccessEnvelope({ task: taskSnapshot.tasks.find((task) => task.id === taskId) ?? null });
      }
      if (methodName === 'TaskCreate') {
        const task = {
          id: `task-e2e-${Date.now()}`,
          subject: typeof params.subject === 'string' ? params.subject : 'E2E Task',
          description: typeof params.description === 'string' ? params.description : '',
          status: 'pending',
          activeForm: typeof params.activeForm === 'string' ? params.activeForm : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return toSuccessEnvelope({ task, todos: taskSnapshot.todos });
      }
      if (methodName === 'TaskUpdate') {
        const taskId = typeof params.taskId === 'string' ? params.taskId : 'task-code-material';
        const baseTask = taskSnapshot.tasks.find((task) => task.id === taskId) ?? taskSnapshot.tasks[0];
        return toSuccessEnvelope({ task: { ...baseTask, ...params, id: taskId, updatedAt: Date.now() }, todos: taskSnapshot.todos });
      }
      if (methodName === 'TodoWrite') {
        const todos = Array.isArray(params.newTodos) ? params.newTodos : taskSnapshot.todos;
        return toSuccessEnvelope({ todos, updatedAt: Date.now() });
      }
      if (methodName === 'TodoGet') {
        return toSuccessEnvelope({ todos: taskSnapshot.todos, updatedAt: Date.now() });
      }
    }

    if (payload.id === 'task.control' && ['tasks.output', 'tasks.stop'].includes(String(payload.operationId))) {
      const requestPayload = requireCapabilityExecutePayload(payload, 'task.control', String(payload.operationId));
      if ('ok' in requestPayload) {
        return requestPayload;
      }
      return toSuccessEnvelope({ success: true, stopped: payload.operationId === 'tasks.stop', output: 'E2E task output' });
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
      const attachedFiles = Array.isArray(requestPayload.input.media)
        ? requestPayload.input.media.flatMap((media) => {
            if (!isRecord(media)
              || typeof media.fileName !== 'string'
              || typeof media.mimeType !== 'string'
              || typeof media.fileSize !== 'number') {
              return [];
            }
            return [{
              fileName: media.fileName,
              mimeType: media.mimeType,
              fileSize: media.fileSize,
              preview: typeof media.preview === 'string' ? media.preview : null,
            }];
          })
        : [];
      const userMessage = appendMessage(sessionKey, { role: 'user', content: message, attachedFiles });
      const runId = `run-${Date.now()}-${++state.counter}`;
      state.runsById[runId] = { runId, sessionKey, userText: message, mode: 'default', status: 'running' };
      setTimeout(() => emitRunStarted(runId, sessionKey), 10);
      setTimeout(() => emitDelta(runId, sessionKey, 'Mock streaming...'), 40);
      setTimeout(() => emitFinal(runId, sessionKey, `Mock reply: ${message}`), 900);
      const snapshot = buildSnapshotForSession(sessionKey);
      return toSuccessEnvelope({
        success: true,
        runId,
        sessionKey,
        item: snapshot.items.find((item) => item.kind === 'user-message' && item.messageId === userMessage.id) ?? null,
        snapshot,
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


export function getE2EDialogStagedAttachments(): Array<{
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
}> | null {
  if (!isE2EMode) {
    return null;
  }
  return [{
    id: 'e2e-notes-txt',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    fileSize: 18,
    stagedPath: 'e2e://attachments/notes.txt',
    preview: null,
  }];
}

export function getE2EGatewayStatus(): MockGatewayStatus | null {
  if (!isE2EMode) {
    return null;
  }
  return buildMockGatewayStatus();
}
