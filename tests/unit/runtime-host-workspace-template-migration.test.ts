import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenClawWorkspaceService } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-service';
import { OpenClawWorkspaceMaintenanceWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-maintenance-workflow';
import { OpenClawWorkspaceQueryWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-query-workflow';
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

  const mainAgentTemplateFiles = [
    'AGENTS.md',
    'SOUL.md',
    'TOOLS.md',
    'IDENTITY.md',
    'USER.md',
    'HEARTBEAT.md',
  ] as const;

  function createService(options: { fileSystem?: ReturnType<typeof createTestRuntimeFileSystem> } = {}): OpenClawWorkspaceService {
    const config = {
      getConfigDir: () => tempRoot,
      read: async () => ({
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      }),
    };
    const environment = {
      getResourcesPath: () => resourcesDir,
      getWorkingDir: () => tempRoot,
      getOpenClawDirPath: () => openclawDir,
    };
    const fileSystem = options.fileSystem ?? createTestRuntimeFileSystem();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const queryWorkflow = new OpenClawWorkspaceQueryWorkflow({ config });
    return new OpenClawWorkspaceService(
      queryWorkflow,
      new OpenClawWorkspaceMaintenanceWorkflow({
        workspaceQuery: queryWorkflow,
        environment,
        fileSystem,
        logger,
      }),
    );
  }

  function createMaintenanceWorkflow(options: { fileSystem?: ReturnType<typeof createTestRuntimeFileSystem> } = {}): OpenClawWorkspaceMaintenanceWorkflow {
    const config = {
      getConfigDir: () => tempRoot,
      read: async () => ({
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      }),
    };
    const environment = {
      getResourcesPath: () => resourcesDir,
      getWorkingDir: () => tempRoot,
      getOpenClawDirPath: () => openclawDir,
    };
    const fileSystem = options.fileSystem ?? createTestRuntimeFileSystem();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const queryWorkflow = new OpenClawWorkspaceQueryWorkflow({ config });
    return new OpenClawWorkspaceMaintenanceWorkflow({
      workspaceQuery: queryWorkflow,
      environment,
      fileSystem,
      logger,
    });
  }

  async function writeMainAgentTemplates(prefix: string): Promise<void> {
    await Promise.all(mainAgentTemplateFiles.map((fileName) => writeFile(
      join(resourcesDir, 'agent-workspace-templates', 'main-agent', fileName),
      `# ${fileName}\n\n${prefix} ${fileName}\n`,
      'utf8',
    )));
  }

  async function writeUpstreamTemplates(prefix: string): Promise<void> {
    await Promise.all(mainAgentTemplateFiles.map((fileName) => writeFile(
      join(openclawDir, 'docs', 'reference', 'templates', fileName),
      `# ${fileName}\n\n${prefix} ${fileName}\n`,
      'utf8',
    )));
  }

  it('initializes main-agent workspace templates and removes legacy bootstrap', async () => {
    await writeMainAgentTemplates('managed');
    await writeFile(join(workspaceDir, 'BOOTSTRAP.md'), 'legacy bootstrap', 'utf8');

    const result = await createService().initializeAgentWorkspace(workspaceDir, {
      workspaceInitialization: 'mainAgentTemplate',
    });

    expect(result.removedBootstrapFiles).toEqual([join(workspaceDir, 'BOOTSTRAP.md')]);
    await expect(access(join(workspaceDir, 'BOOTSTRAP.md'))).rejects.toThrow();
    for (const fileName of mainAgentTemplateFiles) {
      await expect(readFile(join(workspaceDir, fileName), 'utf8')).resolves.toBe(`# ${fileName}\n\nmanaged ${fileName}\n`);
    }
  });

  it('preserves customized main-agent files and fills missing template files', async () => {
    await writeMainAgentTemplates('managed');
    await writeFile(join(workspaceDir, 'AGENTS.md'), '# AGENTS.md\n\ncustom user instructions\n', 'utf8');

    await createService().initializeAgentWorkspace(workspaceDir, {
      workspaceInitialization: 'mainAgentTemplate',
    });

    await expect(readFile(join(workspaceDir, 'AGENTS.md'), 'utf8')).resolves.toBe('# AGENTS.md\n\ncustom user instructions\n');
    for (const fileName of mainAgentTemplateFiles.filter((candidate) => candidate !== 'AGENTS.md')) {
      await expect(readFile(join(workspaceDir, fileName), 'utf8')).resolves.toBe(`# ${fileName}\n\nmanaged ${fileName}\n`);
    }
  });

  it('replaces upstream defaults with managed main-agent templates', async () => {
    await writeMainAgentTemplates('managed');
    await writeUpstreamTemplates('upstream');
    await Promise.all(mainAgentTemplateFiles.map((fileName) => writeFile(
      join(workspaceDir, fileName),
      `# ${fileName}\r\n\r\nupstream ${fileName}\r\n`,
      'utf8',
    )));

    const result = await createService().migrateMainAgentTemplatesIfNeeded();

    expect(result.migratedFiles).toEqual([...mainAgentTemplateFiles]);
    for (const fileName of mainAgentTemplateFiles) {
      await expect(readFile(join(workspaceDir, fileName), 'utf8')).resolves.toBe(`# ${fileName}\n\nmanaged ${fileName}\n`);
    }
  });

  it('does not seed main-agent markdown files for empty workspaces', async () => {
    await writeMainAgentTemplates('managed');
    const emptyWorkspaceDir = join(tempRoot, 'empty-workspace');

    await createService().initializeAgentWorkspace(emptyWorkspaceDir, {
      createDir: true,
      workspaceInitialization: 'emptyWorkspace',
    });

    await expect(access(emptyWorkspaceDir)).resolves.toBeUndefined();
    for (const fileName of mainAgentTemplateFiles) {
      await expect(access(join(emptyWorkspaceDir, fileName))).rejects.toThrow();
    }
  });

  it('reads each main-agent template file once during a migration call', async () => {
    await writeMainAgentTemplates('managed');
    await writeUpstreamTemplates('upstream');
    await Promise.all(mainAgentTemplateFiles.map((fileName) => writeFile(
      join(workspaceDir, fileName),
      `# ${fileName}\n\nupstream ${fileName}\n`,
      'utf8',
    )));
    const fileSystem = createTestRuntimeFileSystem();
    const readTextFile = vi.spyOn(fileSystem, 'readTextFile');

    await createService({ fileSystem }).migrateMainAgentTemplatesIfNeeded();

    for (const fileName of mainAgentTemplateFiles) {
      expect(readTextFile.mock.calls.filter(([pathname]) => pathname === join(resourcesDir, 'agent-workspace-templates', 'main-agent', fileName))).toHaveLength(1);
      expect(readTextFile.mock.calls.filter(([pathname]) => pathname === join(openclawDir, 'docs', 'reference', 'templates', fileName))).toHaveLength(1);
    }
  });

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

    const result = await createMaintenanceWorkflow().ensureIdentityFile(workspaceDir);

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

    await expect(createMaintenanceWorkflow().ensureIdentityFile(workspaceDir)).resolves.toMatchObject({
      wroteIdentity: true,
      replacedTemplate: true,
    });
    await expect(readFile(identityPath, 'utf8')).resolves.toBe('# IDENTITY.md\n\n- **名字：** Matcha\n');

    await writeFile(identityPath, '# IDENTITY.md\n\n- **Name:** Custom\n', 'utf8');
    await expect(createMaintenanceWorkflow().ensureIdentityFile(workspaceDir)).resolves.toMatchObject({
      wroteIdentity: false,
      replacedTemplate: false,
    });
    await expect(readFile(identityPath, 'utf8')).resolves.toBe('# IDENTITY.md\n\n- **Name:** Custom\n');
  });

  it('ensures identity files for every configured task workspace', async () => {
    const subagentWorkspaceDir = join(tempRoot, 'workspace-subagents', 'writer');
    const config = {
      getConfigDir: () => openclawDir,
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
    };
    const environment = {
      getResourcesPath: () => resourcesDir,
      getWorkingDir: () => tempRoot,
      getOpenClawDirPath: () => openclawDir,
    };
    const fileSystem = createTestRuntimeFileSystem();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const queryWorkflow = new OpenClawWorkspaceQueryWorkflow({ config });
    const service = new OpenClawWorkspaceService(
      queryWorkflow,
      new OpenClawWorkspaceMaintenanceWorkflow({
        workspaceQuery: queryWorkflow,
        environment,
        fileSystem,
        logger,
      }),
    );

    const result = await service.ensureDefaultIdentity();

    expect(result.workspaceDirs).toEqual([workspaceDir, subagentWorkspaceDir]);
    await expect(readFile(join(workspaceDir, 'IDENTITY.md'), 'utf8')).resolves.toContain('Matcha');
    await expect(readFile(join(subagentWorkspaceDir, 'IDENTITY.md'), 'utf8')).resolves.toContain('Matcha');
  });
});
