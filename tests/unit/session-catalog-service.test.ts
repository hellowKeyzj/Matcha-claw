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
        { key: 'agent:alpha:main', id: 'main', label: 'indexed catalog title' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'transcript content is not read by catalog',
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
          label: 'indexed catalog title',
          preferred: true,
          status: 'completed',
          titleSource: 'user',
          displayName: 'indexed catalog title',
          updatedAt: expect.any(Number),
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

  it('catalog refresh reads transcript content only when catalog label is missing', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    const transcriptPath = join(sessionsDir, 'main.jsonl');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main', label: 'cached title' },
        { key: 'agent:alpha:session-1', id: 'session-1' },
      ],
    }, null, 2));
    writeFileSync(transcriptPath, [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'transcript title is ignored',
        id: 'message-1',
      }),
    ].join('\n'));
    writeFileSync(join(sessionsDir, 'session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:05:00.000Z',
        role: 'user',
        content: 'catalog transcript title',
        id: 'message-2',
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
    const response = await service.listSessions();
    expect(response.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'agent:alpha:session-1',
        label: 'catalog transcript title',
        titleSource: 'user',
        displayName: 'catalog transcript title',
        updatedAt: expect.any(Number),
      }),
      expect.objectContaining({
        key: 'agent:alpha:main',
        label: 'cached title',
        displayName: 'cached title',
        updatedAt: expect.any(Number),
      }),
    ]));
    expect(storageRepository.readCount).toBe(1);
  });

  it('filters transcript-backed sessions that have no renderable content', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-empty', id: 'session-empty' },
        { key: 'agent:alpha:session-control', id: 'session-control' },
        { key: 'agent:alpha:session-visible', id: 'session-visible' },
        { key: 'agent:alpha:session-manual', id: 'session-manual', label: 'manual empty title' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-empty.jsonl'), '');
    writeFileSync(join(sessionsDir, 'session-control.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'assistant',
        content: 'NO_REPLY',
        id: 'message-control',
      }),
    ].join('\n'));
    writeFileSync(join(sessionsDir, 'session-visible.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:01:00.000Z',
        role: 'user',
        content: 'visible title',
        id: 'message-visible',
      }),
    ].join('\n'));
    writeFileSync(join(sessionsDir, 'session-manual.jsonl'), '');

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
    });

    await service.refreshCache();
    const response = await service.listSessions();

    expect(response.sessions.map((session) => session.key)).toEqual(expect.arrayContaining([
      'agent:alpha:session-visible',
      'agent:alpha:session-manual',
    ]));
    expect(response.sessions.map((session) => session.key)).not.toEqual(expect.arrayContaining([
      'agent:alpha:session-empty',
      'agent:alpha:session-control',
    ]));
  });

  it('bounds catalog scan transcript fingerprint concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseNext: (() => void) | null = null;
    const releaseQueue: Array<() => void> = [];
    const releaseOne = () => {
      const release = releaseQueue.shift();
      if (release) {
        release();
      }
    };
    const descriptors = Array.from({ length: 20 }, (_, index) => ({
      sessionKey: `agent:alpha:session-${index}`,
      agentId: 'alpha',
      sessionsDir: '',
      sessionsJsonPath: null,
      sessionsJson: null,
      sessionStoreEntry: null,
      transcriptPath: `/tmp/session-${index}.jsonl`,
    }));
    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => '' },
      storageRepository: {
        listStorageDescriptors: async () => descriptors,
        findStorageDescriptor: async () => null,
        getTranscriptFingerprint: async (pathname) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => {
            releaseQueue.push(resolve);
            releaseNext = releaseOne;
          });
          active -= 1;
          return { path: pathname, size: 1, mtimeMs: 1 };
        },
        readTranscriptContent: async () => null,
        readTranscriptDescriptorContent: async () => null,
        deleteSession: async () => false,
        renameSession: async () => false,
        updateSessionStatus: async () => false,
      },
      metadataRepository: {
        resolveSessionModel: async () => null,
        readSessionMetadata: async () => null,
        writeSessionMetadata: async () => undefined,
      },
    });

    const scan = service.scanSessions();
    while (releaseQueue.length < 8) {
      await Promise.resolve();
    }
    expect(maxActive).toBe(8);
    expect(releaseQueue).toHaveLength(8);
    for (let index = 0; index < descriptors.length; index += 1) {
      releaseNext?.();
      await Promise.resolve();
    }
    await expect(scan).resolves.toMatchObject({ sessions: expect.any(Array) });
    expect(maxActive).toBe(8);
  });

  it('listSessions reads the cached catalog snapshot without rescanning transcripts', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main', label: 'cached snapshot' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'transcript content is ignored',
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
    expect(storageRepository.readCount).toBe(0);
    await expect(service.listSessions()).resolves.toMatchObject({
      sessions: [
        {
          label: 'cached snapshot',
        },
      ],
    });
    await service.listSessions();
    expect(storageRepository.readCount).toBe(0);
  });

  it('runtime listSessions builds the lightweight catalog when the cache is cold', async () => {
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
    const getRefreshCatalogJob = vi.fn(() => null);
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

    expect(submitRefreshCatalog).not.toHaveBeenCalled();
    expect(getRefreshCatalogJob).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      status: 200,
      data: {
        sessions: [],
        ready: true,
        refreshing: false,
        updatedAt: expect.any(Number),
        error: null,
      },
    });
  });

  it('lists only sessions backed by real transcripts and resolves labels from the session index', async () => {
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
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'indexed session one', updatedAt: Date.parse('2026-04-10T10:10:00.000Z') },
        { key: 'agent:alpha:session-2', id: 'session-2', label: 'indexed session two', updatedAt: Date.parse('2026-04-11T08:00:00.000Z') },
        { key: 'agent:alpha:session-missing', id: 'session-missing', label: 'missing transcript' },
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
          label: 'indexed session two',
          preferred: false,
          titleSource: 'user',
          displayName: 'indexed session two',
          model: 'openai/gpt-5.4',
          updatedAt: Date.parse('2026-04-11T08:00:00.000Z'),
        },
        {
          agentId: 'alpha',
          key: 'agent:alpha:session-1',
          kind: 'named',
          label: 'indexed session one',
          preferred: false,
          titleSource: 'user',
          displayName: 'indexed session one',
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
        label: 'indexed alpha main',
        updatedAt: Date.parse('2026-04-12T10:00:00.000Z'),
        modelProvider: 'openai',
        model: 'gpt-5.4',
      },
      'agent:alpha:session-2': {
        sessionId: 'session-2',
        sessionFile: join(sessionsDir, 'session-2.jsonl'),
        label: 'indexed alpha session two',
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
          label: 'indexed alpha session two',
          preferred: false,
          titleSource: 'user',
          displayName: 'indexed alpha session two',
          model: 'anthropic/claude-opus-4-6',
          updatedAt: Date.parse('2026-04-13T10:00:00.000Z'),
        },
        {
          agentId: 'alpha',
          key: 'agent:alpha:main',
          kind: 'main',
          label: 'indexed alpha main',
          preferred: true,
          titleSource: 'user',
          displayName: 'indexed alpha main',
          model: 'openai/gpt-5.4',
          updatedAt: Date.parse('2026-04-12T10:00:00.000Z'),
        },
      ],
    });
  });

  it('renames a session through runtime-host storage and catalog prefers the user label', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'indexed title' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'transcript title',
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

    await expect(service.renameSession({
      sessionKey: 'agent:alpha:session-1',
      label: 'manual title',
    })).resolves.toEqual({
      status: 200,
      data: {
        success: true,
        sessionKey: 'agent:alpha:session-1',
        label: 'manual title',
      },
    });

    const response = await service.listSessions();

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      key: 'agent:alpha:session-1',
      label: 'manual title',
      titleSource: 'user',
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
        { key: 'agent:alpha:main', id: 'main', label: 'alpha main title' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-13T10:00:00.000Z',
        role: 'user',
        content: 'transcript content is ignored',
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
          titleSource: 'user',
          preferred: false,
          displayName: 'orphan transcript title',
          updatedAt: expect.any(Number),
        },
      ],
    });
  });
});
