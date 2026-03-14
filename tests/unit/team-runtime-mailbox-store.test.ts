import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mailboxPost, mailboxPull } from '@electron/adapters/platform/team-runtime/mailbox-store';

describe('team runtime mailbox store', () => {
  it('deduplicates by msgId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-mailbox-'));
    try {
      await mailboxPost({
        runtimeRoot: root,
        message: {
          msgId: 'm1',
          fromAgentId: 'a1',
          content: 'hello',
        },
      });
      const second = await mailboxPost({
        runtimeRoot: root,
        message: {
          msgId: 'm1',
          fromAgentId: 'a1',
          content: 'hello-2',
        },
      });
      expect(second.created).toBe(false);
      const pull = await mailboxPull({ runtimeRoot: root });
      expect(pull.messages).toHaveLength(1);
      expect(pull.messages[0]?.content).toBe('hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pulls incrementally by cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-mailbox-cursor-'));
    try {
      await mailboxPost({
        runtimeRoot: root,
        message: { msgId: 'm1', fromAgentId: 'a1', content: 'first', createdAt: 1 },
      });
      await mailboxPost({
        runtimeRoot: root,
        message: { msgId: 'm2', fromAgentId: 'a2', content: 'second', createdAt: 2 },
      });

      const firstPull = await mailboxPull({ runtimeRoot: root, limit: 1 });
      expect(firstPull.messages).toHaveLength(1);
      const secondPull = await mailboxPull({
        runtimeRoot: root,
        cursor: firstPull.nextCursor,
      });
      expect(secondPull.messages).toHaveLength(1);
      expect(secondPull.messages[0]?.msgId).toBe('m2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
