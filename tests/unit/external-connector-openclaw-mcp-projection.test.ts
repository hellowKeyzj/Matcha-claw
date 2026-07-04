import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExternalConnectorOpenClawMcpProjectionService,
  projectExternalConnectorToOpenClawMcpServer,
} from '../../runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-projection';
import type { ExternalConnectorSpec } from '../../runtime-host/application/external-connectors/external-connector-model';
import type { OpenClawConfigRepositoryPort } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository';

class MemoryOpenClawConfigRepository implements OpenClawConfigRepositoryPort {
  constructor(private config: Record<string, unknown>) {}

  async read(): Promise<Record<string, unknown>> {
    return this.config;
  }

  async write(config: Record<string, unknown>): Promise<void> {
    this.config = config;
  }

  async updateDirty<T>(mutate: (config: Record<string, unknown>) => { result: T; changed: boolean } | Promise<{ result: T; changed: boolean }>): Promise<T> {
    const update = await mutate(this.config);
    return update.result;
  }

  async patchSection<T>(sectionKey: string, mutate: (value: unknown, config: Record<string, unknown>) => { result: T; value: unknown; changed: boolean } | Promise<{ result: T; value: unknown; changed: boolean }>): Promise<T> {
    const update = await mutate(this.config[sectionKey], this.config);
    if (update.changed) {
      if (update.value === undefined) {
        delete this.config[sectionKey];
      } else {
        this.config[sectionKey] = update.value;
      }
    }
    return update.result;
  }

  getConfigDir(): string {
    return '';
  }

  getConfigFilePath(): string {
    return '';
  }

  getOpenClawDirPath(): string {
    return '';
  }
}

