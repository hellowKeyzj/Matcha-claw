import type { CallDetailByModule } from '../call-log';

export interface SkillsCallDetail {
  access: 'read' | 'write' | 'unknown';
  skillKey?: string;
  slug?: string;
  version?: string;
  enabled?: boolean;
  uploadId?: string;
  sizeBytes?: number;
  offset?: number;
  receivedBytes?: number;
  expiresAt?: number;
  sha256?: string;
  bundleCount?: number;
  fileCount?: number;
  resultReady?: boolean;
  result?: 'accepted' | 'partial' | 'rejected' | 'unknown';
  requestedCount?: number;
  updatedCount?: number;
  invalidCount?: number;
  failedCount?: number;
  outcome?: 'accepted' | 'partial' | 'removed' | 'notFound' | 'succeeded' | 'rejected' | 'unknown' | 'unavailable';
}

declare module '../call-log' {
  interface CallDetailByModule {
    skills: SkillsCallDetail;
  }
}

const textFields = new Set(['skillKey', 'slug', 'version', 'uploadId']);
const numberFields = new Set(['sizeBytes', 'offset', 'receivedBytes', 'expiresAt', 'bundleCount', 'fileCount', 'requestedCount', 'updatedCount', 'invalidCount', 'failedCount']);
const outcomes = new Set(['accepted', 'partial', 'removed', 'notFound', 'succeeded', 'rejected', 'unknown', 'unavailable']);

export function decodeSkillsCallDetail(value: unknown): CallDetailByModule['skills'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Skills call detail');
  }
  const detail = value as Record<string, unknown>;
  if (!['read', 'write', 'unknown'].includes(detail.access as string)) {
    throw new Error('Invalid Skills call access');
  }
  for (const [key, field] of Object.entries(detail)) {
    let valid: boolean;
    if (key === 'access') valid = true;
    else if (textFields.has(key)) valid = typeof field === 'string' && field.length > 0
      && new TextEncoder().encode(field).length <= (key === 'skillKey' ? 4096 : 512)
      && !Array.from(field).some((character) => character.charCodeAt(0) < 32
        || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159));
    else if (numberFields.has(key)) valid = typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
    else if (key === 'enabled' || key === 'resultReady') valid = typeof field === 'boolean';
    else if (key === 'result') valid = typeof field === 'string' && ['accepted', 'partial', 'rejected', 'unknown'].includes(field);
    else if (key === 'sha256') valid = typeof field === 'string' && /^[0-9a-fA-F]{64}$/.test(field);
    else if (key === 'outcome') valid = typeof field === 'string' && outcomes.has(field);
    else valid = false;
    if (!valid) throw new Error('Invalid Skills call detail field');
  }
  return detail as unknown as SkillsCallDetail;
}
