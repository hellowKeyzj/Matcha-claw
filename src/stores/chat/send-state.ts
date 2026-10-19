import { buildSessionIdentityKey } from '../../types/desktop/runtime-address';
import type { ChatSessionRecord, ChatSessionSendAdmission, ChatSessionSendState } from './types';

export function currentSessionSend(record: ChatSessionRecord): ChatSessionSendState | null {
  return record.send && record.meta.sessionIdentity
    && record.send.identityKey === buildSessionIdentityKey(record.meta.sessionIdentity) ? record.send : null;
}

export function isSendPending(send: ChatSessionSendState | null): boolean {
  return send !== null && send.receipt.phase !== 'failed';
}

export function recordSendTerminals(
  send: ChatSessionSendState | null,
  runIds: readonly string[],
): ChatSessionSendState | null {
  if (!send || send.receipt.phase === 'failed' || runIds.length === 0) return send;
  const receipt = send.receipt;
  if (receipt.phase === 'accepted') return runIds.includes(receipt.runId) ? null : send;
  if (receipt.phase === 'unknown' && receipt.runId !== null) return runIds.includes(receipt.runId) ? null : send;
  const terminalRunIds = [...receipt.terminalRunIds];
  let terminalOverflow = receipt.terminalOverflow;
  for (const runId of runIds) {
    if (terminalRunIds.includes(runId)) continue;
    // ponytail: retain at most 32 exact pre-ACK terminals for this operation; overflow stays unknown.
    if (terminalRunIds.length === 32) terminalOverflow = true;
    else terminalRunIds.push(runId);
  }
  return terminalRunIds.length === receipt.terminalRunIds.length && terminalOverflow === receipt.terminalOverflow
    ? send : { ...send, receipt: { ...receipt, terminalRunIds, terminalOverflow } };
}

export function linkSessionSend(
  send: ChatSessionSendState,
  runId: string,
  admission: ChatSessionSendAdmission,
): ChatSessionSendState | null {
  const receipt = send.receipt;
  if (receipt.phase === 'failed') return send;
  if (receipt.phase !== 'accepted') {
    if (receipt.terminalRunIds.includes(runId)) return null;
    if (receipt.terminalOverflow) return {
      ...send,
      receipt: { phase: 'unknown', runId, error: 'Send terminal association is unknown',
        terminalRunIds: receipt.terminalRunIds, terminalOverflow: true },
    };
  }
  return { ...send, receipt: { phase: 'accepted', admission, runId } };
}

export function markSessionSendUnknown(send: ChatSessionSendState, error: string): ChatSessionSendState {
  const receipt = send.receipt;
  if (receipt.phase === 'failed') return send;
  return {
    ...send,
    receipt: {
      phase: 'unknown', error,
      runId: receipt.phase === 'accepted' || receipt.phase === 'unknown' ? receipt.runId : null,
      terminalRunIds: receipt.phase === 'accepted' ? [] : receipt.terminalRunIds,
      terminalOverflow: receipt.phase === 'accepted' ? false : receipt.terminalOverflow,
    },
  };
}
