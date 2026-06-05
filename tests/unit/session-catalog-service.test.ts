import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadataRepository } from '../../runtime-host/application/sessions/session-metadata-repository';
import { SessionStorageRepository } from '../../runtime-host/application/sessions/session-storage-repository';
import { SessionStorageIndexWorkflow, type SessionStorageRuntimeAddressResolverPort } from '../../runtime-host/application/workflows/session-storage/session-storage-index-workflow';
import { SessionStorageRepositoryWorkflow } from '../../runtime-host/application/workflows/session-storage/session-storage-repository-workflow';
import { SessionStorageTranscriptWorkflow } from '../../runtime-host/application/workflows/session-storage/session-storage-transcript-workflow';
import {
  createTestSessionCatalogService,
  createTestSessionRuntimeService,
} from './helpers/session-runtime-fixture';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { validateRuntimeAddress, type RuntimeAddress } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { createOpenClawTestRuntimeAddress } from './helpers/runtime-address-fixtures';

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

function openClawRuntimeAddress(sessionKey: string): RuntimeAddress {
  return createOpenClawTestRuntimeAddress(sessionKey, 'alpha');
}

function createTestSessionStorageRuntimeAddressResolver(): SessionStorageRuntimeAddressResolverPort {
  return {
    resolveStorageRuntimeAddress: ({ agentId, sessionKey, sessionStoreEntry }) => {
      const stored = sessionStoreEntry?.runtimeAddress;
      if (validateRuntimeAddress(stored) === null) {
        return stored as RuntimeAddress;
      }
      return createOpenClawTestRuntimeAddress(sessionKey, agentId);
    },
  };
}

