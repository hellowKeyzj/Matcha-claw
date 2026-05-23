import type {
  SessionCatalogItem,
  SessionCatalogKind,
  SessionListResult,
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import {
  type SessionStorageDescriptor,
  type SessionStoragePort,
  type SessionTranscriptFingerprint,
  readSessionStoreLabel,
} from './session-storage-repository';
import type { SessionMetadataPort } from './session-metadata-repository';
import {
  materializeTranscriptTimelineEntries,
} from './transcript-timeline-materializer';
import {
  parseTranscriptMessages,
} from './transcript-parser';
import {
  resolveSessionLabelDetailsFromTimelineEntries,
} from './transcript-labels';
import { resolveTimelineLastActivityAt } from './timeline-state';

export interface SessionCatalogRuntimeOverlay {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
  runtimeModel?: string | null;
}

export interface SessionCatalogServiceDeps {
  storageRepository: SessionStoragePort;
  metadataRepository: SessionMetadataPort;
}

export interface SessionCatalogPort {
  listStorageDescriptors(): Promise<SessionStorageDescriptor[]>;
  refreshCache(): Promise<void>;
  getSnapshotMeta(): {
    ready: boolean;
    updatedAt: number | null;
    error: string | null;
  };
  listSessions(input?: {
    runtimeOverlays?: readonly SessionCatalogRuntimeOverlay[];
  }): Promise<SessionListResult>;
  scanSessions(): Promise<SessionListResult>;
}

function readSessionKeySuffix(sessionKey: string): string {
  const parts = sessionKey.split(':');
  return parts.length >= 3 ? parts.slice(2).join(':') : sessionKey;
}

export function parseSessionKeyAgent(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) {
    return null;
  }
  const parts = sessionKey.split(':');
  const agentId = parts[1]?.trim();
  return agentId || null;
}

function resolveSessionCatalogKind(sessionKey: string): SessionCatalogKind {
  const suffix = readSessionKeySuffix(sessionKey).trim().toLowerCase();
  if (suffix === 'main') {
    return 'main';
  }
  if (suffix.startsWith('subagent:')) {
    return 'subsession';
  }
  if (/^session-\d{8,16}$/i.test(suffix)) {
    return 'session';
  }
  return 'named';
}

async function buildSessionCatalogItem(input: {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
  storageDescriptor?: SessionStorageDescriptor | null;
  runtimeModel?: string | null;
  metadataRepository: SessionMetadataPort;
}): Promise<SessionCatalogItem> {
  const agentId = parseSessionKeyAgent(input.sessionKey) ?? 'main';
  const storeLabel = readSessionStoreLabel(input.storageDescriptor?.sessionStoreEntry ?? null);
  const timelineLabel = resolveSessionLabelDetailsFromTimelineEntries(input.timelineEntries);
  const updatedAt = resolveTimelineLastActivityAt(input.timelineEntries, input.runtime);
  const kind = resolveSessionCatalogKind(input.sessionKey);
  const resolvedModel = await input.metadataRepository.resolveSessionModel({
    sessionKey: input.sessionKey,
    storageDescriptor: input.storageDescriptor ?? null,
    runtimeModel: input.runtimeModel ?? null,
  });
  return {
    key: input.sessionKey,
    agentId,
    kind,
    preferred: kind === 'main',
    status: input.storageDescriptor?.sessionStoreEntry?.status === 'archived'
      || input.storageDescriptor?.sessionStoreEntry?.status === 'deleted'
      || input.storageDescriptor?.sessionStoreEntry?.status === 'completed'
      || input.storageDescriptor?.sessionStoreEntry?.status === 'active'
      ? input.storageDescriptor.sessionStoreEntry.status
      : 'completed',
    ...(storeLabel || timelineLabel.label ? { label: storeLabel ?? timelineLabel.label ?? undefined } : {}),
    ...(storeLabel
      ? { titleSource: 'user' as const }
      : (timelineLabel.titleSource !== 'none' ? { titleSource: timelineLabel.titleSource } : {})),
    displayName: input.sessionKey,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
  };
}

function createEmptySessionRuntimeState(): SessionRuntimeStateSnapshot {
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
    updatedAt: null,
  };
}

function shouldExposeRuntimeOnlySession(runtime: SessionRuntimeStateSnapshot): boolean {
  return typeof runtime.updatedAt === 'number';
}

export class SessionCatalogService implements SessionCatalogPort {
  private readonly storageRepository: SessionStoragePort;
  private readonly metadataRepository: SessionMetadataPort;
  private readonly transcriptTimelineCache = new Map<string, {
    fingerprint: SessionTranscriptFingerprint;
    timelineEntries: SessionTimelineEntry[];
  }>();
  private cachedSessions: SessionCatalogItem[] = [];
  private cacheReady = false;
  private cacheUpdatedAt: number | null = null;
  private cacheError: string | null = null;

  constructor(private readonly deps: SessionCatalogServiceDeps) {
    this.storageRepository = deps.storageRepository;
    this.metadataRepository = deps.metadataRepository;
  }

  async listStorageDescriptors(): Promise<SessionStorageDescriptor[]> {
    return await this.storageRepository.listStorageDescriptors();
  }

