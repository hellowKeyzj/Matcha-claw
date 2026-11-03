import type { CallDetailByModule } from '../call-log';

export interface WorkspaceCallDetail {
  operation:
    | 'files.readText'
    | 'files.readBinary'
    | 'files.stat'
    | 'files.listDir'
    | 'files.writeText'
    | 'files.writeBinary'
    | 'media.prepare'
    | 'media.resolve'
    | 'media.playback'
    | 'media.thumbnail'
    | 'media.thumbnails'
    | 'media.stagePaths'
    | 'media.stageBuffer'
    | 'media.listSessionImages'
    | 'media.readSessionImage';
  itemCount: number;
  outcome:
    | 'completed'
    | 'invalidPath'
    | 'invalidReference'
    | 'unavailable'
    | 'notFile'
    | 'notDirectory'
    | 'tooLarge'
    | 'binary'
    | 'outcomeUnknown'
    | 'unsupported'
    | 'cursorInvalid'
    | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    workspace: WorkspaceCallDetail;
  }
}

export type WorkspaceCallSummary = CallDetailByModule['workspace'];

const operations: readonly WorkspaceCallDetail['operation'][] = [
  'files.readText', 'files.readBinary', 'files.stat', 'files.listDir', 'files.writeText', 'files.writeBinary',
  'media.prepare', 'media.resolve', 'media.playback', 'media.thumbnail', 'media.thumbnails',
  'media.stagePaths', 'media.stageBuffer', 'media.listSessionImages', 'media.readSessionImage',
];
const outcomes: readonly WorkspaceCallDetail['outcome'][] = [
  null, 'completed', 'invalidPath', 'invalidReference', 'unavailable', 'notFile',
  'notDirectory', 'tooLarge', 'binary', 'outcomeUnknown', 'unsupported', 'cursorInvalid',
];

export function decodeWorkspaceCallDetail(value: unknown): WorkspaceCallDetail | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  const keys = ['operation', 'itemCount', 'outcome'];
  if (Object.keys(detail).length !== keys.length || !keys.every((key) => Object.hasOwn(detail, key))) return null;
  if (typeof detail.operation !== 'string'
    || !operations.includes(detail.operation as WorkspaceCallDetail['operation'])) return null;
  if (typeof detail.itemCount !== 'number' || !Number.isSafeInteger(detail.itemCount)
    || detail.itemCount < 1 || detail.itemCount > 256) return null;
  if (detail.outcome !== null && (typeof detail.outcome !== 'string'
    || !outcomes.includes(detail.outcome as WorkspaceCallDetail['outcome']))) return null;
  if (detail.operation !== 'media.thumbnails' && detail.operation !== 'media.stagePaths'
    && detail.itemCount !== 1) return null;
  return {
    operation: detail.operation as WorkspaceCallDetail['operation'],
    itemCount: detail.itemCount,
    outcome: detail.outcome as WorkspaceCallDetail['outcome'],
  };
}
