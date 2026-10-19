import { hostApiFetchWithFailure } from './host-api';
import {
  BOARD_EXECUTE_PATH,
  decodeBoardExecuteRequest,
  decodeBoardFailure,
  decodeBoardResult,
  type BoardFailure,
  type BoardIdentity,
  type BoardMethod,
  type BoardOperation,
  type BoardResult,
  type BoardSnapshot,
} from '@/types/board';

export async function boardExecute<M extends BoardMethod>(
  identity: BoardIdentity,
  operation: Extract<BoardOperation, { method: M }>,
): Promise<BoardResult<M>> {
  let body: string;
  try {
    body = JSON.stringify(decodeBoardExecuteRequest({ identity, operation }));
  } catch {
    throw Object.assign(new Error('Board request is invalid'), { code: 'invalid' });
  }

  const isRead = operation.method === 'board.get' || operation.method === 'board.widget.appView' || operation.method === 'board.data.read';
  const failure: { value: BoardFailure | null } = { value: null };
  let value: unknown;
  try {
    value = await hostApiFetchWithFailure<unknown>(BOARD_EXECUTE_PATH, { method: 'POST', body }, (_status, payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 1 || !('error' in payload)) {
        throw new Error('Board failure response is invalid');
      }
      failure.value = decodeBoardFailure(payload.error);
      // Throw after hostApiFetch so its generic error normalization cannot erase the native code.
      return undefined;
    });
  } catch {
    throw Object.assign(new Error(isRead
      ? 'Board is unavailable; refresh to try reading it again'
      : 'Board operation outcome is unknown; refresh to confirm before trying again'), {
      code: isRead ? 'unavailable' : 'unknown',
    });
  }
  if (failure.value) throw Object.assign(new Error(failure.value.message), failure.value);

  try {
    const result = decodeBoardResult(operation.method as M, value);
    if ((operation.method === 'board.get' || operation.method === 'board.update'
      || operation.method === 'board.widget.put' || operation.method === 'board.widget.grant')
      && (result as BoardSnapshot).sessionKey !== identity.sessionKey) {
      throw new Error('Board response identity is invalid');
    }
    return result;
  } catch {
    throw Object.assign(new Error(isRead
      ? 'Board response is invalid; refresh to read it again'
      : 'Board operation outcome is unknown; refresh to confirm before trying again'), {
      code: isRead ? 'unavailable' : 'unknown',
    });
  }
}