describe('projectExternalConnectorToOpenClawMcpServer', () => {
  it('projects MCP stdio and HTTP connectors to OpenClaw MCP server config', async () => {
    await expect(projectExternalConnectorToOpenClawMcpServer({
      id: 'stdio-tools',
      kind: 'mcp-stdio',
      command: 'npx',
      args: ['tools-mcp'],
      env: { TOOLS_HOST: 'local' },
    })).resolves.toEqual({
      resultType: 'projectable',
      connectorId: 'stdio-tools',
      serverId: 'stdio-tools',
      server: {
        command: 'npx',
        args: ['tools-mcp'],
        env: { TOOLS_HOST: 'local' },
      },
    });

    await expect(projectExternalConnectorToOpenClawMcpServer({
      id: 'docs',
      kind: 'mcp-http',
      url: 'https://mcp.example.com',
    })).resolves.toEqual({
      resultType: 'projectable',
      connectorId: 'docs',
      serverId: 'docs',
      server: {
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
      },
    });
  });

  it('projects system-runtime MCP stdio through an absolute Matcha CLI entrypoint', async () => {
    const projection = await projectExternalConnectorToOpenClawMcpServer({
      id: 'matcha',
      kind: 'mcp-stdio',
      command: 'matcha',
      args: ['system-runtime', 'mcp-stdio'],
      env: { MATCHACLAW_RUNTIME_HOST_PORT: '39001' },
      mcpServerProgram: { source: 'system-runtime', programId: 'system-runtime:matcha' },
    });

    expect(projection).toMatchObject({
      resultType: 'projectable',
      connectorId: 'matcha',
      serverId: 'matcha',
    });
    if (projection.resultType !== 'projectable') {
      throw new Error('expected system-runtime projection to be projectable');
    }

    expect(projection.server.command).toBe(resolve(process.execPath));
    expect(projection.server.command).not.toBe('matcha');
    expect(projection.server.args).toEqual([
      expect.stringMatching(/runtime-host[\\/]build[\\/]main-cli\.js$/),
      'system-runtime',
      'mcp-stdio',
    ]);
    expect(isAbsolute((projection.server.args as string[])[0])).toBe(true);
    expect(projection.server.env).toEqual({
      MATCHACLAW_RUNTIME_HOST_PORT: '39001',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('honors an explicit system-runtime CLI entrypoint override', async () => {
    const previous = process.env.MATCHACLAW_MAIN_CLI_ENTRY;
    process.env.MATCHACLAW_MAIN_CLI_ENTRY = 'custom/runtime-host-main-cli.js';
    try {
      const projection = await projectExternalConnectorToOpenClawMcpServer({
        id: 'matcha',
        kind: 'mcp-stdio',
        command: 'matcha',
        mcpServerProgram: { source: 'system-runtime' },
      });

      expect(projection).toMatchObject({ resultType: 'projectable' });
      if (projection.resultType !== 'projectable') {
        throw new Error('expected system-runtime projection to be projectable');
      }
      expect(projection.server.args).toEqual([
        resolve('custom/runtime-host-main-cli.js'),
        'system-runtime',
        'mcp-stdio',
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.MATCHACLAW_MAIN_CLI_ENTRY;
      } else {
        process.env.MATCHACLAW_MAIN_CLI_ENTRY = previous;
      }
    }
  });

  it('resolves the packaged system-runtime CLI entrypoint from process.resourcesPath', async () => {
    const previousPackaged = process.env.MATCHACLAW_APP_PACKAGED;
    const previousResourcesPath = process.resourcesPath;
    process.env.MATCHACLAW_APP_PACKAGED = '1';
    process.resourcesPath = resolve('packaged/resources');
    try {
      const projection = await projectExternalConnectorToOpenClawMcpServer({
        id: 'matcha',
        kind: 'mcp-stdio',
        command: 'matcha',
        mcpServerProgram: { source: 'system-runtime' },
      });

      expect(projection).toMatchObject({ resultType: 'projectable' });
      if (projection.resultType !== 'projectable') {
        throw new Error('expected system-runtime projection to be projectable');
      }
      expect(projection.server.args).toEqual([
        resolve('packaged/resources/app.asar/runtime-host/build/main-cli.js'),
        'system-runtime',
        'mcp-stdio',
      ]);
    } finally {
      if (previousPackaged === undefined) {
        delete process.env.MATCHACLAW_APP_PACKAGED;
      } else {
        process.env.MATCHACLAW_APP_PACKAGED = previousPackaged;
      }
      process.resourcesPath = previousResourcesPath;
    }
  });

  it('does not project disabled, non-MCP, or private secret projections', async () => {
    await expect(projectExternalConnectorToOpenClawMcpServer({
      id: 'disabled-mcp',
      kind: 'mcp-stdio',
      enabled: false,
      command: 'npx',
    })).resolves.toMatchObject({
      resultType: 'notProjectable',
      connectorId: 'disabled-mcp',
      reason: 'connector is disabled',
    });

    await expect(projectExternalConnectorToOpenClawMcpServer({
      id: 'github-cli',
      kind: 'cli',
      command: 'gh',
    })).resolves.toMatchObject({
      resultType: 'notProjectable',
      connectorId: 'github-cli',
    });

    await expect(projectExternalConnectorToOpenClawMcpServer({
      id: 'private-mcp',
      kind: 'mcp-http',
      url: 'https://mcp.example.com',
      secretHeaders: { Authorization: { kind: 'secret-ref', ref: 'secret:github' } },
    })).resolves.toMatchObject({
      resultType: 'notProjectable',
      connectorId: 'private-mcp',
    });
  });
});

describe('ExternalConnectorOpenClawMcpProjectionService', () => {
  it('syncs only projectable MCP connectors into OpenClaw config', async () => {
    const connectors: ExternalConnectorSpec[] = [
      { id: 'stdio-tools', kind: 'mcp-stdio', command: 'npx', args: ['tools-mcp'] },
      { id: 'plain-cli', kind: 'cli', command: 'gh' },
    ];
    const configRepository = new MemoryOpenClawConfigRepository({
      mcp: { servers: { existing: { command: 'existing' } } },
    });
    const service = new ExternalConnectorOpenClawMcpProjectionService({
      connectors: { listConnectorSpecs: async () => connectors },
      configRepository,
    });

    await expect(service.sync()).resolves.toEqual({
      projected: ['stdio-tools'],
      skipped: [{
        resultType: 'notProjectable',
        connectorId: 'plain-cli',
        reason: 'cli connectors are Matcha-owned and cannot be projected to OpenClaw MCP config directly',
      }],
    });

    await expect(configRepository.read()).resolves.toEqual({
      mcp: {
        servers: {
          existing: { command: 'existing' },
          'stdio-tools': { command: 'npx', args: ['tools-mcp'] },
        },
      },
      commands: { restart: true },
    });
  });

  it('uses connector ids as OpenClaw MCP server ids and prunes legacy prefixed projections', async () => {
    const connectors: ExternalConnectorSpec[] = [
      {
        id: 'matcha',
        kind: 'mcp-stdio',
        command: 'matcha',
        args: ['system-runtime', 'mcp-stdio'],
        mcpServerProgram: { source: 'system-runtime', programId: 'system-runtime:matcha' },
      },
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ];
    const configRepository = new MemoryOpenClawConfigRepository({
      mcp: {
        servers: {
          'matcha-external.matcha': { command: 'old-system' },
          'matcha-system': { command: 'old-short-system' },
          'matcha-system-runtime': { command: 'old-connector-system' },
          'matcha-external.docs': { command: 'old-docs' },
          existing: { command: 'existing' },
        },
      },
    });
    const service = new ExternalConnectorOpenClawMcpProjectionService({
      connectors: { listConnectorSpecs: async () => connectors },
      configRepository,
    });

    await service.sync();

    const config = await configRepository.read();
    const servers = (config.mcp as { servers: Record<string, unknown> }).servers;
    expect(servers).toMatchObject({
      'matcha': expect.objectContaining({ args: expect.arrayContaining(['system-runtime', 'mcp-stdio']) }),
      docs: expect.objectContaining({ url: 'https://mcp.example.com' }),
      existing: { command: 'existing' },
    });
    expect(servers).not.toHaveProperty('matcha-external.matcha');
    expect(servers).not.toHaveProperty('matcha-system');
    expect(servers).not.toHaveProperty('matcha-system-runtime');
    expect(servers).not.toHaveProperty('matcha-external.docs');
  });
});
