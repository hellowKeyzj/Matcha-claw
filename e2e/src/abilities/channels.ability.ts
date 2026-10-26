import { Ability } from '@serenity-js/core';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron, type PublicHostApiReply } from './use-electron.ability.js';

const canary = 'e2e-channels-public-canary-v1';
const publicError = 'Channel status reported an error';
const forbidden = /configPath|openclaw\.json|native connection details|e2e-channels-public-canary-v1/i;
type Runtime = 'openclaw' | 'matcha-agent';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function text(value: unknown, max = 4_096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function booleans(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(key => !Object.hasOwn(value, key) || typeof value[key] === 'boolean');
}

function errors(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(key => !Object.hasOwn(value, key) || value[key] === publicError);
}

function account(value: unknown): value is Record<string, unknown> {
  return record(value) && keys(value, ['accountId'], [
    'configured', 'connected', 'running', 'linked', 'lastError', 'name',
    'lastConnectedAt', 'lastInboundAt', 'lastOutboundAt', 'lastProbeAt', 'probe',
  ]) && text(value.accountId, 128)
    && booleans(value, ['configured', 'connected', 'running', 'linked'])
    && errors(value, ['lastError'])
    && (!Object.hasOwn(value, 'name') || text(value.name))
    && ['lastConnectedAt', 'lastInboundAt', 'lastOutboundAt', 'lastProbeAt'].every(key =>
      !Object.hasOwn(value, key) || value[key] === null || integer(value[key]))
    && (!Object.hasOwn(value, 'probe') || (record(value.probe) && keys(value.probe, ['ok']) && typeof value.probe.ok === 'boolean'));
}

function statusIsPublic(value: unknown): boolean {
  return record(value) && keys(value, ['accounts']) && Array.isArray(value.accounts)
    && value.accounts.every(entry => record(entry) && keys(entry, ['channel', 'accountId', 'connection'])
      && text(entry.channel, 128) && text(entry.accountId, 128)
      && (entry.connection === 'connected' || entry.connection === 'disconnected' || entry.connection === 'unknown'));
}

function snapshotIsPublic(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !keys(value, ['ts', 'channelOrder', 'channels', 'channelAccounts', 'channelDefaultAccountId'], ['ready', 'refreshing', 'error'])
    || !integer(value.ts) || !booleans(value, ['ready', 'refreshing']) || !errors(value, ['error'])
    || !Array.isArray(value.channelOrder) || !value.channelOrder.every(id => text(id, 128))
    || new Set(value.channelOrder).size !== value.channelOrder.length
    || !record(value.channels) || !record(value.channelAccounts) || !record(value.channelDefaultAccountId)) return false;
  const { channelOrder, channels, channelAccounts, channelDefaultAccountId } = value;
  return keys(channels, channelOrder) && keys(channelAccounts, channelOrder) && keys(channelDefaultAccountId, [], channelOrder)
    && channelOrder.every(id => {
      const summary = channels[id];
      const accounts = channelAccounts[id];
      return record(summary) && keys(summary, [], ['configured', 'running', 'error', 'lastError'])
        && booleans(summary, ['configured', 'running']) && errors(summary, ['error', 'lastError'])
        && Array.isArray(accounts) && accounts.every(account)
        && new Set(accounts.map(entry => entry.accountId)).size === accounts.length
        && (!Object.hasOwn(channelDefaultAccountId, id)
          || (text(channelDefaultAccountId[id], 128) && accounts.some(entry => entry.accountId === channelDefaultAccountId[id])));
    });
}

function snapshotEnvelopeIsPublic(value: unknown): value is Record<string, unknown> {
  return record(value) && keys(value, ['success', 'snapshot', 'ready', 'refreshing', 'updatedAt', 'error'])
    && value.success === true && snapshotIsPublic(value.snapshot)
    && value.ready === (value.snapshot.ready ?? true) && value.refreshing === (value.snapshot.refreshing ?? false)
    && value.updatedAt === value.snapshot.ts && value.error === (value.snapshot.error ?? null);
}

