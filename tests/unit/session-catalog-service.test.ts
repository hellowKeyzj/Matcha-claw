import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadataRepository } from '../../runtime-host/application/sessions/session-metadata-repository';
import { SessionStorageRepository } from '../../runtime-host/application/sessions/session-storage-repository';
import {
  createTestSessionCatalogService,
  createTestSessionRuntimeService,
} from './helpers/session-runtime-fixture';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';

function buildTranscriptLine(input: {
  timestamp: string;
  role: 'user' | 'assistant';
  content: string;
  id: string;
}) {
  return JSON.stringify({
    timestamp: input.timestamp,
    message: {
      id: input.id,
      role: input.role,
      content: input.content,
    },
  });
}

describe('session adapter service catalog', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('catalog service can list persisted sessions without constructing runtime service', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: '独立 catalog service',
        id: 'message-1',
      }),
    ].join('\n'));

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
    });

    await service.refreshCache();
    await expect(service.listSessions()).resolves.toEqual({
      ready: true,
      refreshing: false,
      updatedAt: expect.any(Number),
      error: null,
      sessions: [
        {
          agentId: 'alpha',
          key: 'agent:alpha:main',
          kind: 'main',
          label: '独立 catalog service',
          preferred: true,
          titleSource: 'user',
          displayName: 'agent:alpha:main',
          updatedAt: Date.parse('2026-04-10T10:00:00.000Z'),
        },
      ],
    });
  });

  it('uses the shared session metadata repository for catalog model resolution', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'shared metadata model',
        id: 'message-1',
      }),
    ].join('\n'));

    class TestSessionMetadataRepository extends SessionMetadataRepository {
      override async resolveSessionModel(): Promise<string | null> {
        return 'test/shared-model';
      }
    }

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
      metadataRepository: new TestSessionMetadataRepository({
        workspace: { getConfigDir: () => configDir },
        fileSystem: createTestRuntimeFileSystem(),
      }),
    });

    await service.refreshCache();
    const response = await service.listSessions();

    expect(response.sessions[0]).toMatchObject({
      key: 'agent:alpha:main',
      model: 'test/shared-model',
    });
  });

  it('reuses parsed transcript timelines while the transcript fingerprint is unchanged', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    const transcriptPath = join(sessionsDir, 'main.jsonl');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main' },
      ],
    }, null, 2));
    writeFileSync(transcriptPath, [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'cached title',
        id: 'message-1',
      }),
    ].join('\n'));

    class CountingSessionStorageRepository extends SessionStorageRepository {
      readCount = 0;

      override async readTranscriptDescriptorContent(descriptor: Parameters<SessionStorageRepository['readTranscriptDescriptorContent']>[0]) {
        this.readCount += 1;
        return await super.readTranscriptDescriptorContent(descriptor);
      }
    }

    const storageRepository = new CountingSessionStorageRepository({
      workspace: { getConfigDir: () => configDir },
      fileSystem: createTestRuntimeFileSystem(),
    });
    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
      storageRepository,
    });

    await service.refreshCache();
    await service.listSessions();
    expect(storageRepository.readCount).toBe(1);

    writeFileSync(transcriptPath, [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'cached title changed',
        id: 'message-1',
      }),
    ].join('\n'));
    await service.refreshCache();
    await expect(service.listSessions()).resolves.toMatchObject({
      sessions: [
        {
          label: 'cached title changed',
        },
      ],
    });
    expect(storageRepository.readCount).toBe(2);
  });

  it('listSessions reads the cached catalog snapshot without rescanning transcripts', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'cached snapshot',
        id: 'message-1',
      }),
    ].join('\n'));

    class CountingSessionStorageRepository extends SessionStorageRepository {
      readCount = 0;

      override async readTranscriptDescriptorContent(descriptor: Parameters<SessionStorageRepository['readTranscriptDescriptorContent']>[0]) {
        this.readCount += 1;
        return await super.readTranscriptDescriptorContent(descriptor);
      }
    }

    const storageRepository = new CountingSessionStorageRepository({
      workspace: { getConfigDir: () => configDir },
      fileSystem: createTestRuntimeFileSystem(),
    });
    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
      storageRepository,
    });

    await service.refreshCache();
    expect(storageRepository.readCount).toBe(1);
    await expect(service.listSessions()).resolves.toMatchObject({
      sessions: [
        {
          label: 'cached snapshot',
        },
      ],
    });
    await service.listSessions();
    expect(storageRepository.readCount).toBe(1);
  });

  it('runtime listSessions returns a refreshing snapshot until the catalog cache is ready', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);
    const submitRefreshCatalog = vi.fn(() => ({
      success: true as const,
      job: {
        id: 'job-refresh-session-catalog',
        type: 'sessions.refreshCatalog',
        queue: 'low' as const,
        status: 'queued' as const,
        queuedAt: 1_700_000_000_000,
        attempts: 0,
        maxAttempts: 1,
      },
    }));
    const getRefreshCatalogJob = vi.fn(() => ({
      id: 'job-refresh-session-catalog',
      type: 'sessions.refreshCatalog',
      queue: 'low' as const,
      status: 'queued' as const,
      queuedAt: 1_700_000_000_000,
      attempts: 0,
      maxAttempts: 1,
    }));
    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      sessionCatalogJobs: {
        submitRefreshCatalog,
        getRefreshCatalogJob,
      },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    const response = await service.listSessions();

    expect(submitRefreshCatalog).toHaveBeenCalledTimes(1);
    expect(getRefreshCatalogJob).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      status: 200,
      data: {
        sessions: [],
        ready: false,
        refreshing: true,
        updatedAt: null,
        error: null,
      },
    });
  });

  it('lists only sessions backed by real transcripts and resolves labels from the transcript content', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      agents: {
        defaults: {
          model: 'openai/gpt-5.4',
        },
      },
    }, null, 2));

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-1', id: 'session-1' },
        { key: 'agent:alpha:session-2', id: 'session-2' },
        { key: 'agent:alpha:session-missing', id: 'session-missing' },
      ],
    }, null, 2));

    writeFileSync(join(sessionsDir, 'session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: '第一条问题',
        id: 'message-1',
      }),
      buildTranscriptLine({
        timestamp: '2026-04-10T10:10:00.000Z',
        role: 'user',
        content: '最终标题来自这里',
        id: 'message-2',
      }),
    ].join('\n'));

    writeFileSync(join(sessionsDir, 'session-2.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-11T08:00:00.000Z',
        role: 'assistant',
        content: '没有 user 时用 assistant 兜底',
        id: 'message-3',
      }),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    await service.refreshSessionCatalog();
    const response = await service.listSessions();

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      sessions: [
        {
          agentId: 'alpha',
          key: 'agent:alpha:session-2',
          kind: 'named',
          label: '没有 user 时用 assistant 兜底',
          preferred: false,
          titleSource: 'assistant',
          displayName: 'agent:alpha:session-2',
          model: 'openai/gpt-5.4',
          updatedAt: Date.parse('2026-04-11T08:00:00.000Z'),
        },
        {
          agentId: 'alpha',
          key: 'agent:alpha:session-1',
          kind: 'named',
          label: '最终标题来自这里',
          preferred: false,
          titleSource: 'user',
          displayName: 'agent:alpha:session-1',
          model: 'openai/gpt-5.4',
          updatedAt: Date.parse('2026-04-10T10:10:00.000Z'),
        },
      ],
    });
  });

  it('lists sessions when OpenClaw sessions.json uses native object-map format', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      'agent:alpha:main': {
        sessionId: 'session-main',
        sessionFile: join(sessionsDir, 'session-main.jsonl'),
        updatedAt: Date.parse('2026-04-12T10:00:00.000Z'),
        modelProvider: 'openai',
        model: 'gpt-5.4',
      },
      'agent:alpha:session-2': {
        sessionId: 'session-2',
        sessionFile: join(sessionsDir, 'session-2.jsonl'),
        updatedAt: Date.parse('2026-04-13T10:00:00.000Z'),
        providerOverride: 'anthropic',
        modelOverride: 'claude-opus-4-6',
      },
    }, null, 2));

    writeFileSync(join(sessionsDir, 'session-main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-12T10:00:00.000Z',
        role: 'user',
        content: 'alpha main title',
        id: 'message-main',
      }),
    ].join('\n'));

    writeFileSync(join(sessionsDir, 'session-2.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-13T10:00:00.000Z',
        role: 'assistant',
        content: 'alpha session two',
        id: 'message-2',
      }),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    await service.refreshSessionCatalog();
    const response = await service.listSessions();

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      sessions: [
        {
          agentId: 'alpha',
          key: 'agent:alpha:session-2',
          kind: 'named',
          label: 'alpha session two',
          preferred: false,
          titleSource: 'assistant',
          displayName: 'agent:alpha:session-2',
          model: 'anthropic/claude-opus-4-6',
          updatedAt: Date.parse('2026-04-13T10:00:00.000Z'),
        },
        {
          agentId: 'alpha',
          key: 'agent:alpha:main',
          kind: 'main',
          label: 'alpha main title',
          preferred: true,
          titleSource: 'user',
          displayName: 'agent:alpha:main',
          model: 'openai/gpt-5.4',
          updatedAt: Date.parse('2026-04-12T10:00:00.000Z'),
        },
      ],
    });
  });

  it('falls back to configured agent default model when session store has no override', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      agents: {
        defaults: {
          model: 'openai/gpt-5.4',
        },
        list: [
          {
            id: 'alpha',
            model: 'anthropic/claude-sonnet-4-5',
          },
        ],
      },
    }, null, 2));

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-13T10:00:00.000Z',
        role: 'user',
        content: 'alpha main title',
        id: 'message-main',
      }),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    await service.refreshSessionCatalog();
    const response = await service.listSessions();

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      key: 'agent:alpha:main',
      model: 'anthropic/claude-sonnet-4-5',
    });
  });

  it('falls back to raw jsonl discovery when an agent has transcripts but no sessions.json', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'orphan-agent', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'session-1778000000000.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-15T10:00:00.000Z',
        role: 'user',
        content: 'orphan transcript title',
        id: 'message-1',
      }),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    await service.refreshSessionCatalog();
    const response = await service.listSessions();

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      sessions: [
        {
          agentId: 'orphan-agent',
          key: 'agent:orphan-agent:session-1778000000000',
          kind: 'session',
          label: 'orphan transcript title',
          preferred: false,
          titleSource: 'user',
          displayName: 'agent:orphan-agent:session-1778000000000',
          updatedAt: Date.parse('2026-04-15T10:00:00.000Z'),
        },
      ],
    });
  });
});
