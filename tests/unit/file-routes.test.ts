import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileService } from '../../runtime-host/application/files/file-service';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestRuntimeSystemEnvironment } from './helpers/runtime-system-environment';

describe('file routes', () => {
  let tempHome = '';
  let configDir = '';
  let fileService: FileService;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(process.env.TEMP || process.cwd(), 'matcha-claw-home-'));
    configDir = await mkdtemp(join(process.env.TEMP || process.cwd(), 'matcha-claw-config-'));
    fileService = new FileService({
      fileSystem: createTestRuntimeFileSystem(),
      idGenerator: { randomId: () => 'file-id', randomHex: () => 'file-id' },
      systemEnvironment: createTestRuntimeSystemEnvironment({ homeDir: tempHome }),
      environment: {
        getOpenClawConfigDir: () => configDir,
      } as never,
    });
  });

  afterEach(async () => {
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
    }
    if (configDir) {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('resolves gateway outgoing-media thumbnails through runtime-host records', async () => {
    const attachmentId = `test-${randomUUID()}`;
    const originalPath = join(tempHome, 'artifact.png');
    const recordsDir = join(configDir, 'media', 'outgoing', 'records');
    await createTestRuntimeFileSystem().ensureDirectory(recordsDir);
    await writeFile(originalPath, Buffer.from('png-bytes'));
    await writeFile(join(recordsDir, `${attachmentId}.json`), JSON.stringify({
      original: {
        path: originalPath,
        contentType: 'image/png',
      },
    }));

    const result = await fileService.thumbnails({
      paths: [{
        gatewayUrl: `/api/chat/media/outgoing/agent%3Atest%3Amain/${attachmentId}/full`,
        mimeType: 'image/png',
      }],
    });

    expect(result).toEqual({
      [`/api/chat/media/outgoing/agent%3Atest%3Amain/${attachmentId}/full`]: {
        preview: 'data:image/png;base64,cG5nLWJ5dGVz',
        fileSize: Buffer.from('png-bytes').length,
      },
    });
  });

  it('reads text previews through runtime-host file service', async () => {
    const filePath = join(tempHome, 'notes.md');
    await writeFile(filePath, '# Hello\nworld\n', 'utf8');

    const result = await fileService.readText({ path: filePath });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      path: filePath,
      content: '# Hello\nworld\n',
      mimeType: 'text/markdown',
    }));
  });

  it('writes text files through runtime-host file service', async () => {
    const filePath = join(tempHome, 'exports', 'agent.matchaclaw-agent.json');

    const result = await fileService.writeText({
      path: filePath,
      content: '{"schema":"matchaclaw.agent-config"}\n',
    });

    expect(result).toEqual({
      ok: true,
      path: filePath,
    });
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"schema":"matchaclaw.agent-config"}\n');
  });

  it('returns binary error for NUL-containing text preview reads', async () => {
    const filePath = join(tempHome, 'raw.bin');
    await writeFile(filePath, Buffer.from([0x41, 0x00, 0x42]));

    const result = await fileService.readText({ path: filePath });

    expect(result).toEqual({ ok: false, error: 'binary' });
  });

  it('reads binary previews as base64 payloads', async () => {
    const filePath = join(tempHome, 'table.xlsx');
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    await writeFile(filePath, buffer);

    const result = await fileService.readBinary({ path: filePath });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      path: filePath,
      data: buffer.toString('base64'),
      mimeType: 'application/octet-stream',
    }));
  });

  it('lists directory entries for workspace browser reads', async () => {
    const docsDir = join(tempHome, 'docs');
    const filePath = join(docsDir, 'guide.md');
    const nestedDir = join(docsDir, 'nested');
    await createTestRuntimeFileSystem().ensureDirectory(docsDir);
    await createTestRuntimeFileSystem().ensureDirectory(nestedDir);
    await writeFile(filePath, 'guide', 'utf8');

    const result = await fileService.listDir({ path: docsDir });

    expect(result).toEqual({
      ok: true,
      entries: [
        expect.objectContaining({
          name: 'nested',
          path: nestedDir,
          isDir: true,
          hasChildren: true,
        }),
        expect.objectContaining({
          name: 'guide.md',
          path: filePath,
          isDir: false,
          hasChildren: false,
        }),
      ],
    });
  });
});
