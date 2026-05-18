import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenClawWorkspaceService } from '../../runtime-host/application/openclaw/openclaw-workspace-service';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';

describe('runtime-host workspace template migration', () => {
  let tempRoot = '';
  let workspaceDir = '';
  let resourcesDir = '';
  let openclawDir = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-workspace-template-'));
    workspaceDir = join(tempRoot, 'workspace');
    resourcesDir = join(tempRoot, 'resources');
    openclawDir = join(tempRoot, 'openclaw');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(resourcesDir, 'agent-workspace-templates', 'main-agent'), { recursive: true });
    await mkdir(join(openclawDir, 'docs', 'reference', 'templates'), { recursive: true });
    await writeFile(
      join(resourcesDir, 'agent-workspace-templates', 'main-agent', 'IDENTITY.md'),
      '# IDENTITY.md\n\n- **名字：** Matcha\n',
      'utf8',
    );
    await writeFile(
      join(openclawDir, 'docs', 'reference', 'templates', 'IDENTITY.md'),
      '# IDENTITY.md - Who Am I?\n\n- **Name:**\n  _(pick something you like)_\n',
      'utf8',
    );
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  function createService(): OpenClawWorkspaceService {
    return new OpenClawWorkspaceService(
      {
        getConfigDir: () => tempRoot,
        read: async () => ({
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        }),
      },
      {
        getResourcesPath: () => resourcesDir,
        getWorkingDir: () => tempRoot,
        getOpenClawDirPath: () => openclawDir,
      },
      createTestRuntimeFileSystem(),
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );
  }

  it('treats CRLF/LF-only differences as the same upstream template and migrates', async () => {
    const managedPath = join(resourcesDir, 'agent-workspace-templates', 'main-agent', 'AGENTS.md');
    const upstreamPath = join(openclawDir, 'docs', 'reference', 'templates', 'AGENTS.md');
    const workspacePath = join(workspaceDir, 'AGENTS.md');
    await writeFile(managedPath, '# AGENTS.md\n\nManaged\n', 'utf8');
    await writeFile(upstreamPath, '# AGENTS.md\n\nHello\n', 'utf8');
    await writeFile(workspacePath, '# AGENTS.md\r\n\r\nHello\r\n', 'utf8');

    const result = await createService().migrateMainAgentTemplatesIfNeeded();

    expect(result.migratedFiles).toEqual(['AGENTS.md']);
    await expect(readFile(workspacePath, 'utf8')).resolves.toBe('# AGENTS.md\n\nManaged\n');
  });

  it('does not replace a workspace file once it diverges from the upstream default', async () => {
    const managedPath = join(resourcesDir, 'agent-workspace-templates', 'main-agent', 'AGENTS.md');
    const upstreamPath = join(openclawDir, 'docs', 'reference', 'templates', 'AGENTS.md');
    const workspacePath = join(workspaceDir, 'AGENTS.md');
    await writeFile(managedPath, '# AGENTS.md\n\nManaged\n', 'utf8');
    await writeFile(upstreamPath, '# AGENTS.md\n\nOfficial default\n', 'utf8');
    await writeFile(workspacePath, '# AGENTS.md\n\nCustomized for this user\n', 'utf8');

    const result = await createService().migrateMainAgentTemplatesIfNeeded();

    expect(result.migratedFiles).toEqual([]);
    await expect(readFile(workspacePath, 'utf8')).resolves.toBe('# AGENTS.md\n\nCustomized for this user\n');
  });

  it('creates a default identity and removes legacy bootstrap files from managed workspaces', async () => {
    await writeFile(join(workspaceDir, 'BOOTSTRAP.md'), 'chat-first bootstrap', 'utf8');

    const result = await createService().ensureIdentityFile(workspaceDir);

    expect(result).toEqual({
      wroteIdentity: true,
      replacedTemplate: false,
      removedBootstrap: true,
    });
    await expect(readFile(join(workspaceDir, 'IDENTITY.md'), 'utf8')).resolves.toBe('# IDENTITY.md\n\n- **名字：** Matcha\n');
    await expect(access(join(workspaceDir, 'BOOTSTRAP.md'))).rejects.toThrow();
  });

  it('replaces only untouched upstream identity templates', async () => {
    const identityPath = join(workspaceDir, 'IDENTITY.md');
    await writeFile(identityPath, '# IDENTITY.md - Who Am I?\n\n- **Name:**\n  _(pick something you like)_\n', 'utf8');

    await expect(createService().ensureIdentityFile(workspaceDir)).resolves.toMatchObject({
      wroteIdentity: true,
      replacedTemplate: true,
    });
    await expect(readFile(identityPath, 'utf8')).resolves.toBe('# IDENTITY.md\n\n- **名字：** Matcha\n');

    await writeFile(identityPath, '# IDENTITY.md\n\n- **Name:** Custom\n', 'utf8');
    await expect(createService().ensureIdentityFile(workspaceDir)).resolves.toMatchObject({
      wroteIdentity: false,
      replacedTemplate: false,
    });
    await expect(readFile(identityPath, 'utf8')).resolves.toBe('# IDENTITY.md\n\n- **Name:** Custom\n');
  });

  it('ensures identity files for every configured task workspace', async () => {
    const subagentWorkspaceDir = join(tempRoot, 'workspace-subagents', 'writer');
    const service = new OpenClawWorkspaceService(
      {
        getConfigDir: () => tempRoot,
        read: async () => ({
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
            list: [
              { id: 'writer', workspace: subagentWorkspaceDir },
            ],
          },
        }),
      },
      {
        getResourcesPath: () => resourcesDir,
        getWorkingDir: () => tempRoot,
        getOpenClawDirPath: () => openclawDir,
      },
      createTestRuntimeFileSystem(),
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    const result = await service.ensureDefaultIdentity();

    expect(result.workspaceDirs).toEqual([workspaceDir, subagentWorkspaceDir]);
    await expect(readFile(join(workspaceDir, 'IDENTITY.md'), 'utf8')).resolves.toContain('Matcha');
    await expect(readFile(join(subagentWorkspaceDir, 'IDENTITY.md'), 'utf8')).resolves.toContain('Matcha');
  });
});
