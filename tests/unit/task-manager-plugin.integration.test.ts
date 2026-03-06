import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import taskManagerPlugin from '../../packages/openclaw-task-manager-plugin/src/index';
import type { Task } from '../../packages/openclaw-task-manager-plugin/src/task-store';

type ToolContext = {
  workspaceDir?: string;
  sessionKey?: string;
};

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details?: unknown }>;
};

type GatewayMethodHandler = (options: {
  params: Record<string, unknown>;
  respond: (success: boolean, result?: unknown, error?: unknown) => void;
  context: {
    nodeSendToAllSubscribed: (event: string, payload: Record<string, unknown>) => void;
  };
}) => Promise<void>;

type HttpRouteHandler = (req: { url?: string }, res: MockResponse) => Promise<void>;

interface MockResponse {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
  readonly body: string;
}

function createWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function createMockResponse(): MockResponse {
  let responseBody = '';
  return {
    statusCode: 200,
    setHeader: () => {},
    end: (body?: string) => {
      responseBody = body ?? '';
    },
    get body() {
      return responseBody;
    },
  };
}

function bootstrapPlugin(workspaceDir: string) {
  const toolFactories: Array<(ctx: ToolContext) => RegisteredTool> = [];
  const gatewayMethods = new Map<string, GatewayMethodHandler>();
  const httpRoutes = new Map<string, HttpRouteHandler>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  taskManagerPlugin.register({
    config: { workspaceDir, gateway: { port: 18789 } },
    registerTool(factory: (ctx: ToolContext) => RegisteredTool) {
      toolFactories.push(factory);
    },
    registerGatewayMethod(name: string, handler: GatewayMethodHandler) {
      gatewayMethods.set(name, handler);
    },
    registerHttpRoute(route: { path: string; handler: HttpRouteHandler }) {
      httpRoutes.set(route.path, route.handler);
    },
    on: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      hooks.set(hookName, handler);
    },
  } as unknown as Parameters<typeof taskManagerPlugin.register>[0]);

  function getTool(name: string, context: ToolContext): RegisteredTool {
    for (const factory of toolFactories) {
      const tool = factory(context);
      if (tool.name === name) {
        return tool;
      }
    }
    throw new Error(`Tool not found: ${name}`);
  }

  async function callGatewayMethod(method: string, params: Record<string, unknown>) {
    const handler = gatewayMethods.get(method);
    if (!handler) {
      throw new Error(`Gateway method not found: ${method}`);
    }
    const output: { success?: boolean; result?: unknown; error?: unknown } = {};
    await handler({
      params,
      respond: (success, result, error) => {
        output.success = success;
        output.result = result;
        output.error = error;
      },
      context: {
        nodeSendToAllSubscribed: (event, payload) => {
          events.push({ event, payload });
        },
      },
    });
    return output;
  }

  function getHttpRoute(pathname: string): HttpRouteHandler {
    const route = httpRoutes.get(pathname);
    if (!route) {
      throw new Error(`HTTP route not found: ${pathname}`);
    }
    return route;
  }

  async function callHook(hookName: string, event: Record<string, unknown>, ctx: Record<string, unknown>) {
    const handler = hooks.get(hookName);
    if (!handler) {
      throw new Error(`Hook not found: ${hookName}`);
    }
    return await handler(event, ctx);
  }

  return {
    events,
    getTool,
    callGatewayMethod,
    getHttpRoute,
    callHook,
  };
}

