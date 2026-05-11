import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
});