function claudeCodeRuntimeAddress(sessionKey: string): RuntimeAddress {
  return {
    kind: 'protocol-connector',
    capabilityId: 'session.prompt',
    protocolId: 'acp',
    connectorId: 'acp',
    endpointId: 'claude-code',
    agentId: 'default',
    sessionKey,
  };
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
        { key: 'agent:alpha:main', id: 'main', label: 'indexed catalog title', runtimeAddress: openClawRuntimeAddress('agent:alpha:main') },
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
    await expect(service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') })).resolves.toEqual({
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
          protocolId: 'openclaw-v4',
          runtimeEndpointId: 'openclaw-local',
          runtimeAddress: openClawRuntimeAddress('agent:alpha:main'),
          status: 'completed',
          titleSource: 'user',
          displayName: 'indexed catalog title',
          updatedAt: expect.any(Number),
        },
      ],
    });
  });

  it('keeps same-key sessions isolated across runtime agents in the catalog', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    for (const agentId of ['alpha', 'beta']) {
      const sessionsDir = join(configDir, 'agents', agentId, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
        sessions: [
          { key: 'main', id: 'main', label: `${agentId} main`, runtimeAddress: createOpenClawTestRuntimeAddress('main', agentId) },
        ],
      }, null, 2));
      writeFileSync(join(sessionsDir, 'main.jsonl'), [
        buildTranscriptLine({
          timestamp: '2026-04-10T10:00:00.000Z',
          role: 'user',
          content: `${agentId} transcript`,
          id: `message-${agentId}`,
        }),
      ].join('\n'));
    }

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
    });

    await service.refreshCache();
    const response = await service.listSessions({ runtimeAddress: createOpenClawTestRuntimeAddress('main', 'alpha') });

    expect(response.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'alpha',
        key: 'main',
        displayName: 'alpha main',
        runtimeAddress: createOpenClawTestRuntimeAddress('main', 'alpha'),
      }),
      expect.objectContaining({
        agentId: 'beta',
        key: 'main',
        displayName: 'beta main',
        runtimeAddress: createOpenClawTestRuntimeAddress('main', 'beta'),
      }),
    ]));
    expect(response.sessions.filter((session) => session.key === 'main')).toHaveLength(2);
  });

  it('projects OpenClaw agent-scoped historical sessions into runtime-addressed catalog items', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main', label: 'legacy title' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'legacy transcript',
        id: 'message-1',
      }),
    ].join('\n'));

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
    });

    await service.refreshCache();
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

    expect(response.sessions).toEqual([
      expect.objectContaining({
        agentId: 'alpha',
        key: 'agent:alpha:main',
        runtimeAddress: openClawRuntimeAddress('agent:alpha:main'),
        protocolId: 'openclaw-v4',
        runtimeEndpointId: 'openclaw-local',
        label: 'legacy title',
      }),
    ]);
  });

  it('uses the shared session metadata repository for catalog model resolution', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main', runtimeAddress: openClawRuntimeAddress('agent:alpha:main') },
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
      metadataRepository: new TestSessionMetadataRepository(),
    });

    await service.refreshCache();
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

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
        { key: 'agent:alpha:main', id: 'main', label: 'cached title', runtimeAddress: openClawRuntimeAddress('agent:alpha:main') },
        { key: 'agent:alpha:session-1', id: 'session-1', runtimeAddress: openClawRuntimeAddress('agent:alpha:session-1') },
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

    const fileSystem = createTestRuntimeFileSystem();
    const storageRepository = new CountingSessionStorageRepository({
      repositoryWorkflow: new SessionStorageRepositoryWorkflow({
        indexWorkflow: new SessionStorageIndexWorkflow({
          workspace: { getConfigDir: () => configDir },
          fileSystem,
          runtimeAddressResolver: createTestSessionStorageRuntimeAddressResolver(),
        }),
        transcriptWorkflow: new SessionStorageTranscriptWorkflow({
          fileSystem,
        }),
        mutationWorkflow: {
          upsertRuntimeAddress: async () => undefined,
          updateStatus: async () => undefined,
          rename: async () => undefined,
          delete: async () => undefined,
        },
      }),
    });
    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
      storageRepository,
    });

    await service.refreshCache();
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });
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
        { key: 'agent:alpha:session-empty', id: 'session-empty', runtimeAddress: openClawRuntimeAddress('agent:alpha:session-empty') },
        { key: 'agent:alpha:session-control', id: 'session-control', runtimeAddress: openClawRuntimeAddress('agent:alpha:session-control') },
        { key: 'agent:alpha:session-visible', id: 'session-visible', runtimeAddress: openClawRuntimeAddress('agent:alpha:session-visible') },
        { key: 'agent:alpha:session-manual', id: 'session-manual', label: 'manual empty title', runtimeAddress: openClawRuntimeAddress('agent:alpha:session-manual') },
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
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

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
      runtimeAddress: openClawRuntimeAddress(`agent:alpha:session-${index}`),
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
        readTranscriptLines: async function* () {},
        readTranscriptDescriptorLines: async function* () {},
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

  it('lists all agents sharing the requested runtime endpoint', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const alphaSessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    const betaSessionsDir = join(configDir, 'agents', 'beta', 'sessions');
    mkdirSync(alphaSessionsDir, { recursive: true });
    mkdirSync(betaSessionsDir, { recursive: true });
    writeFileSync(join(alphaSessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'alpha history', runtimeAddress: createOpenClawTestRuntimeAddress('agent:alpha:session-1', 'alpha') },
      ],
    }, null, 2));
    writeFileSync(join(betaSessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:beta:session-1', id: 'session-1', label: 'beta history', runtimeAddress: createOpenClawTestRuntimeAddress('agent:beta:session-1', 'beta') },
      ],
    }, null, 2));
    writeFileSync(join(alphaSessionsDir, 'session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'alpha transcript',
        id: 'alpha-message-1',
      }),
    ].join('\n'));
    writeFileSync(join(betaSessionsDir, 'session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:01:00.000Z',
        role: 'user',
        content: 'beta transcript',
        id: 'beta-message-1',
      }),
    ].join('\n'));

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
    });

    await service.refreshCache();
    const response = await service.listSessions({ runtimeAddress: createOpenClawTestRuntimeAddress('agent:main:main', 'main') });

    expect(response.sessions.map((session) => session.key)).toEqual(expect.arrayContaining([
      'agent:alpha:session-1',
      'agent:beta:session-1',
    ]));
  });

  it('uses RuntimeAddress agent identity instead of parsing OpenClaw-style session keys', async () => {
    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => '' },
      storageRepository: {
        listStorageDescriptors: async () => [],
        findStorageDescriptor: async () => null,
        getTranscriptFingerprint: async () => null,
        readTranscriptContent: async () => null,
        readTranscriptDescriptorContent: async () => null,
        readTranscriptLines: async function* () {},
        readTranscriptDescriptorLines: async function* () {},
        deleteSession: async () => false,
        renameSession: async () => false,
        updateSessionStatus: async () => false,
        upsertSessionRuntimeAddress: async () => true,
      },
      metadataRepository: {
        resolveSessionModel: async () => null,
        readSessionMetadata: async () => null,
        writeSessionMetadata: async () => undefined,
      },
    });

    const response = await service.listSessions({
      runtimeAddress: createOpenClawTestRuntimeAddress('agent:legacy-name:main', 'address-agent'),
      runtimeOverlays: [{
        sessionKey: 'agent:legacy-name:main',
        protocolId: 'openclaw-v4',
        runtimeEndpointId: 'openclaw-local',
        runtimeAddress: createOpenClawTestRuntimeAddress('agent:legacy-name:main', 'address-agent'),
        timelineEntries: [],
        runtime: {
          status: 'idle',
          updatedAt: 1,
          phase: 'idle',
          lastError: null,
          transportIssue: null,
          approvals: [],
          usage: [],
          artifacts: [],
          capabilities: null,
          control: null,
        },
      }],
    });

    expect(response.sessions[0]).toMatchObject({
      key: 'agent:legacy-name:main',
      agentId: 'address-agent',
      runtimeAddress: {
        agentId: 'address-agent',
      },
    });
  });

  it('listSessions reads the cached catalog snapshot without rescanning transcripts', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main', label: 'cached snapshot', runtimeAddress: openClawRuntimeAddress('agent:alpha:main') },
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

    const fileSystem = createTestRuntimeFileSystem();
    const storageRepository = new CountingSessionStorageRepository({
      repositoryWorkflow: new SessionStorageRepositoryWorkflow({
        indexWorkflow: new SessionStorageIndexWorkflow({
          workspace: { getConfigDir: () => configDir },
          fileSystem,
          runtimeAddressResolver: createTestSessionStorageRuntimeAddressResolver(),
        }),
        transcriptWorkflow: new SessionStorageTranscriptWorkflow({
          fileSystem,
        }),
        mutationWorkflow: {
          upsertRuntimeAddress: async () => undefined,
          updateStatus: async () => undefined,
          rename: async () => undefined,
          delete: async () => undefined,
        },
      }),
    });
    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
      storageRepository,
    });

    await service.refreshCache();
    expect(storageRepository.readCount).toBe(0);
    await expect(service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') })).resolves.toMatchObject({
      sessions: [
        {
          label: 'cached snapshot',
        },
      ],
    });
    await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });
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

    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

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
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'indexed session one', updatedAt: Date.parse('2026-04-10T10:10:00.000Z'), runtimeAddress: openClawRuntimeAddress('agent:alpha:session-1') },
        { key: 'agent:alpha:session-2', id: 'session-2', label: 'indexed session two', updatedAt: Date.parse('2026-04-11T08:00:00.000Z'), runtimeAddress: openClawRuntimeAddress('agent:alpha:session-2') },
        { key: 'agent:alpha:session-missing', id: 'session-missing', label: 'missing transcript', runtimeAddress: openClawRuntimeAddress('agent:alpha:session-missing') },
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
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

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

  it('lists sessions when the session index uses provider-namespaced object-map keys', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'claude-code', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      'claude-code:session-1': {
        sessionId: 'session-1',
        sessionFile: join(sessionsDir, 'session-1.jsonl'),
        label: 'claude code indexed session',
        updatedAt: Date.parse('2026-04-14T10:00:00.000Z'),
        runtimeAddress: claudeCodeRuntimeAddress('claude-code:session-1'),
      },
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-14T10:00:00.000Z',
        role: 'user',
        content: 'provider namespaced title',
        id: 'message-provider',
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
    const response = await service.listSessions({ runtimeAddress: claudeCodeRuntimeAddress('claude-code:session-1') });

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      agentId: 'default',
      key: 'claude-code:session-1',
      label: 'claude code indexed session',
      displayName: 'claude code indexed session',
      updatedAt: Date.parse('2026-04-14T10:00:00.000Z'),
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
        runtimeAddress: openClawRuntimeAddress('agent:alpha:main'),
      },
      'agent:alpha:session-2': {
        sessionId: 'session-2',
        sessionFile: join(sessionsDir, 'session-2.jsonl'),
        label: 'indexed alpha session two',
        updatedAt: Date.parse('2026-04-13T10:00:00.000Z'),
        providerOverride: 'anthropic',
        modelOverride: 'claude-opus-4-6',
        runtimeAddress: openClawRuntimeAddress('agent:alpha:session-2'),
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
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

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

  it('renames a provider-namespaced session through runtime-host storage', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'claude-code', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      'claude-code:session-1': {
        sessionId: 'session-1',
        sessionFile: join(sessionsDir, 'session-1.jsonl'),
        label: 'indexed title',
        runtimeAddress: claudeCodeRuntimeAddress('claude-code:session-1'),
      },
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
      sessionKey: 'claude-code:session-1',
      runtimeAddress: claudeCodeRuntimeAddress('claude-code:session-1'),
      label: 'manual provider title',
    })).resolves.toEqual({
      status: 200,
      data: {
        success: true,
        sessionKey: 'claude-code:session-1',
        label: 'manual provider title',
      },
    });

    const response = await service.listSessions({ runtimeAddress: claudeCodeRuntimeAddress('claude-code:session-1') });

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      key: 'claude-code:session-1',
      label: 'manual provider title',
      titleSource: 'user',
    });
  });

  it('renames a session through runtime-host storage and catalog prefers the user label', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'indexed title', runtimeAddress: openClawRuntimeAddress('agent:alpha:session-1') },
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
      runtimeAddress: openClawRuntimeAddress('agent:alpha:session-1'),
      label: 'manual title',
    })).resolves.toEqual({
      status: 200,
      data: {
        success: true,
        sessionKey: 'agent:alpha:session-1',
        label: 'manual title',
      },
    });

    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

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
        { key: 'agent:alpha:main', id: 'main', label: 'alpha main title', runtimeAddress: openClawRuntimeAddress('agent:alpha:main') },
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
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      key: 'agent:alpha:main',
      model: 'anthropic/claude-sonnet-4-5',
    });
  });

  it('projects raw OpenClaw jsonl discovery into runtime-addressed catalog items', async () => {
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
    const response = await service.listSessions({ runtimeAddress: openClawRuntimeAddress('agent:alpha:main') });

    expect(response.status).toBe(200);
    expect(response.data.sessions).toEqual([
      expect.objectContaining({
        agentId: 'orphan-agent',
        key: 'agent:orphan-agent:session-1778000000000',
        label: 'orphan transcript title',
        runtimeAddress: createOpenClawTestRuntimeAddress('agent:orphan-agent:session-1778000000000', 'orphan-agent'),
      }),
    ]);
  });
});
