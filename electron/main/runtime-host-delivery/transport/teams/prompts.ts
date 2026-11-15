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
  type TeamPromptPreview,
  type TeamPromptSettings,
  type TeamPromptsFailure,
  type TeamPromptsRequest,
} from '../../../../../src/types/team-prompts';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { sendLoopbackJsonDelivery } from '../client';

export type TeamPromptsTransportResponse = Readonly<{
  status: 200 | 400 | 409 | 503;
  body: TeamPromptCatalog | TeamPromptSettings | TeamPromptPreview | TeamPromptsFailure;
}>;
export type TeamPromptsTransport = ReturnType<typeof createTeamPromptsTransport>;

export function createTeamPromptsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
) {
  return {
    execute: async (request: TeamPromptsRequest, signal?: AbortSignal): Promise<TeamPromptsTransportResponse> => {
      if (!isTeamPromptsRequest(request)) return { status: 400, body: TEAM_PROMPTS_INVALID };
      const unavailable = request.operation === 'team.prompts.save' ? TEAM_PROMPTS_OUTCOME_UNKNOWN : TEAM_PROMPTS_UNAVAILABLE;
      const delivery = await sendLoopbackJsonDelivery({
        port: runtimeHostTransportPort,
        path: TEAM_PROMPTS_ENDPOINT,
        issuer,
        decision: {
          endpoint: TEAM_PROMPTS_ENDPOINT,
          scope: request.operation === 'team.prompts.read' ? 'team:read' : 'team:write',
          capability: request.operation,
          subject: 'team-prompts',
        },
        method: 'POST',
        fetcher,
        body: request,
        signal,
        timeoutMs: 30_000,
      });
      if (delivery.outcome !== 'response') {
        return { status: 503, body: delivery.outcome === 'unknown' ? unavailable : TEAM_PROMPTS_UNAVAILABLE };
      }
      const { status, body } = delivery.response;
      if (status === 200) {
        try {
          const result = request.operation === 'team.prompts.read' ? decodeTeamPromptCatalog(body)
            : request.operation === 'team.prompts.save' ? decodeTeamPromptSettings(body) : decodeTeamPromptPreview(body);
          return { status: 200, body: result };
        } catch {
          return { status: 503, body: unavailable };
        }
      }
      if (status === 400 || status === 409 || status === 503) {
        const failure = decodeTeamPromptsFailure(status, body);
        if (failure) return { status, body: failure };
      }
      return { status: 503, body: unavailable };
    },
  };
}