  async refreshCache(): Promise<void> {
    try {
      const result = await this.scanSessions();
      this.cachedSessions = result.sessions;
      this.cacheReady = true;
      this.cacheUpdatedAt = Date.now();
      this.cacheError = null;
    } catch (error) {
      this.cacheError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getSnapshotMeta(): {
    ready: boolean;
    updatedAt: number | null;
    error: string | null;
  } {
    return {
      ready: this.cacheReady,
      updatedAt: this.cacheUpdatedAt,
      error: this.cacheError,
    };
  }

  async listSessions(input: {
    runtimeOverlays?: readonly SessionCatalogRuntimeOverlay[];
  } = {}): Promise<SessionListResult> {
    const sessionsByKey = new Map(this.cachedSessions.map((session) => [session.key, session]));

    for (const overlay of input.runtimeOverlays ?? []) {
      const cached = sessionsByKey.get(overlay.sessionKey);
      if (!cached && !shouldExposeRuntimeOnlySession(overlay.runtime)) {
        continue;
      }
      sessionsByKey.set(overlay.sessionKey, await this.buildOverlayCatalogItem(overlay, cached));
    }

    const sessions = Array.from(sessionsByKey.values())
      .filter((session) => session.status !== 'archived' && session.status !== 'deleted');
    this.sortSessions(sessions);
    return {
      sessions,
      ready: this.cacheReady,
      refreshing: false,
      updatedAt: this.cacheUpdatedAt,
      error: this.cacheError,
    };
  }

  async scanSessions(): Promise<SessionListResult> {
    const sessionsByKey = new Map<string, SessionCatalogItem>();
    const descriptors = await this.listStorageDescriptors();
    const liveTranscriptPaths = new Set<string>();

    await Promise.all(descriptors.map(async (descriptor) => {
      const timelineEntries = await this.resolveTranscriptTimelineEntries(descriptor);
      if (!timelineEntries || timelineEntries.length === 0) {
        return;
      }
      if (descriptor.transcriptPath) {
        liveTranscriptPaths.add(descriptor.transcriptPath);
      }
      sessionsByKey.set(descriptor.sessionKey, await buildSessionCatalogItem({
        sessionKey: descriptor.sessionKey,
        timelineEntries,
        runtime: createEmptySessionRuntimeState(),
        storageDescriptor: descriptor,
        runtimeModel: null,
        metadataRepository: this.metadataRepository,
      }));
    }));
    this.pruneTranscriptTimelineCache(liveTranscriptPaths);

    const sessions = Array.from(sessionsByKey.values());
    this.sortSessions(sessions);

    return {
      sessions,
      ready: true,
      refreshing: false,
      updatedAt: null,
      error: null,
    };
  }

  private async buildOverlayCatalogItem(
    overlay: SessionCatalogRuntimeOverlay,
    cached: SessionCatalogItem | undefined,
  ): Promise<SessionCatalogItem> {
    const agentId = parseSessionKeyAgent(overlay.sessionKey) ?? cached?.agentId ?? 'main';
    const storageDescriptor = await this.storageRepository.findStorageDescriptor(overlay.sessionKey);
    const storeLabel = readSessionStoreLabel(storageDescriptor?.sessionStoreEntry ?? null);
    const timelineLabel = resolveSessionLabelDetailsFromTimelineEntries(overlay.timelineEntries);
    const label = storeLabel ?? timelineLabel.label;
    const titleSource = storeLabel ? 'user' : timelineLabel.titleSource;
    const updatedAt = resolveTimelineLastActivityAt(overlay.timelineEntries, overlay.runtime);
    const kind = resolveSessionCatalogKind(overlay.sessionKey);
    return {
      key: overlay.sessionKey,
      agentId,
      kind,
      preferred: kind === 'main',
      ...(cached ?? {}),
      status: cached?.status ?? 'completed',
      ...(label ? { label } : {}),
      ...(titleSource !== 'none' ? { titleSource } : {}),
      displayName: cached?.displayName ?? overlay.sessionKey,
      ...(overlay.runtimeModel ? { model: overlay.runtimeModel } : {}),
      ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
    };
  }

  private sortSessions(sessions: SessionCatalogItem[]): void {
    sessions.sort((left, right) => {
      const leftUpdatedAt = typeof left.updatedAt === 'number' ? left.updatedAt : 0;
      const rightUpdatedAt = typeof right.updatedAt === 'number' ? right.updatedAt : 0;
      if (leftUpdatedAt !== rightUpdatedAt) {
        return rightUpdatedAt - leftUpdatedAt;
      }
      return left.key.localeCompare(right.key);
    });
  }

  private async resolveTranscriptTimelineEntries(
    descriptor: SessionStorageDescriptor,
  ): Promise<SessionTimelineEntry[] | null> {
    if (!descriptor.transcriptPath) {
      return null;
    }

    const fingerprint = await this.storageRepository.getTranscriptFingerprint(descriptor.transcriptPath);
    if (!fingerprint) {
      this.transcriptTimelineCache.delete(descriptor.transcriptPath);
      return null;
    }

    const cached = this.transcriptTimelineCache.get(descriptor.transcriptPath);
    if (
      cached
      && cached.fingerprint.size === fingerprint.size
      && cached.fingerprint.mtimeMs === fingerprint.mtimeMs
    ) {
      return cached.timelineEntries;
    }

    const content = await this.storageRepository.readTranscriptDescriptorContent(descriptor);
    if (!content) {
      this.transcriptTimelineCache.delete(descriptor.transcriptPath);
      return null;
    }

    const timelineEntries = materializeTranscriptTimelineEntries(
      descriptor.sessionKey,
      parseTranscriptMessages(content),
    );
    this.transcriptTimelineCache.set(descriptor.transcriptPath, {
      fingerprint,
      timelineEntries,
    });
    return timelineEntries;
  }

  private pruneTranscriptTimelineCache(liveTranscriptPaths: Set<string>): void {
    for (const cachedPath of this.transcriptTimelineCache.keys()) {
      if (!liveTranscriptPaths.has(cachedPath)) {
        this.transcriptTimelineCache.delete(cachedPath);
      }
    }
  }
}
