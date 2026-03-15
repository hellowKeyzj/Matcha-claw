import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import plugin from '../../packages/openclaw-task-manager-plugin/src/index';

type RecordedEvent = {
  event: string;
  payload: Record<string, unknown>;
};

function createFakeApi(workspaceDir: string, pluginConfig?: Record<string, unknown>) {
  const hooks = new Map<string, (...args: any[]) => Promise<any> | any>();
  const gatewayMethods = new Map<string, (options: any) => Promise<void> | void>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const api = {
    id: 'task-manager',
    name: 'Task Manager',
    version: 'test',
    source: 'unit-test',
    description: 'unit test',
    config: {
      workspaceDir,
      gateway: { port: 18789 },
    },
    pluginConfig,
    runtime: {},
    logger,
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: (method: string, handler: (options: any) => Promise<void> | void) => {
      gatewayMethods.set(method, handler);
    },
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    resolvePath: (input: string) => input,
    on: (hookName: string, handler: (...args: any[]) => Promise<any> | any) => {
      hooks.set(hookName, handler);
    },
  };

  plugin.register(api as any);
  return { hooks, gatewayMethods, logger };
}

function createApprovalManager(decision: 'allow-once' | 'allow-always' | 'deny' | null) {
  let seq = 0;
  return {
    create: vi.fn((request: Record<string, unknown>, timeoutMs: number) => {
      seq += 1;
      return {
        id: `approval-${seq}`,
        request,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + timeoutMs,
      };
    }),
    register: vi.fn(async () => decision),
  };
}

