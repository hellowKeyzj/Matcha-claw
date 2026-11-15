export const TEAM_PROMPTS_ENDPOINT = '/api/team/prompts';
export const TEAM_PROMPTS_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const TEAM_PROMPT_KEYS = [
  'discussion.body.body',
  'design.body.body',
  'execution.rules.body',
  'execution.completion.body',
  'execution.work.body',
  'execution.reviewCompleted.body',
  'execution.reviewRework.body',
  'repair.common.body',
  'repair.missing.body',
  'repair.missing.targetSummary',
  'repair.missing.targetDecision',
  'repair.declared.body',
  'repair.declared.targetSummary',
  'repair.unreadable.body',
  'repair.unreadable.targetSummary',
  'repair.fallback.body',
  'repair.fallback.targetSummary',
  'introduction.system.body',
  'introduction.input.body',
] as const;

export type TeamPromptKey = typeof TEAM_PROMPT_KEYS[number];
export type TeamPromptGroup = 'discussion' | 'design' | 'execution' | 'repair' | 'introduction';
export type TeamPromptPreviewVariant = 'work' | 'review' | 'missing' | 'declared' | 'unreadable';

export interface TeamPromptSettings {
  revision: number;
  values: Record<string, string>;
}

export interface TeamPromptCatalog extends TeamPromptSettings {
  defaults: Record<string, string>;
}

export type TeamPromptPreview = { prompt: string };
export type TeamPromptsRequest =
  | { operation: 'team.prompts.read' }
  | { operation: 'team.prompts.save'; expectedRevision: number; values: Record<string, string> }
  | { operation: 'team.prompts.preview'; values: Record<string, string>; group: TeamPromptGroup; variant: TeamPromptPreviewVariant };

export type TeamPromptsErrorCode = 'TEAM_PROMPTS_INVALID' | 'TEAM_PROMPTS_CONFLICT' | 'TEAM_PROMPTS_UNAVAILABLE' | 'TEAM_PROMPTS_OUTCOME_UNKNOWN';
export type TeamPromptsFailure = {
  success: false;
  error: string;
  code: TeamPromptsErrorCode;
  key?: string;
};

export const TEAM_PROMPTS_INVALID = {
  success: false,
  error: 'Team prompt settings request is invalid',
  code: 'TEAM_PROMPTS_INVALID',
} as const;
export const TEAM_PROMPTS_UNAVAILABLE = {
  success: false,
  error: 'Team prompt settings are unavailable',
  code: 'TEAM_PROMPTS_UNAVAILABLE',
} as const;
export const TEAM_PROMPTS_OUTCOME_UNKNOWN = {
  success: false,
  error: 'Team prompt settings save outcome is unknown. Read settings before saving again.',
  code: 'TEAM_PROMPTS_OUTCOME_UNKNOWN',
} as const;

const encoder = new TextEncoder();

export function isTeamPromptsRequest(value: unknown): value is TeamPromptsRequest {
  if (!record(value)) return false;
  if (value.operation === 'team.prompts.read') return exact(value, ['operation']);
  if (value.operation === 'team.prompts.save') {
    return exact(value, ['operation', 'expectedRevision', 'values'])
      && revision(value.expectedRevision) && values(value.values);
  }
  return value.operation === 'team.prompts.preview'
    && exact(value, ['operation', 'values', 'group', 'variant'])
    && values(value.values)
    && (value.group === 'discussion' || value.group === 'design' || value.group === 'execution'
      || value.group === 'repair' || value.group === 'introduction')
    && (value.variant === 'work' || value.variant === 'review' || value.variant === 'missing'
      || value.variant === 'declared' || value.variant === 'unreadable');
}

export function decodeTeamPromptSettings(value: unknown): TeamPromptSettings {
  if (!record(value) || !exact(value, ['revision', 'values']) || !revision(value.revision) || !values(value.values)) {
    throw new Error('Invalid Team prompt settings response');
  }
  return { revision: value.revision, values: value.values };
}

export function decodeTeamPromptCatalog(value: unknown): TeamPromptCatalog {
  if (!record(value) || !exact(value, ['revision', 'values', 'defaults'])
    || !revision(value.revision) || !values(value.values) || !values(value.defaults)) {
    throw new Error('Invalid Team prompt catalog response');
  }
  return { revision: value.revision, values: value.values, defaults: value.defaults };
}

export function decodeTeamPromptPreview(value: unknown): TeamPromptPreview {
  if (!record(value) || !exact(value, ['prompt']) || typeof value.prompt !== 'string') {
    throw new Error('Invalid Team prompt preview response');
  }
  return { prompt: value.prompt };
}

export function decodeTeamPromptsFailure(status: number, value: unknown): TeamPromptsFailure | null {
  if (!record(value) || value.success !== false || typeof value.error !== 'string'
    || value.error.length === 0 || value.error.length > 4096
    || !exact(value, ['success', 'error', 'code', ...(Object.hasOwn(value, 'key') ? ['key'] : [])])) return null;
  const code = value.code;
  if (!(status === 400 && code === 'TEAM_PROMPTS_INVALID'
    || status === 409 && code === 'TEAM_PROMPTS_CONFLICT'
    || status === 503 && (code === 'TEAM_PROMPTS_UNAVAILABLE' || code === 'TEAM_PROMPTS_OUTCOME_UNKNOWN'))) return null;
  if (Object.hasOwn(value, 'key')
    && (code !== 'TEAM_PROMPTS_INVALID' || typeof value.key !== 'string'
      || value.key.length === 0 || value.key.length > 256 || value.key.includes('\0'))) return null;
  return {
    success: false, error: value.error, code,
    ...(Object.hasOwn(value, 'key') ? { key: value.key as string } : {}),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function values(value: unknown): value is Record<string, string> {
  if (!record(value) || !exact(value, TEAM_PROMPT_KEYS)) return false;
  let total = 0;
  for (const key of TEAM_PROMPT_KEYS) {
    const text = value[key];
    if (typeof text !== 'string' || text.length > 65536) return false;
    const bytes = encoder.encode(text).length;
    if (bytes > 65536) return false;
    total += bytes;
    if (total > 524288) return false;
  }
  return true;
}