describe('task-manager plugin integration', () => {
  it('runs create -> markdown -> block -> resume -> webhook approval flow', async () => {
    const workspace = await createWorkspace('task-plugin-flow-');
    try {
      const app = bootstrapPlugin(workspace);

      const listResult = await app.callGatewayMethod('task_list', { workspaceDir: workspace });
      expect(listResult.success).toBe(true);
      expect((listResult.result as { tasks: unknown[] }).tasks).toEqual([]);

      const createTool = app.getTool('task_create', { workspaceDir: workspace, sessionKey: 'agent:main:main' });
      const created = (await createTool.execute('call-1', { goal: '实现任务中心闭环' })).details as Task;
      expect(created.id.startsWith('task-')).toBe(true);
      expect(created.status).toBe('pending');
      expect(app.events.some((row) => row.event === 'task_status_changed' && row.payload.to === 'pending')).toBe(true);

      const markdown = [
        '# 计划',
        '- [ ] 第一步',
        '```md',
        '- [x] 代码块中的勾选不计入进度',
        '```',
        '- [x] 第二步',
      ].join('\n');

      const setPlanTool = app.getTool('task_set_plan_markdown', { workspaceDir: workspace });
      const planned = (await setPlanTool.execute('call-2', { taskId: created.id, markdown })).details as Task;
      expect(planned.progress).toBe(0.5);
      expect(planned.status).toBe('running');
      expect(app.events.some((row) => row.event === 'task_progress_update' && row.payload.taskId === created.id)).toBe(true);

      const bindTool = app.getTool('task_bind_session', { workspaceDir: workspace, sessionKey: 'agent:spawn:auto' });
      const bound = (await bindTool.execute('call-3', { taskId: created.id })).details as Task;
      expect(bound.assigned_session).toBe('agent:spawn:auto');
      expect(bound.status).toBe('running');

      const requestInputTool = app.getTool('task_request_user_input', { workspaceDir: workspace });
      const blocked = (await requestInputTool.execute('call-4', {
        taskId: created.id,
        question: '是否覆盖已有文件？',
      })).details as { action: string; task: Task };
      expect(blocked.action).toBe('pause_session');
      expect(blocked.task.status).toBe('waiting_for_input');
      expect(typeof blocked.task.blocked_info?.confirm_id).toBe('string');
      expect(
        app.events.some(
          (row) =>
            row.event === 'task_blocked'
            && row.payload.type === 'waiting_for_input'
            && row.payload.confirmId === blocked.task.blocked_info?.confirm_id,
        ),
      ).toBe(true);

      const resumed = await app.callGatewayMethod('task_resume', {
        taskId: created.id,
        confirmId: blocked.task.blocked_info?.confirm_id,
        decision: 'approve',
        workspaceDir: workspace,
      });
      expect(resumed.success).toBe(true);
      expect((resumed.result as { task: Task }).task.status).toBe('running');
      expect(
        app.events.some(
          (row) =>
            row.event === 'task_needs_resume' &&
            row.payload.taskId === created.id &&
            row.payload.confirmId === blocked.task.blocked_info?.confirm_id &&
            row.payload.resumeReason === 'user_input',
        ),
      ).toBe(true);

      const duplicatedResume = await app.callGatewayMethod('task_resume', {
        taskId: created.id,
        confirmId: blocked.task.blocked_info?.confirm_id,
        decision: 'approve',
        workspaceDir: workspace,
      });
      expect(duplicatedResume.success).toBe(false);
      expect(duplicatedResume.error).toMatchObject({
        code: 'conflict',
      });

      const waitApprovalTool = app.getTool('task_wait_approval', { workspaceDir: workspace });
      const approval = (await waitApprovalTool.execute('call-5', {
        taskId: created.id,
        description: '等待外部审批',
        ttlSec: 120,
      })).details as { webhookUrl: string; task: Task };
      expect(approval.task.status).toBe('waiting_approval');
      expect(approval.webhookUrl).toContain('/task-manager/webhook');

      const webhook = app.getHttpRoute('/task-manager/webhook');
      const successResponse = createMockResponse();
      const webhookUrl = new URL(approval.webhookUrl);
      await webhook({ url: `${webhookUrl.pathname}${webhookUrl.search}` }, successResponse);
      expect(successResponse.statusCode).toBe(200);
      expect(JSON.parse(successResponse.body)).toEqual({ success: true, taskId: created.id });

      const replayResponse = createMockResponse();
      await webhook({ url: `${webhookUrl.pathname}${webhookUrl.search}` }, replayResponse);
      expect(replayResponse.statusCode).toBe(403);
      expect(JSON.parse(replayResponse.body)).toEqual({ success: false, error: 'invalid or expired token' });

      expect(
        app.events.some(
          (row) =>
            row.event === 'task_needs_resume' &&
            row.payload.taskId === created.id &&
            row.payload.resumeReason === 'approval_webhook',
        ),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('supports dynamic switch hint without blocking non-task tools', async () => {
    const workspace = await createWorkspace('task-plugin-hook-guard-');
    try {
      const app = bootstrapPlugin(workspace);
      const sessionKey = 'agent:business-expert:main';

      await app.callHook(
        'llm_output',
        {
          assistantTexts: ['步骤 1：提交申请\n步骤 2：风险评估\n步骤 3：审批决策'],
        },
        { sessionKey, agentId: 'business-expert' },
      );

      const beforeStart = await app.callHook(
        'before_agent_start',
        { prompt: '继续' },
        { sessionKey, workspaceDir: workspace, agentId: 'business-expert' },
      );
      expect((beforeStart as { prependContext?: string })?.prependContext).toContain('Task Manager 动态切换建议');

      const passthrough = await app.callHook(
        'before_tool_call',
        { toolName: 'read', params: { path: 'foo.txt' } },
        { sessionKey, toolName: 'read' },
      );
      expect(passthrough).toBeUndefined();

      const allowed = await app.callHook(
        'before_tool_call',
        { toolName: 'task_create', params: { goal: '测试任务' } },
        { sessionKey, toolName: 'task_create', agentId: 'business-expert' },
      );
      expect(allowed).toBeUndefined();

      const afterDisarm = await app.callHook(
        'before_tool_call',
        { toolName: 'read', params: { path: 'bar.txt' } },
        { sessionKey, toolName: 'read', agentId: 'business-expert' },
      );
      expect(afterDisarm).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
