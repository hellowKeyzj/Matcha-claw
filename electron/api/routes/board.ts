import { BOARD_EXECUTE_PATH, decodeBoardExecuteRequest } from '../../../src/types/board';
import { boardFailureResponse, type BoardTransport } from '../../main/runtime-host-delivery/transport/board';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleBoardRoutes(
  req: HostApiRequest, url: URL, transport: BoardTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== BOARD_EXECUTE_PATH || req.method !== 'POST') return undefined;
  let request;
  try {
    if (url.search) throw new Error('Board query is invalid');
    request = decodeBoardExecuteRequest(await req.readJson());
  } catch {
    return req.signal.aborted ? null : jsonResult(400, boardFailureResponse('invalid'));
  }
  try {
    const response = await transport.execute(request, req.signal);
    return req.signal.aborted ? null : jsonResult(response.status, response.body);
  } catch {
    return req.signal.aborted ? null : jsonResult(503, boardFailureResponse(
      request.operation.method === 'board.get' || request.operation.method === 'board.data.read' ? 'unavailable' : 'unknown',
    ));
  }
}
