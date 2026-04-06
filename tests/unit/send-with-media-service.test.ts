import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sendWithMediaViaOpenClawBridge } from '../../runtime-host/application/chat/send-media';

describe('chat send-media', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }));
    tempDirs.length = 0;
  });

  it('文本附件仅注入文件引用，不生成图像 attachments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'matcha-media-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'notes.txt');
    await writeFile(filePath, 'hello text', 'utf8');

    const chatSend = vi.fn(async () => ({ runId: 'run-text' }));
    const result = await sendWithMediaViaOpenClawBridge({ chatSend } as never, {
      sessionKey: 'agent:main:session-1',
      message: 'process this',
      idempotencyKey: 'id-text',
      media: [{ filePath, mimeType: 'text/plain', fileName: 'notes.txt' }],
    });

    expect(result.success).toBe(true);
    expect(chatSend).toHaveBeenCalledTimes(1);
    const [rpcParams] = chatSend.mock.calls[0];
    expect(rpcParams).toMatchObject({
      sessionKey: 'agent:main:session-1',
      deliver: false,
      idempotencyKey: 'id-text',
    });
    expect((rpcParams as { message: string }).message).toContain('[media attached:');
    expect((rpcParams as { attachments?: unknown[] }).attachments).toBeUndefined();
  });

  it('图片附件会附带 base64 attachments 并保留文件引用', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'matcha-media-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'image.png');
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const chatSend = vi.fn(async () => ({ runId: 'run-image' }));
    const result = await sendWithMediaViaOpenClawBridge({ chatSend } as never, {
      sessionKey: 'agent:main:session-2',
      message: 'process image',
      idempotencyKey: 'id-image',
      media: [{ filePath, mimeType: 'image/png', fileName: 'image.png' }],
    });

    expect(result.success).toBe(true);
    expect(chatSend).toHaveBeenCalledTimes(1);
    const [rpcParams] = chatSend.mock.calls[0];
    const payload = rpcParams as {
      message: string;
      attachments?: Array<{ content: string; mimeType: string; fileName: string }>;
    };
    expect(payload.message).toContain('[media attached:');
    expect(payload.attachments?.length).toBe(1);
    expect(payload.attachments?.[0].mimeType).toBe('image/png');
    expect(payload.attachments?.[0].fileName).toBe('image.png');
    expect(typeof payload.attachments?.[0].content).toBe('string');
    expect(payload.attachments?.[0].content.length).toBeGreaterThan(0);
  });
});
