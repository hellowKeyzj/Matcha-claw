import type { SessionRenderItem } from './render-item';
import type { GatewayTransportIssue } from './runtime-state';
import {
  decodeSessionDelta,
  decodeSessionView,
  type SessionDelta,
  type SessionStateSnapshot,
  type SessionView,
} from './snapshot';

export type SessionProjectionEvent =
  | { kind: 'view'; view: SessionView }
  | { kind: 'delta'; delta: SessionDelta };

export function decodeSessionProjectionEvent(value: unknown): SessionProjectionEvent | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.kind === 'view' && Object.hasOwn(record, 'view')) {
      try { return { kind: 'view', view: decodeSessionView(record.view) }; } catch { return null; }
    }
    if (record.kind === 'delta' && Object.hasOwn(record, 'delta')) {
      try { return { kind: 'delta', delta: decodeSessionDelta(record.delta) }; } catch { return null; }
    }
  }
  try { return { kind: 'view', view: decodeSessionView(value) }; } catch { /* not a projection view */ }
  try { return { kind: 'delta', delta: decodeSessionDelta(value) }; } catch { return null; }
}
import type { TaskSnapshotEvent } from './task-snapshot';

export interface SessionInfoUpdateEvent {
  sessionUpdate: 'session_info_update';
  sessionKey: string | null;
  runId: string | null;
  phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
  snapshot: SessionStateSnapshot;
  error: string | null;
  transportIssue?: GatewayTransportIssue | null;
  _meta?: Record<string, unknown>;
}

export interface SessionItemChunkUpdateEvent {
  sessionUpdate: 'session_item_chunk';
  sessionKey: string | null;
  runId: string | null;
  item: SessionRenderItem | null;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export interface SessionItemUpdateEvent {
  sessionUpdate: 'session_item';
  sessionKey: string | null;
  runId: string | null;
  item: SessionRenderItem | null;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export interface SessionPlanUpdateEvent {
  sessionUpdate: 'plan';
  sessionKey: string | null;
  runId: string | null;
  taskSnapshot: TaskSnapshotEvent;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export type SessionUpdateEvent =
  | SessionInfoUpdateEvent
  | SessionItemChunkUpdateEvent
  | SessionItemUpdateEvent
  | SessionPlanUpdateEvent;

export interface SessionPromptResult {
  success: boolean;
  sessionKey: string;
  runId: string | null;
  item: SessionRenderItem | null;
  snapshot: SessionStateSnapshot;
}

export interface SessionNewResult {
  success: boolean;
  sessionKey: string;
  snapshot: SessionStateSnapshot;
}
