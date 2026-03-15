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
});