describe('guardian plugin hooks', () => {
  let tempDir = '';
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'matchaclaw-guardian-test-'));
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    if (prevStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // node:sqlite 在 Windows 下句柄释放有延迟，测试阶段忽略清理失败。
    }
  });

  it('before_tool_call 在 confirm 场景下同一 run 等待审批并放行', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: { defaultAction: 'confirm', allowTools: ['task_create'] },
    });
    const beforeToolCall = hooks.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');

    const events: RecordedEvent[] = [];
    const approvalManager = createApprovalManager('allow-once');
    const context = {
      execApprovalManager: approvalManager,
      nodeSendToAllSubscribed: (event: string, payload: Record<string, unknown>) => {
        events.push({ event, payload });
      },
    };

    const taskList = gatewayMethods.get('task_list');
    expect(taskList).toBeTypeOf('function');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const result = await beforeToolCall?.(
      { toolName: 'system.run', params: { command: 'echo hello' }, runId: 'run-1', toolCallId: 'tc-1' },
      { toolName: 'system.run', runId: 'run-1', toolCallId: 'tc-1', sessionKey: 'agent:main:main', agentId: 'main' },
    );

    expect(result).toBeUndefined();
    expect(approvalManager.create).toHaveBeenCalledTimes(1);
    expect(approvalManager.register).toHaveBeenCalledTimes(1);
    expect(events.some((item) => item.event === 'exec.approval.requested')).toBe(true);
    expect(events.some((item) => item.event === 'exec.approval.resolved')).toBe(true);

    const requested = events.find((item) => item.event === 'exec.approval.requested');
    const resolved = events.find((item) => item.event === 'exec.approval.resolved');
    expect(requested?.payload.runId).toBe('run-1');
    expect(resolved?.payload.runId).toBe('run-1');
  });

  it('before_tool_call 在审批拒绝时阻断并写入审计', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: { defaultAction: 'confirm' },
    });
    const beforeToolCall = hooks.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');

    const approvalManager = createApprovalManager('deny');
    const context = {
      execApprovalManager: approvalManager,
      nodeSendToAllSubscribed: vi.fn(),
    };

    const taskList = gatewayMethods.get('task_list');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const result = await beforeToolCall?.(
      { toolName: 'system.run', params: { command: 'cat .env' }, runId: 'run-2', toolCallId: 'tc-2' },
      { toolName: 'system.run', runId: 'run-2', toolCallId: 'tc-2', sessionKey: 'agent:main:main', agentId: 'main' },
    );
    expect(result?.block).toBe(true);

    const query = gatewayMethods.get('guardian.audit.query');
    expect(query).toBeTypeOf('function');
    let payload: Record<string, unknown> | null = null;
    await query?.({
      params: { runId: 'run-2', page: 1, pageSize: 10 },
      context,
      respond: (ok: boolean, body?: Record<string, unknown>) => {
        expect(ok).toBe(true);
        payload = body ?? null;
      },
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const items = ((payload?.items as Array<Record<string, unknown>> | undefined) ?? []);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.decision).toBe('deny');
    expect(items[0]?.result).toBe('blocked');
  });

  it('after_tool_call 落审计并对敏感参数脱敏', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: { defaultAction: 'allow' },
    });
    const afterToolCall = hooks.get('after_tool_call');
    expect(afterToolCall).toBeTypeOf('function');

    const context = {
      execApprovalManager: createApprovalManager('allow-once'),
      nodeSendToAllSubscribed: vi.fn(),
    };
    const taskList = gatewayMethods.get('task_list');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    await afterToolCall?.(
      {
        toolName: 'http.request',
        params: {
          url: 'https://example.com/api',
          authorization: 'Bearer sk-secret-value',
          content: 'very long sensitive content',
        },
        runId: 'run-3',
        toolCallId: 'tc-3',
        durationMs: 27,
      },
      {
        toolName: 'http.request',
        runId: 'run-3',
        toolCallId: 'tc-3',
        sessionKey: 'agent:main:main',
        agentId: 'main',
      },
    );

    const query = gatewayMethods.get('guardian.audit.query');
    let payload: Record<string, unknown> | null = null;
    await query?.({
      params: { runId: 'run-3', page: 1, pageSize: 10 },
      context,
      respond: (ok: boolean, body?: Record<string, unknown>) => {
        expect(ok).toBe(true);
        payload = body ?? null;
      },
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });
    const items = ((payload?.items as Array<Record<string, unknown>> | undefined) ?? []);
    expect(items.length).toBeGreaterThan(0);
    const paramsPreview = items[0]?.paramsPreview as Record<string, unknown>;
    const preview = (paramsPreview?.preview as Record<string, unknown>) ?? {};
    expect(preview.authorization).toBe('[REDACTED]');
  });

  it('guardian.policy.sync 可按 agent 覆盖策略并即时生效', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: { defaultAction: 'deny' },
    });
    const beforeToolCall = hooks.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');

    const context = {
      execApprovalManager: createApprovalManager('allow-once'),
      nodeSendToAllSubscribed: vi.fn(),
    };

    const taskList = gatewayMethods.get('task_list');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const syncPolicy = gatewayMethods.get('guardian.policy.sync');
    expect(syncPolicy).toBeTypeOf('function');
    let syncPayload: Record<string, unknown> | null = null;
    await syncPolicy?.({
      params: {
        securityPolicyVersion: 2,
        securityPolicyByAgent: {
          main: {
            defaultAction: 'allow',
          },
        },
      },
      context,
      respond: (ok: boolean, body?: Record<string, unknown>) => {
        expect(ok).toBe(true);
        syncPayload = body ?? null;
      },
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });
    expect(syncPayload?.securityPolicyVersion).toBe(2);
    expect(syncPayload?.overrideAgentCount).toBe(1);

    const mainAgentResult = await beforeToolCall?.(
      { toolName: 'custom.echo', params: { text: 'hello' }, runId: 'run-4', toolCallId: 'tc-4' },
      { toolName: 'custom.echo', runId: 'run-4', toolCallId: 'tc-4', sessionKey: 'agent:main:main', agentId: 'main' },
    );
    expect(mainAgentResult).toBeUndefined();

    const otherAgentResult = await beforeToolCall?.(
      { toolName: 'custom.echo', params: { text: 'hello' }, runId: 'run-5', toolCallId: 'tc-5' },
      { toolName: 'custom.echo', runId: 'run-5', toolCallId: 'tc-5', sessionKey: 'agent:analytics-reporter:main', agentId: 'analytics-reporter' },
    );
    expect(otherAgentResult?.block).toBe(true);
  });

  it('immutable 规则生效：禁用 guardian 指令必须被阻断', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: { defaultAction: 'allow' },
    });
    const beforeToolCall = hooks.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');
    const context = {
      execApprovalManager: createApprovalManager('allow-once'),
      nodeSendToAllSubscribed: vi.fn(),
    };
    const taskList = gatewayMethods.get('task_list');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const result = await beforeToolCall?.(
      { toolName: 'system.disable_guardian', params: {}, runId: 'run-6', toolCallId: 'tc-6' },
      { toolName: 'system.disable_guardian', runId: 'run-6', toolCallId: 'tc-6', sessionKey: 'agent:main:main', agentId: 'main' },
    );
    expect(result?.block).toBe(true);
  });

  it('confirmStrategy=every_time 时不缓存 allow-always', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: {
        confirmTools: ['system.run'],
      },
    });
    const beforeToolCall = hooks.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');
    const context = {
      execApprovalManager: createApprovalManager('allow-always'),
      nodeSendToAllSubscribed: vi.fn(),
    };
    const taskList = gatewayMethods.get('task_list');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });
    const syncPolicy = gatewayMethods.get('guardian.policy.sync');
    await syncPolicy?.({
      params: {
        securityPolicyVersion: 3,
        securityPolicyByAgent: {
          main: {
            confirmStrategy: 'every_time',
            confirmTools: ['system.run'],
          },
        },
      },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const first = await beforeToolCall?.(
      { toolName: 'system.run', params: { command: 'echo 1' }, runId: 'run-7', toolCallId: 'tc-7' },
      { toolName: 'system.run', runId: 'run-7', toolCallId: 'tc-7', sessionKey: 'agent:main:main', agentId: 'main' },
    );
    const second = await beforeToolCall?.(
      { toolName: 'system.run', params: { command: 'echo 2' }, runId: 'run-8', toolCallId: 'tc-8' },
      { toolName: 'system.run', runId: 'run-8', toolCallId: 'tc-8', sessionKey: 'agent:main:main', agentId: 'main' },
    );
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(context.execApprovalManager.register).toHaveBeenCalledTimes(2);
  });

  it('会话缓存只用于 confirm_tools，不可绕过路径白名单判定', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: {
        confirmTools: ['system.run'],
      },
    });
    const beforeToolCall = hooks.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');
    const context = {
      execApprovalManager: createApprovalManager('allow-always'),
      nodeSendToAllSubscribed: vi.fn(),
    };
    const taskList = gatewayMethods.get('task_list');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });
    const syncPolicy = gatewayMethods.get('guardian.policy.sync');
    await syncPolicy?.({
      params: {
        securityPolicyVersion: 4,
        securityPolicyByAgent: {
          main: {
            confirmStrategy: 'session',
            confirmTools: ['system.run'],
            allowPathPrefixes: ['C:\\safe-root'],
          },
        },
      },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const first = await beforeToolCall?.(
      { toolName: 'system.run', params: { command: 'echo first' }, runId: 'run-9', toolCallId: 'tc-9' },
      { toolName: 'system.run', runId: 'run-9', toolCallId: 'tc-9', sessionKey: 'agent:main:main', agentId: 'main' },
    );
    const second = await beforeToolCall?.(
      { toolName: 'system.run', params: { command: 'echo second', path: 'C:\\outside-root\\secret.txt' }, runId: 'run-10', toolCallId: 'tc-10' },
      { toolName: 'system.run', runId: 'run-10', toolCallId: 'tc-10', sessionKey: 'agent:main:main', agentId: 'main' },
    );

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(context.execApprovalManager.register).toHaveBeenCalledTimes(2);
  });

  it('relaxed 预设默认不走 confirm_tools 审批', async () => {
    const { hooks, gatewayMethods } = createFakeApi(tempDir, {
      guardian: {
        preset: 'relaxed',
      },
    });
    const beforeToolCall = hooks.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');
    const context = {
      execApprovalManager: createApprovalManager('allow-once'),
      nodeSendToAllSubscribed: vi.fn(),
    };
    const taskList = gatewayMethods.get('task_list');
    await taskList?.({
      params: { workspaceDir: tempDir },
      context,
      respond: () => {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    const result = await beforeToolCall?.(
      { toolName: 'system.run', params: { command: 'echo relaxed' }, runId: 'run-11', toolCallId: 'tc-11' },
      { toolName: 'system.run', runId: 'run-11', toolCallId: 'tc-11', sessionKey: 'agent:main:main', agentId: 'main' },
    );

    expect(result).toBeUndefined();
    expect(context.execApprovalManager.register).not.toHaveBeenCalled();
  });
});
