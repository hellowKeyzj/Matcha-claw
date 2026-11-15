import {
  isTeamPromptsRequest,
  TEAM_PROMPTS_ENDPOINT,
  TEAM_PROMPTS_INVALID,
  TEAM_PROMPTS_MAX_REQUEST_BYTES,
  TEAM_PROMPTS_OUTCOME_UNKNOWN,
  TEAM_PROMPTS_UNAVAILABLE,
} from '../../../src/types/team-prompts';
import type { TeamPromptsTransport } from '../../main/runtime-host-delivery/transport/teams/prompts';
import { jsonResult, parseJsonBytes, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleTeamPromptsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: TeamPromptsTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== TEAM_PROMPTS_ENDPOINT || req.method !== 'POST') return undefined;
  if (url.search) return jsonResult(400, TEAM_PROMPTS_INVALID);
  if (req.signal.aborted) return null;
  let request: unknown;
  try {
    request = parseJsonBytes<unknown>(await req.readBytes(TEAM_PROMPTS_MAX_REQUEST_BYTES, true));
  } catch {
    return req.signal.aborted ? null : jsonResult(400, TEAM_PROMPTS_INVALID);
  }
  if (req.signal.aborted) return null;
  if (!isTeamPromptsRequest(request)) return jsonResult(400, TEAM_PROMPTS_INVALID);
  try {
    const response = await transport.execute(request, req.signal);
    return req.signal.aborted ? null : jsonResult(response.status, response.body);
  } catch {
    return req.signal.aborted ? null : jsonResult(503,
      request.operation === 'team.prompts.save' ? TEAM_PROMPTS_OUTCOME_UNKNOWN : TEAM_PROMPTS_UNAVAILABLE);
  }
}
