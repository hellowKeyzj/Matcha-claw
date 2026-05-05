import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRuntimeHostApiHarness, type RuntimeHostApiHarness } from './helpers/runtime-host-api-harness';

describe('runtime-host API 真实链路 contract', () => {
  let harness: RuntimeHostApiHarness;

  beforeAll(async () => {
    harness = await createRuntimeHostApiHarness({
      enabledPluginIds: ['task-manager'],
      pluginCatalog: [
        {
          id: 'task-manager',
          name: 'Task Manager',
          version: '1.0.0',
          kind: 'third-party',
          category: 'workflow',
        },
      ],
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('provider accounts 通过 /dispatch 完成增删查与校验', async () => {
    const created = await harness.dispatchOk<{ success: boolean; account: { id: string; vendorId: string } }>(
      'POST',
      '/api/provider-accounts',
      {
        account: {
          id: 'openai-main',
          vendorId: 'openai',
          label: 'OpenAI 主账号',
          authMode: 'api_key',
        },
        apiKey: 'sk-test-001',
      },
    );
    expect(created.success).toBe(true);
    expect(created.account.id).toBe('openai-main');

    const listed = await harness.dispatchOk<{
      accounts: Array<{ id: string }>;
      statuses: Array<{ id: string; hasKey: boolean }>;
      defaultAccountId: string | null;
    }>('GET', '/api/provider-accounts');
    expect(listed.accounts.some((item) => item.id === 'openai-main')).toBe(true);
    expect(listed.statuses.some((item) => item.id === 'openai-main' && item.hasKey)).toBe(true);
    expect(listed.defaultAccountId).toBe('openai-main');

    const validated = await harness.dispatchOk<{ valid: boolean }>(
      'POST',
      '/api/provider-accounts/validate',
      { vendorId: 'ollama', apiKey: '' },
    );
    expect(validated.valid).toBe(true);
  });

  it('channels 配置链路通过 /dispatch 生效并可读回', async () => {
    const saved = await harness.dispatchOk<{ success: boolean }>(
      'POST',
      '/api/channels/activate',
      {
        channelType: 'wecom',
        accountId: 'default',
        enabled: true,
        config: {
          botId: 'wecom-bot-1',
          secret: 'wecom-secret-1',
        },
      },
    );
    expect(saved.success).toBe(true);

    const configured = await harness.dispatchOk<{ success: boolean; channels: string[] }>(
      'GET',
      '/api/channels/configured',
    );
    expect(configured.success).toBe(true);
    expect(configured.channels).toContain('wecom');

    const values = await harness.dispatchOk<{ success: boolean; values: Record<string, string> }>(
      'GET',
      '/api/channels/config/wecom?accountId=default',
    );
    expect(values.success).toBe(true);
    expect(values.values.botId).toBe('wecom-bot-1');
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

    const updated = await harness.dispatchOk<{
      success: boolean;
      policy?: { preset: string; securityPolicyVersion: number };
      error?: string;
    }>('PUT', '/api/security', {
      preset: 'strict',
      securityPolicyVersion: 7,
      runtime: {
        auditDailyCostLimitUsd: 12,
      },
    });
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

  it('team-runtime 生命周期通过 API 串联（init/plan/claim/update/mailbox）', async () => {
    const teamId = 'team-api-chain';
    const init = await harness.dispatchOk<{ run: { teamId: string; status: string } }>(
      'POST',
      '/api/team-runtime/init',
      { teamId, leadAgentId: 'lead-1' },
    );
    expect(init.run.teamId).toBe(teamId);
    expect(init.run.status).toBe('active');

    const planned = await harness.dispatchOk<{ tasks: Array<{ taskId: string; status: string }> }>(
      'POST',
      '/api/team-runtime/plan-upsert',
      {
        teamId,
        tasks: [
          { taskId: 'task-1', instruction: 'first task' },
          { taskId: 'task-2', instruction: 'second task', dependsOn: ['task-1'] },
        ],
      },
    );
    expect(planned.tasks).toHaveLength(2);

    const firstClaim = await harness.dispatchOk<{ task: { taskId: string; status: string } }>(
      'POST',
      '/api/team-runtime/claim-next',
      { teamId, agentId: 'agent-A', sessionKey: 'session-A' },
    );
    expect(firstClaim.task.taskId).toBe('task-1');
    expect(firstClaim.task.status).toBe('claimed');

    const running = await harness.dispatchOk<{ task: { taskId: string; status: string } }>(
      'POST',
      '/api/team-runtime/task-update',
      { teamId, taskId: 'task-1', status: 'running' },
    );
    expect(running.task.status).toBe('running');

    const done = await harness.dispatchOk<{ task: { taskId: string; status: string } }>(
      'POST',
      '/api/team-runtime/task-update',
      { teamId, taskId: 'task-1', status: 'done', resultSummary: 'ok' },
    );
    expect(done.task.status).toBe('done');

    const secondClaim = await harness.dispatchOk<{ task: { taskId: string } }>(
      'POST',
      '/api/team-runtime/claim-next',
      { teamId, agentId: 'agent-A', sessionKey: 'session-A' },
    );
    expect(secondClaim.task.taskId).toBe('task-2');

    const posted = await harness.dispatchOk<{ created: boolean; message: { msgId: string } }>(
      'POST',
      '/api/team-runtime/mailbox-post',
      {
        teamId,
        message: {
          msgId: 'msg-1',
          fromAgentId: 'agent-A',
          content: 'hello runtime mailbox',
        },
      },
    );
    expect(posted.created).toBe(true);
    expect(posted.message.msgId).toBe('msg-1');

    const pulled = await harness.dispatchOk<{ messages: Array<{ msgId: string }> }>(
      'POST',
      '/api/team-runtime/mailbox-pull',
      { teamId, limit: 10 },
    );
    expect(pulled.messages.some((item) => item.msgId === 'msg-1')).toBe(true);
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
          timestamp: '2026-04-06T10:00:00.000Z',
          message: { role: 'user', id: 'm1', content: 'hello-1' },
        }),
        JSON.stringify({
          timestamp: '2026-04-06T10:01:00.000Z',
          message: { role: 'assistant', id: 'm2', content: 'hello-2' },
        }),
        JSON.stringify({
          timestamp: '2026-04-06T10:02:00.000Z',
          message: { role: 'user', id: 'm3', content: 'hello-3' },
        }),
        JSON.stringify({
          timestamp: '2026-04-06T10:03:00.000Z',
          message: { role: 'assistant', id: 'm4', content: 'hello-4' },
        }),
      ].join('\n'),
      'utf8',
    );

    const latest = await harness.dispatchOk<{
      snapshot: {
        items: Array<{ key: string; kind: string; messageId?: string; turnKey?: string }>;
        window: {
          totalItemCount: number;
          windowStartOffset: number;
          windowEndOffset: number;
          hasMore: boolean;
          hasNewer: boolean;
          isAtLatest: boolean;
        };
      };
    }>('POST', '/api/sessions/window', {
      sessionKey: 'agent:main:session-window',
      mode: 'latest',
      limit: 2,
    });
    expect(latest.snapshot.window.totalItemCount).toBe(4);
    expect(latest.snapshot.window.windowStartOffset).toBe(2);
    expect(latest.snapshot.window.windowEndOffset).toBe(4);
    expect(latest.snapshot.window.hasMore).toBe(true);
    expect(latest.snapshot.window.hasNewer).toBe(false);
    expect(latest.snapshot.window.isAtLatest).toBe(true);
    expect(latest.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-window|entry:m3',
      'session:agent:main:session-window|assistant-turn:main:entry:m4:main',
    ]);

    const older = await harness.dispatchOk<{
      snapshot: {
        items: Array<{ key: string; kind: string; messageId?: string; turnKey?: string }>;
        window: {
          windowStartOffset: number;
          windowEndOffset: number;
          hasMore: boolean;
          hasNewer: boolean;
          isAtLatest: boolean;
        };
      };
    }>('POST', '/api/sessions/window', {
      sessionKey: 'agent:main:session-window',
      mode: 'older',
      limit: 2,
      offset: latest.snapshot.window.windowStartOffset,
    });
    expect(older.snapshot.window.windowStartOffset).toBe(0);
    expect(older.snapshot.window.windowEndOffset).toBe(4);
    expect(older.snapshot.window.hasMore).toBe(false);
    expect(older.snapshot.window.hasNewer).toBe(false);
    expect(older.snapshot.window.isAtLatest).toBe(true);
    expect(older.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-window|entry:m1',
      'session:agent:main:session-window|assistant-turn:main:entry:m2:main',
      'session:agent:main:session-window|entry:m3',
      'session:agent:main:session-window|assistant-turn:main:entry:m4:main',
    ]);
  });
});
