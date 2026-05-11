import type {
  SessionCatalogItem,
  SessionCatalogKind,
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import { parseSessionKeyAgent } from './session-catalog';
import {
  resolveSessionLabelDetailsFromTimelineEntries,
} from './transcript-labels';
import {
  resolveTimelineLastActivityAt,
} from './timeline-state';

function readSessionKeySuffix(sessionKey: string): string {
  const parts = sessionKey.split(':');
  return parts.length >= 3 ? parts.slice(2).join(':') : sessionKey;
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

export function createSessionCatalogItem(input: {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
  runtimeModel?: string | null;
  resolvedModel?: string | null;
}): SessionCatalogItem {
  const agentId = parseSessionKeyAgent(input.sessionKey) ?? 'main';
  const label = resolveSessionLabelDetailsFromTimelineEntries(input.timelineEntries);
  const updatedAt = resolveTimelineLastActivityAt(input.timelineEntries, input.runtime);
  const kind = resolveSessionCatalogKind(input.sessionKey);
  const resolvedModel = input.runtimeModel ?? input.resolvedModel ?? null;
  return {
    key: input.sessionKey,
    agentId,
    kind,
    preferred: kind === 'main',
    ...(label.label ? { label: label.label } : {}),
    ...(label.titleSource !== 'none' ? { titleSource: label.titleSource } : {}),
    displayName: input.sessionKey,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
  };
}
