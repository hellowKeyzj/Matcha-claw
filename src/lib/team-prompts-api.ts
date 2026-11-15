import { hostApiFetchWithFailure } from '@/lib/host-api';
import {
  decodeTeamPromptCatalog,
  decodeTeamPromptPreview,
  decodeTeamPromptSettings,
  decodeTeamPromptsFailure,
  isTeamPromptsRequest,
  TEAM_PROMPTS_ENDPOINT,
  TEAM_PROMPTS_INVALID,
  TEAM_PROMPTS_OUTCOME_UNKNOWN,
  TEAM_PROMPTS_UNAVAILABLE,
  type TeamPromptCatalog,
  type TeamPromptGroup,
  type TeamPromptPreview,
  type TeamPromptPreviewVariant,
  type TeamPromptSettings,
  type TeamPromptsFailure,
  type TeamPromptsRequest,
} from '@/types/team-prompts';

export const teamPromptsApi = {
  read: (): Promise<TeamPromptCatalog> => request({ operation: 'team.prompts.read' }, decodeTeamPromptCatalog),
  save: (expectedRevision: number, values: Record<string, string>): Promise<TeamPromptSettings> => request(
    { operation: 'team.prompts.save', expectedRevision, values }, decodeTeamPromptSettings,
  ),
  preview: (values: Record<string, string>, group: TeamPromptGroup, variant: TeamPromptPreviewVariant, signal?: AbortSignal): Promise<TeamPromptPreview> => request(
    { operation: 'team.prompts.preview', values, group, variant }, decodeTeamPromptPreview, signal,
  ),
};

async function request<T>(body: TeamPromptsRequest, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  if (!isTeamPromptsRequest(body)) throw failureError(TEAM_PROMPTS_INVALID);
  let failure: TeamPromptsFailure | null = null;
  let payload: unknown;
  try {
    payload = await hostApiFetchWithFailure<unknown>(TEAM_PROMPTS_ENDPOINT, {
      method: 'POST', body: JSON.stringify(body), signal,
    }, (status, value) => {
      failure = decodeTeamPromptsFailure(status, value);
      return failure;
    });
  } catch (cause) {
    if (body.operation === 'team.prompts.save') {
      throw Object.assign(failureError(TEAM_PROMPTS_OUTCOME_UNKNOWN), { cause });
    }
    throw cause;
  }
  if (failure) throw failureError(failure);
  try {
    return decode(payload);
  } catch {
    throw failureError(body.operation === 'team.prompts.save' ? TEAM_PROMPTS_OUTCOME_UNKNOWN : TEAM_PROMPTS_UNAVAILABLE);
  }
}

function failureError(failure: TeamPromptsFailure): Error & { code: string; key?: string } {
  return Object.assign(new Error(failure.error), {
    code: failure.code, ...(failure.key === undefined ? {} : { key: failure.key }),
  });
}
