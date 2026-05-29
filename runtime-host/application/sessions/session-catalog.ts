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
  readSessionStoreLabel,
} from './session-storage-repository';
import type { SessionMetadataPort } from './session-metadata-repository';
import { iterateTranscriptMessages } from './transcript-parser';
import {
  canProjectTranscriptMessage,
} from './canonical/canonical-transcript-replay';
import {
  resolveSessionLabelDetailsFromTimelineEntries,
  resolveSessionLabelDetailsFromTranscriptMessages,
  type SessionResolvedLabel,
} from './transcript-labels';
import { resolveTimelineLastActivityAt } from './timeline-state';
import { createOpenClawRuntimeSessionContext } from './runtime-providers/session-runtime-context';

const SESSION_CATALOG_SCAN_CONCURRENCY = 8;

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

function readSessionStoreStatus(entry: Record<string, unknown> | null): SessionCatalogItem['status'] {
  const status = entry?.status;
  return status === 'archived'
    || status === 'deleted'
    || status === 'completed'
    || status === 'active'
    ? status
    : 'completed';
}

function readSessionStoreUpdatedAt(entry: Record<string, unknown> | null): number | null {
  const updatedAt = entry?.updatedAt ?? entry?.updated_at ?? entry?.lastActivityAt ?? entry?.last_activity_at;
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  if (typeof updatedAt === 'string') {
    const parsed = Date.parse(updatedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

interface SessionTranscriptCatalogDetails extends SessionResolvedLabel {
  hasRenderableContent: boolean;
}

async function resolveTranscriptCatalogDetails(input: {
  storageRepository: SessionStoragePort;
  storageDescriptor: SessionStorageDescriptor;
}): Promise<SessionTranscriptCatalogDetails> {
  const content = await input.storageRepository.readTranscriptDescriptorContent(input.storageDescriptor);
  let userLabel: string | null = null;
  let assistantLabel: string | null = null;
  let hasRenderableContent = false;
  for (const message of content ? iterateTranscriptMessages(content) : []) {
    const details = resolveSessionLabelDetailsFromTranscriptMessages([message]);
    if (details.titleSource === 'user') {
      userLabel = details.label;
    } else if (details.titleSource === 'assistant') {
      assistantLabel = details.label;
    }
    hasRenderableContent ||= canProjectTranscriptMessage(input.storageDescriptor.sessionKey, message);
  }
  if (userLabel) {
    return { label: userLabel, titleSource: 'user', hasRenderableContent };
  }
  if (assistantLabel) {
    return { label: assistantLabel, titleSource: 'assistant', hasRenderableContent };
  }
  return { label: null, titleSource: 'none', hasRenderableContent };
}

async function buildSessionCatalogItem(input: {
  sessionKey: string;
  storageDescriptor: SessionStorageDescriptor;
  transcriptUpdatedAt?: number | null;
  runtimeModel?: string | null;
  metadataRepository: SessionMetadataPort;
  storageRepository: SessionStoragePort;
}): Promise<SessionCatalogItem | null> {
  if (!input.storageDescriptor.transcriptPath) {
    return null;
  }
  const context = createOpenClawRuntimeSessionContext(input.sessionKey);
  const agentId = parseSessionKeyAgent(input.sessionKey) ?? input.storageDescriptor.agentId;
  const storeLabel = readSessionStoreLabel(input.storageDescriptor.sessionStoreEntry);
  const transcriptDetails = storeLabel
    ? { label: null, titleSource: 'none' as const, hasRenderableContent: true }
    : await resolveTranscriptCatalogDetails({
        storageRepository: input.storageRepository,
        storageDescriptor: input.storageDescriptor,
      });
  if (!storeLabel && !transcriptDetails.hasRenderableContent) {
    return null;
  }
  const label = storeLabel ?? transcriptDetails.label;
  const titleSource = storeLabel ? 'user' : transcriptDetails.titleSource;
  const updatedAt = readSessionStoreUpdatedAt(input.storageDescriptor.sessionStoreEntry) ?? input.transcriptUpdatedAt ?? null;
  const kind = resolveSessionCatalogKind(input.sessionKey);
  const resolvedModel = await input.metadataRepository.resolveSessionModel({
    sessionKey: input.sessionKey,
    storageDescriptor: input.storageDescriptor,
    runtimeModel: input.runtimeModel ?? null,
  });
  return {
    key: input.sessionKey,
    agentId,
    protocolId: context.protocolId,
    runtimeProviderId: context.runtimeProviderId,
    kind,
    preferred: kind === 'main',
    status: readSessionStoreStatus(input.storageDescriptor.sessionStoreEntry),
    ...(label ? { label } : {}),
    ...(titleSource !== 'none' ? { titleSource } : {}),
    displayName: label ?? input.sessionKey,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
  };
}

function shouldExposeRuntimeOnlySession(runtime: SessionRuntimeStateSnapshot): boolean {
  return typeof runtime.updatedAt === 'number';
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]!;
      nextIndex += 1;
      await worker(item);
    }
  }));
}

export class SessionCatalogService implements SessionCatalogPort {
  private readonly storageRepository: SessionStoragePort;
  private readonly metadataRepository: SessionMetadataPort;
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

    await forEachWithConcurrency(descriptors, SESSION_CATALOG_SCAN_CONCURRENCY, async (descriptor) => {
      if (!descriptor.transcriptPath) {
        return;
      }
      const fingerprint = await this.storageRepository.getTranscriptFingerprint(descriptor.transcriptPath);
      if (!fingerprint) {
        return;
      }
      const item = await buildSessionCatalogItem({
        sessionKey: descriptor.sessionKey,
        storageDescriptor: descriptor,
        transcriptUpdatedAt: fingerprint.mtimeMs,
        runtimeModel: null,
        metadataRepository: this.metadataRepository,
        storageRepository: this.storageRepository,
      });
      if (item) {
        sessionsByKey.set(descriptor.sessionKey, item);
      }
    });

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
      protocolId: overlay.protocolId,
      runtimeProviderId: overlay.runtimeProviderId,
      kind,
      preferred: kind === 'main',
      ...(cached ?? {}),
      status: cached?.status ?? 'completed',
      ...(label ? { label } : {}),
      ...(titleSource !== 'none' ? { titleSource } : {}),
      displayName: label ?? cached?.displayName ?? overlay.sessionKey,
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

}
