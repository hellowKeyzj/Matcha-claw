import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadataRepository } from '../../runtime-host/application/sessions/session-metadata-repository';
import { SessionStorageRepository } from '../../runtime-host/application/sessions/session-storage-repository';
import { SessionStorageIndexWorkflow, type SessionStorageSessionIdentityResolverPort } from '../../runtime-host/application/workflows/session-storage/session-storage-index-workflow';
import { SessionStorageRepositoryWorkflow } from '../../runtime-host/application/workflows/session-storage/session-storage-repository-workflow';
import { SessionStorageTranscriptWorkflow } from '../../runtime-host/application/workflows/session-storage/session-storage-transcript-workflow';
import {
  createTestSessionCatalogService,
  createTestSessionRuntimeService,
} from './helpers/session-runtime-fixture';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { validateSessionIdentity, type SessionIdentity } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import type { SessionStorageDescriptor } from '../../runtime-host/application/sessions/session-storage-repository';
import type { SessionRuntimeStateSnapshot } from '../../runtime-host/shared/session-adapter-types';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

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

function openClawSessionIdentity(sessionKey: string): SessionIdentity {
  return createOpenClawTestSessionIdentity(sessionKey, 'alpha');
}

function createTestSessionStorageSessionIdentityResolver(): SessionStorageSessionIdentityResolverPort {
  return {
    resolveStorageSessionIdentity: ({ agentId, sessionKey, sessionStoreEntry }) => {
      const stored = sessionStoreEntry?.sessionIdentity;
      if (validateSessionIdentity(stored) === null) {
        const identity = stored as SessionIdentity;
        if (identity.agentId === agentId && identity.sessionKey === sessionKey) {
          return identity;
        }
      }
      return createOpenClawTestSessionIdentity(sessionKey, agentId);
    },
  };
}

function claudeCodeSessionIdentity(sessionKey: string): SessionIdentity {
  return createOpenClawTestSessionIdentity(sessionKey, 'claude-code');
}

function sessionListPayload(sessionIdentity: SessionIdentity) {
  return {
    endpoint: sessionIdentity.endpoint,
    sessionIdentity,
  };
}