function receipt(reply: PublicHostApiReply, contractValid: boolean) {
  return { transportOk: reply.ok, status: reply.ok ? reply.data.status : null, httpOk: reply.ok && reply.data.ok, contractValid };
}

function rejection(reply: PublicHostApiReply, message: string) {
  const body = reply.ok ? reply.data.json : undefined;
  return {
    ...receipt(reply, record(body) && keys(body, ['success', 'error']) && body.success === false && body.error === message),
    redacted: reply.ok && !forbidden.test(JSON.stringify({ json: reply.data.json, text: reply.data.text })),
  };
}

export class Channels extends Ability {
  constructor(private readonly electron: UseElectron) { super(); }

  async readPublicState(runtime: Runtime) {
    const scope = { kind: 'runtime-instance', endpoint: { kind: 'native-runtime', runtimeAdapterId: runtime, runtimeInstanceId: 'local' } };
    const status = await this.electron.fetchHostApi({ path: '/api/channels/status', method: 'POST', body: { scope } });
    const path = `/api/channels/snapshot?scope=${encodeURIComponent(JSON.stringify(scope))}`;
    const deadline = Date.now() + 45_000;
    let snapshot = await this.electron.fetchHostApi({ path, method: 'GET' });
    while (snapshot.ok && snapshot.data.status === 200 && snapshot.data.ok
      && snapshotEnvelopeIsPublic(snapshot.data.json) && snapshot.data.json.ready === false && Date.now() < deadline) {
      await delay(500);
      snapshot = await this.electron.fetchHostApi({ path, method: 'GET' });
    }
    const body = snapshot.ok ? snapshot.data.json : undefined;
    const valid = snapshotEnvelopeIsPublic(body);
    if (valid && body.error !== null) throw new Error('Channels public snapshot reported an error; it is not an empty configured catalog');
    let configuredCount = 0;
    if (valid && record(body) && record(body.snapshot)) {
      const summaries = body.snapshot.channels as Record<string, Record<string, unknown>>;
      const accounts = body.snapshot.channelAccounts as Record<string, unknown[]>;
      for (const id of body.snapshot.channelOrder as string[]) {
        if (summaries[id]?.configured === true) configuredCount += runtime === 'matcha-agent' ? accounts[id]!.length : 1;
      }
    }
    return {
      status: receipt(status, status.ok && statusIsPublic(status.data.json)),
      snapshot: { ...receipt(snapshot, valid), ready: valid && record(body) && body.ready === true },
      configuredCount,
      redacted: [status, snapshot].every(reply => reply.ok
        && !forbidden.test(JSON.stringify({ json: reply.data.json, text: reply.data.text }))),
    };
  }

  async readRejections() {
    const invalidStatus = await this.electron.fetchHostApi({
      path: '/api/channels/status', method: 'POST',
      body: { configPath: `${canary}/openclaw.json`, native: `native connection details ${canary}` },
    });
    const invalidScope = { kind: 'runtime-instance', endpoint: { kind: 'native-runtime', runtimeAdapterId: canary, runtimeInstanceId: 'local' } };
    const invalidSnapshot = await this.electron.fetchHostApi({
      path: `/api/channels/snapshot?scope=${encodeURIComponent(JSON.stringify(invalidScope))}`, method: 'GET',
    });
    const invalidControl = await this.electron.fetchHostApi({
      path: '/api/channels/control', method: 'POST',
      body: { action: 'disconnect', channel: canary, accountId: ` ${canary}` },
    });
    return {
      invalidStatus: rejection(invalidStatus, 'Channel status request is invalid'),
      invalidSnapshot: rejection(invalidSnapshot, 'Channel status is unavailable'),
      invalidControl: rejection(invalidControl, 'Channel control request is invalid'),
    };
  }
}
