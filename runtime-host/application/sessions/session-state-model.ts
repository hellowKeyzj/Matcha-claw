import type {
  SessionRuntimeStateSnapshot,
} from '../../shared/session-adapter-types';
import {
  isRecord,
  normalizeString,
} from './session-value-normalization';
import {
  createLatestWindowState,
} from './session-window-model';
import { createEmptyCanonicalSessionState } from './canonical/canonical-reducer';
import type {
  SessionRuntimeTimelineState,
} from './session-runtime-types';
import type { RuntimeSessionContext } from '../agent-runtime/contracts/runtime-endpoint-types';

export function createEmptySessionRuntimeState(): SessionRuntimeStateSnapshot {
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

export function createEmptyTimelineState(
  patch: Partial<SessionRuntimeTimelineState> = {},
  context?: RuntimeSessionContext,
): SessionRuntimeTimelineState {
  const sessionKey = patch.sessionKey ?? context?.sessionKey ?? '';
  return {
    sessionKey,
    runEpoch: 0,
    canonical: createEmptyCanonicalSessionState(sessionKey, context),
    timelineEntries: [],
    executionGraphItems: [],
    renderItems: [],
    renderItemIndexByKey: new Map(),
    renderItemKeyIndex: {
      messageItemKeyByCanonicalKey: new Map(),
      toolItemKeyByCanonicalKey: new Map(),
    },
    taskSnapshot: null,
    hydrated: false,
    runtime: createEmptySessionRuntimeState(),
    window: createLatestWindowState(0),
    activeTransportEpoch: null,
    ...patch,
  };
}

export function cloneSessionRuntimeState(runtime: SessionRuntimeStateSnapshot): SessionRuntimeStateSnapshot {
  return { ...runtime };
}

function qualifySessionModel(provider: string, model: string): string | null {
  if (!model) {
    return null;
  }
  if (provider && model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) {
    return model;
  }
  return provider ? `${provider}/${model}` : model;
}

export function readPatchedSessionResolvedModel(requestedModel: string, result: unknown): string {
  if (!isRecord(result)) {
    return requestedModel;
  }
  const resolved = isRecord(result.resolved) ? result.resolved : null;
  if (!resolved) {
    return requestedModel;
  }
  const provider = normalizeString(resolved.modelProvider);
  const model = normalizeString(resolved.model);
  return qualifySessionModel(provider, model) ?? requestedModel;
}
