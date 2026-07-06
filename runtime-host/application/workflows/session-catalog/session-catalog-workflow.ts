import { buildRuntimeEndpointKey, buildSessionIdentityKey, type RuntimeEndpointRef, type SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import type {
  SessionCatalogItem,
  SessionCatalogKind,
  SessionListResult,
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
} from '../../../shared/session-adapter-types';
import {
  type SessionStorageDescriptor,
  type SessionStoragePort,
  readSessionStoreLabel,
} from '../../sessions/session-storage-repository';
import type { SessionMetadataPort } from '../../sessions/session-metadata-repository';
import { iterateTranscriptMessagesAsync } from '../../sessions/transcript-parser';
import { canProjectTranscriptMessage } from '../../sessions/canonical/canonical-transcript-replay';
import {
  resolveSessionLabelDetailsFromTimelineEntries,
  resolveSessionLabelDetailsFromTranscriptMessages,
  type SessionResolvedLabel,
} from '../../sessions/transcript-labels';
import { resolveTimelineLastActivityAt } from '../../sessions/timeline-state';
import { readSessionContextTokenSnapshot } from '../../sessions/session-context-tokens';

const SESSION_CATALOG_SCAN_CONCURRENCY = 8;

export interface SessionCatalogRuntimeOverlay {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
  runtimeModel?: string | null;
  sessionIdentity: SessionIdentity;
}

export interface SessionCatalogWorkflowDeps {
  storageRepository: SessionStoragePort;
  metadataRepository: SessionMetadataPort;
  agentRuntimeRegistry: AgentRuntimeRegistry;
}

export class SessionCatalogWorkflow {
  private cachedSessions: SessionCatalogItem[] = [];
  private cacheReady = false;
  private cacheUpdatedAt: number | null = null;
  private cacheError: string | null = null;

  constructor(private readonly deps: SessionCatalogWorkflowDeps) {}

  async listStorageDescriptors(): Promise<SessionStorageDescriptor[]> {
    return await this.deps.storageRepository.listStorageDescriptors();
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
    endpoint: RuntimeEndpointRef;
    runtimeOverlays?: readonly SessionCatalogRuntimeOverlay[];
  }): Promise<SessionListResult> {
    const sessionsByKey = new Map<string, SessionCatalogItem>();
    for (const session of this.cachedSessions) {
      if (!isSameRuntimeEndpoint(session.sessionIdentity.endpoint, input.endpoint)) {
        continue;
      }
      const canonicalSession = this.resolveBoundSessionCatalogItem(session);
      sessionsByKey.set(buildSessionIdentityKey(canonicalSession.sessionIdentity), canonicalSession);
    }

    for (const overlay of input.runtimeOverlays ?? []) {
      if (!isSameRuntimeEndpoint(overlay.sessionIdentity.endpoint, input.endpoint)) {
        continue;
      }
      const identityKey = buildSessionIdentityKey(overlay.sessionIdentity);
      const cached = sessionsByKey.get(identityKey);
      if (!cached && !shouldExposeRuntimeOnlySession(overlay.runtime)) {
        continue;
      }
      sessionsByKey.set(identityKey, await this.buildOverlayCatalogItem(overlay, cached));
    }

    const sessions = Array.from(sessionsByKey.values())
      .filter((session) => session.status !== 'archived' && session.status !== 'deleted');
    sortSessions(sessions);
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
      const fingerprint = await this.deps.storageRepository.getTranscriptFingerprint(descriptor.transcriptPath);
      if (!fingerprint) {
        return;
      }
      const item = await buildSessionCatalogItem({
        sessionKey: descriptor.sessionKey,
        storageDescriptor: descriptor,
        runtimeModel: null,
        metadataRepository: this.deps.metadataRepository,
        storageRepository: this.deps.storageRepository,
        agentRuntimeRegistry: this.deps.agentRuntimeRegistry,
      });
      if (item) {
        sessionsByKey.set(buildSessionIdentityKey(item.sessionIdentity), item);
      }
    });

    const sessions = Array.from(sessionsByKey.values());
    sortSessions(sessions);

    return {
      sessions,
      ready: true,
      refreshing: false,
      updatedAt: null,
      error: null,
    };
  }

  private resolveBoundSessionCatalogItem(session: SessionCatalogItem): SessionCatalogItem {
    const context = this.deps.agentRuntimeRegistry.resolveSessionContextByEndpointSessionId(
      session.sessionIdentity.endpoint,
      session.key,
    );
    if (!context || buildSessionIdentityKey(context.identity) === buildSessionIdentityKey(session.sessionIdentity)) {
      return session;
    }
    return {
      ...session,
      key: context.localSessionId,
      endpointSessionId: context.endpointSessionId,
      sessionIdentity: context.identity,
      kind: resolveSessionCatalogKind(context.localSessionId),
      preferred: false,
      displayName: session.displayName ?? context.localSessionId,
    };
  }

  private async buildOverlayCatalogItem(
    overlay: SessionCatalogRuntimeOverlay,
    cached: SessionCatalogItem | undefined,
  ): Promise<SessionCatalogItem> {
    const agentId = overlay.sessionIdentity.agentId;
    const storageDescriptor = await this.deps.storageRepository.findStorageDescriptor(overlay.sessionIdentity);
    const storeLabel = readSessionStoreLabel(storageDescriptor?.sessionStoreEntry ?? null);
    const timelineLabel = resolveSessionLabelDetailsFromTimelineEntries(overlay.timelineEntries);
    const label = storeLabel ?? timelineLabel.label;
    const titleSource = storeLabel ? 'user' : timelineLabel.titleSource;
    const updatedAt = resolveTimelineLastActivityAt(overlay.timelineEntries, overlay.runtime);
    const kind = resolveSessionCatalogKind(overlay.sessionKey);
    const contextTokens = readSessionContextTokenSnapshot(storageDescriptor?.sessionStoreEntry);
    const endpoint = this.deps.agentRuntimeRegistry.resolveEndpointForRef(overlay.sessionIdentity.endpoint, overlay.sessionIdentity.agentId);
    const context = this.deps.agentRuntimeRegistry.findSessionContext(overlay.sessionIdentity);
    return {
      ...(cached ?? {}),
      key: overlay.sessionKey,
      agentId,
      protocolId: endpoint.protocolId,
      runtimeEndpointId: endpoint.id,
      ...(context ? { endpointSessionId: context.endpointSessionId } : {}),
      sessionIdentity: overlay.sessionIdentity,
      kind,
      preferred: kind === 'main',
      status: cached?.status ?? 'completed',
      ...(label ? { label } : {}),
      ...(titleSource !== 'none' ? { titleSource } : {}),
      displayName: label ?? cached?.displayName ?? overlay.sessionKey,
      ...(overlay.runtimeModel ? { model: overlay.runtimeModel } : {}),
      ...(contextTokens ? { contextTokens } : {}),
      ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
    };
  }
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
  lastActivityAt: number | null;
}

