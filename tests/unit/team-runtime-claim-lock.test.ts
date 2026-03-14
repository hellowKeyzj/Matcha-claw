import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimTaskLock, isLeaseExpired, releaseTaskLock } from '@electron/adapters/platform/team-runtime/claim-lock';

describe('team runtime claim lock', () => {
  it('allows only one claimer for same task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-lock-'));
    try {
      const [a, b] = await Promise.all([
        claimTaskLock({
          runtimeRoot: root,
          taskId: 'task-1',
          ownerAgentId: 'a1',
          sessionKey: 's1',
          leaseMs: 30000,
        }),
        claimTaskLock({
          runtimeRoot: root,
          taskId: 'task-1',
          ownerAgentId: 'a2',
          sessionKey: 's2',
          leaseMs: 30000,
        }),
      ]);
      const okCount = [a, b].filter((row) => row.ok).length;
      expect(okCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows reclaim after lease timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-lock-expire-'));
    try {
      const first = await claimTaskLock({
        runtimeRoot: root,
        taskId: 'task-1',
        ownerAgentId: 'a1',
        sessionKey: 's1',
        leaseMs: 10,
        nowMs: 100,
      });
      expect(first.ok).toBe(true);
      expect(isLeaseExpired((first as { ok: true; lock: { leaseUntil: number } }).lock.leaseUntil, 1200)).toBe(true);

      const second = await claimTaskLock({
        runtimeRoot: root,
        taskId: 'task-1',
        ownerAgentId: 'a2',
        sessionKey: 's2',
        leaseMs: 1000,
        nowMs: 1300,
      });
      expect(second.ok).toBe(true);

      const released = await releaseTaskLock({
        runtimeRoot: root,
        taskId: 'task-1',
        ownerAgentId: 'a2',
        sessionKey: 's2',
      });
      expect(released.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
