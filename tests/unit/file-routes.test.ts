import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileService } from '../../runtime-host/application/files/file-service';
import { createWorkspaceFileCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/workspace/workspace-file-capability';
import { WorkspaceFileRuntimeWorkflow } from '../../runtime-host/application/workflows/workspace-file/workspace-file-runtime-workflow';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestRuntimeSystemEnvironment } from './helpers/runtime-system-environment';

const testEndpoint = { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' };
const testSessionIdentity = {
  endpoint: testEndpoint,
  agentId: 'default',
  sessionKey: 'agent:default:main',
};

describe('file routes', () => {
  let tempHome = '';
  let configDir = '';
  let workspaceRoot = '';
  let outsideRoot = '';
  let fileService: FileService;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(process.env.TEMP || process.cwd(), 'matcha-claw-home-'));
    configDir = await mkdtemp(join(process.env.TEMP || process.cwd(), 'matcha-claw-config-'));
    workspaceRoot = await mkdtemp(join(process.env.TEMP || process.cwd(), 'matcha-claw-workspace-'));
    outsideRoot = await mkdtemp(join(process.env.TEMP || process.cwd(), 'matcha-claw-outside-'));
    const runtimeWorkflow = new WorkspaceFileRuntimeWorkflow({
      fileSystem: createTestRuntimeFileSystem(),
      idGenerator: { randomId: () => 'file-id', randomHex: () => 'file-id' },
      systemEnvironment: createTestRuntimeSystemEnvironment({ homeDir: tempHome }),
      runtimeDataStore: {
        getRuntimeDataRootDir: () => configDir,
      },
      workspaceRoots: {
        getMainWorkspaceDir: async () => workspaceRoot,
        getWorkspaceDirForSession: async () => workspaceRoot,
        getTaskWorkspaceDirs: async () => [workspaceRoot],
      },
    });
    fileService = new FileService({ runtimeWorkflow });
  });

  afterEach(async () => {
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
    }
    if (configDir) {
      await rm(configDir, { recursive: true, force: true });
    }
    if (workspaceRoot) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    if (outsideRoot) {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('resolves gateway outgoing-media thumbnails only for the owner session target', async () => {
    const attachmentId = `test-${randomUUID()}`;
    const originalPath = join(workspaceRoot, 'artifact.png');
    const ownerIdentity = {
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'main',
      sessionKey: 'agent:main:main',
    };
    const gatewayUrl = `/api/chat/media/outgoing/${encodeURIComponent(ownerIdentity.sessionKey)}/${attachmentId}/full`;
    const recordsDir = join(configDir, 'media', 'outgoing', 'records');
    await createTestRuntimeFileSystem().ensureDirectory(recordsDir);
    await writeFile(originalPath, Buffer.from('png-bytes'));
    await writeFile(join(recordsDir, `${attachmentId}.json`), JSON.stringify({
      sessionIdentity: ownerIdentity,
      original: {
        path: originalPath,
        contentType: 'image/png',
      },
    }));

    const result = await fileService.thumbnail({
      path: gatewayUrl,
      mimeType: 'image/png',
      scope: { kind: 'workspace', endpoint: ownerIdentity.endpoint },
      target: { kind: 'workspace-file', path: gatewayUrl, identity: ownerIdentity },
    });

    expect(result).toEqual({
      preview: 'data:image/png;base64,cG5nLWJ5dGVz',
      fileSize: Buffer.from('png-bytes').length,
    });
  });

  it('does not resolve gateway outgoing-media thumbnails for a mismatched owner session', async () => {
    const attachmentId = `test-${randomUUID()}`;
    const originalPath = join(workspaceRoot, 'artifact.png');
    const ownerIdentity = {
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'main',
      sessionKey: 'agent:main:main',
    };
    const otherIdentity = { ...ownerIdentity, agentId: 'other', sessionKey: 'agent:other:main' };
    const gatewayUrl = `/api/chat/media/outgoing/${encodeURIComponent(ownerIdentity.sessionKey)}/${attachmentId}/full`;
    const recordsDir = join(configDir, 'media', 'outgoing', 'records');
    await createTestRuntimeFileSystem().ensureDirectory(recordsDir);
    await writeFile(originalPath, Buffer.from('png-bytes'));
    await writeFile(join(recordsDir, `${attachmentId}.json`), JSON.stringify({
      sessionIdentity: ownerIdentity,
      original: {
        path: originalPath,
        contentType: 'image/png',
      },
    }));

    const result = await fileService.thumbnail({
      path: gatewayUrl,
      mimeType: 'image/png',
      scope: { kind: 'workspace', endpoint: ownerIdentity.endpoint },
      target: { kind: 'workspace-file', path: gatewayUrl, identity: otherIdentity },
    });

    expect(result).toEqual({ preview: null, fileSize: 0 });
  });

  it('reads text previews through runtime-host file service', async () => {
    const filePath = join(workspaceRoot, 'notes.md');
    await writeFile(filePath, '# Hello\nworld\n', 'utf8');

    const result = await fileService.readText({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      path: filePath,
      content: '# Hello\nworld\n',
      mimeType: 'text/markdown',
    }));
  });

  it('writes text files through runtime-host file service', async () => {
    const filePath = join(workspaceRoot, 'exports', 'agent.matchaclaw-agent.json');

    const result = await fileService.writeText({
      path: filePath,
      content: '{"schema":"matchaclaw.agent-config"}\n',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });

    expect(result).toEqual({
      ok: true,
      path: filePath,
    });
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"schema":"matchaclaw.agent-config"}\n');
  });

  it('returns binary error for NUL-containing text preview reads', async () => {
    const filePath = join(workspaceRoot, 'raw.bin');
    await writeFile(filePath, Buffer.from([0x41, 0x00, 0x42]));

    const result = await fileService.readText({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });

    expect(result).toEqual({ ok: false, error: 'binary' });
  });

  it('reads binary previews as base64 payloads', async () => {
    const filePath = join(workspaceRoot, 'table.xlsx');
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    await writeFile(filePath, buffer);

    const result = await fileService.readBinary({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      path: filePath,
      data: buffer.toString('base64'),
      mimeType: 'application/octet-stream',
    }));
  });

  it('lists directory entries for workspace browser reads', async () => {
    const docsDir = join(workspaceRoot, 'docs');
    const filePath = join(docsDir, 'guide.md');
    const nestedDir = join(docsDir, 'nested');
    await createTestRuntimeFileSystem().ensureDirectory(docsDir);
    await createTestRuntimeFileSystem().ensureDirectory(nestedDir);
    await writeFile(filePath, 'guide', 'utf8');

    const result = await fileService.listDir({
      path: docsDir,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: docsDir, identity: testSessionIdentity },
    });

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

  it('routes workspace file thumbnail capability and preserves matching input/target path', async () => {
    const filePath = join(workspaceRoot, 'artifact.png');
    const fileServiceMock = {
      readText: vi.fn(),
      readBinary: vi.fn(),
      stat: vi.fn(),
      listDir: vi.fn(),
      writeText: vi.fn(),
      thumbnail: vi.fn(async () => ({ preview: 'data:image/png;base64,abc', fileSize: 3 })),
      stagePaths: vi.fn(),
      stageBuffer: vi.fn(),
    };
    const route = createWorkspaceFileCapabilityOperationRoutes({ fileService: fileServiceMock })
      .find((item) => item.operationId === 'files.thumbnail');
    expect(route).toBeDefined();

    await expect(route!.handle({
      capabilityId: 'workspace.file',
      operationId: 'files.thumbnail',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
      input: { path: filePath, mimeType: 'image/png' },
      domainInput: { path: filePath, mimeType: 'image/png' },
    })).resolves.toEqual({
      status: 200,
      data: { preview: 'data:image/png;base64,abc', fileSize: 3 },
    });
    expect(fileServiceMock.thumbnail).toHaveBeenCalledWith({
      path: filePath,
      mimeType: 'image/png',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });
  });

  it('rejects capability requests without workspace file target identity', async () => {
    const filePath = join(workspaceRoot, 'notes.md');
    const fileServiceMock = {
      readText: vi.fn(),
      readBinary: vi.fn(),
      stat: vi.fn(),
      listDir: vi.fn(),
      writeText: vi.fn(),
      thumbnail: vi.fn(),
      stagePaths: vi.fn(),
      stageBuffer: vi.fn(),
    };
    const [route] = createWorkspaceFileCapabilityOperationRoutes({ fileService: fileServiceMock });
    expect(route).toBeDefined();

    await expect(route!.handle({
      capabilityId: 'workspace.file',
      operationId: 'files.readText',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath } as never,
      input: { path: filePath },
      domainInput: { path: filePath },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Workspace file target identity does not match workspace scope' },
    });
    expect(fileServiceMock.readText).not.toHaveBeenCalled();
  });

  it('rejects capability requests when target path differs from input path', async () => {
    const filePath = join(workspaceRoot, 'notes.md');
    const fileServiceMock = {
      readText: vi.fn(),
      readBinary: vi.fn(),
      stat: vi.fn(),
      listDir: vi.fn(),
      writeText: vi.fn(),
      thumbnail: vi.fn(),
      stagePaths: vi.fn(),
      stageBuffer: vi.fn(),
    };
    const [route] = createWorkspaceFileCapabilityOperationRoutes({ fileService: fileServiceMock });
    expect(route).toBeDefined();

    await expect(route!.handle({
      capabilityId: 'workspace.file',
      operationId: 'files.readText',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: join(workspaceRoot, 'other.md'), identity: testSessionIdentity },
      input: { path: filePath },
      domainInput: { path: filePath },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Workspace file target path must match input path' },
    });
    expect(fileServiceMock.readText).not.toHaveBeenCalled();
  });

  it('rejects capability requests when UI supplied workspace metadata reaches the target', async () => {
    const filePath = join(workspaceRoot, 'notes.md');
    const fileServiceMock = {
      readText: vi.fn(),
      readBinary: vi.fn(),
      stat: vi.fn(),
      listDir: vi.fn(),
      writeText: vi.fn(),
      thumbnail: vi.fn(),
      stagePaths: vi.fn(),
      stageBuffer: vi.fn(),
    };
    const [route] = createWorkspaceFileCapabilityOperationRoutes({ fileService: fileServiceMock });
    expect(route).toBeDefined();

    await expect(route!.handle({
      capabilityId: 'workspace.file',
      operationId: 'files.readText',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, workspaceId: 'workspace-1', identity: testSessionIdentity },
      input: { path: filePath },
      domainInput: { path: filePath },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Workspace file target does not match workspace scope' },
    });
    expect(fileServiceMock.readText).not.toHaveBeenCalled();
  });

  it('rejects workspace file operations without target identity', async () => {
    const filePath = join(workspaceRoot, 'notes.md');
    await writeFile(filePath, '# Hello\n', 'utf8');

    const result = await fileService.readText({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath } as never,
    });

    expect(result).toEqual({ ok: false, error: 'invalidTarget' });
  });

  it('rejects workspace file operations when target path differs from input path', async () => {
    const filePath = join(workspaceRoot, 'notes.md');
    const otherPath = join(workspaceRoot, 'other.md');
    await writeFile(filePath, '# Hello\n', 'utf8');

    const result = await fileService.readText({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: otherPath, identity: testSessionIdentity },
    });

    expect(result).toEqual({ ok: false, error: 'pathMismatch' });
  });

  it('rejects workspace file operations when target path only matches after normalization', async () => {
    const filePath = join(workspaceRoot, 'notes.md');
    await writeFile(filePath, '# Hello\n', 'utf8');

    const result = await fileService.readText({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath.toUpperCase(), identity: testSessionIdentity },
    });

    expect(result).toEqual({ ok: false, error: 'pathMismatch' });
  });

  it('rejects stageBuffer oversized base64 before decoding', async () => {
    const oversizedBase64 = 'A'.repeat(Math.ceil((50 * 1024 * 1024 + 1) / 3) * 4);
    const fileSystem = createTestRuntimeFileSystem();
    const writeBinaryFile = vi.spyOn(fileSystem, 'writeBinaryFile');
    const runtimeWorkflow = new WorkspaceFileRuntimeWorkflow({
      fileSystem,
      idGenerator: { randomId: () => 'file-id', randomHex: () => 'file-id' },
      systemEnvironment: createTestRuntimeSystemEnvironment({ homeDir: tempHome }),
      runtimeDataStore: {
        getRuntimeDataRootDir: () => configDir,
      },
      workspaceRoots: {
        getMainWorkspaceDir: async () => workspaceRoot,
        getWorkspaceDirForSession: async () => workspaceRoot,
        getTaskWorkspaceDirs: async () => [workspaceRoot],
      },
    });
    const service = new FileService({ runtimeWorkflow });

    await expect(service.stageBuffer({
      base64: oversizedBase64,
      fileName: 'huge.bin',
      mimeType: 'application/octet-stream',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: {
        kind: 'workspace-staging',
        identity: {
          endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
          agentId: 'default',
          sessionKey: 'agent:default:main',
        },
      },
    })).rejects.toThrow('tooLarge');
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it('does not authorize all task workspace dirs for an identified workspace file target', async () => {
    const filePath = join(outsideRoot, 'task-secret.txt');
    await writeFile(filePath, 'secret', 'utf8');
    const runtimeWorkflow = new WorkspaceFileRuntimeWorkflow({
      fileSystem: createTestRuntimeFileSystem(),
      idGenerator: { randomId: () => 'file-id', randomHex: () => 'file-id' },
      systemEnvironment: createTestRuntimeSystemEnvironment({ homeDir: tempHome }),
      runtimeDataStore: {
        getRuntimeDataRootDir: () => configDir,
      },
      workspaceRoots: {
        getMainWorkspaceDir: async () => workspaceRoot,
        getWorkspaceDirForSession: async () => workspaceRoot,
        getTaskWorkspaceDirs: async () => [outsideRoot],
      },
    });
    const service = new FileService({ runtimeWorkflow });

    const result = await service.readText({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });

    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });

  it('rejects workspace file reads outside workspace roots', async () => {
    const filePath = join(outsideRoot, 'secret.txt');
    await writeFile(filePath, 'secret', 'utf8');

    const result = await fileService.readText({
      path: filePath,
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });

    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });

  it('rejects text writes outside workspace roots', async () => {
    const filePath = join(outsideRoot, 'exports', 'agent.json');

    const result = await fileService.writeText({
      path: filePath,
      content: '{}',
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    });

    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });

  it('stages only files addressed by a workspace staging target', async () => {
    const filePath = join(workspaceRoot, 'demo.txt');
    await writeFile(filePath, 'demo', 'utf8');

    const result = await fileService.stagePaths({
      filePaths: [filePath],
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: {
        kind: 'workspace-staging',
        identity: {
          endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
          agentId: 'default',
          sessionKey: 'agent:default:main',
        },
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'file-id',
        fileName: 'demo.txt',
        mimeType: 'text/plain',
        fileSize: 4,
      }),
    ]);
  });

  it('rejects stagePaths without a workspace staging target', async () => {
    const filePath = join(workspaceRoot, 'demo.txt');
    await writeFile(filePath, 'demo', 'utf8');

    await expect(fileService.stagePaths({
      filePaths: [filePath],
      target: { kind: 'workspace-file', path: filePath, identity: testSessionIdentity },
    })).rejects.toThrow('invalidTarget');
  });

  it('rejects stagePaths outside workspace roots', async () => {
    const filePath = join(outsideRoot, 'secret.txt');
    await writeFile(filePath, 'secret', 'utf8');

    await expect(fileService.stagePaths({
      filePaths: [filePath],
      scope: { kind: 'workspace', endpoint: testEndpoint },
      target: {
        kind: 'workspace-staging',
        identity: {
          endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
          agentId: 'default',
          sessionKey: 'agent:default:main',
        },
      },
    })).rejects.toThrow('forbidden');
  });
});
