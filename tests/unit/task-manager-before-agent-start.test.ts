import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBeforeAgentStartHandler } from '../../packages/openclaw-task-manager-plugin/src/hooks/before-agent-start';
import { TaskStore } from '../../packages/openclaw-task-manager-plugin/src/task-store';

function createWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('before-agent-start hook', () => {
  it('injects recovery instructions for main session', async () => {
    const workspace = await createWorkspace('task-hook-main-');
    try {
      const store = new TaskStore(workspace);

      const runningTask = await store.createTask('恢复运行中的任务');
      await store.setPlanMarkdown(runningTask.id, '- [ ] 步骤一');
      await store.bindSession(runningTask.id, 'agent:spawn:old');

      const waitingTask = await store.createTask('等待用户确认任务');
      await store.setPlanMarkdown(waitingTask.id, '- [ ] 步骤一');
      await store.blockForUserInput(waitingTask.id, '是否继续执行？');

      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        { prompt: '主会话启动' },
        { workspaceDir: workspace, sessionKey: 'agent:main:main' },
      );

      expect(result?.prependContext).toContain('Task Manager 恢复提示');
      expect(result?.prependContext).toContain(runningTask.id);
      expect(result?.prependContext).toContain(waitingTask.id);
      expect(result?.prependContext).toContain('如需恢复任务，请执行 sessions_spawn');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('injects task context and rebinds session for worker session', async () => {
    const workspace = await createWorkspace('task-hook-worker-');
    try {
      const store = new TaskStore(workspace);
      const task = await store.createTask('执行子会话任务');
      const markdown = ['# 任务目标', '- [ ] 第一步'].join('\n');
      await store.setPlanMarkdown(task.id, markdown);

      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const sessionKey = 'agent:spawn:new-session';
      const result = await handler(
        { prompt: `请恢复执行任务 ${task.id}` },
        { workspaceDir: workspace, sessionKey },
      );

      expect(result?.prependContext).toContain('Task Manager Task Packet');
      expect(result?.prependContext).toContain(task.id);
      expect(result?.prependContext).toContain('执行子会话任务');
      expect(result?.prependContext).toContain(markdown);
      expect(result?.prependContext).toContain(`工作区: ${workspace}`);
      expect(result?.prependContext).toContain('进度摘要: 0%（0/1）');
      expect(result?.prependContext).toContain('下一顶层步骤: 第一步');
      expect(result?.prependContext).toContain('### 执行边界');
      expect(result?.prependContext).toContain('执行决策以 Task Packet 字段为准，Markdown 仅作为参考附件。');
      expect(result?.prependContext).toContain('参考附件：当前计划（Markdown 原文）');

      const updated = await store.getTask(task.id);
      expect(updated?.assigned_session).toBe(sessionKey);
      expect(updated?.status).toBe('running');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('injects trigger hint for multi-step sequence intent from non-main agents', async () => {
    const workspace = await createWorkspace('task-hook-trigger-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        { prompt: '请先梳理需求，然后生成实现计划，最后输出验收清单。' },
        { workspaceDir: workspace, sessionKey: 'agent:ontology-expert:main' },
      );

      expect(result?.prependContext).toContain('Task Manager 触发建议');
      expect(result?.prependContext).toContain('复杂度评估框架');
      expect(result?.prependContext).toContain('task_create -> task_set_plan_markdown');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('injects trigger hint from recent assistant output when user prompt is short', async () => {
    const workspace = await createWorkspace('task-hook-assistant-output-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        {
          prompt: '继续',
          history: [
            { role: 'user', content: '方案一' },
            {
              role: 'assistant',
              content: [
                '流程实例已创建！现在开始执行第一步。',
                '步骤1：初审',
                '步骤2：征信查询',
                '步骤3：风险评估',
              ].join('\n'),
            },
          ],
        },
        { workspaceDir: workspace, sessionKey: 'agent:business-expert:main' },
      );

      expect(result?.prependContext).toContain('Task Manager 触发建议');
      expect(result?.prependContext).toContain('复杂度评估框架');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('injects trigger hint when history uses wrapped message shape', async () => {
    const workspace = await createWorkspace('task-hook-wrapped-history-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        {
          prompt: '继续',
          messages: [
            {
              type: 'message',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '步骤 1：提交申请\n步骤 2：风险评估\n步骤 3：审批决策' }],
              },
            },
          ],
        },
        { workspaceDir: workspace, sessionKey: 'agent:business-expert:main' },
      );

      expect(result?.prependContext).toContain('Task Manager 触发建议');
      expect(result?.prependContext).toContain('复杂度评估框架');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not inject trigger hint for simple short queries', async () => {
    const workspace = await createWorkspace('task-hook-no-trigger-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        { prompt: '你好，今天天气如何？' },
        { workspaceDir: workspace, sessionKey: 'agent:ontology-expert:main' },
      );

      expect(result).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not inject trigger hint from old assistant checklist when prompt is plain question', async () => {
    const workspace = await createWorkspace('task-hook-plain-question-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        {
          prompt: '你能做什么？',
          history: [
            { role: 'user', content: '执行贷款审批流程' },
            {
              role: 'assistant',
              content: [
                '以下是执行清单：',
                '- 步骤1：初审',
                '- 步骤2：征信查询',
                '- 步骤3：风险评估',
                '- 步骤4：审批决策',
              ].join('\n'),
            },
          ],
        },
        { workspaceDir: workspace, sessionKey: 'agent:business-expert:main' },
      );

      expect(result).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('injects trigger hint for ontology authoring/spec writing prompts', async () => {
    const workspace = await createWorkspace('task-hook-ontology-authoring-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        {
          prompt: [
            '请分步构建本体规范：',
            '步骤1：整理 SOUL.md、AGENTS.md 的约束。',
            '步骤2：对照 schemas/rule_schema.json 检查 rules/ 与 bindings/。',
            '步骤3：输出变更清单并进入评审。',
          ].join('\n'),
        },
        { workspaceDir: workspace, sessionKey: 'agent:ontology-builder:main' },
      );

      expect(result?.prependContext).toContain('Task Manager 触发建议');
      expect(result?.prependContext).toContain('复杂度评估框架');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('injects trigger hint for ontology authoring prompts with strong execution intent', async () => {
    const workspace = await createWorkspace('task-hook-ontology-exec-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        {
          prompt: [
            '请执行本体构建任务，按阶段推进：',
            '1. 读取 schemas/rule_schema.json 并校验现有 rules/。',
            '2. 生成缺失的 bindings/ 映射并补齐 actions/。',
            '3. 更新变更报告并提交评审。',
          ].join('\n'),
        },
        { workspaceDir: workspace, sessionKey: 'agent:ontology-builder:main' },
      );

      expect(result?.prependContext).toContain('Task Manager 触发建议');
      expect(result?.prependContext).toContain('复杂度评估框架');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('injects trigger hint for generic workflow-execution intent in user prompt', async () => {
    const workspace = await createWorkspace('task-hook-workflow-intent-');
    try {
      const handler = createBeforeAgentStartHandler((workspaceDir?: unknown) => new TaskStore(String(workspaceDir)));
      const result = await handler(
        { prompt: '执行贷款审批流程' },
        { workspaceDir: workspace, sessionKey: 'agent:business-expert:business-expert' },
      );

      expect(result?.prependContext).toContain('Task Manager 触发建议');
      expect(result?.prependContext).toContain('检测到流程/工作流执行意图');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
