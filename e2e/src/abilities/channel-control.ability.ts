import { Ability } from '@serenity-js/core';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron, type PublicHostApiReply } from './use-electron.ability.js';

const channel = 'feishu';
const accountId = 'e2e-sandbox-account';
const scope = {
  kind: 'runtime-instance',
  endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
} as const;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Channel control returned an invalid public object');
  }
  return value as Record<string, unknown>;
}

function assertPublicRedaction(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertPublicRedaction);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/configPath|sourcePath|sourceDir|workspaceDir|token|secret|credential|password|authorization|qr/i.test(key)) {
        throw new Error('Channel control public response exposes a private field');
      }
      assertPublicRedaction(child);
    }
  } else if (typeof value === 'string' && /openclaw\.json|data:image\/|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) {
    throw new Error('Channel control public response exposes private material');
  }
}

function bodyOf(reply: PublicHostApiReply, status: number): Record<string, unknown> {
  assertPublicRedaction(reply);
  if (!reply.ok || reply.data.status !== status || reply.data.ok !== (status < 400)) {
    throw new Error(`Channel control public request expected HTTP ${status}; received ${reply.ok ? reply.data.status : 'IPC failure'}`);
  }
  return record(reply.data.json);
}

export class ChannelControl extends Ability {
  private state: 'unprepared' | 'prepared' | 'connected' | 'restored' | 'outcome_unknown' = 'unprepared';

  constructor(private readonly electron: UseElectron) { super(); }

  async requirePreparedSandbox(): Promise<void> {
    if (this.state !== 'unprepared' && this.state !== 'restored') {
      throw new Error('The previous sandbox control has not been restored; do not start another control sequence');
    }
    const accounts = await this.accounts();
    const sandbox = accounts.filter(account => account.channel === channel);
    if (sandbox.length !== 1 || sandbox[0].accountId !== accountId || sandbox[0].connection !== 'disconnected') {
      throw new Error('Sandbox prerequisite: dedicated licensed E2E profile must contain only feishu/e2e-sandbox-account for Feishu, initially disconnected; never substitute a daily account or provision credentials in this test');
    }
    const body = bodyOf(await this.electron.fetchHostApi({
      path: `/api/channels/snapshot?scope=${encodeURIComponent(JSON.stringify(scope))}`, method: 'GET',
    }), 200);
    const snapshot = record(body.snapshot);
    const summary = record(record(snapshot.channels)[channel]);
    const projected = record(snapshot.channelAccounts)[channel];
    if (body.success !== true || body.ready !== true || summary.configured !== true || !Array.isArray(projected)
      || projected.length !== 1 || record(projected[0]).accountId !== accountId) {
      throw new Error('Sandbox prerequisite: ready public snapshot must project the configured feishu/e2e-sandbox-account as the sole Feishu account; no fixture is fabricated');
    }
    this.state = 'prepared';
  }

  async connect(): Promise<void> {
    if (this.state !== 'prepared') throw new Error('Sandbox connect requires its verified disconnected baseline and must not be retried');
    this.state = 'outcome_unknown';
    const body = bodyOf(await this.electron.fetchHostApi({
      path: '/api/channels/control', method: 'POST', body: { scope, action: 'connect', channel, accountId },
    }), 200);
    if (body.outcome === 'target_rejected') {
      this.state = 'prepared';
      throw new Error('Sandbox connect was explicitly rejected; no retry or reset was issued');
    }
    if (Object.keys(body).length !== 1 || body.outcome !== 'confirmed') {
      throw new Error('Sandbox connect outcome_unknown; no automatic resend or reset is allowed; inspect the dedicated sandbox manually');
    }
    this.state = 'connected';
    await this.waitForConnection('connected');
  }

  async restoreDisconnectedBaseline() {
    if (this.state !== 'connected') return undefined;
    // Only our confirmed connect is compensated, once. Admission/ambiguity never authorises another mutation.
    this.state = 'outcome_unknown';
    const receipt = bodyOf(await this.electron.fetchHostApi({
      path: '/api/channels/control', method: 'POST', body: { scope, action: 'disconnect', channel, accountId },
    }), 202);
    if (Object.keys(receipt).sort().join(',') !== 'accepted,callId' || receipt.accepted !== true
      || typeof receipt.callId !== 'string' || !/^[a-f0-9]{32}$/.test(receipt.callId)) {
      throw new Error('Sandbox disconnect outcome_unknown: invalid admission receipt; no automatic resend or reset is allowed');
    }
    const settlement = await this.waitForDisconnect(receipt.callId);
    this.state = 'restored';
    await this.waitForConnection('disconnected');
    return settlement;
  }

  private async accounts(): Promise<Record<string, unknown>[]> {
    const body = bodyOf(await this.electron.fetchHostApi({
      path: '/api/channels/status', method: 'POST', body: { scope }, timeoutMs: 5_000,
    }), 200);
    if (!Array.isArray(body.accounts)) throw new Error('Public channel status has no account projection');
    return body.accounts.map(record);
  }

  private async waitForConnection(connection: 'connected' | 'disconnected'): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const accounts = (await this.accounts()).filter(account => account.channel === channel);
      if (accounts.length !== 1 || accounts[0].accountId !== accountId) {
        throw new Error('Sandbox account projection changed; no substitute account is permitted');
      }
      if (accounts[0].connection === connection) return;
      await delay(250);
    }
    throw new Error(`Sandbox public status did not confirm ${connection}; no control request was retried`);
  }

  private async waitForDisconnect(callId: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const call = bodyOf(await this.electron.fetchHostApi({
        path: '/api/calls/get', method: 'POST', body: { callId }, timeoutMs: 5_000,
      }), 200);
      const detail = record(call.detail);
      if (Object.keys(call).sort().join(',') !== 'callId,command,detail,end,module,revision,start,status'
        || call.callId !== callId || call.module !== 'channels' || call.command !== 'disconnect'
        || detail.operation !== 'disconnect' || detail.channel !== channel || detail.accountId !== accountId
        || Object.keys(detail).sort().join(',') !== 'accountId,channel,configFinalization,operation,outcome,phase,reply'
        || detail.reply !== null || detail.configFinalization !== null) {
        throw new Error('Sandbox disconnect settlement does not match the admitted command and account; no automatic reset is allowed');
      }
      if (call.status === 'succeeded' && typeof call.end === 'number' && detail.phase === 'complete' && detail.outcome === 'confirmed') {
        return { admitted: true, status: 'succeeded', operation: 'disconnect', phase: 'complete', outcome: 'confirmed', sameAccount: true, redacted: true };
      }
      if (!['received', 'accepted', 'running', 'waiting'].includes(String(call.status))) {
        throw new Error('Sandbox disconnect was not succeeded/confirmed (rejected, failed, or outcome_unknown); no automatic resend or reset is allowed');
      }
      await delay(250);
    }
    throw new Error('Sandbox disconnect settlement outcome_unknown after timeout; no automatic resend or reset is allowed; inspect the dedicated sandbox manually');
  }
}
