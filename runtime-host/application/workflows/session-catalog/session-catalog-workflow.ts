import { buildRuntimeAddressKey, type RuntimeAddress } from '../../agent-runtime/contracts/runtime-address';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import type { RuntimeEndpointId, RuntimeProtocolId } from '../../agent-runtime/contracts/runtime-endpoint-types';
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
import { iterateTranscriptMessages } from '../../sessions/transcript-parser';
import { canProjectTranscriptMessage } from '../../sessions/canonical/canonical-transcript-replay';
import {
  resolveSessionLabelDetailsFromTimelineEntries,
  resolveSessionLabelDetailsFromTranscriptMessages,
  type SessionResolvedLabel,
} from '../../sessions/transcript-labels';
import { resolveTimelineLastActivityAt } from '../../sessions/timeline-state';

const SESSION_CATALOG_SCAN_CONCURRENCY = 8;

export interface SessionCatalogRuntimeOverlay {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
  runtimeModel?: string | null;
  runtimeAddress: RuntimeAddress;
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
    runtimeAddress: RuntimeAddress;
    runtimeOverlays?: readonly SessionCatalogRuntimeOverlay[];
  }): Promise<SessionListResult> {
    const sessionsByKey = new Map(
      this.cachedSessions
        .filter((session) => isSameRuntimeTarget(session.runtimeAddress, input.runtimeAddress))
        .map((session) => [buildSessionIdentityKey(session.runtimeAddress, session.key), session]),
    );

    for (const overlay of input.runtimeOverlays ?? []) {
      if (!isSameRuntimeTarget(overlay.runtimeAddress, input.runtimeAddress)) {
        continue;
      }
      const identityKey = buildSessionIdentityKey(overlay.runtimeAddress, overlay.sessionKey);
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
        transcriptUpdatedAt: fingerprint.mtimeMs,
        runtimeModel: null,
        metadataRepository: this.deps.metadataRepository,
        storageRepository: this.deps.storageRepository,
        agentRuntimeRegistry: this.deps.agentRuntimeRegistry,
      });
      if (item) {
        sessionsByKey.set(buildSessionIdentityKey(item.runtimeAddress, item.key), item);
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

  private async buildOverlayCatalogItem(
    overlay: SessionCatalogRuntimeOverlay,
    cached: SessionCatalogItem | undefined,
  ): Promise<SessionCatalogItem> {
    const agentId = overlay.runtimeAddress.agentId;
    const storageDescriptor = await this.deps.storageRepository.findStorageDescriptor(overlay.sessionKey);
    const storeLabel = readSessionStoreLabel(storageDescriptor?.sessionStoreEntry ?? null);
    const timelineLabel = resolveSessionLabelDetailsFromTimelineEntries(overlay.timelineEntries);
    const label = storeLabel ?? timelineLabel.label;
    const titleSource = storeLabel ? 'user' : timelineLabel.titleSource;
    const updatedAt = resolveTimelineLastActivityAt(overlay.timelineEntries, overlay.runtime);
    const kind = resolveSessionCatalogKind(overlay.sessionKey);
    const identity = resolveSessionIdentity(this.deps.agentRuntimeRegistry, overlay.runtimeAddress);
    return {
      key: overlay.sessionKey,
      agentId,
      protocolId: identity.protocolId,
      runtimeEndpointId: identity.runtimeEndpointId,
      runtimeAddress: overlay.runtimeAddress,
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
  agentRuntimeRegistry: AgentRuntimeRegistry;
}): Promise<SessionCatalogItem | null> {
  if (!input.storageDescriptor.transcriptPath) {
    return null;
  }
  const runtimeAddress = input.storageDescriptor.runtimeAddress;
  const agentId = runtimeAddress.agentId;
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
  const identity = resolveSessionIdentity(input.agentRuntimeRegistry, runtimeAddress);
  return {
    key: input.sessionKey,
    agentId,
    protocolId: identity.protocolId,
    runtimeEndpointId: identity.runtimeEndpointId,
    runtimeAddress,
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

function resolveSessionIdentity(registry: AgentRuntimeRegistry, address: RuntimeAddress): {
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
} {
  try {
    return registry.resolveSessionIdentityForAddress(address);
  } catch (error) {
    if (address.kind !== 'protocol-connector') {
      throw error;
    }
    return {
      protocolId: address.protocolId,
      runtimeEndpointId: address.endpointId,
    };
  }
}

function isSameRuntimeTarget(left: RuntimeAddress, right: RuntimeAddress): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'native-runtime' && right.kind === 'native-runtime') {
    return left.runtimeAdapterId === right.runtimeAdapterId
      && left.runtimeInstanceId === right.runtimeInstanceId;
  }
  if (left.kind === 'protocol-connector' && right.kind === 'protocol-connector') {
    return left.protocolId === right.protocolId
      && left.connectorId === right.connectorId
      && left.endpointId === right.endpointId;
  }
  return false;
}

function buildSessionIdentityKey(runtimeAddress: RuntimeAddress, sessionKey: string): string {
  return `${buildRuntimeAddressKey(runtimeAddress)}::${sessionKey}`;
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