async function resolveTranscriptCatalogDetails(input: {
  storageRepository: SessionStoragePort;
  storageDescriptor: SessionStorageDescriptor;
}): Promise<SessionTranscriptCatalogDetails> {
  let userLabel: string | null = null;
  let assistantLabel: string | null = null;
  let hasRenderableContent = false;
  let lastActivityAt: number | null = null;
  for await (const message of iterateTranscriptMessagesAsync(input.storageRepository.readTranscriptDescriptorLines(input.storageDescriptor))) {
    const details = resolveSessionLabelDetailsFromTranscriptMessages([message]);
    if (details.titleSource === 'user') {
      userLabel = details.label;
    } else if (details.titleSource === 'assistant') {
      assistantLabel = details.label;
    }
    if (canProjectTranscriptMessage(input.storageDescriptor.sessionKey, message)) {
      hasRenderableContent = true;
      if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
        lastActivityAt = message.timestamp;
      }
    }
  }
  if (userLabel) {
    return { label: userLabel, titleSource: 'user', hasRenderableContent, lastActivityAt };
  }
  if (assistantLabel) {
    return { label: assistantLabel, titleSource: 'assistant', hasRenderableContent, lastActivityAt };
  }
  return { label: null, titleSource: 'none', hasRenderableContent, lastActivityAt };
}

async function buildSessionCatalogItem(input: {
  sessionKey: string;
  storageDescriptor: SessionStorageDescriptor;
  runtimeModel?: string | null;
  metadataRepository: SessionMetadataPort;
  storageRepository: SessionStoragePort;
  agentRuntimeRegistry: AgentRuntimeRegistry;
}): Promise<SessionCatalogItem | null> {
  if (!input.storageDescriptor.transcriptPath) {
    return null;
  }
  const sessionIdentity = input.storageDescriptor.sessionIdentity;
  const agentId = sessionIdentity.agentId;
  const storeLabel = readSessionStoreLabel(input.storageDescriptor.sessionStoreEntry);
  const transcriptDetails = await resolveTranscriptCatalogDetails({
    storageRepository: input.storageRepository,
    storageDescriptor: input.storageDescriptor,
  });
  if (!storeLabel && !transcriptDetails.hasRenderableContent) {
    return null;
  }
  const label = storeLabel ?? transcriptDetails.label;
  const titleSource = storeLabel ? 'user' : transcriptDetails.titleSource;
  const updatedAt = transcriptDetails.lastActivityAt ?? readSessionStoreUpdatedAt(input.storageDescriptor.sessionStoreEntry);
  const kind = resolveSessionCatalogKind(input.sessionKey);
  const resolvedModel = await input.metadataRepository.resolveSessionModel({
    sessionIdentity,
    storageDescriptor: input.storageDescriptor,
    runtimeModel: input.runtimeModel ?? null,
  });
  const contextTokens = readSessionContextTokenSnapshot(input.storageDescriptor.sessionStoreEntry);
  const endpoint = input.agentRuntimeRegistry.resolveEndpointForRef(sessionIdentity.endpoint, sessionIdentity.agentId);
  const context = input.agentRuntimeRegistry.findSessionContext(sessionIdentity);
  return {
    key: input.sessionKey,
    agentId,
    protocolId: endpoint.protocolId,
    runtimeEndpointId: endpoint.id,
    ...(context ? { endpointSessionId: context.endpointSessionId } : {}),
    sessionIdentity,
    kind,
    preferred: kind === 'main',
    status: readSessionStoreStatus(input.storageDescriptor.sessionStoreEntry),
    ...(label ? { label } : {}),
    ...(titleSource !== 'none' ? { titleSource } : {}),
    displayName: label ?? input.sessionKey,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(contextTokens ? { contextTokens } : {}),
    ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
  };
}

function shouldExposeRuntimeOnlySession(runtime: SessionRuntimeStateSnapshot): boolean {
  return typeof runtime.updatedAt === 'number';
}

function isSameRuntimeEndpoint(left: RuntimeEndpointRef, right: RuntimeEndpointRef): boolean {
  return buildRuntimeEndpointKey(left) === buildRuntimeEndpointKey(right);
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

function sortSessions(sessions: SessionCatalogItem[]): void {
  sessions.sort((left, right) => {
    const leftUpdatedAt = typeof left.updatedAt === 'number' ? left.updatedAt : 0;
    const rightUpdatedAt = typeof right.updatedAt === 'number' ? right.updatedAt : 0;
    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }
    return left.key.localeCompare(right.key);
  });
}
