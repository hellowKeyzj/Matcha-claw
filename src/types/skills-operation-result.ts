import { isCallId } from './call-log/decode';

export type SkillBundle = {
  skillKey: string;
  files: { path: string; content: string }[];
};
export type SkillsConfigResult = {
  kind: 'config';
  outcome: 'accepted' | 'partial' | 'rejected' | 'unknown';
  skillKey: string;
  invalidKeys: string[];
};
export type SkillsBatchStateResult = {
  kind: 'batchState';
  success: boolean;
  outcome: 'accepted' | 'partial' | 'rejected' | 'unknown';
  enabled: boolean;
  requested: string[];
  updated: string[];
  invalidKeys: string[];
  failed: { skillKey: string; outcome: 'rejected' | 'unknown' | 'notAttempted' }[];
};
export type SkillsUploadCommitResult = {
  kind: 'uploadCommit';
  outcome: 'accepted' | 'rejected' | 'unknown';
  receipt?: { uploadId: string; receivedBytes: number; expiresAt: number; sha256: string };
};
export type SkillsBundleExportResult = {
  kind: 'bundleExport';
  outcome: 'accepted' | 'rejected' | 'unknown';
  skillBundles?: SkillBundle[];
};
export type SkillsOperationResult = SkillsConfigResult | SkillsBatchStateResult | SkillsUploadCommitResult | SkillsBundleExportResult;
export type SkillsOperationResultResponse = { callId: string; command: string; result: SkillsOperationResult };

export function decodeSkillsOperationResult(value: unknown): SkillsOperationResultResponse {
  if (!record(value) || !keys(value, ['callId', 'command', 'result'])
    || !isCallId(value.callId) || typeof value.command !== 'string' || !record(value.result)) {
    throw new Error('Invalid Skills operation result');
  }
  const result = value.result;
  let valid = false;
  if (['skills.config', 'skills.updateConfig', 'skills.updateState'].includes(value.command)) {
    valid = keys(result, ['kind', 'outcome', 'skillKey', 'invalidKeys']) && result.kind === 'config'
      && outcome(result.outcome, true) && skillKey(result.skillKey) && Array.isArray(result.invalidKeys) && result.invalidKeys.every(skillKey);
  } else if (value.command === 'skills.updateBatchState') {
    valid = keys(result, ['kind', 'success', 'outcome', 'enabled', 'requested', 'updated', 'invalidKeys', 'failed'])
      && result.kind === 'batchState' && typeof result.success === 'boolean' && outcome(result.outcome, true)
      && result.success === (result.outcome === 'accepted') && typeof result.enabled === 'boolean'
      && strings(result.requested) && strings(result.updated) && Array.isArray(result.invalidKeys) && result.invalidKeys.every(skillKey)
      && Array.isArray(result.failed) && result.failed.every((item) => record(item)
        && keys(item, ['skillKey', 'outcome']) && skillKey(item.skillKey)
        && ['rejected', 'unknown', 'notAttempted'].includes(item.outcome as string));
  } else if (value.command === 'skills.upload.commit') {
    valid = onlyKeys(result, ['kind', 'outcome', 'receipt']) && result.kind === 'uploadCommit'
      && outcome(result.outcome) && (result.receipt === undefined ? result.outcome !== 'accepted'
        : record(result.receipt) && keys(result.receipt, ['uploadId', 'receivedBytes', 'expiresAt', 'sha256'])
          && typeof result.receipt.uploadId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.receipt.uploadId)
          && integer(result.receipt.receivedBytes) && integer(result.receipt.expiresAt)
          && typeof result.receipt.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.receipt.sha256));
  } else if (['skills.bundles.export', 'skills.exportBundles'].includes(value.command)) {
    valid = onlyKeys(result, ['kind', 'outcome', 'skillBundles']) && result.kind === 'bundleExport'
      && outcome(result.outcome) && (result.skillBundles === undefined ? result.outcome !== 'accepted'
        : Array.isArray(result.skillBundles) && result.skillBundles.every(isSkillBundle));
  }
  if (!valid) throw new Error('Invalid Skills operation result');
  return value as unknown as SkillsOperationResultResponse;
}

export function isSkillBundle(value: unknown): value is SkillBundle {
  return record(value) && keys(value, ['skillKey', 'files']) && skillKey(value.skillKey)
    && Array.isArray(value.files) && value.files.every((file) => record(file)
      && keys(file, ['path', 'content']) && typeof file.path === 'string'
      && file.path.length > 0 && file.path.length <= 240 && !file.path.startsWith('/')
      && !file.path.includes('\\') && !file.path.includes('\0')
      && file.path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
      && typeof file.content === 'string');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function skillKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !value.includes('\0');
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(skillKey) && new Set(value).size === value.length;
}
function outcome(value: unknown, partial = false): boolean {
  return ['accepted', 'rejected', 'unknown', ...(partial ? ['partial'] : [])].includes(value as string);
}
function integer(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