function idleRuntimeSnapshot(updatedAt: number | null): SessionRuntimeStateSnapshot {
  return {
    activeRunId: null,
    runPhase: 'idle',
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    runtimeActivity: null,
    lastUserMessageAt: null,
    lastError: null,
    lastIssue: null,
    updatedAt,
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
        { key: 'agent:alpha:main', id: 'main', label: 'indexed catalog title', sessionIdentity: openClawSessionIdentity('agent:alpha:main') },
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
    await expect(service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')))).resolves.toEqual({
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
          sessionIdentity: openClawSessionIdentity('agent:alpha:main'),
          status: 'completed',
          titleSource: 'user',
          displayName: 'indexed catalog title',
          updatedAt: expect.any(Number),
        },
      ],
    });
  });

  it('falls back when stored sessionIdentity does not validate or match entry ownership', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        {
          key: 'main',
          id: 'main',
          label: 'alpha main',
          sessionIdentity: createOpenClawTestSessionIdentity('main', 'beta'),
        },
        {
          key: 'invalid',
          id: 'invalid',
          label: 'alpha invalid',
          sessionIdentity: { sessionKey: 'invalid' },
        },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'main.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'alpha main transcript',
        id: 'message-main',
      }),
    ].join('\n'));
    writeFileSync(join(sessionsDir, 'invalid.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:01:00.000Z',
        role: 'user',
        content: 'alpha invalid transcript',
        id: 'message-invalid',
      }),
    ].join('\n'));

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
    });

    await service.refreshCache();
    const response = await service.listSessions(sessionListPayload(createOpenClawTestSessionIdentity('main', 'alpha')));

    expect(response.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'main',
        agentId: 'alpha',
        sessionIdentity: createOpenClawTestSessionIdentity('main', 'alpha'),
      }),
      expect.objectContaining({
        key: 'invalid',
        agentId: 'alpha',
        sessionIdentity: createOpenClawTestSessionIdentity('invalid', 'alpha'),
      }),
    ]));
  });

  it('keeps same-key sessions isolated across runtime agents in the catalog', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    for (const agentId of ['alpha', 'beta']) {
      const sessionsDir = join(configDir, 'agents', agentId, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
        sessions: [
          { key: 'main', id: 'main', label: `${agentId} main`, sessionIdentity: createOpenClawTestSessionIdentity('main', agentId) },
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
    const response = await service.listSessions(sessionListPayload(createOpenClawTestSessionIdentity('main', 'alpha')));

    expect(response.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'alpha',
        key: 'main',
        displayName: 'alpha main',
        sessionIdentity: createOpenClawTestSessionIdentity('main', 'alpha'),
      }),
      expect.objectContaining({
        agentId: 'beta',
        key: 'main',
        displayName: 'beta main',
        sessionIdentity: createOpenClawTestSessionIdentity('main', 'beta'),
      }),
    ]));
    expect(response.sessions.filter((session) => session.key === 'main')).toHaveLength(2);
  });

  it('projects OpenClaw agent-scoped historical sessions into session-identified catalog items', async () => {
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

    expect(response.sessions).toEqual([
      expect.objectContaining({
        agentId: 'alpha',
        key: 'agent:alpha:main',
        sessionIdentity: openClawSessionIdentity('agent:alpha:main'),
        protocolId: 'openclaw-v4',
        runtimeEndpointId: 'openclaw-local',
        label: 'legacy title',
      }),
    ]);
  });

  it('does not wrap unindexed Team role local transcripts in OpenClaw agent session grammar', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'leader', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'team-role-session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: 'team role transcript',
        id: 'message-1',
      }),
    ].join('\n'));

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => configDir },
    });

    await service.refreshCache();
    const response = await service.listSessions(sessionListPayload(createOpenClawTestSessionIdentity('agent:leader:main', 'leader')));

    expect(response.sessions).toEqual([]);
  });

  it('uses the shared session metadata repository for catalog model resolution', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main', sessionIdentity: openClawSessionIdentity('agent:alpha:main') },
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

    expect(response.sessions[0]).toMatchObject({
      key: 'agent:alpha:main',
      model: 'test/shared-model',
    });
  });

  it('catalog refresh reads transcript lines for activity time while preserving indexed labels', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    const transcriptPath = join(sessionsDir, 'main.jsonl');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        {
          key: 'agent:alpha:main',
          id: 'main',
          label: 'cached title',
          updatedAt: Date.parse('2026-06-05T10:00:00.000Z'),
          sessionIdentity: openClawSessionIdentity('agent:alpha:main'),
        },
        { key: 'agent:alpha:session-1', id: 'session-1', sessionIdentity: openClawSessionIdentity('agent:alpha:session-1') },
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
      readLineCount = 0;

      override async *readTranscriptDescriptorLines(descriptor: Parameters<SessionStorageRepository['readTranscriptDescriptorLines']>[0]) {
        this.readLineCount += 1;
        yield* super.readTranscriptDescriptorLines(descriptor);
      }
    }

    const fileSystem = createTestRuntimeFileSystem();
    const storageRepository = new CountingSessionStorageRepository({
      repositoryWorkflow: new SessionStorageRepositoryWorkflow({
        indexWorkflow: new SessionStorageIndexWorkflow({
          workspace: { getConfigDir: () => configDir },
          fileSystem,
          sessionIdentityResolver: createTestSessionStorageSessionIdentityResolver(),
        }),
        transcriptWorkflow: new SessionStorageTranscriptWorkflow({
          fileSystem,
        }),
        mutationWorkflow: {
          upsertSessionIdentity: async () => undefined,
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));
    expect(response.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'agent:alpha:session-1',
        label: 'catalog transcript title',
        titleSource: 'user',
        displayName: 'catalog transcript title',
        updatedAt: Date.parse('2026-04-10T10:05:00.000Z'),
      }),
      expect.objectContaining({
        key: 'agent:alpha:main',
        label: 'cached title',
        displayName: 'cached title',
        updatedAt: Date.parse('2026-04-10T10:00:00.000Z'),
      }),
    ]));
    expect(storageRepository.readLineCount).toBe(2);
  });

  it('uses transcript message timestamps instead of transcript file mtime for catalog activity', async () => {
    const descriptors = [{
      sessionKey: 'agent:alpha:session-old-message',
      agentId: 'alpha',
      sessionsDir: '',
      sessionsJsonPath: null,
      sessionsJson: null,
      sessionStoreEntry: null,
      sessionIdentity: openClawSessionIdentity('agent:alpha:session-old-message'),
      transcriptPath: '/tmp/session-old-message.jsonl',
    }];
    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => '' },
      storageRepository: {
        listStorageDescriptors: async () => descriptors,
        findStorageDescriptor: async () => null,
        getTranscriptFingerprint: async (pathname) => ({
          path: pathname,
          size: 1,
          mtimeMs: Date.parse('2026-06-05T10:00:00.000Z'),
        }),
        readTranscriptContent: async () => null,
        readTranscriptDescriptorContent: async () => null,
        readTranscriptLines: async function* () {},
        readTranscriptDescriptorLines: async function* () {
          yield buildTranscriptLine({
            timestamp: '2026-04-10T10:00:00.000Z',
            role: 'user',
            content: 'old real message time',
            id: 'message-old',
          });
        },
        deleteSession: async () => false,
        renameSession: async () => false,
        updateSessionStatus: async () => false,
        upsertSessionIdentity: async () => true,
      },
      metadataRepository: {
        resolveSessionModel: async () => null,
        readSessionMetadata: async () => null,
        writeSessionMetadata: async () => undefined,
      },
    });

    await service.refreshCache();
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

    expect(response.sessions).toEqual([
      expect.objectContaining({
        key: 'agent:alpha:session-old-message',
        label: 'old real message time',
        updatedAt: Date.parse('2026-04-10T10:00:00.000Z'),
      }),
    ]);
  });

  it('filters transcript-backed sessions that have no renderable content', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-empty', id: 'session-empty', sessionIdentity: openClawSessionIdentity('agent:alpha:session-empty') },
        { key: 'agent:alpha:session-control', id: 'session-control', sessionIdentity: openClawSessionIdentity('agent:alpha:session-control') },
        { key: 'agent:alpha:session-visible', id: 'session-visible', sessionIdentity: openClawSessionIdentity('agent:alpha:session-visible') },
        { key: 'agent:alpha:session-manual', id: 'session-manual', label: 'manual empty title', sessionIdentity: openClawSessionIdentity('agent:alpha:session-manual') },
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

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
      sessionIdentity: openClawSessionIdentity(`agent:alpha:session-${index}`),
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
        upsertSessionIdentity: async () => true,
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
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'alpha history', sessionIdentity: createOpenClawTestSessionIdentity('agent:alpha:session-1', 'alpha') },
      ],
    }, null, 2));
    writeFileSync(join(betaSessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:beta:session-1', id: 'session-1', label: 'beta history', sessionIdentity: createOpenClawTestSessionIdentity('agent:beta:session-1', 'beta') },
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
    const response = await service.listSessions(sessionListPayload(createOpenClawTestSessionIdentity('agent:main:main', 'main')));

    expect(response.sessions.map((session) => session.key)).toEqual(expect.arrayContaining([
      'agent:alpha:session-1',
      'agent:beta:session-1',
    ]));
  });

  it('uses SessionIdentity agent identity instead of parsing OpenClaw-style session keys', async () => {
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
        upsertSessionIdentity: async () => true,
      },
      metadataRepository: {
        resolveSessionModel: async () => null,
        readSessionMetadata: async () => null,
        writeSessionMetadata: async () => undefined,
      },
    });

    const sessionIdentity = createOpenClawTestSessionIdentity('agent:legacy-name:main', 'identity-agent');
    const response = await service.listSessions({
      ...sessionListPayload(sessionIdentity),
      runtimeOverlays: [{
        sessionKey: 'agent:legacy-name:main',
        protocolId: 'openclaw-v4',
        runtimeEndpointId: 'openclaw-local',
        sessionIdentity,
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
      agentId: 'identity-agent',
      sessionIdentity: {
        agentId: 'identity-agent',
      },
    });
  });

  it('canonicalizes cached Team role endpoint sessions back to local sessions and preserves live overlay binding', async () => {
    const localSessionIdentity = createOpenClawTestSessionIdentity('team-role-session-run-1-leader', 'leader-agent');
    const opaqueEndpointSessionId = 'team-endpoint-session-run-1-leader';
    const materializedEndpointSessionId = `agent:leader-agent:${opaqueEndpointSessionId}`;
    const agentRuntimeRegistry = new AgentRuntimeRegistry({
      gateway: () => ({
        chatSend: async () => ({ success: true }),
        gatewayRpc: async () => ({}),
      }),
    });
    agentRuntimeRegistry.register({ runtimeAdapters: [new OpenClawRuntimeAdapter()] });
    agentRuntimeRegistry.rememberSessionIdentity(localSessionIdentity, materializedEndpointSessionId);
    const descriptor: SessionStorageDescriptor = {
      sessionKey: materializedEndpointSessionId,
      agentId: 'leader-agent',
      sessionsDir: '',
      sessionsJsonPath: null,
      sessionsJson: null,
      sessionStoreEntry: { label: 'cached Team role title' },
      sessionIdentity: localSessionIdentity,
      transcriptPath: '/tmp/agent-leader-agent-team-endpoint-session-run-1-leader.jsonl',
    };

    const service = createTestSessionCatalogService({
      workspace: { getConfigDir: () => '' },
      agentRuntimeRegistry,
      storageRepository: {
        listStorageDescriptors: async () => [descriptor],
        findStorageDescriptor: async (identity) => (identity.sessionKey === localSessionIdentity.sessionKey ? descriptor : null),
        getTranscriptFingerprint: async (pathname) => ({ path: pathname, size: 1, mtimeMs: 1 }),
        readTranscriptContent: async () => null,
        readTranscriptDescriptorContent: async () => null,
        readTranscriptLines: async function* () {},
        readTranscriptDescriptorLines: async function* () {
          yield buildTranscriptLine({
            timestamp: '2026-04-10T10:00:00.000Z',
            role: 'user',
            content: 'cached Team role transcript',
            id: 'message-1',
          });
        },
        deleteSession: async () => false,
        renameSession: async () => false,
        updateSessionStatus: async () => false,
        upsertSessionIdentity: async () => true,
      },
      metadataRepository: {
        resolveSessionModel: async () => null,
        readSessionMetadata: async () => null,
        writeSessionMetadata: async () => undefined,
      },
    });

    await service.refreshCache();
    const response = await service.listSessions({
      ...sessionListPayload(localSessionIdentity),
      runtimeOverlays: [{
        sessionKey: localSessionIdentity.sessionKey,
        sessionIdentity: localSessionIdentity,
        timelineEntries: [],
        runtime: idleRuntimeSnapshot(Date.parse('2026-04-10T10:05:00.000Z')),
      }],
    });

    expect(response.sessions).toEqual([
      expect.objectContaining({
        key: localSessionIdentity.sessionKey,
        endpointSessionId: materializedEndpointSessionId,
        sessionIdentity: localSessionIdentity,
        label: 'cached Team role title',
        displayName: 'cached Team role title',
        updatedAt: Date.parse('2026-04-10T10:05:00.000Z'),
      }),
    ]);
    expect(response.sessions[0]?.key).not.toBe(materializedEndpointSessionId);
  });

  it('listSessions reads the cached catalog snapshot without rescanning transcripts', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:main', id: 'main', label: 'cached snapshot', sessionIdentity: openClawSessionIdentity('agent:alpha:main') },
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
      readLineCount = 0;

      override async *readTranscriptDescriptorLines(descriptor: Parameters<SessionStorageRepository['readTranscriptDescriptorLines']>[0]) {
        this.readLineCount += 1;
        yield* super.readTranscriptDescriptorLines(descriptor);
      }
    }

    const fileSystem = createTestRuntimeFileSystem();
    const storageRepository = new CountingSessionStorageRepository({
      repositoryWorkflow: new SessionStorageRepositoryWorkflow({
        indexWorkflow: new SessionStorageIndexWorkflow({
          workspace: { getConfigDir: () => configDir },
          fileSystem,
          sessionIdentityResolver: createTestSessionStorageSessionIdentityResolver(),
        }),
        transcriptWorkflow: new SessionStorageTranscriptWorkflow({
          fileSystem,
        }),
        mutationWorkflow: {
          upsertSessionIdentity: async () => undefined,
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
    expect(storageRepository.readLineCount).toBe(1);
    await expect(service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')))).resolves.toMatchObject({
      sessions: [
        {
          label: 'cached snapshot',
        },
      ],
    });
    await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));
    expect(storageRepository.readLineCount).toBe(1);
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

    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

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
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'indexed session one', updatedAt: Date.parse('2026-04-10T10:10:00.000Z'), sessionIdentity: openClawSessionIdentity('agent:alpha:session-1') },
        { key: 'agent:alpha:session-2', id: 'session-2', label: 'indexed session two', updatedAt: Date.parse('2026-04-11T08:00:00.000Z'), sessionIdentity: openClawSessionIdentity('agent:alpha:session-2') },
        { key: 'agent:alpha:session-missing', id: 'session-missing', label: 'missing transcript', sessionIdentity: openClawSessionIdentity('agent:alpha:session-missing') },
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

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
        sessionIdentity: claudeCodeSessionIdentity('claude-code:session-1'),
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
    const response = await service.listSessions(sessionListPayload(claudeCodeSessionIdentity('claude-code:session-1')));

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      agentId: 'claude-code',
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
        sessionIdentity: openClawSessionIdentity('agent:alpha:main'),
      },
      'agent:alpha:session-2': {
        sessionId: 'session-2',
        sessionFile: join(sessionsDir, 'session-2.jsonl'),
        label: 'indexed alpha session two',
        updatedAt: Date.parse('2026-04-13T10:00:00.000Z'),
        providerOverride: 'anthropic',
        modelOverride: 'claude-opus-4-6',
        sessionIdentity: openClawSessionIdentity('agent:alpha:session-2'),
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

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
        sessionIdentity: claudeCodeSessionIdentity('claude-code:session-1'),
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
      sessionIdentity: claudeCodeSessionIdentity('claude-code:session-1'),
      label: 'manual provider title',
    })).resolves.toEqual({
      status: 200,
      data: {
        success: true,
        sessionKey: 'claude-code:session-1',
        label: 'manual provider title',
      },
    });

    const response = await service.listSessions(sessionListPayload(claudeCodeSessionIdentity('claude-code:session-1')));

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
        { key: 'agent:alpha:session-1', id: 'session-1', label: 'indexed title', sessionIdentity: openClawSessionIdentity('agent:alpha:session-1') },
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
      sessionIdentity: openClawSessionIdentity('agent:alpha:session-1'),
      label: 'manual title',
    })).resolves.toEqual({
      status: 200,
      data: {
        success: true,
        sessionKey: 'agent:alpha:session-1',
        label: 'manual title',
      },
    });

    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      key: 'agent:alpha:session-1',
      label: 'manual title',
      titleSource: 'user',
    });
  });

  it('isolates storage mutation when different agents reuse the same sessionKey', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    for (const agentId of ['alpha', 'beta']) {
      const sessionsDir = join(configDir, 'agents', agentId, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
        sessions: [
          {
            key: 'shared-session',
            id: 'shared-session',
            label: `${agentId} title`,
            sessionIdentity: createOpenClawTestSessionIdentity('shared-session', agentId),
          },
        ],
      }, null, 2));
      writeFileSync(join(sessionsDir, 'shared-session.jsonl'), [
        buildTranscriptLine({
          timestamp: '2026-04-10T10:00:00.000Z',
          role: 'user',
          content: `${agentId} transcript`,
          id: `${agentId}-message`,
        }),
      ].join('\n'));
    }

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    const betaIdentity = createOpenClawTestSessionIdentity('shared-session', 'beta');
    await expect(service.renameSession({
      sessionKey: 'shared-session',
      sessionIdentity: betaIdentity,
      label: 'beta renamed',
    })).resolves.toMatchObject({
      status: 200,
      data: { success: true },
    });

    const alphaResponse = await service.listSessions({ endpoint: createOpenClawTestSessionIdentity('shared-session', 'alpha').endpoint });

    expect(alphaResponse.status).toBe(200);
    expect(alphaResponse.data.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'alpha',
        key: 'shared-session',
        label: 'alpha title',
      }),
      expect.objectContaining({
        agentId: 'beta',
        key: 'shared-session',
        label: 'beta renamed',
      }),
    ]));
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
        { key: 'agent:alpha:main', id: 'main', label: 'alpha main title', sessionIdentity: openClawSessionIdentity('agent:alpha:main') },
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

    expect(response.status).toBe(200);
    expect(response.data.sessions[0]).toMatchObject({
      key: 'agent:alpha:main',
      model: 'anthropic/claude-sonnet-4-5',
    });
  });

  it('projects raw OpenClaw jsonl discovery into session-identified catalog items', async () => {
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
    const response = await service.listSessions(sessionListPayload(openClawSessionIdentity('agent:alpha:main')));

    expect(response.status).toBe(200);
    expect(response.data.sessions).toEqual([
      expect.objectContaining({
        agentId: 'orphan-agent',
        key: 'agent:orphan-agent:session-1778000000000',
        label: 'orphan transcript title',
        sessionIdentity: createOpenClawTestSessionIdentity('agent:orphan-agent:session-1778000000000', 'orphan-agent'),
      }),
    ]);
  });
});
