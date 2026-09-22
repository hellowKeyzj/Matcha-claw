import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleOpenClawRoutes } from '../../electron/api/routes/openclaw';

function createRequest(method: string, body?: string) {
  return Object.assign(Readable.from(body === undefined ? [] : [body]), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

function createResponse() {
  const response = { statusCode: 200, body: null as unknown };
  return {
    response,
    raw: {
      get statusCode() { return response.statusCode; },
      set statusCode(value: number) { response.statusCode = value; },
      setHeader: vi.fn(),
      end: (content?: string) => { response.body = content ? JSON.parse(content) : null; },
    },
  };
}

function context(
  command: ReturnType<typeof vi.fn> = vi.fn(),
  runtimeControlTransport: Record<string, unknown> = {},
  openClawPlatformTransport: Record<string, unknown> = {},
) {
  return {
    runtimeHost: { command },
    runtimeHostTransports: { runtimeControlTransport, openClawPlatformTransport },
  } as never;
}

function transportResponse(body: unknown, status = 200) {
  return { status, body };
}

function succeeded(result: unknown) {
  return { kind: 'succeeded' as const, result };
}

describe('OpenClaw Host API routes', () => {
  it('projects the Rust installation status and readiness with the trusted directory', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      environmentStatus: vi.fn().mockResolvedValue(transportResponse({
        packageExists: true,
        isBuilt: true,
        dir: 'E:/runtime/openclaw',
        version: '1.2.3',
      })),
    };
    const status = createResponse();
    const ready = createResponse();

    await expect(handleOpenClawRoutes(
      createRequest('GET') as never,
      status.raw as never,
      new URL('http://localhost/api/openclaw/status'),
      context(command, {}, openClawPlatformTransport),
    )).resolves.toBe(true);
    await expect(handleOpenClawRoutes(
      createRequest('GET') as never,
      ready.raw as never,
      new URL('http://localhost/api/openclaw/ready'),
      context(command, {}, openClawPlatformTransport),
    )).resolves.toBe(true);

    expect(openClawPlatformTransport.environmentStatus).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
    expect(status.response.statusCode).toBe(200);
    expect(status.response.body).toEqual({
      packageExists: true,
      isBuilt: true,
      dir: 'E:/runtime/openclaw',
      version: '1.2.3',
    });
    expect(ready.response.statusCode).toBe(200);
    expect(ready.response.body).toBe(true);
    expect(JSON.stringify(status.response.body)).not.toMatch(/(?:path|sourcePath|configPath|token|secret|endpoint|argv)/);
  });

  it('fails closed for unexpected status fields', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      environmentStatus: vi.fn().mockResolvedValue(transportResponse({
        packageExists: true,
        isBuilt: true,
        dir: 'E:/runtime/openclaw',
        version: '1.2.3',
        path: 'E:/private/openclaw',
      })),
    };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/status'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw environment status is unavailable',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('E:/private/openclaw');
  });

  it.each([
    {
      status: 200,
      body: {
        packageExists: true,
        isBuilt: true,
        version: '1.2.3',
      },
    },
    {
      status: 200,
      body: {
        packageExists: true,
        isBuilt: true,
        dir: 'E:/runtime/openclaw',
        token: 'private-token',
      },
    },
    { status: 503, body: { success: false, error: 'private native error' } },
  ] as const)('maps malformed or unavailable status outcome to unavailable', async (outcome) => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      environmentStatus: vi.fn().mockResolvedValue(transportResponse(outcome.body, outcome.status)),
    };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/status'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw environment status is unavailable',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('private-token');
  });

  it('rejects empty, control-character, and oversized installation directories', async () => {
    for (const dir of ['', 'E:/runtime/\u0000openclaw', 'x'.repeat(16 * 1024 + 1)]) {
      const command = vi.fn();
      const openClawPlatformTransport = {
        environmentStatus: vi.fn().mockResolvedValue(transportResponse({ packageExists: true, isBuilt: true, dir })),
      };
      const fixture = createResponse();

      await handleOpenClawRoutes(
        createRequest('GET') as never,
        fixture.raw as never,
        new URL('http://localhost/api/openclaw/status'),
        context(command, {}, openClawPlatformTransport),
      );

      expect(fixture.response.statusCode).toBe(503);
      expect(fixture.response.body).toEqual({
        success: false,
        error: 'OpenClaw environment status is unavailable',
      });
    }
  });

  it('projects template catalog and detail while removing native path fields', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      subagentTemplateCatalog: vi.fn().mockResolvedValue(transportResponse({
        categories: [{ id: 'design', order: 10 }],
        templates: [{
          id: 'brand-guardian',
          name: 'Brand Guardian',
          categoryId: 'design',
          subcategoryId: 'game-development/godot',
          files: ['AGENTS.md'],
        }],
      })),
      subagentTemplateDetail: vi.fn().mockResolvedValue(transportResponse({
        template: {
          id: 'brand-guardian',
          name: 'Brand Guardian',
          files: ['AGENTS.md'],
          fileContents: { 'AGENTS.md': 'Guard the brand.' },
        },
      })),
    };
    const catalog = createResponse();
    const detail = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      catalog.raw as never,
      new URL('http://localhost/api/openclaw/subagent-templates'),
      context(command, {}, openClawPlatformTransport),
    );
    await handleOpenClawRoutes(
      createRequest('GET') as never,
      detail.raw as never,
      new URL('http://localhost/api/openclaw/subagent-templates/brand-guardian'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(openClawPlatformTransport.subagentTemplateCatalog).toHaveBeenCalledWith();
    expect(openClawPlatformTransport.subagentTemplateDetail).toHaveBeenCalledWith({ id: 'brand-guardian' });
    expect(command).not.toHaveBeenCalled();
    expect(catalog.response.statusCode).toBe(200);
    expect(catalog.response.body).toEqual({
      categories: [{ id: 'design', order: 10 }],
      templates: [{
        id: 'brand-guardian',
        name: 'Brand Guardian',
        categoryId: 'design',
        subcategoryId: 'game-development/godot',
        files: ['AGENTS.md'],
      }],
    });
    expect(detail.response.statusCode).toBe(200);
    expect(detail.response.body).toEqual({
      template: {
        id: 'brand-guardian',
        name: 'Brand Guardian',
        files: ['AGENTS.md'],
        fileContents: { 'AGENTS.md': 'Guard the brand.' },
      },
    });
  });

  it('rejects private template fields and unsafe template ids', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      subagentTemplateDetail: vi.fn().mockResolvedValue(transportResponse({
        template: {
          id: 'brand-guardian',
          name: 'Brand Guardian',
          files: ['AGENTS.md'],
          fileContents: { 'AGENTS.md': 'safe' },
          sourcePath: 'E:/private/templates/brand-guardian',
        },
      })),
    };
    const privateFields = createResponse();
    const unsafeId = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      privateFields.raw as never,
      new URL('http://localhost/api/openclaw/subagent-templates/brand-guardian'),
      context(command, {}, openClawPlatformTransport),
    );
    await handleOpenClawRoutes(
      createRequest('GET') as never,
      unsafeId.raw as never,
      new URL('http://localhost/api/openclaw/subagent-templates/brand_guardian'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(privateFields.response.statusCode).toBe(503);
    expect(privateFields.response.body).toEqual({
      success: false,
      error: 'OpenClaw subagent template is unavailable',
    });
    expect(JSON.stringify(privateFields.response.body)).not.toContain('E:/private/templates');
    expect(unsafeId.response.statusCode).toBe(400);
    expect(unsafeId.response.body).toEqual({
      success: false,
      error: 'OpenClaw subagent template is unavailable',
    });
    expect(openClawPlatformTransport.subagentTemplateDetail).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
  });

  it('projects the bounded runtime snapshot without process identities', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({
      state: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle' },
        openClaw: { lifecycle: 'running' },
      },
      health: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle' },
        openClaw: { lifecycle: 'running' },
      },
      gateway: {
        availability: 'available',
        ok: true,
        timestampMs: 1,
        durationMs: 2,
        channelCount: 1,
        agentCount: 1,
        sessionCount: 1,
        heartbeatEnabled: null,
      },
      control: { ready: true, phase: 'ready', retryable: false },
      observedAtMs: 3,
    }));
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/runtime/snapshot'),
      context(command),
    );

    expect(command).toHaveBeenCalledWith({ name: 'host.runtime.snapshot' });
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toMatchObject({
      observedAtMs: 3,
      gateway: { availability: 'available' },
    });
  });

  it('fails closed for private runtime snapshot fields', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({
      state: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle', pid: 42 },
        openClaw: { lifecycle: 'running' },
      },
      health: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle' },
        openClaw: { lifecycle: 'running' },
      },
      gateway: { availability: 'unavailable' },
      control: { ready: false, phase: 'unavailable', retryable: false },
      observedAtMs: 3,
    }));
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/runtime/snapshot'),
      context(command),
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw runtime snapshot is unavailable',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('42');
  });

  it('projects lifecycle status and restart state without private diagnostics', async () => {
    const command = vi.fn();
    const runtimeControlTransport = {
      lifecycleStatus: vi.fn().mockResolvedValue({
        status: 200,
        body: { result: { lifecycle: 'failed', observedAtMs: 1_725_000_000_000, failure: 'readiness', startupDiagnostic: 'appServerReportedError' } },
      }),
      lifecycleRestart: vi.fn().mockResolvedValue({
        status: 200,
        body: { result: { lifecycle: 'starting', observedAtMs: 1_725_000_000_000 } },
      }),
    };
    const status = createResponse();
    const restart = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      status.raw as never,
      new URL('http://localhost/api/openclaw/lifecycle/status'),
      context(command, runtimeControlTransport),
    );
    await handleOpenClawRoutes(
      createRequest('POST') as never,
      restart.raw as never,
      new URL('http://localhost/api/openclaw/lifecycle/restart'),
      context(command, runtimeControlTransport),
    );

    expect(runtimeControlTransport.lifecycleStatus).toHaveBeenCalledWith();
    expect(runtimeControlTransport.lifecycleRestart).toHaveBeenCalledWith();
    expect(command).not.toHaveBeenCalled();
    expect(status.response.statusCode).toBe(200);
    expect(status.response.body).toEqual({
      processState: 'failed',
      failure: 'readiness',
      startupDiagnostic: 'appServerReportedError',
    });
    expect(restart.response.statusCode).toBe(200);
    expect(restart.response.body).toEqual({
      success: true,
      status: { processState: 'starting' },
    });
  });

  it('reports unknown restart delivery without exposing native errors', async () => {
    const command = vi.fn();
    const runtimeControlTransport = {
      lifecycleRestart: vi.fn().mockResolvedValue({
        status: 503,
        body: { success: false, error: 'private native error' },
      }),
    };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/lifecycle/restart'),
      context(command, runtimeControlTransport),
    );

    expect(runtimeControlTransport.lifecycleRestart).toHaveBeenCalledWith();
    expect(command).not.toHaveBeenCalled();
    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw lifecycle restart outcome is unknown',
    });
  });

  it.each([
    ['/api/openclaw/dir', 'E:/runtime/openclaw'],
    ['/api/openclaw/config-dir', 'E:/runtime/openclaw-config'],
    ['/api/openclaw/workspace-dir', 'E:/runtime/workspace'],
    ['/api/openclaw/skills-dir', 'E:/runtime/skills'],
  ] as const)('projects %s from the sealed runtime paths result', async (pathname, expected) => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      runtimePaths: vi.fn().mockResolvedValue(transportResponse({
        openclawDirectory: 'E:/runtime/openclaw',
        configDirectory: 'E:/runtime/openclaw-config',
        workspaceDirectory: 'E:/runtime/workspace',
        taskWorkspaceDirectories: ['E:/runtime/workspace/task-a'],
        skillsDirectory: 'E:/runtime/skills',
      })),
    };
    const fixture = createResponse();

    await expect(handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL(`http://localhost${pathname}`),
      context(command, {}, openClawPlatformTransport),
    )).resolves.toBe(true);

    expect(openClawPlatformTransport.runtimePaths).toHaveBeenCalledWith();
    expect(command).not.toHaveBeenCalled();
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toBe(expected);
  });

  it('projects task workspace directories from the sealed runtime paths result', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      runtimePaths: vi.fn().mockResolvedValue(transportResponse({
        openclawDirectory: 'E:/runtime/openclaw',
        configDirectory: 'E:/runtime/openclaw-config',
        workspaceDirectory: 'E:/runtime/workspace',
        taskWorkspaceDirectories: ['E:/runtime/workspace/task-a', 'E:/runtime/workspace/task-b'],
        skillsDirectory: 'E:/runtime/skills',
      })),
    };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/task-workspace-dirs'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(openClawPlatformTransport.runtimePaths).toHaveBeenCalledWith();
    expect(command).not.toHaveBeenCalled();
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toEqual([
      'E:/runtime/workspace/task-a',
      'E:/runtime/workspace/task-b',
    ]);
  });

  it('projects the sealed CLI command and tool permission mode', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      cliCommand: vi.fn().mockResolvedValue(transportResponse({ command: 'E:/runtime/openclaw.cmd' })),
      toolPermissionMode: vi.fn().mockResolvedValue(transportResponse({ mode: 'default' })),
    };
    const cli = createResponse();
    const permission = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      cli.raw as never,
      new URL('http://localhost/api/openclaw/cli-command'),
      context(command, {}, openClawPlatformTransport),
    );
    await handleOpenClawRoutes(
      createRequest('GET') as never,
      permission.raw as never,
      new URL('http://localhost/api/openclaw/tool-permission-mode'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(openClawPlatformTransport.cliCommand).toHaveBeenCalledWith();
    expect(openClawPlatformTransport.toolPermissionMode).toHaveBeenCalledWith();
    expect(command).not.toHaveBeenCalled();
    expect(cli.response.statusCode).toBe(200);
    expect(cli.response.body).toEqual({ success: true, command: 'E:/runtime/openclaw.cmd' });
    expect(permission.response.statusCode).toBe(200);
    expect(permission.response.body).toEqual({ mode: 'default' });
  });

  it('updates tool permission mode without exposing the native write receipt', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      setToolPermissionMode: vi.fn().mockResolvedValue(transportResponse({ mode: 'fullAccess', changed: true })),
    };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('PUT', JSON.stringify({ mode: 'fullAccess' })) as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/tool-permission-mode'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(openClawPlatformTransport.setToolPermissionMode).toHaveBeenCalledWith({ mode: 'fullAccess' });
    expect(command).not.toHaveBeenCalled();
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toEqual({ mode: 'fullAccess' });
    expect(JSON.stringify(fixture.response.body)).not.toContain('changed');
  });

  it('fails closed for malformed tool permission write results', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      setToolPermissionMode: vi.fn().mockResolvedValue(transportResponse({
        mode: 'default',
        changed: false,
        sourcePath: 'E:/private/openclaw.json',
      })),
    };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('PUT', JSON.stringify({ mode: 'default' })) as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/tool-permission-mode'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw tool permission mode is unavailable',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('E:/private/openclaw.json');
  });

  it.each([
    undefined,
    '',
    '{',
    JSON.stringify({}),
    JSON.stringify({ mode: 'all' }),
    JSON.stringify({ mode: 'default', extra: true }),
  ])('rejects invalid tool permission updates before invoking Rust', async (body) => {
    const command = vi.fn();
    const openClawPlatformTransport = { setToolPermissionMode: vi.fn() };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('PUT', body) as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/tool-permission-mode'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(openClawPlatformTransport.setToolPermissionMode).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(fixture.response.statusCode).toBe(400);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'permission mode must be "default" or "fullAccess"',
    });
  });

  it.each([
    [400, 400],
    [503, 503],
    [500, 500],
  ] as const)('maps Rust %s transport failures to the stable public status', async (transportStatus, statusCode) => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      runtimePaths: vi.fn().mockResolvedValue(transportResponse({ success: false, error: 'private native error' }, transportStatus)),
    };
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/dir'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(fixture.response.statusCode).toBe(statusCode);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw directory is unavailable',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('private native error');
  });

  it('fails closed for malformed or private OpenClaw projections', async () => {
    const cases = [
      {
        pathname: '/api/openclaw/dir',
        openClawPlatformTransport: {
          runtimePaths: vi.fn().mockResolvedValue(transportResponse({
            openclawDirectory: 'E:/runtime/openclaw',
            configDirectory: 'E:/runtime/openclaw-config',
            workspaceDirectory: 'E:/runtime/workspace',
            taskWorkspaceDirectories: [],
            skillsDirectory: 'E:/runtime/skills',
            sourcePath: 'E:/private/source',
          })),
        },
        error: 'OpenClaw directory is unavailable',
      },
      {
        pathname: '/api/openclaw/cli-command',
        openClawPlatformTransport: {
          cliCommand: vi.fn().mockResolvedValue(transportResponse({ command: 'E:/runtime/openclaw.cmd', token: 'private-token' })),
        },
        error: 'OpenClaw CLI command is unavailable',
      },
      {
        pathname: '/api/openclaw/tool-permission-mode',
        openClawPlatformTransport: {
          toolPermissionMode: vi.fn().mockResolvedValue(transportResponse({ mode: 'default', secret: 'private-secret' })),
        },
        error: 'OpenClaw tool permission mode is unavailable',
      },
    ];

    for (const testCase of cases) {
      const command = vi.fn();
      const fixture = createResponse();
      await handleOpenClawRoutes(
        createRequest('GET') as never,
        fixture.raw as never,
        new URL(`http://localhost${testCase.pathname}`),
        context(command, {}, testCase.openClawPlatformTransport),
      );
      expect(fixture.response.statusCode).toBe(503);
      expect(fixture.response.body).toEqual({ success: false, error: testCase.error });
      expect(JSON.stringify(fixture.response.body)).not.toMatch(/sourcePath|private-token|private-secret/);
      expect(command).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      pathname: '/api/openclaw/dir',
      openClawPlatformTransport: {
        runtimePaths: vi.fn().mockResolvedValue(transportResponse({
          openclawDirectory: `E:/runtime/${String.fromCharCode(0)}openclaw`,
          configDirectory: 'E:/runtime/openclaw-config',
          workspaceDirectory: 'E:/runtime/workspace',
          taskWorkspaceDirectories: [],
          skillsDirectory: 'E:/runtime/skills',
        })),
      },
      error: 'OpenClaw directory is unavailable',
    },
    {
      pathname: '/api/openclaw/cli-command',
      openClawPlatformTransport: {
        cliCommand: vi.fn().mockResolvedValue(transportResponse({ command: ['openclaw', '--version'].join(String.fromCharCode(10)) })),
      },
      error: 'OpenClaw CLI command is unavailable',
    },
  ])('rejects control characters in sealed OpenClaw strings', async ({ pathname, openClawPlatformTransport, error }) => {
    const command = vi.fn();
    const fixture = createResponse();

    await handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL(`http://localhost${pathname}`),
      context(command, {}, openClawPlatformTransport),
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({ success: false, error });
  });

  it('reports platform transport failures as unavailable without native details', async () => {
    const command = vi.fn();
    const openClawPlatformTransport = {
      runtimePaths: vi.fn().mockRejectedValue(new Error('private read timeout')),
      setToolPermissionMode: vi.fn().mockRejectedValue(new Error('private write timeout')),
    };
    const readFixture = createResponse();
    await handleOpenClawRoutes(
      createRequest('GET') as never,
      readFixture.raw as never,
      new URL('http://localhost/api/openclaw/dir'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(readFixture.response.statusCode).toBe(503);
    expect(readFixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw directory is unavailable',
    });

    const writeFixture = createResponse();
    await handleOpenClawRoutes(
      createRequest('PUT', JSON.stringify({ mode: 'default' })) as never,
      writeFixture.raw as never,
      new URL('http://localhost/api/openclaw/tool-permission-mode'),
      context(command, {}, openClawPlatformTransport),
    );

    expect(writeFixture.response.statusCode).toBe(503);
    expect(writeFixture.response.body).toEqual({
      success: false,
      error: 'OpenClaw tool permission mode is unavailable',
    });
    expect(JSON.stringify(writeFixture.response.body)).not.toMatch(/private .* timeout/);
    expect(command).not.toHaveBeenCalled();
  });

  it('does not claim unrelated OpenClaw paths or methods', async () => {
    const command = vi.fn();
    const fixture = createResponse();

    await expect(handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/lifecycle/restart'),
      context(command),
    )).resolves.toBe(false);
    await expect(handleOpenClawRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/openclaw/unknown'),
      context(command),
    )).resolves.toBe(false);

    expect(command).not.toHaveBeenCalled();
  });
});
