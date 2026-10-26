import { randomUUID } from 'node:crypto';
import type { FailureStage } from '../../../src/types/world';
import type { InitialWorldIssue } from '../../../src/types/world-initial';
import { logger } from '../../utils/logger';
import { RuntimeHostControlError, type RuntimeHostControlCommand, type RuntimeHostControlOutcome } from '../runtime-host-delivery/control';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { parseWorldControlFailure } from './control-failure';
import type { WorldStorageControl } from './storage-transfer';

type MainReason = Extract<InitialWorldIssue, { source: 'main' }>['reason'];

export class InitialWorldImportError extends Error {
  constructor(readonly issue: InitialWorldIssue) { super(issue.code); }
}
export function initialWorldIssue(reason: MainReason, stage: FailureStage): InitialWorldIssue {
  return { source: 'main', reason, code: `world.initial.${reason.replaceAll('-', '_')}`, stage,
    diagnosticId: randomUUID(), recovery: { kind: 'none' }, details: { kind: 'internal_fault' } };
}

/** Keep the original safe failure, not a control rejection's private message or an exception cause. */
export async function initialControlData(
  host: WorldStorageControl, command: RuntimeHostControlCommand, timeoutMs?: number,
): Promise<unknown> {
  let outcome: RuntimeHostControlOutcome;
  try { outcome = await host.command(command, timeoutMs === undefined ? undefined : { timeoutMs }); }
  catch (error) {
    if (error instanceof RuntimeHostControlError) {
      throw new InitialWorldImportError({ source: 'control', reason: error.delivery,
        code: `world.initial.control.${error.kind}`, stage: 'execute', diagnosticId: randomUUID(),
        recovery: { kind: 'none' }, details: { kind: 'transport', failure: error.kind === 'frame-too-large' ? 'size_limit'
          : error.kind === 'command-invalid' || error.kind === 'protocol-invalid' ? 'contract_data' : 'disconnected' } });
    }
    throw controlError('host-unavailable', 'UNAVAILABLE');
  }
  if (outcome.kind === 'rejected') throw controlError('control-rejected', outcome.error.code);
  if (outcome.kind === 'timed-out') throw controlError('timed-out', 'TIMEOUT');
  const body = outcome.result;
  if (isRecord(body) && hasExactKeys(body, ['success', 'data']) && body.success === true && outcome.kind === 'succeeded') return body.data;
  if (isRecord(body) && hasExactKeys(body, ['success', 'error']) && body.success === false) {
    const safe = parseWorldControlFailure(body.error);
    if (safe) {
      logger.warn('[World] Initial request failed', {
        ...(/^world\.[a-z_]{1,96}$/.test(safe.code) ? { code: safe.code } : {}),
        stage: safe.stage, diagnosticId: safe.diagnosticId, recoveryKind: safe.recovery.kind,
      });
      throw new InitialWorldImportError({ source: 'world', reason: outcome.kind === 'unknown' ? 'outcome-unknown' : 'world-rejected', ...safe });
    }
  }
  throw controlError(outcome.kind === 'unknown' ? 'outcome-unknown' : 'protocol-invalid', 'CONTRACT_DATA');
}
function controlError(reason: 'host-unavailable' | 'control-rejected' | 'timed-out' | 'outcome-unknown' | 'protocol-invalid', code: string): InitialWorldImportError {
  return new InitialWorldImportError({ source: 'control', reason, code: `world.initial.control.${code}`, stage: 'execute',
    diagnosticId: randomUUID(), recovery: { kind: 'none' }, details: { kind: 'transport', failure: code === 'INVALID_INPUT' || code === 'CONTRACT_DATA' ? 'contract_data' : 'disconnected' } });
}
