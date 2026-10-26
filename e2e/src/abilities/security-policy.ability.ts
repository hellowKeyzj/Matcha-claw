import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { licensedProfileRoot, profileMode } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

type PublicSecurityPolicy = {
  preset: string;
  securityPolicyVersion: number;
  runtime: Record<string, unknown> & {
    runtimeGuardEnabled: boolean;
    enablePromptInjectionGuard: boolean;
    promptInjectionPatterns: string[];
  };
};
type SavePurpose = 'change' | 'restore';
type PolicyCall = { callId: string; status: string; detail: { revision: number | null; effect: string | null } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class UseSecurityPolicy extends Ability {
  private original?: PublicSecurityPolicy;
  private changed?: PublicSecurityPolicy;
  private phase: 'untouched' | 'draft' | 'unknown' | 'confirmed' | 'restored' = 'untouched';
  private baselineCallIds = new Set<string>();
  private savePurpose: SavePurpose = 'change';
  private observedCallId?: string;

  constructor(private readonly electron: UseElectron) { super(); }

  async openPolicy(): Promise<void> {
    // The current app retains this route but exposes no sidebar or Settings entry.
    await this.electron.page.goto(new URL('#/security', this.electron.page.url()).href);
  }

  async rememberPolicy(): Promise<void> {
    if (profileMode !== 'licensed' || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) {
      throw new Error('Security policy writes require the fixture-owned dedicated licensed E2E profile');
    }
    const policy = await this.readPolicy();
    if (!policy.runtime.runtimeGuardEnabled || !policy.runtime.enablePromptInjectionGuard) {
      throw new Error('Security policy E2E requires runtime and prompt-injection guards already enabled; it will not weaken or repair security prerequisites');
    }
    const patterns = policy.runtime.promptInjectionPatterns;
    if (patterns.length >= 256 || patterns.some(pattern => pattern.trim() !== pattern || /[,\r\n]/.test(pattern))
      || new Set(patterns).size !== patterns.length) {
      throw new Error('Existing public prompt-injection patterns cannot round-trip exactly through the current UI');
    }
    this.original = structuredClone(policy);
    this.changed = structuredClone(policy);
    // A never-matching expression exercises policy delivery without granting access or disabling protection.
    this.changed.runtime.promptInjectionPatterns.push(`e2e-security-${randomUUID()}^`);
  }

  draftPatterns(): string {
    if (!this.changed) throw new Error('Public security policy snapshot is unavailable');
    this.phase = 'draft';
    return this.changed.runtime.promptInjectionPatterns.join(', ');
  }

  originalPatterns(): string {
    if (!this.original) throw new Error('Public security policy snapshot is unavailable');
    return this.original.runtime.promptInjectionPatterns.join(', ');
  }

  async beginSave(purpose: SavePurpose): Promise<void> {
    const expected = purpose === 'change' ? this.original : this.changed;
    if ((purpose === 'change' ? this.phase !== 'draft' : this.phase !== 'confirmed')
      || !expected || !isDeepStrictEqual(await this.readPolicy(), expected)) {
      throw new Error('Security desired policy changed outside this scenario; refusing to overwrite it');
    }
    this.baselineCallIds = new Set((await this.listPolicyCalls()).map(call => call.callId));
    this.savePurpose = purpose;
    this.observedCallId = undefined;
    // Set before the UI click: a timeout after dispatch is not permission to retry or roll back.
    this.phase = 'unknown';
  }

  async confirmSave(): Promise<{ status: string; effect: string; revision: number }> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!this.observedCallId) {
        const added = (await this.listPolicyCalls()).filter(call => !this.baselineCallIds.has(call.callId));
        if (added.length > 1) throw new Error('Multiple security policy writes observed; refusing ambiguous confirmation or restoration');
        this.observedCallId = added[0]?.callId;
      }
      if (this.observedCallId) {
        const call = await this.readPolicyCall(this.observedCallId);
        if (['succeeded', 'failed', 'rejected', 'unknown'].includes(call.status)) {
          if (call.status !== 'succeeded' || call.detail.effect !== 'confirmed'
            || call.detail.revision === null || call.detail.revision <= 0) {
            throw new Error(`Security runtime delivery was not confirmed (${call.status}/${call.detail.effect}); no retry or automatic restoration`);
          }
          this.phase = this.savePurpose === 'change' ? 'confirmed' : 'restored';
          await this.requireDesiredPolicy(this.savePurpose === 'change' ? this.changed : this.original);
          return { status: call.status, effect: call.detail.effect, revision: call.detail.revision };
        }
      }
      await delay(200);
    }
    throw new Error('Security runtime delivery outcome is unknown after the bounded public call read; no retry or automatic restoration');
  }

  async prepareCleanup(): Promise<'none' | 'discard' | 'restore'> {
    if (this.phase === 'unknown') {
      throw new Error(`Security policy outcome is unknown${this.observedCallId ? ` for call ${this.observedCallId}` : ''}; the dedicated profile may retain the E2E detection marker; retain it for reconciliation, do not restore or resend`);
    }
    if (!this.original) return 'none';
    if (this.phase === 'untouched' || this.phase === 'draft' || this.phase === 'restored') return 'discard';
    if (!this.observedCallId) throw new Error('Confirmed security policy call identity is unavailable');
    const call = await this.readPolicyCall(this.observedCallId);
    if (call.status !== 'succeeded' || call.detail.effect !== 'confirmed') {
      throw new Error('Security runtime confirmation is no longer available; refusing automatic restoration');
    }
    await this.requireDesiredPolicy(this.changed);
    return 'restore';
  }

  async observeDesiredChange(): Promise<boolean> {
    await this.requireDesiredPolicy(this.changed);
    return true;
  }

  async observeExactRestoration(): Promise<boolean> {
    if (!this.original) return false;
    await this.requireDesiredPolicy(this.original);
    return true;
  }

  private async requireDesiredPolicy(expected: PublicSecurityPolicy | undefined): Promise<void> {
    if (!expected || !isDeepStrictEqual(await this.readPolicy(), expected)) {
      throw new Error('Public security desired DTO differs from the exact scenario-owned policy; no blind overwrite');
    }
  }

  private async readPolicy(): Promise<PublicSecurityPolicy> {
    const reply = await this.electron.fetchHostApi({ path: '/api/security', method: 'GET', timeoutMs: 5_000 });
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) throw new Error('Public security policy is unavailable');
    const value = reply.data.json;
    if (!isRecord(value) || Object.keys(value).length !== 3
      || !['strict', 'balanced', 'relaxed'].includes(String(value.preset))
      || typeof value.securityPolicyVersion !== 'number' || !Number.isSafeInteger(value.securityPolicyVersion) || value.securityPolicyVersion <= 0
      || !isRecord(value.runtime) || typeof value.runtime.runtimeGuardEnabled !== 'boolean'
      || typeof value.runtime.enablePromptInjectionGuard !== 'boolean'
      || !Array.isArray(value.runtime.promptInjectionPatterns)
      || !value.runtime.promptInjectionPatterns.every(pattern => typeof pattern === 'string')) {
      throw new Error('Public security policy DTO is invalid');
    }
    // This route already enforces the complete public DTO; never snapshot a profile file or private projection.
    return value as PublicSecurityPolicy;
  }

  private async listPolicyCalls(): Promise<Array<{ callId: string }>> {
    const reply = await this.electron.fetchHostApi({
      path: '/api/calls/list', method: 'POST', body: { module: 'security', limit: 200 }, timeoutMs: 5_000,
    });
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok
      || !isRecord(reply.data.json) || !Array.isArray(reply.data.json.items)) {
      throw new Error('Public security call list is unavailable');
    }
    return reply.data.json.items.filter(item => isRecord(item) && item.command === 'security.replace').map(item => {
      if (!isRecord(item) || item.module !== 'security' || typeof item.callId !== 'string' || !/^[a-f0-9]{32}$/.test(item.callId)) {
        throw new Error('Public security policy call identity is invalid');
      }
      return { callId: item.callId };
    });
  }

  private async readPolicyCall(callId: string): Promise<PolicyCall> {
    const reply = await this.electron.fetchHostApi({ path: '/api/calls/get', method: 'POST', body: { callId }, timeoutMs: 5_000 });
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) throw new Error('Public security policy call is unavailable');
    const value = reply.data.json;
    if (!isRecord(value) || value.callId !== callId || value.module !== 'security' || value.command !== 'security.replace'
      || typeof value.status !== 'string' || !['received', 'accepted', 'running', 'waiting', 'succeeded', 'failed', 'rejected', 'unknown'].includes(value.status)
      || !isRecord(value.detail) || value.detail.kind !== 'policyReplace'
      || !(value.detail.revision === null || typeof value.detail.revision === 'number' && Number.isSafeInteger(value.detail.revision))
      || !(value.detail.effect === null || typeof value.detail.effect === 'string' && ['confirmed', 'rejected', 'unavailable', 'unknown'].includes(value.detail.effect))) {
      throw new Error('Public security policy call DTO is invalid');
    }
    return { callId, status: value.status, detail: { revision: value.detail.revision, effect: value.detail.effect } };
  }
}
