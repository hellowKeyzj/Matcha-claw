import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../../packages/openclaw-task-manager-plugin/src/task-store';

async function createWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('task manager task store', () => {
  it('repairs incompatible schema by backup + reset', async () => {
    const workspace = await createWorkspace('task-store-schema-');
    try {
      const managerDir = join(workspace, '.task-manager');
      await mkdir(managerDir, { recursive: true });
      const brokenFile = join(managerDir, 'tasks.json');
      await writeFile(
        brokenFile,
        JSON.stringify({ schema_version: 99, tasks: [{ id: 'bad' }] }, null, 2),
        'utf-8',
      );

      const store = new TaskStore(workspace);
      const list = await store.listTasks();
      expect(list).toEqual([]);

      const files = await readdir(managerDir);
      const backups = files.filter((name) => name.startsWith('tasks.bak.'));
      expect(backups.length).toBeGreaterThan(0);

      const repaired = JSON.parse(await readFile(brokenFile, 'utf-8')) as { schema_version: number; tasks: unknown[] };
      expect(repaired.schema_version).toBe(1);
      expect(Array.isArray(repaired.tasks)).toBe(true);
      expect(repaired.tasks.length).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('supports approval token lookup with expiration and one-time consumption', async () => {
    const workspace = await createWorkspace('task-store-token-');
    try {
      const store = new TaskStore(workspace);
      const task = await store.createTask('审批测试');
      await store.setPlanMarkdown(task.id, '- [ ] step 1');

      const token = 'token-abc';
      const active = await store.blockForApproval(task.id, '等待审批', token, Date.now() + 60_000);
      expect(active.status).toBe('waiting_approval');
      expect(typeof active.blocked_info?.confirm_id).toBe('string');

      const found = await store.findApprovalTaskByToken(token);
      expect(found?.id).toBe(task.id);

      await store.resumeTask(task.id, { confirmId: active.blocked_info?.confirm_id });
      const consumed = await store.findApprovalTaskByToken(token);
      expect(consumed).toBeNull();

      const task2 = await store.createTask('过期审批测试');
      await store.setPlanMarkdown(task2.id, '- [ ] step 1');
      await store.blockForApproval(task2.id, '已过期审批', 'token-expired', Date.now() - 1000);
      const expired = await store.findApprovalTaskByToken('token-expired');
      expect(expired).toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects resume when confirmId mismatches or task already resumed', async () => {
    const workspace = await createWorkspace('task-store-resume-guard-');
    try {
      const store = new TaskStore(workspace);
      const task = await store.createTask('恢复校验测试');
      await store.setPlanMarkdown(task.id, '- [ ] step 1');

      const blocked = await store.blockForUserInput(task.id, '是否继续？');
      const validConfirmId = blocked.blocked_info?.confirm_id;
      expect(typeof validConfirmId).toBe('string');

      await expect(
        store.resumeTask(task.id, { confirmId: 'confirm-invalid' }),
      ).rejects.toThrow(/confirmId does not match/i);

      await store.resumeTask(task.id, { confirmId: validConfirmId });

      await expect(
        store.resumeTask(task.id, { confirmId: validConfirmId }),
      ).rejects.toThrow(/not waiting for resume/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('accepts free-text user input resume when confirmId matches', async () => {
    const workspace = await createWorkspace('task-store-free-text-');
    try {
      const store = new TaskStore(workspace);
      const task = await store.createTask('文本输入恢复测试');
      await store.setPlanMarkdown(task.id, '- [ ] step 1');
      const blocked = await store.blockForUserInput(task.id, '请补充申请人信息', 'free_text');

      const resumed = await store.resumeTask(task.id, {
        confirmId: blocked.blocked_info?.confirm_id,
      });

      expect(resumed.status).toBe('running');
      expect(resumed.blocked_info).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
