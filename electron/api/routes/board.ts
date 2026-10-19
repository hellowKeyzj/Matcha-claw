import type { IncomingMessage, ServerResponse } from 'node:http';
import { BOARD_EXECUTE_PATH, decodeBoardExecuteRequest } from '../../../src/types/board';
import { boardFailureResponse, type BoardTransport } from '../../main/runtime-host-delivery/transport/board';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleBoardRoutes(
  req: IncomingMessage, res: ServerResponse, url: URL, transport: BoardTransport,
): Promise<boolean> {
  if (url.pathname !== BOARD_EXECUTE_PATH || req.method !== 'POST') return false;
  let request;
  try {
    if (url.search) throw new Error('Board query is invalid');
    request = decodeBoardExecuteRequest(await parseJsonBody(req));
  } catch {
    sendJson(res, 400, boardFailureResponse('invalid'));
    return true;
  }
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  try {
    const response = await transport.execute(request, controller.signal);
    if (!controller.signal.aborted) sendJson(res, response.status, response.body);
  } catch {
    if (!controller.signal.aborted) sendJson(res, 503, boardFailureResponse(
      request.operation.method === 'board.get' || request.operation.method === 'board.data.read' ? 'unavailable' : 'unknown',
    ));
  } finally { res.off('close', onClose); }
  return true;
}
