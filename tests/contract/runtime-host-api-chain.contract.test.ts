import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRuntimeHostApiHarness, type RuntimeHostApiHarness } from './helpers/runtime-host-api-harness';
import type { CapabilityTarget, RuntimeScope, SessionIdentity } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeEndpointSummary } from '../../runtime-host/shared/runtime-topology';
import { openClawTestRuntimeEndpoint } from '../unit/helpers/runtime-address-fixtures';

type SessionWindowContractResult = {
  snapshot: {
    items: Array<{ key: string; kind: string; messageId?: string; turnKey?: string }>;
    window: {
      totalItemCount?: number;
      windowStartOffset: number;
      windowEndOffset: number;
      hasMore: boolean;
      hasNewer: boolean;
      isAtLatest: boolean;
    };
  };
  hydrationJob?: { id: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrapRuntimeJobResult(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }
  if ('data' in result) {
    return unwrapRuntimeJobResult(result.data);
  }
  if ('value' in result) {
    return unwrapRuntimeJobResult(result.value);
  }
  return result;
}

function readSessionWindowResult(result: unknown): SessionWindowContractResult | null {
  const unwrapped = unwrapRuntimeJobResult(result);
  if (!isRecord(unwrapped)) {
    return null;
  }
  const snapshot = normalizeSessionWindowSnapshot(unwrapped.snapshot);
  return snapshot ? { snapshot } : null;
}

function normalizeSessionWindowSnapshot(value: unknown): SessionWindowContractResult['snapshot'] | null {
  if (!isRecord(value)) {
    return null;
  }
  if (isRecord(value.window)) {
    return value as SessionWindowContractResult['snapshot'];
  }
  return normalizeSessionWindowSnapshot(value.snapshot);
}

function requireSessionWindowResult(result: SessionWindowContractResult): SessionWindowContractResult {
  const snapshot = normalizeSessionWindowSnapshot(result.snapshot);
  if (!snapshot) {
    throw new Error(`Invalid session window result: ${JSON.stringify(result)}`);
  }
  return { ...result, snapshot };
}

const openClawRuntimeInstanceScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: openClawTestRuntimeEndpoint,
};

function createOpenClawSessionIdentity(sessionKey: string, agentId = 'main'): SessionIdentity {
  return {
    endpoint: openClawTestRuntimeEndpoint,
    agentId,
    sessionKey,
  };
}

function createOpenClawCapabilityPayload(
  capabilityId: string,
  operationId: string,
  target: CapabilityTarget | null,
  input: Record<string, unknown>,
  scope: RuntimeScope = openClawRuntimeInstanceScope,
) {
  return {
    id: capabilityId,
    operationId,
    scope,
    target,
    input,
  };
}

async function dispatchSessionWindow(
  harness: RuntimeHostApiHarness,
  input: {
    sessionKey: string;
    sessionIdentity: SessionIdentity;
    mode: 'latest' | 'older' | 'newer';
    limit: number;
    offset?: number;
  },
): Promise<SessionWindowContractResult> {
  return await harness.dispatchOk<SessionWindowContractResult>(
    'POST',
    '/api/capabilities/execute',
    createOpenClawCapabilityPayload(
      'session.management',
      'sessions.window',
      { kind: 'session', identity: input.sessionIdentity },
      input,
      { kind: 'session', identity: input.sessionIdentity },
    ),
  );
}

async function readOpenClawEndpointSummary(harness: RuntimeHostApiHarness): Promise<RuntimeEndpointSummary> {
  const topology = await harness.dispatchOk<{ endpoints: RuntimeEndpointSummary[] }>('GET', '/api/runtime-endpoints/list');
  const endpoint = topology.endpoints.find((item) => item.runtimeAdapterId === 'openclaw' && item.runtimeInstanceId === 'local');
  if (!endpoint) {
    throw new Error(`OpenClaw endpoint summary not found: ${JSON.stringify(topology)}`);
  }
  return endpoint;
}

