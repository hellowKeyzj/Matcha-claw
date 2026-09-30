export type ChannelsCallOperation =
  | 'catalog' | 'configureForm' | 'configRead' | 'pairingList' | 'status' | 'snapshot'
  | 'configure' | 'deleteConfig' | 'connect' | 'disconnect'
  | 'loginStart' | 'loginWait' | 'loginCancel' | 'logout' | 'pairingApprove' | 'validateCredentials';

export type ChannelsCallOutcome =
  | 'confirmed' | 'connected' | 'qr' | 'pending' | 'rejected' | 'unsupported'
  | 'cancelled' | 'valid' | 'invalid' | 'unknown';

export interface ChannelsCallDetail {
  operation: ChannelsCallOperation;
  channel: string | null;
  accountId: string | null;
  phase: 'admission' | 'execution' | 'reply' | 'configFinalization' | 'complete';
  outcome: ChannelsCallOutcome | null;
  reply: ChannelsCallOutcome | null;
  configFinalization: 'confirmed' | 'rejected' | 'unknown' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    channels: ChannelsCallDetail;
  }
}

const operations = new Set<ChannelsCallOperation>([
  'catalog', 'configureForm', 'configRead', 'pairingList', 'status', 'snapshot',
  'configure', 'deleteConfig', 'connect', 'disconnect', 'loginStart', 'loginWait',
  'loginCancel', 'logout', 'pairingApprove', 'validateCredentials',
]);
const outcomes = new Set<ChannelsCallOutcome>([
  'confirmed', 'connected', 'qr', 'pending', 'rejected', 'unsupported', 'cancelled', 'valid', 'invalid', 'unknown',
]);
const phases = new Set<ChannelsCallDetail['phase']>(['admission', 'execution', 'reply', 'configFinalization', 'complete']);

export function decodeChannelsCallDetail(value: unknown): ChannelsCallDetail {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid channels call detail');
  const detail = value as Record<string, unknown>;
  if (Object.keys(detail).length !== 7
    || !operations.has(detail.operation as ChannelsCallOperation)
    || !isReference(detail.channel) || !isReference(detail.accountId)
    || !phases.has(detail.phase as ChannelsCallDetail['phase'])
    || !isOutcome(detail.outcome) || !isOutcome(detail.reply)
    || (detail.configFinalization !== null && detail.configFinalization !== 'confirmed'
      && detail.configFinalization !== 'rejected' && detail.configFinalization !== 'unknown')) {
    throw new Error('Invalid channels call detail');
  }
  return detail as unknown as ChannelsCallDetail;
}

function isReference(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\p{Cc}]/u.test(value));
}

function isOutcome(value: unknown): boolean {
  return value === null || outcomes.has(value as ChannelsCallOutcome);
}
