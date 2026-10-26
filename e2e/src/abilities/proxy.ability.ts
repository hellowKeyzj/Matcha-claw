import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { licensedProfileRoot, profileMode } from '../config/electron.js';
import { UseElectron, type PublicHostApiReply } from './use-electron.ability.js';

type Settings = {
  browserMode: 'native' | 'relay' | 'off';
  launchAtStartup: boolean;
  gatewayAutoStart: boolean;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
};
type Purpose = 'enabled' | 'disabled' | 'restore';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Proxy public response is not an object');
  return value as Record<string, unknown>;
}

function body(reply: PublicHostApiReply): Record<string, unknown> {
  if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) throw new Error('Proxy public settings/call read is unavailable');
  return record(reply.data.json);
}

export class UseProxy extends Ability {
  private server?: Server;
  private original?: Settings;
  private current?: Settings;
  private expected?: Settings;
  private target = '';
  private bypassRules = '';
  private phase: 'unprepared' | 'prepared' | 'unknown' | 'confirmed' | 'restored' = 'unprepared';
  private purpose?: Purpose;
  private callIds = new Set<string>();
  private observedCallId?: string;

  constructor(private readonly electron: UseElectron) { super(); }

  async prepare() {
    if (profileMode !== 'licensed' || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) {
      throw new Error('Proxy changes require the fixture-owned dedicated licensed E2E profile');
    }
    if (this.phase !== 'unprepared') throw new Error('Proxy resources were already prepared for this case');
    const original = await this.readSettings();
    if (original.proxyServer !== original.proxyServer.trim() || original.proxyBypassRules !== original.proxyBypassRules.trim()) {
      throw new Error('The proxy baseline cannot round-trip exactly through the current UI');
    }
    this.original = original;
    this.current = structuredClone(original);
    const server = createServer(socket => socket.destroy());
    this.server = server;
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy E2E could not reserve its own loopback endpoint');
    // An owned destination only: no proxy protocol, forwarding, or synthetic business response.
    this.target = `http://127.0.0.1:${address.port}`;
    this.bypassRules = [original.proxyBypassRules, `e2e-proxy-${randomUUID()}.invalid`].filter(Boolean).join(';');
    this.phase = 'prepared';
    return { server: this.target, bypassRules: this.bypassRules, baseline: structuredClone(original) };
  }

  async beginSave(purpose: Purpose): Promise<void> {
    if (!this.original || !this.current || !['prepared', 'confirmed'].includes(this.phase)) {
      throw new Error('Proxy save requires a known baseline; unresolved writes must not be retried');
    }
    await this.requireSettings(this.current);
    this.expected = purpose === 'restore' ? structuredClone(this.original) : {
      ...this.original, proxyEnabled: purpose === 'enabled', proxyServer: this.target, proxyBypassRules: this.bypassRules,
    };
    if (isDeepStrictEqual(this.expected, this.current)) throw new Error('Proxy save must represent an actual UI change');
    this.callIds = new Set(await this.listCalls());
    this.observedCallId = undefined;
    this.purpose = purpose;
    // Arm before the only UI click; admission or timeout never permits a resend/rollback.
    this.phase = 'unknown';
  }

  async confirmSave() {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (!this.observedCallId) {
        const added = (await this.listCalls()).filter(id => !this.callIds.has(id));
        if (added.length > 1) throw new Error('Multiple settings writes observed; no ambiguous proxy restoration is allowed');
        this.observedCallId = added[0];
      }
      if (this.observedCallId) {
        const call = body(await this.electron.fetchHostApi({
          path: '/api/calls/get', method: 'POST', body: { callId: this.observedCallId }, timeoutMs: 5_000,
        }));
        const detail = record(call.detail);
        if (call.callId !== this.observedCallId || call.module !== 'settings' || call.command !== 'settings.replace'
          || detail.operation !== 'replaceDesired') throw new Error('Proxy settings call identity is invalid');
        if (['succeeded', 'failed', 'rejected', 'unknown'].includes(String(call.status))) {
          const settlement = record(detail.settlement);
          if (call.status !== 'succeeded' || settlement.outcome !== 'confirmed'
            || !Number.isSafeInteger(settlement.revision) || Number(settlement.revision) <= 0
            || detail.failure !== null || detail.launchAtStartup !== this.original?.launchAtStartup) {
            throw new Error(`Proxy settings outcome is not confirmed (${String(call.status)}); no retry or automatic restoration`);
          }
          if (!this.expected) throw new Error('Proxy expected settings are unavailable');
          await this.requireSettings(this.expected);
          this.current = structuredClone(this.expected);
          this.phase = this.purpose === 'restore' ? 'restored' : 'confirmed';
          return { status: 'succeeded', outcome: 'confirmed', exactPublicSettings: true };
        }
        if (!['received', 'accepted', 'running', 'waiting'].includes(String(call.status))) throw new Error('Proxy settings call status is invalid');
      }
      await delay(200);
    }
    throw new Error(`Proxy settings outcome is unresolved${this.observedCallId ? ` (${this.observedCallId})` : ''}; do not resend or restore`);
  }

  async observeCurrent(): Promise<boolean> {
    if (!this.current || this.phase === 'unknown') throw new Error('Proxy settings have no confirmed expected state');
    await this.requireSettings(this.current);
    return true;
  }

  async prepareCleanup(): Promise<'none' | 'discard' | 'restore'> {
    if (this.phase === 'unknown') throw new Error(`Proxy settings outcome is unknown${this.observedCallId ? ` (${this.observedCallId})` : ''}; retain the dedicated profile for reconciliation, do not resend or restore`);
    if (!this.original || this.phase === 'unprepared') return 'none';
    if (!this.current) throw new Error('Proxy current settings are unavailable');
    await this.requireSettings(this.current);
    return isDeepStrictEqual(this.current, this.original) ? 'discard' : 'restore';
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server?.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    this.server = undefined;
  }

  private async requireSettings(expected: Settings): Promise<void> {
    if (!isDeepStrictEqual(await this.readSettings(), expected)) {
      throw new Error('Public settings changed outside this case or differ from the exact submitted proxy values; no blind overwrite');
    }
  }

  private async readSettings(): Promise<Settings> {
    const value = body(await this.electron.fetchHostApi({ path: '/api/settings', method: 'GET', timeoutMs: 5_000 }));
    if (Object.keys(value).sort().join(',') !== 'browserMode,gatewayAutoStart,launchAtStartup,proxyBypassRules,proxyEnabled,proxyServer'
      || !['native', 'relay', 'off'].includes(String(value.browserMode)) || typeof value.launchAtStartup !== 'boolean'
      || typeof value.gatewayAutoStart !== 'boolean' || typeof value.proxyEnabled !== 'boolean'
      || typeof value.proxyServer !== 'string' || typeof value.proxyBypassRules !== 'string') throw new Error('Public settings DTO is invalid');
    return value as Settings;
  }

  private async listCalls(): Promise<string[]> {
    const catalog = body(await this.electron.fetchHostApi({ path: '/api/calls/list', method: 'POST', body: { module: 'settings', limit: 200 }, timeoutMs: 5_000 }));
    if (!Array.isArray(catalog.items)) throw new Error('Public settings call catalog is invalid');
    return catalog.items.map(record).filter(call => call.command === 'settings.replace').map(call => {
      if (call.module !== 'settings' || typeof call.callId !== 'string' || !/^[a-f0-9]{32}$/.test(call.callId)) throw new Error('Public settings call ID is invalid');
      return call.callId;
    });
  }
}