async function readRuntimeCapabilityScope(harness: RuntimeHostApiHarness, capabilityId: string): Promise<RuntimeScope> {
  const endpoint = await readOpenClawEndpointSummary(harness);
  const capability = endpoint.capabilitySummaries.find((item) => item.id === capabilityId && item.scope.kind === 'runtime-instance');
  if (!capability) {
    throw new Error(`Runtime capability summary not found: ${capabilityId}`);
  }
  return capability.scope;
}

async function readTeamRunCapabilityScope(harness: RuntimeHostApiHarness, runId: string): Promise<RuntimeScope> {
  const teamScope: RuntimeScope = {
    kind: 'team-run',
    endpoint: openClawTestRuntimeEndpoint,
    runId,
  };
  const capability = await harness.dispatchOk<{ capability: { scope: RuntimeScope } }>(
    'POST',
    '/api/capabilities/describe',
    { id: 'team.runtime', scope: teamScope },
  );
  return capability.capability.scope;
}

describe('runtime-host API 真实链路 contract', { timeout: 20000 }, () => {
  let harness: RuntimeHostApiHarness | null = null;

  beforeAll(async () => {
    harness = await createRuntimeHostApiHarness({
      enabledPluginIds: ['task-manager', 'team-runtime'],
      pluginCatalog: [
        {
          id: 'task-manager',
          name: 'Task Manager',
          version: '1.0.0',
          kind: 'third-party',
          category: 'workflow',
        },
        {
          id: 'team-runtime',
          name: 'Team Runtime',
          version: '1.0.0',
          kind: 'third-party',
          category: 'workflow',
        },
      ],
      gatewayMethods: [
        'agents.list',
        'agents.create',
        'agents.update',
        'agents.delete',
        'agents.files.set',
      ],
      gatewayHandler: ({ method, params }) => {
        const body = isRecord(params) ? params : {};
        if (method === 'agents.list') {
          return { agents: [] };
        }
        if (method === 'agents.create') {
          return { agentId: typeof body.name === 'string' ? body.name : 'agent' };
        }
        return { ok: true };
      },
    });
  }, 20000);

  afterAll(async () => {
    await harness?.stop();
  });

  it('provider accounts 通过 /dispatch 完成增删查与校验', async () => {
    const modelProviderScope = await readRuntimeCapabilityScope(harness, 'model.provider');
    const created = await harness.dispatchOk<{ success: boolean; job: { id: string } }>(
      'POST',
      '/api/capabilities/execute',
      createOpenClawCapabilityPayload('model.provider', 'providers.createAccount', {
        kind: 'provider-account',
        accountId: 'openai-main',
        vendorId: 'openai',
      }, {
        account: {
          id: 'openai-main',
          vendorId: 'openai',
          label: 'OpenAI 主账号',
          authMode: 'api_key',
        },
        apiKey: 'sk-test-001',
      }, modelProviderScope),
    );
    expect(created.success).toBe(true);
    const createResult = await harness.waitForJob<{ account?: { id: string }; credential?: { id: string } }>(created.job.id);
    expect((createResult.credential ?? createResult.account)?.id).toBe('openai-main');

    const listed = await harness.dispatchOk<{
      credentials: Array<{ id: string }>;
      statuses: Array<{ id: string; hasKey: boolean }>;
    }>('GET', '/api/provider-accounts');
    expect(listed.credentials.some((item) => item.id === 'openai-main')).toBe(true);
    expect(listed.statuses.some((item) => item.id === 'openai-main' && item.hasKey)).toBe(true);

    const validated = await harness.dispatchOk<{ valid: boolean }>(
      'POST',
      '/api/capabilities/execute',
      createOpenClawCapabilityPayload('model.provider', 'providers.validate', {
        kind: 'provider-credential',
        accountId: 'ollama',
        vendorId: 'ollama',
      }, {
        vendorId: 'ollama',
        apiKey: '',
      }, modelProviderScope),
    );
    expect(validated.valid).toBe(true);
  });

  it('channels 配置链路通过 /dispatch 生效并可读回', async () => {
    const channelScope = await readRuntimeCapabilityScope(harness, 'integration.channel');
    const saved = await harness.dispatchOk<{ success: boolean; job: { id: string } }>(
      'POST',
      '/api/capabilities/execute',
      createOpenClawCapabilityPayload('integration.channel', 'channels.activate', {
        kind: 'channel',
        channelType: 'wecom',
        accountId: 'default',
      }, {
        channelType: 'wecom',
        accountId: 'default',
        enabled: true,
        config: {
          botId: 'wecom-bot-1',
          secret: 'wecom-secret-1',
        },
      }, channelScope),
    );
    expect(saved.success).toBe(true);
    await harness.waitForJob(saved.job.id);

    const snapshot = await harness.dispatchOk<{
      success: boolean;
      snapshot: { channelOrder: string[] };
    }>(
      'GET',
      '/api/channels/snapshot',
    );
    expect(snapshot.success).toBe(true);
    expect(snapshot.snapshot.channelOrder).toContain('wecom');

    const openclawConfig = JSON.parse(readFileSync(join(harness.paths.openclawConfigDir, 'openclaw.json'), 'utf8')) as {
      channels?: { wecom?: { accounts?: { default?: { botId?: string } } } };
    };
    expect(openclawConfig.channels?.wecom?.accounts?.default?.botId).toBe('wecom-bot-1');
  });

  it('plugins 运行态和目录均由 API 暴露，不依赖内部 import', async () => {
    const runtime = await harness.dispatchOk<{
      success: boolean;
      execution: { enabledPluginIds: string[] };
    }>('GET', '/api/plugins/runtime');
    expect(runtime.success).toBe(true);
    expect(runtime.execution.enabledPluginIds).toContain('task-manager');

    const catalog = await harness.dispatchOk<{
      success: boolean;
      plugins: Array<{ id: string; enabled: boolean }>;
    }>('GET', '/api/plugins/catalog');
    expect(catalog.success).toBe(true);
    expect(catalog.plugins).toContainEqual(expect.objectContaining({
      id: 'task-manager',
      enabled: true,
    }));
  });

  it('security 策略通过 API 读写并标准化落盘', async () => {
    const beforePolicy = await harness.dispatchOk<{ preset: string; securityPolicyVersion: number }>(
      'GET',
      '/api/security',
    );
    expect(typeof beforePolicy.preset).toBe('string');
    expect(typeof beforePolicy.securityPolicyVersion).toBe('number');

    const securityScope = await readRuntimeCapabilityScope(harness, 'security.runtime');
    const updated = await harness.dispatchOk<{
      success: boolean;
      policy?: { preset: string; securityPolicyVersion: number };
      error?: string;
    }>('POST', '/api/capabilities/execute', createOpenClawCapabilityPayload('security.runtime', 'security.writePolicy', {
      kind: 'security-policy',
      policyId: 'runtime',
    }, {
      preset: 'strict',
      securityPolicyVersion: 7,
      runtime: {
        auditDailyCostLimitUsd: 12,
      },
    }, securityScope));
    if (!updated.success) {
      expect(typeof updated.error).toBe('string');
    }

    const afterPolicy = await harness.dispatchOk<{ preset: string; securityPolicyVersion: number }>(
      'GET',
      '/api/security',
    );
    expect(afterPolicy.preset).toBe('strict');
    expect(afterPolicy.securityPolicyVersion).toBe(7);

    const catalog = await harness.dispatchOk<{ success: boolean; items: unknown[] }>(
      'GET',
      '/api/security/destructive-rule-catalog?platform=windows',
    );
    expect(catalog.success).toBe(true);
    expect(Array.isArray(catalog.items)).toBe(true);
    expect(catalog.items.length).toBeGreaterThan(0);
  });

  it('team runtime capability 通过 API 创建并读取 TeamRun snapshot', async () => {
    const runId = 'team-api-chain';
    const teamScope = await readRuntimeCapabilityScope(harness, 'team.runtime');
    const teamCapabilityPayload = (
      operationId: string,
      target: CapabilityTarget,
      input: Record<string, unknown>,
      scope: RuntimeScope = teamScope,
    ) => createOpenClawCapabilityPayload('team.runtime', operationId, target, input, scope);

    await harness.dispatchOk<{ teamId: string; managedAgentCount: number }>(
      'POST',
      '/api/capabilities/execute',
      teamCapabilityPayload('team.provisionAgents', {
        kind: 'team',
        packagePath: resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0'),
      }, {
        packagePath: resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0'),
        idempotencyKey: `${runId}:provision-agents`,
      }),
    );

    const created = await harness.dispatchOk<{ runId: string; status: string }>(
      'POST',
      '/api/capabilities/execute',
      teamCapabilityPayload('team.runCreate', {
        kind: 'team',
        packagePath: resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0'),
      }, {
        runId,
        packagePath: resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0'),
        idempotencyKey: `${runId}:create`,
      }),
    );
    expect(created, JSON.stringify(created)).toMatchObject({ runId, status: 'created' });

    const teamRunScope = await readTeamRunCapabilityScope(harness, runId);

    const snapshot = await harness.dispatchOk<{
      run: { runId: string; status: string } | null;
      roles: unknown[];
      dispatchTasks: unknown[];
      events: Array<{ type: string }>;
    }>(
      'POST',
      '/api/capabilities/execute',
      teamCapabilityPayload('team.runSnapshot', {
        kind: 'team-run',
        runId,
      }, { runId, eventLimit: 20 }, teamRunScope),
    );
    expect(snapshot.run?.runId).toBe(runId);
    expect(snapshot.roles.length).toBeGreaterThan(0);
    expect(snapshot.dispatchTasks).toEqual([]);
    expect(snapshot.events).toEqual([]);
  });

  it('openclaw workspace 与 usage 历史通过 API 返回', async () => {
    const defaultWorkspace = resolve(join(harness.paths.openclawConfigDir, 'workspace-main'));
    const workerWorkspace = resolve(join(harness.paths.openclawConfigDir, 'workspace-worker'));
    writeFileSync(
      join(harness.paths.openclawConfigDir, 'openclaw.json'),
      `${JSON.stringify({
        agents: {
          defaults: {
            workspace: defaultWorkspace,
          },
          list: [
            { id: 'main', workspace: defaultWorkspace, isDefault: true },
            { id: 'worker-1', workspace: workerWorkspace },
          ],
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const workspaceDir = await harness.dispatchOk<string>('GET', '/api/openclaw/workspace-dir');
    expect(workspaceDir).toBe(defaultWorkspace);

    const taskWorkspaceDirs = await harness.dispatchOk<string[]>(
      'GET',
      '/api/openclaw/task-workspace-dirs',
    );
    expect(taskWorkspaceDirs).toContain(defaultWorkspace);
    expect(taskWorkspaceDirs).toContain(workerWorkspace);

    const sessionsDir = join(harness.paths.openclawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'session-1.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-06T10:00:00.000Z',
          message: {
            role: 'assistant',
            provider: 'openai',
            model: 'gpt-5.4',
            usage: {
              input: 10,
              output: 5,
              total: 15,
              cost: { total: 0.0015 },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await harness.dispatchOk<Array<{ totalTokens: number; provider?: string }>>(
      'GET',
      '/api/runtime-host/usage/recent?limit=5',
    );
    const usageJobs = await harness.dispatchOk<{ jobs: Array<{ id: string; type: string }> }>(
      'GET',
      '/api/runtime-host/jobs?type=usage.refreshHistory',
    );
    const refreshJob = usageJobs.jobs.at(-1);
    expect(refreshJob?.id).toBeTruthy();
    await harness.waitForJob(refreshJob?.id);
    const usage = await harness.dispatchOk<Array<{ totalTokens: number; provider?: string }>>(
      'GET',
      '/api/runtime-host/usage/recent?limit=5',
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]?.totalTokens).toBe(15);
    expect(usage[0]?.provider).toBe('openai');
  });

  it('sessions/window 通过 runtime-host 返回真实消息窗口', async () => {
    const sessionsDir = join(harness.paths.openclawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        sessions: [
          { key: 'agent:main:session-window', id: 'session-window' },
        ],
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, 'session-window.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-06T10:00:00.000Z',
          message: { role: 'user', id: 'm1', content: 'hello-1' },
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-06T10:01:00.000Z',
          message: { role: 'assistant', id: 'm2', content: 'hello-2' },
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-06T10:02:00.000Z',
          message: { role: 'user', id: 'm3', content: 'hello-3' },
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-06T10:03:00.000Z',
          message: { role: 'assistant', id: 'm4', content: 'hello-4' },
        }),
      ].join('\n'),
      'utf8',
    );

    const sessionIdentity = createOpenClawSessionIdentity('agent:main:session-window');
    const initialLatest = await dispatchSessionWindow(harness, {
      sessionKey: 'agent:main:session-window',
      sessionIdentity,
      mode: 'latest',
      limit: 2,
    });
    const latest = requireSessionWindowResult(initialLatest.hydrationJob
      ? await harness.waitForJob(initialLatest.hydrationJob.id).then(async (result) => readSessionWindowResult(result) ?? await dispatchSessionWindow(harness, {
          sessionKey: 'agent:main:session-window',
          sessionIdentity,
          mode: 'latest',
          limit: 2,
        }))
      : initialLatest);
    expect(latest.snapshot.window.totalItemCount).toBe(4);
    expect(latest.snapshot.window.windowStartOffset).toBe(2);
    expect(latest.snapshot.window.windowEndOffset).toBe(4);
    expect(latest.snapshot.window.hasMore).toBe(true);
    expect(latest.snapshot.window.hasNewer).toBe(false);
    expect(latest.snapshot.window.isAtLatest).toBe(true);
    expect(latest.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-window|user:message:user:main:m3',
      'session:agent:main:session-window|assistant-turn:main:message:assistant:main:m4',
    ]);

    const initialOlder = await dispatchSessionWindow(harness, {
      sessionKey: 'agent:main:session-window',
      sessionIdentity,
      mode: 'older',
      limit: 2,
      offset: latest.snapshot.window.windowStartOffset,
    });
    const older = requireSessionWindowResult(initialOlder.hydrationJob
      ? await harness.waitForJob(initialOlder.hydrationJob.id).then(async (result) => readSessionWindowResult(result) ?? await dispatchSessionWindow(harness, {
          sessionKey: 'agent:main:session-window',
          sessionIdentity,
          mode: 'older',
          limit: 2,
          offset: latest.snapshot.window.windowStartOffset,
        }))
      : initialOlder);
    expect(older.snapshot.window.windowStartOffset).toBe(0);
    expect(older.snapshot.window.windowEndOffset).toBe(4);
    expect(older.snapshot.window.hasMore).toBe(false);
    expect(older.snapshot.window.hasNewer).toBe(false);
    expect(older.snapshot.window.isAtLatest).toBe(true);
    expect(older.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-window|user:message:user:main:m1',
      'session:agent:main:session-window|assistant-turn:main:message:assistant:main:m2',
      'session:agent:main:session-window|user:message:user:main:m3',
      'session:agent:main:session-window|assistant-turn:main:message:assistant:main:m4',
    ]);
  });
});
